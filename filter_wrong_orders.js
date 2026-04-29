require('dotenv').config();
const { MongoClient } = require('mongodb');

async function preFilterWrongOrders() {
    // MongoDB setup from .env
    const uri = process.env.mongodb_uri;
    if (!uri) {
        console.error("Missing mongodb_uri in .env file!");
        return;
    }
    const client = new MongoClient(uri);

    try {
        console.log("Connecting to database...");
        await client.connect();

        // We use the database specified in the URI, or default to crmdb
        const db = client.db('crmdb');
        
        console.log("Connected successfully. Processing 350,000+ documents (this might take a minute)...");

        // Query the messages collection directly since conversations don't have the text field
        const messagesCollection = db.collection('messages');
        const conversationsCollection = db.collection('conversations');

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        // Fetch customer messages from the last 24 hours
        const query = {
            createdAt: { $gte: yesterday },
            senderType: "customer" // Only analyze what the customer said
        };

        const cursor = messagesCollection.find(query);
        
        let totalProcessed = 0;
        const flaggedConversationIds = new Set();
        
        // Pre-filtering keywords indicating potential logistics/order issues
        const suspiciousKeywords = [
            "opened the box", 
            "not what i see", 
            "different item", 
            "missing", 
            "instead of", 
            "wrong", 
            "ordered"
        ];

        // Iterate safely using await
        for await (const msg of cursor) {
            totalProcessed++;
            
            if (totalProcessed % 10000 === 0) {
                console.log(`Processed ${totalProcessed} messages...`);
            }

            // Extract the text safely from the message document
            let textToAnalyze = msg.text || "";
            if (!textToAnalyze && msg.emailData && msg.emailData.plainTextBody) {
                textToAnalyze = msg.emailData.plainTextBody;
            }

            textToAnalyze = textToAnalyze.toLowerCase();

            // Simple heuristic check
            const isSuspicious = suspiciousKeywords.some(keyword => textToAnalyze.includes(keyword));
            
            if (isSuspicious && msg.conversationId) {
                // We add the ID as a string, no ObjectId conversion needed based on your schema
                flaggedConversationIds.add(msg.conversationId.toString());
            }
        }

        console.log(`\nFound keywords in ${flaggedConversationIds.size} unique conversations. Checking their statuses...`);

        // Now, fetch the actual conversations and filter out the closed/success ones
        const flaggedConversations = [];
        if (flaggedConversationIds.size > 0) {
            const openConversations = await conversationsCollection.find({
                _id: { $in: Array.from(flaggedConversationIds).map(id => {
                    // Try ObjectId conversion if stored as ObjectId, else fallback to string
                    try { return new (require('mongodb').ObjectId)(id); } catch(e) { return id; }
                }) },
                status: { $nin: ["Success", "Closed"] }
            }).toArray();

            // If some use string `conversationId` instead of `_id` (fallback)
            const openConversationsFallback = await conversationsCollection.find({
                conversationId: { $in: Array.from(flaggedConversationIds) },
                status: { $nin: ["Success", "Closed"] }
            }).toArray();

            // Merge avoiding duplicates
            const allFound = [...openConversations, ...openConversationsFallback];
            const uniqueMap = new Map();
            allFound.forEach(c => uniqueMap.set(c._id.toString(), c));
            
            flaggedConversations.push(...uniqueMap.values());
        }

        console.log(`DONE! Final flagged 'wrong order' active conversations: ${flaggedConversations.length}`);

        // Save the results to a JSON file
        if (flaggedConversations.length > 0) {
            const fs = require('fs');
            
            // Format the data to keep only the important fields (id, conversation data, date)
            const outputData = flaggedConversations.map(conv => ({
                id: conv._id.toString(),
                conversationId: conv.conversationId || conv._id.toString(),
                customerName: conv.customerName || "Unknown",
                customerEmail: conv.customerEmail || "Unknown",
                date: conv.createdAt,
                status: conv.status,
                lastMessage: conv.lastMessage || "No last message"
            }));

            fs.writeFileSync('flagged_wrong_orders.json', JSON.stringify(outputData, null, 2));
            console.log(`\nSuccessfully saved ${flaggedConversations.length} records to 'flagged_wrong_orders.json'!`);
        }

    } catch (err) {
        console.error("\nDatabase Error:", err.message);
    } finally {
        await client.close();
    }
}

preFilterWrongOrders();
