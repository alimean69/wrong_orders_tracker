const express = require('express');
const opsController = require('../controllers/opsController');
const router = express.Router();

router.get('/', (req, res, next) => opsController.getOpsMetrics(req, res, next));
router.get('/stream', (req, res, next) => opsController.streamOpsMetrics(req, res, next));

module.exports = router;
