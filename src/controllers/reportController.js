const reportService = require('../services/reportService');
const logger = require('../utils/logger');

// SEC-05 & MEM-03: Job tracking with automatic 30-day cleanup
const jobs = new Map();

// Periodic cleanup: Runs every 24 hours to delete jobs older than 30 days
setInterval(() => {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let deletedCount = 0;

    for (const [jobId, job] of jobs.entries()) {
        const jobTime = job.finishedAt || job.failedAt || job.startedAt;
        if (jobTime && new Date(jobTime).getTime() < thirtyDaysAgo) {
            jobs.delete(jobId);
            deletedCount++;
        }
    }
    
    if (deletedCount > 0) {
        logger.info(`Cleanup: Removed ${deletedCount} old job logs from memory.`);
    }
}, 24 * 60 * 60 * 1000); 

class ReportController {
    async getDailyReport(req, res, next) {
        try {
            const db = req.params.db || req.query.db || 'crmdb';
            const jobId = req.query.jobId;
            
            // If a specific jobId is provided, return its status and logs
            if (jobId && jobs.has(jobId)) {
                const job = jobs.get(jobId);
                return res.json({
                    jobId,
                    status: job.status,
                    startedAt: job.startedAt,
                    finishedAt: job.finishedAt,
                    failedAt: job.failedAt,
                    error: job.error,
                    logs: job.logs,
                    data: job.data
                });
            }

            // Fallback for compatibility or checking current active job
            const latestJobId = `${db}-latest`;
            const activeJob = jobs.get(latestJobId);
            if (activeJob && activeJob.status === 'processing') {
                return res.json({ 
                    status: 'processing',
                    message: 'A report is currently being generated in the background.',
                    startedAt: activeJob.startedAt,
                    db,
                    logs: activeJob.logs
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
            if (jobs.has(jobId)) {
                const existingJob = jobs.get(jobId);
                
                if (existingJob.status === 'processing') {
                    return res.status(200).json({
                        message: 'Report generation is already in progress.',
                        status: 'processing',
                        jobId,
                        checkStatusAt: `/api/reports/${db}/daily?jobId=${jobId}`
                    });
                }

                if (existingJob.status === 'completed') {
                    return res.status(200).json({
                        message: 'Report for this date has already been generated.',
                        status: 'completed',
                        jobId,
                        data: existingJob.data,
                        logs: existingJob.logs
                    });
                }
            }

            logger.info('Starting background daily report generation', { date, db });
            
            // Set job status to processing with an empty logs array
            const jobState = { 
                status: 'processing', 
                startedAt: new Date(),
                logs: [`Job started at ${new Date().toISOString()}`]
            };
            jobs.set(jobId, jobState);

            // Define log function for this job
            const jobLogger = (msg) => {
                const timestampedMsg = `[${new Date().toISOString()}] ${msg}`;
                jobState.logs.push(timestampedMsg);
            };

            // Start processing but do NOT 'await' it to allow immediate response
            reportService.runDailyReport(date, db, jobLogger)
                .then(report => {
                    jobState.status = 'completed';
                    jobState.finishedAt = new Date();
                    jobState.data = report;
                    jobState.logs.push(`Job completed successfully at ${new Date().toISOString()}`);
                    logger.info(`Background report ${jobId} finished successfully`);
                })
                .catch(err => {
                    jobState.status = 'failed';
                    jobState.error = err.message;
                    jobState.failedAt = new Date();
                    jobState.logs.push(`Job failed at ${new Date().toISOString()}: ${err.message}`);
                    logger.error(`Background report ${jobId} failed`, err);
                });

            // Return immediately with 202 Accepted
            res.status(202).json({
                message: 'Report generation started in the background.',
                status: 'processing',
                jobId,
                checkStatusAt: `/api/reports/${db}/daily?jobId=${jobId}`
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
