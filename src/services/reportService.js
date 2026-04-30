const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const axios = require('axios');
const logger = require('../utils/logger');

const MONGO_URI_CRM = process.env.mongodb_uri;
const MONGO_URI_FLO = process.env.flodb_uri;

if (!MONGO_URI_CRM) throw new Error('mongodb_uri environment variable is required');
const OPENAI_API_KEY = process.env.openai_api_key;

// Connection Pool Singleton
const clients = {
    crmdb: new MongoClient(MONGO_URI_CRM, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000 }),
    flodb: MONGO_URI_FLO ? new MongoClient(MONGO_URI_FLO, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000 }) : null
};

const connectionState = { crmdb: false, flodb: false };

class ReportService {
    async getDb(dbType = 'crmdb') {
        const type = dbType === 'flodb' ? 'flodb' : 'crmdb';
        const client = clients[type];
        if (!client) throw new Error(`Database connection for ${type} is not configured in .env`);
        
        if (!connectionState[type]) {
            await client.connect();
            connectionState[type] = true;
            logger.info(`Connected to MongoDB: ${type}`);
        }
        return client.db(type === 'flodb' ? 'flodb' : 'crmdb');
    }

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

    async runDailyReport(dateArg, dbType = 'crmdb', onProgress = () => {}) {
        if (dbType === 'all') {
            onProgress(`Starting combined report for all databases`);
            const [crm, flo] = await Promise.all([
                this.runDailyReport(dateArg, 'crmdb', (msg) => onProgress(`[crmdb] ${msg}`)),
                this.runDailyReport(dateArg, 'flodb', (msg) => onProgress(`[flodb] ${msg}`))
            ]);
            onProgress(`Combined report generation complete`);
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

        onProgress(`Connecting to ${dbType} database...`);
        const db = await this.getDb(dbType);
        try {
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
            onProgress(`Querying tickets for date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
            
            const [totalDailyTickets, totalClosedTickets] = await Promise.all([
                conversationsCollection.countDocuments({ createdAt: dateQuery }),
                conversationsCollection.countDocuments({ createdAt: dateQuery, status: "closed" })
            ]);

            onProgress(`Found ${totalDailyTickets} total tickets, ${totalClosedTickets} closed tickets.`);

            const suspiciousKeywords = ["opened the box", "not what i see", "different item", "missing", "instead of", "wrong", "ordered"];
            const keywordRegex = new RegExp(suspiciousKeywords.join('|'), 'i');
            
            onProgress(`Scanning messages for suspicious keywords...`);
            const cursor = messagesCollection.find({ 
                createdAt: dateQuery, 
                senderType: { $regex: /^customer$/i },
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

            onProgress(`Found ${flaggedConversationIds.size} unique conversations with suspicious keywords.`);

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

            onProgress(`Starting AI verification for ${flaggedConversations.length} conversations...`);
            for (let i = 0; i < flaggedConversations.length; i += BATCH_SIZE) {
                const batch = flaggedConversations.slice(i, i + BATCH_SIZE);
                onProgress(`Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(flaggedConversations.length/BATCH_SIZE)}...`);
                
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
                            timeout: 10000
                        });

                        const aiContent = response.data.choices[0].message.content;
                        const parsed = typeof aiContent === 'string' ? JSON.parse(aiContent) : aiContent;
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

            onProgress(`AI verification complete. Found ${totalWrongDelivered} confirmed wrong orders.`);

            const report = {
                date: startDate.toDateString(),
                db: dbType,
                totalDailyTickets,
                totalClosedTickets,
                totalWrongOrdersDelivered: totalWrongDelivered,
                wrongOrdersDetails: confirmedResults,
                generatedAt: new Date().toISOString()
            };

            onProgress(`Saving results to disk...`);
            fs.writeFileSync(path.join(process.cwd(), `daily_report_${dbType}_output.json`), JSON.stringify(report, null, 2));
            fs.writeFileSync(path.join(process.cwd(), `confirmed_wrong_orders_${dbType}.json`), JSON.stringify(confirmedResults, null, 2));
            
            onProgress(`Report generation finished successfully.`);
            return report;
        } catch (error) {
            onProgress(`Error: ${error.message}`);
            logger.error(`Error running daily report for ${dbType}`, error);
            throw error;
        }
    }
}

module.exports = new ReportService();
