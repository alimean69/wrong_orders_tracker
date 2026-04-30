const reportService = require('../services/reportService');
const logger = require('../utils/logger');

// SEC-05: Rate limiting and job tracking for long-running reports
const jobs = new Map();

class ReportController {
    async getDailyReport(req, res, next) {
        try {
            const db = req.params.db || req.query.db || 'crmdb';
            const jobId = `${db}-latest`;
            
            // Check if there is an active job for this DB
            const activeJob = jobs.get(jobId);
            if (activeJob && activeJob.status === 'processing') {
                return res.json({ 
                    status: 'processing',
                    message: 'A report is currently being generated in the background.',
                    startedAt: activeJob.startedAt,
                    db
                });
            }

            const report = await reportService.getDailyReport(db);
            res.json({ data: report });
        } catch (err) {
            next(err);
        }
    }


    async runDailyReport(req, res, next) {
        try {
            const { date } = req.body;
            const { db } = req.params;
            const jobId = `${db}-${date || 'latest'}`;

            // SEC-01: Validate input
            if (date && isNaN(Date.parse(date))) {
                return res.status(400).json({
                    error: {
                        code: 'INVALID_INPUT',
                        message: 'Invalid date format. Use YYYY-MM-DD',
                        traceId: req.headers['x-request-id'] || 'N/A'
                    }
                });
            }

            // Check if job is already running to prevent duplicate work
            if (jobs.has(jobId) && jobs.get(jobId).status === 'processing') {
                return res.status(200).json({
                    message: 'Report generation is already in progress.',
                    status: 'processing',
                    jobId
                });
            }

            logger.info('Starting background daily report generation', { date, db });
            
            // Set job status to processing
            jobs.set(jobId, { status: 'processing', startedAt: new Date() });

            // Start processing but do NOT 'await' it to allow immediate response
            reportService.runDailyReport(date, db)
                .then(report => {
                    jobs.set(jobId, { status: 'completed', finishedAt: new Date(), data: report });
                    logger.info(`Background report ${jobId} finished successfully`);
                })
                .catch(err => {
                    jobs.set(jobId, { status: 'failed', error: err.message, failedAt: new Date() });
                    logger.error(`Background report ${jobId} failed`, err);
                });

            // Return immediately with 202 Accepted
            res.status(202).json({
                message: 'Report generation started in the background.',
                status: 'processing',
                jobId,
                checkStatusAt: `/api/reports/${db}/daily`
            });

        } catch (err) {
            next(err);
        }
    }


    async getWrongOrders(req, res, next) {
        try {
            const db = req.params.db || req.query.db || 'crmdb';
            const orders = await reportService.getWrongOrders(db);
            res.json({ data: orders });
        } catch (err) {
            next(err);
        }
    }


    async getFlaggedOrders(req, res, next) {
        try {
            const db = req.params.db || req.query.db || 'crmdb';
            const orders = await reportService.getFlaggedOrders(db);
            res.json({ data: orders });
        } catch (err) {
            next(err);
        }
    }

}

module.exports = new ReportController();
