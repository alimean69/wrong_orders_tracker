const logger = require('../utils/logger');

/**
 * Middleware to validate Bearer Token authentication.
 * Checks for Authorization: Bearer <token> in headers.
 */
const authMiddleware = (req, res, next) => {
    let token = null;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        logger.warn(`Unauthorized access attempt: No token found`, { 
            url: req.url, 
            ip: req.ip,
            hasAuthHeader: !!authHeader,
            hasQueryToken: !!req.query.token,
            queryParams: Object.keys(req.query)
        });
        return res.status(401).json({
            error: {
                code: 'UNAUTHORIZED',
                message: 'Authentication required. Please provide a Bearer token.',
                traceId: req.headers['x-request-id'] || 'N/A'
            }
        });
    }

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
