const logger = {
    info: (message, context = {}) => {
        console.log(JSON.stringify({
            level: 'info',
            timestamp: new Date().toISOString(),
            message,
            ...context
        }));
    },
    error: (message, error = {}, context = {}) => {
        console.error(JSON.stringify({
            level: 'error',
            timestamp: new Date().toISOString(),
            message,
            error: error.message || error,
            stack: error.stack,
            ...context
        }));
    },
    warn: (message, context = {}) => {
        console.warn(JSON.stringify({
            level: 'warn',
            timestamp: new Date().toISOString(),
            message,
            ...context
        }));
    }
};

module.exports = logger;
