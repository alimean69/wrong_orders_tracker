require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const reportRoutes = require('./src/routes/reportRoutes');
const logger = require('./src/utils/logger');
const authMiddleware = require('./src/middleware/authMiddleware');


const app = express();
const PORT = process.env.PORT || 3001;

// Serve static files from the 'public' directory
app.use(express.static('public'));

// SEC-07: Security headers
app.use(helmet());

// SEC-06: CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

app.use(express.json());

// Request logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        logger.info(`${req.method} ${req.url} ${res.statusCode}`, {
            durationMs: Date.now() - start,
            ip: req.ip,
            userAgent: req.get('user-agent')
        });
    });
    next();
});

// OPS-02: Health + Readiness Endpoints
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/ready', async (req, res) => {
    // Basic check for MongoDB connectivity if needed
    res.status(200).json({ status: 'ready' });
});

// API Routes - Protected by authMiddleware
app.use('/api', authMiddleware);
app.use('/api/reports', reportRoutes);


// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: {
            code: 'NOT_FOUND',
            message: `Route ${req.method} ${req.url} not found`,
            traceId: req.headers['x-request-id'] || 'N/A'
        }
    });
});

// API-01: Consistent Error Schema
app.use((err, req, res, next) => {
    logger.error('Unhandled Error', err, { url: req.url });
    
    const status = err.status || 500;
    const code = err.code || 'INTERNAL_SERVER_ERROR';
    const message = err.message || 'An unexpected error occurred';

    res.status(status).json({
        error: {
            code,
            message,
            traceId: req.headers['x-request-id'] || 'N/A'
        }
    });
});

const server = app.listen(PORT, () => {
    logger.info(`Server started on port ${PORT}`);
});

// OPS-03: Graceful Shutdown
const shutdown = (signal) => {
    logger.info(`${signal} received. Starting graceful shutdown.`);
    server.close(() => {
        logger.info('Process terminated.');
        process.exit(0);
    });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', err);
    process.exit(1);
});
