const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const axios = require('axios');
const logger = require('../utils/logger');

const MONGO_URI_CRM = process.env.mongodb_uri;
const MONGO_URI_FLO = process.env.flodb_uri;

if (!MONGO_URI_CRM) throw new Error('mongodb_uri environment variable is required');
const OPENAI_API_KEY = process.env.openai_api_key;


class ReportService {
    async getDailyReport(db = 'crmdb') {
        if (db === 'all') {
            const [crm, flo] = await Promise.allSettled([
                this.getDailyReport('crmdb'),
                this.getDailyReport('flodb')
            ]);
            return {
                crmdb: crm.status === 'fulfilled' ? crm.value : null,
                flodb: flo.status === 'fulfilled' ? flo.value : null
            };
        }
        const filePath = path.join(process.cwd(), `daily_report_${db}_output.json`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Daily report for ${db} not found. Run the report first.`);
        }
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            throw new Error(`Daily report file for ${db} is corrupted or unreadable.`);
        }
    }


    async getWrongOrders(db = 'crmdb') {
        if (db === 'all') {
            const [crm, flo] = await Promise.all([
                this.getWrongOrders('crmdb'),
                this.getWrongOrders('flodb')
            ]);
            return [...crm, ...flo];
        }
        const filePath = path.join(process.cwd(), `confirmed_wrong_orders_${db}.json`);
        if (!fs.existsSync(filePath)) return [];
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            throw new Error(`Wrong orders file for ${db} is corrupted or unreadable.`);
        }
    }


    async getFlaggedOrders(db = 'crmdb') {
        if (db === 'all') {
            const [crm, flo] = await Promise.all([
                this.getFlaggedOrders('crmdb'),
                this.getFlaggedOrders('flodb')
            ]);
            return [...crm, ...flo];
        }
        const filePath = path.join(process.cwd(), `flagged_wrong_orders_${db}.json`);
        if (!fs.existsSync(filePath)) return [];
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            throw new Error(`Flagged orders file for ${db} is corrupted or unreadable.`);
        }
    }


    async runDailyReport(dateArg, dbType = 'crmdb') {
        if (dbType === 'all') {
            const [crm, flo] = await Promise.all([
                this.runDailyReport(dateArg, 'crmdb'),
                this.runDailyReport(dateArg, 'flodb')
            ]);
            return {
                crmdb: crm,
                flodb: flo,
                summary: {
                    totalDailyTickets: crm.totalDailyTickets + flo.totalDailyTickets,
                    totalClosedTickets: crm.totalClosedTickets + flo.totalClosedTickets,
                    totalWrongOrdersDelivered: crm.totalWrongOrdersDelivered + flo.totalWrongOrdersDelivered,
                    wrongOrdersDetails: [...crm.wrongOrdersDetails, ...flo.wrongOrdersDetails]
                }
            };
        }
        if (!OPENAI_API_KEY) throw new Error("Missing openai_api_key");

        const mongoUri = dbType === 'flodb' ? MONGO_URI_FLO : MONGO_URI_CRM;
        if (!mongoUri) throw new Error(`Connection string for ${dbType} is not defined in .env`);

        const client = new MongoClient(mongoUri);
        try {
            await client.connect();
            // Connect to the specific database name provided in the URI or default to the parameter
            const dbName = dbType === 'flodb' ? 'flodb' : 'crmdb';
            const db = client.db(dbName);

            const conversationsCollection = db.collection('conversations');
            const messagesCollection = db.collection('messages');

            let startDate, endDate;
            if (dateArg) {
                startDate = new Date(dateArg);
                endDate = new Date(startDate);
                endDate.setDate(endDate.getDate() + 1);
            } else {
                endDate = new Date();
                startDate = new Date();
                startDate.setDate(startDate.getDate() - 1);
            }

            const dateQuery = { $gte: startDate, $lt: endDate };
            
            const [totalDailyTickets, totalClosedTickets] = await Promise.all([
                conversationsCollection.countDocuments({ createdAt: dateQuery }),
                conversationsCollection.countDocuments({ createdAt: dateQuery, status: "closed" })
            ]);

            const suspiciousKeywords = ["opened the box", "not what i see", "different item", "missing", "instead of", "wrong", "ordered"];
            const keywordRegex = new RegExp(suspiciousKeywords.join('|'), 'i');
            
            // Optimization: Filter messages by keywords in the database query
            const cursor = messagesCollection.find({ 
                createdAt: dateQuery, 
                senderType: { $regex: /^customer$/i }, // Case-insensitive customer check
                $or: [
                    { text: { $regex: keywordRegex } },
                    { "emailData.plainTextBody": { $regex: keywordRegex } }
                ]
            });

            const flaggedConversationIds = new Set();
            const messageMap = new Map();

            for await (const msg of cursor) {
                const originalText = msg.text || (msg.emailData && msg.emailData.plainTextBody) || "";
                if (msg.conversationId) {
                    const cIdStr = msg.conversationId.toString();
                    flaggedConversationIds.add(cIdStr);
                    if (!messageMap.has(cIdStr)) messageMap.set(cIdStr, originalText);
                }
            }

            const flaggedConversations = [];
            if (flaggedConversationIds.size > 0) {
                const idArray = Array.from(flaggedConversationIds);
                const convs = await conversationsCollection.find({
                    $or: [
                        { _id: { $in: idArray.map(id => { try { return new ObjectId(id); } catch(e) { return id; } }) } },
                        { conversationId: { $in: idArray } }
                    ]
                }).toArray();

                const uniqueMap = new Map();
                convs.forEach(c => {
                    const idStr = c._id.toString();
                    if (!uniqueMap.has(idStr)) {
                        c.aiMessageContext = messageMap.get(idStr) || c.lastMessage || "";
                        uniqueMap.set(idStr, c);
                    }
                });
                flaggedConversations.push(...uniqueMap.values());
            }

            let totalWrongDelivered = 0;
            const confirmedResults = [];
            const BATCH_SIZE = 20;

            for (let i = 0; i < flaggedConversations.length; i += BATCH_SIZE) {
                const batch = flaggedConversations.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(async (conv) => {
                    const text = conv.aiMessageContext;
                    if (!text || text.length < 5) return null;

                    try {
                        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                            model: "gpt-4o-mini",
                            response_format: { type: "json_object" },
                            messages: [
                                { role: "system", content: "You are an assistant that checks if a customer received the wrong item. Return ONLY a JSON object with a single boolean property 'wrongItem'. Set to true ONLY if they explicitly complain about receiving the wrong product. Ignore lost or late packages." },
                                { role: "user", content: `Message: ${text}` }
                            ],
                            max_tokens: 15,
                            temperature: 0
                        }, {
                            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                            timeout: 10000 // 10s timeout for OpenAI calls
                        });

                        const aiContent = response.data.choices[0].message.content;
                        const parsed = typeof aiContent === 'string' ? JSON.parse(aiContent) : aiContent;

                        // Robust check for wrongItem (handles "true" string or boolean)
                        const isWrong = parsed.wrongItem === true || parsed.wrongItem === "true" || parsed.wrongitem === true || parsed.wrongitem === "true";

                        if (isWrong) {
                            return {
                                customerEmail: conv.customerEmail,
                                conversationId: conv.conversationId || conv._id.toString(),
                                status: conv.status,
                                wrongItem: true
                            };
                        }
                    } catch (e) {
                        logger.error('OpenAI verification failed for conversation', e, { conversationId: conv._id });
                        return null;
                    }
                    return null;
                }));

                results.forEach(res => {
                    if (res) {
                        totalWrongDelivered++;
                        confirmedResults.push(res);
                    }
                });
            }

            const report = {
                date: startDate.toDateString(),
                db: dbType,
                totalDailyTickets,
                totalClosedTickets,
                totalWrongOrdersDelivered: totalWrongDelivered,
                wrongOrdersDetails: confirmedResults,
                generatedAt: new Date().toISOString()
            };

            fs.writeFileSync(path.join(process.cwd(), `daily_report_${dbType}_output.json`), JSON.stringify(report, null, 2));
            // Also update the general "latest" collections for this DB
            fs.writeFileSync(path.join(process.cwd(), `confirmed_wrong_orders_${dbType}.json`), JSON.stringify(confirmedResults, null, 2));
            
            return report;


        } finally {
            await client.close();
        }
    }
}

module.exports = new ReportService();
