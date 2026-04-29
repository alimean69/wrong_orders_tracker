require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const OPENAI_API_KEY = process.env.openai_api_key;
const MONGO_URI = process.env.mongodb_uri;

async function runDailyReport() {
    if (!OPENAI_API_KEY) {
        console.error("Missing openai_api_key in .env file!");
        return;
    }
    if (!MONGO_URI) {
        console.error("Missing mongodb_uri in .env file!");
        return;
    }

    const client = new MongoClient(MONGO_URI);

    try {
        await client.connect();
        const db = client.db('crmdb');
        const conversationsCollection = db.collection('conversations');
        const messagesCollection = db.collection('messages');

        // Date Logic
        const dateArg = process.argv[2];
        let startDate, endDate;

        if (dateArg) {
            // If user provides a date like '2026-04-28'
            startDate = new Date(dateArg);
            endDate = new Date(startDate);
            endDate.setDate(endDate.getDate() + 1);
            console.log(`\nAnalyzing data for date: ${startDate.toDateString()}`);
        } else {
            // Default to last 24 hours
            endDate = new Date();
            startDate = new Date();
            startDate.setDate(startDate.getDate() - 1);
            console.log(`\nAnalyzing data for the last 24 hours (No date defined)`);
        }

        const dateQuery = { $gte: startDate, $lt: endDate };

        console.log("Fetching daily metrics from database...");

        // 1. Total Number of Daily Tickets
        const totalDailyTickets = await conversationsCollection.countDocuments({ createdAt: dateQuery });
        
        // 2. Total tickets with status "closed" created in this period
        // The user specifically used status: "closed" in their manual query
        const totalClosedTickets = await conversationsCollection.countDocuments({ 
            createdAt: dateQuery, 
            status: "closed" 
        });

        console.log(`Total Daily Tickets: ${totalDailyTickets}`);
        console.log(`Total Closed Tickets: ${totalClosedTickets}`);
        console.log("Scanning messages for potential wrong orders...");

        // 3. Pre-Filter (Heuristics)
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

        console.log(`Pre-filter found ${flaggedConversations.length} suspicious conversations. Starting AI Verification...`);

        // 4. AI Verification in batches of 10
        let totalWrongDelivered = 0;
        const BATCH_SIZE = 10;
        const confirmedResults = [];

        for (let i = 0; i < flaggedConversations.length; i += BATCH_SIZE) {
            const batch = flaggedConversations.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(async (conv) => {
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
                                { 
                                    role: "system", 
                                    content: "You are an assistant that checks if a customer received the wrong item. Return ONLY a JSON object with a single boolean property 'wrongItem'. Set to true ONLY if they explicitly complain about receiving the wrong product. Ignore lost or late packages." 
                                },
                                { role: "user", content: `Message: ${text}` }
                            ],
                            max_tokens: 15,
                            temperature: 0
                        })
                    });

                    const result = await response.json();
                    if (!result.choices) return null;
                    
                    const aiContent = JSON.parse(result.choices[0].message.content);
                    
                    if (aiContent.wrongItem === true || aiContent.wrongitem === true) {
                        return {
                            customerEmail: conv.customerEmail,
                            conversationId: conv.conversationId || conv._id.toString(),
                            status: conv.status,
                            wrongItem: true
                        };
                    }
                } catch (e) { return null; }
                return null;
            });

            const results = await Promise.all(batchPromises);
            results.forEach(res => {
                if (res) {
                    totalWrongDelivered++;
                    confirmedResults.push(res);
                }
            });
            process.stdout.write(`\rVerified ${Math.min(i + BATCH_SIZE, flaggedConversations.length)} / ${flaggedConversations.length}`);
        }

        console.log("\n\n==================================================");
        console.log("               DAILY TICKET REPORT                ");
        console.log("==================================================");
        console.log(`TOTAL NUMBER OF DAILY TICKETS : ${totalDailyTickets}`);
        console.log(`TOTAL CLOSED TICKETS          : ${totalClosedTickets}`);
        console.log(`TOTAL WRONG ORDERS DELIVERED  : ${totalWrongDelivered}`);
        console.log(`"status": "closed" (Check)      : ${totalClosedTickets}`);
        console.log("==================================================\n");

        // Optionally save to a file
        const fs = require('fs');
        fs.writeFileSync('daily_report_output.json', JSON.stringify({
            date: startDate.toDateString(),
            totalDailyTickets,
            totalClosedTickets,
            totalWrongOrdersDelivered: totalWrongDelivered,
            wrongOrdersDetails: confirmedResults
        }, null, 2));

    } catch (err) {
        console.error("Error:", err.message);
    } finally {
        await client.close();
    }
}

runDailyReport();
