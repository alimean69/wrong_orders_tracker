const axios = require('axios');
const pLimit = require('p-limit').default;
const logger = require('./logger');

/**
 * Parses the UPS tracking response to extract the delivery date and time.
 */
function parseUpsDelivered(payload) {
    try {
        const shipment = payload?.trackResponse?.shipment?.[0];
        const pkg = shipment?.package?.[0];
        if (!pkg) return null;

        let ymd = null;
        const deliveryDates = pkg.deliveryDate || [];
        for (const entry of deliveryDates) {
            if (entry && entry.type === 'DEL') {
                ymd = entry.date;
                break;
            }
        }

        if (!ymd) return null;

        const endTime = String(pkg.deliveryTime?.endTime || '000000').padEnd(6, '0').substring(0, 6);
        
        // ymd is YYYYMMDD, endTime is HHMMSS
        const year = parseInt(ymd.substring(0, 4));
        const month = parseInt(ymd.substring(4, 6)) - 1; // JS months are 0-indexed
        const day = parseInt(ymd.substring(6, 8));
        const hour = parseInt(endTime.substring(0, 2));
        const min = parseInt(endTime.substring(2, 4));
        const sec = parseInt(endTime.substring(4, 6));

        return new Date(year, month, day, hour, min, sec);
    } catch (error) {
        logger.error('Error parsing UPS delivered date', error);
        return null;
    }
}

/**
 * Fetches tracking information for a single tracking number.
 */
async function fetchOneTracking(tn, token) {
    const url = `https://onlinetools.ups.com/api/track/v1/details/${tn}`;
    
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'transId': `node-${tn}-${attempt}`,
                    'transactionSrc': 'node'
                },
                timeout: 10000
            });

            if (response.status === 200) {
                return { tn, deliveredAt: parseUpsDelivered(response.data), status: 200 };
            }
        } catch (error) {
            if (error.response?.status === 429 && attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
                continue;
            }
            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
                continue;
            }
            return { tn, deliveredAt: null, status: error.response?.status || -1 };
        }
    }
    return { tn, deliveredAt: null, status: -1 };
}

/**
 * Fetches tracking information for multiple tracking numbers in parallel with a limit.
 */
async function fetchAllTrackings(trackings, token, progressCallback) {
    const limit = pLimit(50); // Limit to 50 concurrent requests (similar to Python's 300 but safer for Node)
    const deliveredByTracking = {};
    const total = trackings.length;
    let done = 0;

    const tasks = trackings.map(tn => limit(async () => {
        const result = await fetchOneTracking(tn, token);
        done++;
        
        if (result.status === 200 && result.deliveredAt) {
            deliveredByTracking[tn] = result.deliveredAt;
        }

        if (progressCallback && (done % 100 === 0 || done === total)) {
            await progressCallback(done, total);
        }
        
        return result;
    }));

    await Promise.all(tasks);
    return deliveredByTracking;
}

module.exports = {
    fetchAllTrackings
};
