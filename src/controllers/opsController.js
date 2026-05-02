const opsService = require('../services/opsService');
const logger = require('../utils/logger');

class OpsController {
    async getOpsReport(req, res, next) {
        try {
            const date = req.query.date || new Date().toISOString().split('T')[0];
            const force = req.query.force === 'true';

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

            // If the service says it started or is running, return 202/status
            if (result.status === 'started' || result.status === 'background_process_is_running') {
                return res.status(202).json({
                    message: result.message || 'Report generation is in progress.',
                    status: 'processing',
                    jobId: date,
                    progress: result.progress,
                    processed: result.processed,
                    total: result.total,
                    checkStatusAt: `/api/ops?date=${date}`
                });
            }

            // Otherwise return the completed result
            res.json({
                status: 'completed',
                data: result
            });
        } catch (error) {
            next(error);
        }
    }

    async runOpsReport(req, res, next) {
        try {
            const date = req.body.date || new Date().toISOString().split('T')[0];
            const force = req.query.force === 'true';

            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({
                    error: {
                        code: 'INVALID_DATE',
                        message: 'Invalid date format. Use YYYY-MM-DD.'
                    }
                });
            }

            // In our service, getOpsReport already triggers if not exists
            // We might want to clear cache if force is true
            if (force) {
                // We'd need to expose a way to delete from activeJobs or delete the file
                // For now, let's just call getOpsReport
            }

            const result = await opsService.getOpsReport(date);
            
            res.status(202).json({
                message: 'Report generation started or already in progress.',
                status: 'processing',
                jobId: date,
                checkStatusAt: `/api/ops?date=${date}`
            });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = new OpsController();
