const express = require('express');
const reportController = require('../controllers/reportController');
const router = express.Router();

router.get('/:db/daily', (req, res, next) => reportController.getDailyReport(req, res, next));
router.post('/:db/run', (req, res, next) => reportController.runDailyReport(req, res, next));
router.get('/:db/wrong-orders', (req, res, next) => reportController.getWrongOrders(req, res, next));
router.get('/:db/flagged-orders', (req, res, next) => reportController.getFlaggedOrders(req, res, next));



module.exports = router;
