require('dotenv').config();
const fs = require('fs');

const OPENAI_API_KEY = process.env.openai_api_key;

async function verifyWrongOrders() {
    if (!OPENAI_API_KEY) {
        console.error("Missing openai_api_key in .env file!");
        return;
    }

    console.log("Reading flagged_wrong_orders.json...");
    let flaggedOrders = [];
    try {
        const data = fs.readFileSync('flagged_wrong_orders.json', 'utf8');
        flaggedOrders = JSON.parse(data);
    } catch (err) {
        console.error("Could not read flagged_wrong_orders.json. Make sure you run the filter script first.");
        return;
    }

    console.log(`Starting AI Verification for ${flaggedOrders.length} conversations...`);
    console.log("Using gpt-4o-mini to save tokens and costs.\n");

    const confirmedWrongOrders = [];
    let totalWrongDelivered = 0;

    const axios = require('axios');

    // Process sequentially or in small batches to avoid OpenAI rate limits
    for (let i = 0; i < flaggedOrders.length; i++) {
        const order = flaggedOrders[i];

        // Skip if lastMessage is missing or too short
        if (!order.lastMessage || order.lastMessage.length < 5) continue;

        try {
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                response_format: { type: "json_object" },
                messages: [
                    {
                        role: "system",
                        content: "You are an assistant that checks if a customer received the wrong item. Return ONLY a JSON object with a single boolean property 'wrongItem'. Set to true ONLY if they explicitly complain about receiving the wrong product. Ignore lost or late packages."
                    },
                    {
                        role: "user",
                        content: `Message: ${order.lastMessage}`
                    }
                ],
                max_tokens: 15,
                temperature: 0
            }, {
                headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                timeout: 10000
            });

            const aiContent = response.data.choices[0].message.content;
            const parsed = typeof aiContent === 'string' ? JSON.parse(aiContent) : aiContent;

            // Format exactly as you requested
            const isWrong = parsed.wrongItem === true || parsed.wrongItem === "true" || parsed.wrongitem === true || parsed.wrongitem === "true";
            
            const finalResult = {
                customerEmail: order.customerEmail,
                conversationId: order.conversationId,
                wrongItem: isWrong
            };

            // If it is indeed a wrong order, save it and count it
            if (finalResult.wrongItem) {
                confirmedWrongOrders.push(finalResult);
                totalWrongDelivered++;
                console.log(`[FOUND] Wrong Order detected for ${finalResult.customerEmail}`);
            }

            // Print progress every 50 items
            if ((i + 1) % 50 === 0) {
                console.log(`Processed ${i + 1} / ${flaggedOrders.length}...`);
            }

        } catch (err) {
            console.error(`Error processing index ${i}:`, err.message);
        }
    }

    console.log("\n=================================");
    console.log(`TOTAL WRONG ORDERS DELIVERED: ${totalWrongDelivered}`);
    console.log("=================================");

    // Save the final verified ones
    fs.writeFileSync('confirmed_wrong_orders.json', JSON.stringify(confirmedWrongOrders, null, 2));
    console.log(`Saved results to 'confirmed_wrong_orders.json'`);
}

verifyWrongOrders();
