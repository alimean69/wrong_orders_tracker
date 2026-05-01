const opsService = require('../services/opsService');
const logger = require('../utils/logger');

class OpsController {
    async getOpsMetrics(req, res, next) {
        try {
            const date = req.query.date || new Date().toISOString().split('T')[0];
            
            // Validate date format
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({
                    error: {
                        code: 'INVALID_DATE',
                        message: 'Invalid date format. Use YYYY-MM-DD.'
                    }
                });
            }

            const result = await opsService.getOpsReport(date);
            res.json(result);
        } catch (error) {
            next(error);
        }
    }

    async streamOpsMetrics(req, res, next) {
        const date = req.query.date || new Date().toISOString().split('T')[0];
        
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Invalid date format' });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const sendEvent = (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const onLog = (message) => sendEvent({ status: 'logging', message });
        const onProgress = (data) => sendEvent({ 
            status: 'running', 
            progress: Math.round((data.done / data.total) * 100),
            processed: data.done,
            total: data.total
        });
        const onCompleted = (result) => {
            sendEvent({ status: 'completed', progress: 100, result });
            res.end();
        };

        opsService.jobEvents.on(`log:${date}`, onLog);
        opsService.jobEvents.on(`progress:${date}`, onProgress);
        opsService.jobEvents.on(`completed:${date}`, onCompleted);

        req.on('close', () => {
            opsService.jobEvents.off(`log:${date}`, onLog);
            opsService.jobEvents.off(`progress:${date}`, onProgress);
            opsService.jobEvents.off(`completed:${date}`, onCompleted);
        });

        try {
            // Trigger or get the report status (this starts the background job if needed)
            const reportStatus = await opsService.getOpsReport(date);
            
            if (reportStatus.targetDay) {
                // Already completed, send result immediately
                sendEvent({ status: 'completed', progress: 100, result: reportStatus });
                res.end();
            } else {
                // Job is running or just started, SSE will receive events from EventEmitter
                sendEvent({ status: 'starting', message: reportStatus.message || 'Connecting to database...' });
                
                // If it's already running, we might have missed the initial logs, 
                // but we'll get everything from now on.
            }
        } catch (error) {
            logger.error(`SSE Ops stream failed for ${date}`, error);
            sendEvent({ status: 'failed', error: error.message });
            res.end();
        }
    }
}

module.exports = new OpsController();
