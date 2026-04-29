const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const logger = require('../utils/logger');

const MONGO_URI_CRM = process.env.mongodb_uri;
const MONGO_URI_FLO = process.env.flodb_uri;

if (!MONGO_URI_CRM) throw new Error('mongodb_uri environment variable is required');
const OPENAI_API_KEY = process.env.openai_api_key;


class ReportService {
    async getDailyReport(db = 'crmdb') {
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
        const filePath = path.join(process.cwd(), `confirmed_wrong_orders_${db}.json`);
        if (!fs.existsSync(filePath)) return [];
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            throw new Error(`Wrong orders file for ${db} is corrupted or unreadable.`);
        }
    }


    async getFlaggedOrders(db = 'crmdb') {
        const filePath = path.join(process.cwd(), `flagged_wrong_orders_${db}.json`);
        if (!fs.existsSync(filePath)) return [];
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            throw new Error(`Flagged orders file for ${db} is corrupted or unreadable.`);
        }
    }


    async runDailyReport(dateArg, dbType = 'crmdb') {
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
            const cursor = messagesCollection.find({ createdAt: dateQuery, senderType: "customer" });

            const flaggedConversationIds = new Set();
            const messageMap = new Map();

            for await (const msg of cursor) {
                const originalText = msg.text || (msg.emailData && msg.emailData.plainTextBody) || "";
                const textToAnalyze = originalText.toLowerCase();

                if (suspiciousKeywords.some(kw => textToAnalyze.includes(kw))) {
                    if (msg.conversationId) {
                        const cIdStr = msg.conversationId.toString();
                        flaggedConversationIds.add(cIdStr);
                        if (!messageMap.has(cIdStr)) messageMap.set(cIdStr, originalText);
                    }
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
            const BATCH_SIZE = 10;

            for (let i = 0; i < flaggedConversations.length; i += BATCH_SIZE) {
                const batch = flaggedConversations.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(async (conv) => {
                    const text = conv.aiMessageContext;
                    if (!text || text.length < 5) return null;

                    try {
                        const response = await fetch('https://api.openai.com/v1/chat/completions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                            body: JSON.stringify({
                                model: "gpt-4o-mini",
                                response_format: { type: "json_object" },
                                messages: [
                                    { role: "system", content: "You are an assistant that checks if a customer received the wrong item. Return ONLY a JSON object with a single boolean property 'wrongItem'. Set to true ONLY if they explicitly complain about receiving the wrong product. Ignore lost or late packages." },
                                    { role: "user", content: `Message: ${text}` }
                                ],
                                max_tokens: 15,
                                temperature: 0
                            })
                        });

                        const result = await response.json();
                        if (!result.choices || !result.choices[0]) {
                            logger.warn('OpenAI returned unexpected response', { result });
                            return null;
                        }
                        const aiContent = JSON.parse(result.choices[0].message.content);

                        if (aiContent.wrongItem === true || aiContent.wrongitem === true) {
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
