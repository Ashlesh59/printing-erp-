const crypto = require('crypto');
const os = require('os');
const { EventTypes, CriticalEvents } = require('./EventTypes');

class EventBus {
    constructor() {
        this.subscribers = {};
        this.middlewares = [];
    }

    /**
     * Register a middleware function in the publishing pipeline.
     * @param {Function} middleware - function of form (event, next)
     */
    use(middleware) {
        this.middlewares.push(middleware);
    }

    /**
     * Subscribe to a namespaced event.
     * @param {string} eventName - Registered event name
     * @param {Function} callback - Callback function
     */
    subscribe(eventName, callback) {
        if (!Object.values(EventTypes).includes(eventName)) {
            throw new Error(`Cannot subscribe to unregistered event: ${eventName}`);
        }
        if (!this.subscribers[eventName]) {
            this.subscribers[eventName] = [];
        }
        this.subscribers[eventName].push(callback);
        console.log(`[EventBus] Subscriber registered for event: ${eventName}`);
    }

    /**
     * Publish a namespaced event.
     * @param {string} eventName - Registered event name
     * @param {Object} payload - Event payload data
     * @param {Object} [meta] - Optional overrides (sourceModule, userId, deviceId, version)
     */
    publish(eventName, payload, meta = {}) {
        if (!Object.values(EventTypes).includes(eventName)) {
            throw new Error(`Cannot publish unregistered event: ${eventName}`);
        }

        // Standardize event structure
        const event = {
            eventId: crypto.randomUUID(),
            eventName,
            timestamp: new Date().toISOString(),
            sourceModule: meta.sourceModule || 'System',
            userId: meta.userId || null,
            deviceId: meta.deviceId || os.hostname(),
            version: meta.version || '1.0',
            payload
        };

        // Delay requires to avoid circular dependency issues
        const EventMetrics = require('./EventMetrics');
        const EventHistory = require('./EventHistory');

        // Record metrics: published count
        EventMetrics.incrementPublished(eventName);

        try {
            // Execute middlewares sequentially (synchronously)
            this.runMiddlewaresSync(event);

            // Record to Event History (which persists critical events to DB)
            EventHistory.record(event);

            const isCritical = CriticalEvents.has(eventName);
            const subscribers = this.subscribers[eventName] || [];

            if (isCritical) {
                // Critical Event: Execute subscribers synchronously inside current thread/transaction
                for (const sub of subscribers) {
                    const start = Date.now();
                    try {
                        sub(event);
                        EventMetrics.recordProcessed(eventName, Date.now() - start);
                    } catch (err) {
                        EventMetrics.recordFailed(eventName);
                        console.error(`[EventBus] Critical subscriber failed for event ${eventName}. Transaction aborting:`, err);
                        throw err; // Re-throw to abort SQLite transaction
                    }
                }
            } else {
                // Non-Critical Event: Execute subscribers asynchronously to not block
                setImmediate(() => {
                    for (const sub of subscribers) {
                        const start = Date.now();
                        try {
                            sub(event);
                            EventMetrics.recordProcessed(eventName, Date.now() - start);
                        } catch (err) {
                            EventMetrics.recordFailed(eventName);
                            console.error(`[EventBus] Non-critical async subscriber failed for event ${eventName}:`, err);
                        }
                    }
                });
            }
        } catch (err) {
            console.error(`[EventBus] Publish flow failed for ${eventName}:`, err);
            throw err;
        }
    }

    /**
     * Run middleware chain synchronously
     */
    runMiddlewaresSync(event) {
        let index = 0;
        const next = () => {
            if (index < this.middlewares.length) {
                const middleware = this.middlewares[index++];
                middleware(event, next);
            }
        };
        next();
    }
}

// Single central instance
const eventBus = new EventBus();
module.exports = eventBus;
