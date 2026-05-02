const { Pool } = require('pg');
const { fetchAllTrackings } = require('../utils/upsApi');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

const pool = new Pool({
    host: process.env.ERP_DB_HOST,
    port: process.env.ERP_DB_PORT,
    database: process.env.ERP_DB_NAME,
    user: process.env.ERP_DB_USER,
    password: process.env.ERP_DB_PASSWORD
});

const jobEvents = new EventEmitter();

const BRANDS = ["Flo Pilates", "Nobl Travel"];
const REPORTS_DIR = path.join(process.cwd(), 'reports');

// Ensure reports directory exists
async function ensureReportsDir() {
    try {
        await fs.mkdir(REPORTS_DIR, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
}

function shiftDate(dateStr, delta) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + delta);
    return d.toISOString().split('T')[0];
}

function avg(values) {
    if (!values || values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

const activeJobs = new Map();

async function runOpsLogic(targetDay, progressCallback, logCallback) {
    const job = activeJobs.get(targetDay);
    const log = (msg) => {
        const timestampedMsg = `[${new Date().toISOString()}] ${msg}`;
        logger.info(msg);
        if (job) {
            if (!job.logs) job.logs = [];
            job.logs.push(timestampedMsg);
        }
        jobEvents.emit(`log:${targetDay}`, msg);
        if (logCallback) logCallback(msg);
    };

    log(`Starting ops report for ${targetDay}...`);
    
    const windowStart = shiftDate(targetDay, -6);
    const windowEnd = targetDay;

    const client = await pool.connect();
    try {
        log(`Window: ${windowStart} to ${windowEnd}`);
        log(`Connecting to database to fetch UPS token...`);
        
        // Get UPS token
        const tokenRes = await client.query(
            "SELECT token_value FROM public.third_party_tokens WHERE token_name = $1 ORDER BY token_inserted_at DESC LIMIT 1",
            [process.env.UPS_TOKEN_NAME || 'ups']
        );
        const upsToken = tokenRes.rows[0]?.token_value;

        if (!upsToken) {
            throw new Error("UPS token not found in database.");
        }

        log(`Fetching shipment rows from store.orders_shipment...`);
        // Fetch shipments
        const shipmentQuery = `
            SELECT os.created_at::date as date_only, os.created_at, os.order_number, os.tracking_number, b.brand_name, lo.created_at as live_order_created_at
            FROM store.orders_shipment os
            JOIN store.shiphero_live_orders lo ON lo.order_nodeid = os.order_uuid
            JOIN public.shiphero_brand_ids b ON b.account_uuid = lo.account_id
            WHERE os.created_at::date BETWEEN $1 AND $2
              AND b.brand_name = ANY($3)
              AND lower(coalesce(os.shipping_carrier, '')) = 'ups'
              AND coalesce(os.tracking_number, '') <> ''
        `;
        const shipmentRes = await client.query(shipmentQuery, [windowStart, windowEnd, BRANDS]);
        const shipmentRows = shipmentRes.rows.map(r => ({
            shippedAt: new Date(r.created_at),
            orderNumber: String(r.order_number),
            trackingNumber: r.tracking_number,
            brandName: r.brand_name,
            liveOrderCreatedAt: r.live_order_created_at ? new Date(r.live_order_created_at) : null
        }));

        log(`Found ${shipmentRows.length} shipment rows.`);

        log(`Fetching shipping label costs...`);
        // Fetch costs
        const costQuery = `
            SELECT tracking_number, coalesce(sum(cost), 0) as total_cost
            FROM store.orders_shipment_shipping_label
            WHERE created_at::date BETWEEN $1 AND $2
            GROUP BY tracking_number
        `;
        const costRes = await client.query(costQuery, [windowStart, windowEnd]);
        const costByTracking = {};
        costRes.rows.forEach(r => {
            costByTracking[r.tracking_number] = parseFloat(r.total_cost);
        });


        log(`Fetching UPS tracking data for ${[...new Set(shipmentRows.map(r => r.trackingNumber))].length} unique tracking numbers...`);
        // Fetch UPS tracking data
        const uniqueTrackings = [...new Set(shipmentRows.map(r => r.trackingNumber))];
        const job = activeJobs.get(targetDay);
        const deliveredByTracking = await fetchAllTrackings(uniqueTrackings, upsToken, (done, total) => {
            if (job) {
                job.progress = Math.round((done / total) * 100);
                job.processed = done;
                job.total = total;
            }
            jobEvents.emit(`progress:${targetDay}`, { done, total });
            if (progressCallback) progressCallback(done, total);
        });

        log(`UPS data fetch complete. Calculating metrics...`);

        // Group by order
        const byOrder = {};
        shipmentRows.forEach(r => {
            const key = `${r.brandName}||${r.orderNumber}`;
            if (!byOrder[key]) byOrder[key] = [];
            byOrder[key].push(r);
        });

        const results = {
            targetDay,
            windowStart,
            windowEnd,
            brands: []
        };

        for (const brand of BRANDS) {
            const brandOrdersKeys = Object.keys(byOrder).filter(k => k.startsWith(`${brand}||`));
            const orderFulfillmentAverages = [];
            const orderShippingCosts = [];
            const orderShipToDoorAverages = [];
            let ordersWithUpsDelivery = 0;

            brandOrdersKeys.forEach(key => {
                const orderShipments = byOrder[key];
                const fulfillmentVals = [];
                const transitVals = [];
                const trackingSet = new Set();

                orderShipments.forEach(s => {
                    if (s.liveOrderCreatedAt && s.shippedAt >= s.liveOrderCreatedAt) {
                        fulfillmentVals.push((s.shippedAt - s.liveOrderCreatedAt) / (1000 * 60 * 60));
                    }
                    trackingSet.add(s.trackingNumber);
                    
                    const deliveredAt = deliveredByTracking[s.trackingNumber];
                    if (deliveredAt && deliveredAt >= s.shippedAt) {
                        transitVals.push((deliveredAt - s.shippedAt) / (1000 * 60 * 60));
                    }
                });

                if (fulfillmentVals.length > 0) {
                    orderFulfillmentAverages.push(avg(fulfillmentVals));
                }

                let totalCost = 0;
                trackingSet.forEach(tn => {
                    totalCost += costByTracking[tn] || 0;
                });
                orderShippingCosts.push(totalCost);

                if (transitVals.length > 0) {
                    ordersWithUpsDelivery++;
                    orderShipToDoorAverages.push(avg(transitVals));
                }
            });

            const shipToDoor = avg(orderShipToDoorAverages);
            results.brands.push({
                brandName: brand,
                ordersCount: brandOrdersKeys.length,
                ordersWithUpsDelivery,
                avgTimeToFulfillmentHours: parseFloat((avg(orderFulfillmentAverages) || 0).toFixed(2)),
                avgShippingCostPerOrder: parseFloat((avg(orderShippingCosts) || 0).toFixed(2)),
                avgShipToDeliveryHours: shipToDoor !== null ? parseFloat(shipToDoor.toFixed(2)) : null
            });
            log(`Metrics for ${brand}: ${brandOrdersKeys.length} orders processed.`);
        }

        log(`Report generation complete.`);
        return results;

    } catch (error) {
        throw error;
    } finally {
        if (client) client.release();
    }
}

async function getOpsReport(targetDay) {
    // 1. Check memory cache (running or completed)
    if (activeJobs.has(targetDay)) {
        const job = activeJobs.get(targetDay);
        if (job.status === 'running') {
            return {
                status: 'background_process_is_running',
                progress: `${job.progress}%`,
                processed: job.processed,
                total: job.total,
                logs: job.logs,
                message: "The report is currently being generated in the background."
            };
        } else if (job.status === 'completed') {
            return { ...job.result, logs: job.logs };
        } else if (job.status === 'failed') {
            // If it failed, we might want to allow a retry
            activeJobs.delete(targetDay);
        }
    }

    // 2. Check if report exists on disk
    const reportPath = path.join(REPORTS_DIR, `${targetDay}.json`);
    try {
        const data = await fs.readFile(reportPath, 'utf8');
        const result = JSON.parse(data);
        // Cache result in memory for faster subsequent access
        activeJobs.set(targetDay, { status: 'completed', result });
        return result;
    } catch (err) {
        // Continue to start job if not found
    }

    // 3. Start job - Set in activeJobs IMMEDIATELY to prevent race conditions
    const job = {
        status: 'running',
        progress: 0,
        processed: 0,
        total: 0,
        targetDay,
        startTime: new Date(),
        logs: [`Job started at ${new Date().toISOString()}`]
    };
    activeJobs.set(targetDay, job);

    // Run in background
    (async () => {
        try {
            await ensureReportsDir();
            const result = await runOpsLogic(targetDay, (done, total) => {
                job.progress = Math.round((done / total) * 100);
                job.processed = done;
                job.total = total;
            });
            job.status = 'completed';
            job.result = result;
            jobEvents.emit(`completed:${targetDay}`, result);
            
            await fs.writeFile(reportPath, JSON.stringify(result, null, 2));
        } catch (error) {
            logger.error(`Ops job failed for ${targetDay}`, { error: error.message, stack: error.stack });
            job.status = 'failed';
            job.error = error.message;
            jobEvents.emit(`log:${targetDay}`, `Error: ${error.message}`);
        }
    })();

    return {
        status: 'started',
        message: `Report generation for ${targetDay} has started in the background.`
    };
}

module.exports = {
    getOpsReport,
    runOpsLogic,
    jobEvents
};
