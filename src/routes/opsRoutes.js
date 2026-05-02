const express = require('express');
const opsController = require('../controllers/opsController');
const router = express.Router();

router.get('/', (req, res, next) => opsController.getOpsReport(req, res, next));
router.post('/run', (req, res, next) => opsController.runOpsReport(req, res, next));

module.exports = router;
