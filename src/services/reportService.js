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
let clients = {
    crmdb: new MongoClient(MONGO_URI_CRM, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000 }),
    flodb: MONGO_URI_FLO ? new MongoClient(MONGO_URI_FLO, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000 }) : null
};

let connectionState = { crmdb: false, flodb: false };

class ReportService {
    async updateConfig(newConfig) {
        const { mongodb_uri, flodb_uri } = newConfig;
        
        // Close existing connections
        await Promise.all([
            clients.crmdb ? clients.crmdb.close() : Promise.resolve(),
            clients.flodb ? clients.flodb.close() : Promise.resolve()
        ]);

        // Update process.env
        if (mongodb_uri) process.env.mongodb_uri = mongodb_uri;
        if (flodb_uri) process.env.flodb_uri = flodb_uri;

        // Re-initialize clients
        clients.crmdb = new MongoClient(process.env.mongodb_uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000 });
        clients.flodb = process.env.flodb_uri ? new MongoClient(process.env.flodb_uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000 }) : null;
        
        connectionState = { crmdb: false, flodb: false };
        logger.info('Database configurations updated dynamically');
        
        // Persist to .env file
        const envPath = path.join(process.cwd(), '.env');
        let envContent = '';
        for (const key in process.env) {
            if (['mongodb_uri', 'flodb_uri', 'openai_api_key', 'API_AUTH_TOKEN', 'PORT', 'ALLOWED_ORIGINS'].includes(key)) {
                envContent += `${key}=${process.env[key]}\n`;
            }
        }
        fs.writeFileSync(envPath, envContent);
    }

    async getDb(dbType = 'crmdb') {
        const normalizedType = dbType.toLowerCase();
        const type = (normalizedType === 'flodb' || normalizedType === 'flowdb') ? 'flodb' : 'crmdb';
        
        const client = clients[type];
        if (!client) throw new Error(`Database connection for ${type} is not configured in .env`);
        
        // SEC-02: Check if both URIs are identical which might cause duplicate data
        if (type === 'crmdb' && MONGO_URI_FLO === MONGO_URI_CRM) {
            logger.warn('WARNING: mongodb_uri and flodb_uri are identical. Both databases will return the same data.');
        }

        if (!connectionState[type]) {
            await client.connect();
            connectionState[type] = true;
            logger.info(`Connected to MongoDB: ${type}`);
        }
        
        // Use the database specified in the URI (default behavior)
        return client.db();
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
                    totalFlaggedTickets: crm.totalFlaggedTickets + flo.totalFlaggedTickets,
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

            const totalFlagged = flaggedConversationIds.size;
            onProgress(`Found ${totalFlagged} unique conversations with suspicious keywords.`);

            const flaggedConversations = [];
            if (totalFlagged > 0) {
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

            onProgress(`Starting AI verification for ${flaggedConversations.length} conversations...`);
            
            // Helper function for OpenAI verification with Retry logic
            const verifyWithRetry = async (conv, retryCount = 0) => {
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
                    return parsed.wrongItem === true || parsed.wrongItem === "true" || parsed.wrongitem === true || parsed.wrongitem === "true";
                } catch (e) {
                    if (e.response?.status === 429 && retryCount < 3) {
                        const delay = Math.pow(2, retryCount) * 2000; // 2s, 4s, 8s
                        onProgress(`[Rate Limit] Retrying in ${delay/1000}s... (Attempt ${retryCount + 1}/3)`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        return verifyWithRetry(conv, retryCount + 1);
                    }
                    logger.error('OpenAI verification failed', e, { conversationId: conv._id });
                    return null;
                }
            };

            // Process sequentially to respect low rate limits
            for (let i = 0; i < flaggedConversations.length; i++) {
                const conv = flaggedConversations[i];
                onProgress(`Verifying conversation ${i + 1}/${flaggedConversations.length}...`);
                
                const isWrong = await verifyWithRetry(conv);
                
                if (isWrong) {
                    totalWrongDelivered++;
                    confirmedResults.push({
                        customerEmail: conv.customerEmail,
                        conversationId: conv.conversationId || conv._id.toString(),
                        status: conv.status,
                        wrongItem: true
                    });
                }

                // Small rest between messages to stay under RPM (Requests Per Minute)
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            onProgress(`AI verification complete. Found ${totalWrongDelivered} confirmed wrong orders.`);

            const report = {
                date: startDate.toDateString(),
                db: dbType,
                totalDailyTickets,
                totalClosedTickets,
                totalFlaggedTickets: totalFlagged,
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
