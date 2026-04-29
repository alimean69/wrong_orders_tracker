const reportService = require('../services/reportService');
const logger = require('../utils/logger');

class ReportController {
    async getDailyReport(req, res, next) {
        try {
            const db = req.params.db || req.query.db || 'crmdb';
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

            logger.info('Starting manual daily report generation', { date, db });
            const report = await reportService.runDailyReport(date, db);
            res.json({ data: report });
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
