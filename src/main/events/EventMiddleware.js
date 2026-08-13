/**
 * Schema Validation Middleware
 */
const ValidationMiddleware = (event, next) => {
    const required = ['eventId', 'eventName', 'timestamp', 'sourceModule', 'version', 'payload'];
    for (const field of required) {
        if (event[field] === undefined || event[field] === null) {
            throw new Error(`Validation Error: Event envelope missing required field "${field}"`);
        }
    }
    next();
};

/**
 * Basic Logging Middleware
 */
const LoggingMiddleware = (event, next) => {
    console.log(`[EventBus] Publishing event "${event.eventName}" (ID: ${event.eventId}) from module: "${event.sourceModule}"`);
    try {
        next();
        console.log(`[EventBus] Successfully dispatched event "${event.eventName}" (ID: ${event.eventId})`);
    } catch (err) {
        console.error(`[EventBus] Failed to dispatch event "${event.eventName}" (ID: ${event.eventId}). Error:`, err);
        throw err; // Re-throw to propagate failure (essential for critical transaction rollbacks)
    }
};

/**
 * Performance timing tracking middleware
 */
const PerformanceMiddleware = (event, next) => {
    const start = Date.now();
    next();
    const duration = Date.now() - start;
    console.log(`[EventBus Perf] Event "${event.eventName}" processed in ${duration}ms`);
};

/**
 * Debug Payload Logger Middleware generator
 * @param {boolean} isDebug - active status flag
 */
const DebugMiddleware = (isDebug = false) => {
    return (event, next) => {
        if (isDebug) {
            console.log(`[EventBus DEBUG] Event payload for "${event.eventName}":`, JSON.stringify(event.payload, null, 2));
        }
        next();
    };
};

/**
 * Authorization and Security Permission Hook Middleware
 */
const PermissionHooksMiddleware = (event, next) => {
    // Placeholder for future authentication/permission validations
    next();
};

module.exports = {
    ValidationMiddleware,
    LoggingMiddleware,
    PerformanceMiddleware,
    DebugMiddleware,
    PermissionHooksMiddleware
};
