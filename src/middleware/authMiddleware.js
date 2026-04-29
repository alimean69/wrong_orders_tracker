const logger = require('../utils/logger');

/**
 * Middleware to validate Bearer Token authentication.
 * Checks for Authorization: Bearer <token> in headers.
 */
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logger.warn(`Unauthorized access attempt: No Bearer token provided`, { 
            url: req.url, 
            ip: req.ip 
        });
        return res.status(401).json({
            error: {
                code: 'UNAUTHORIZED',
                message: 'Authentication required. Please provide a Bearer token.',
                traceId: req.headers['x-request-id'] || 'N/A'
            }
        });
    }

    const token = authHeader.split(' ')[1];
    const validToken = process.env.API_AUTH_TOKEN;

    if (!validToken) {
        logger.error('API_AUTH_TOKEN is not defined in environment variables');
        return res.status(500).json({
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Server configuration error.',
                traceId: req.headers['x-request-id'] || 'N/A'
            }
        });
    }

    if (token !== validToken) {
        logger.warn(`Unauthorized access attempt: Invalid token`, { 
            url: req.url, 
            ip: req.ip 
        });
        return res.status(403).json({
            error: {
                code: 'FORBIDDEN',
                message: 'Invalid or expired token.',
                traceId: req.headers['x-request-id'] || 'N/A'
            }
        });
    }

    // Token is valid
    next();
};

module.exports = authMiddleware;
