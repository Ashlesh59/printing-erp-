class EventMetrics {
    constructor() {
        this.metrics = {};
    }

    /**
     * Get or initialize metrics structure for an event namespace
     * @param {string} eventName
     */
    getMetrics(eventName) {
        if (!this.metrics[eventName]) {
            this.metrics[eventName] = {
                publishedCount: 0,
                processedCount: 0,
                failedCount: 0,
                totalProcessingTimeMs: 0,
                queueLength: 0,
                retryCount: 0
            };
        }
        return this.metrics[eventName];
    }

    incrementPublished(eventName) {
        const m = this.getMetrics(eventName);
        m.publishedCount++;
        m.queueLength++; // added to virtual queue before subscriber dispatch
    }

    recordProcessed(eventName, durationMs) {
        const m = this.getMetrics(eventName);
        m.processedCount++;
        m.totalProcessingTimeMs += durationMs;
        m.queueLength = Math.max(0, m.queueLength - 1);
    }

    recordFailed(eventName) {
        const m = this.getMetrics(eventName);
        m.failedCount++;
        m.queueLength = Math.max(0, m.queueLength - 1);
    }

    incrementRetry(eventName) {
        const m = this.getMetrics(eventName);
        m.retryCount++;
    }

    /**
     * Return summary of all monitored metrics including calculated averages.
     */
    getAllMetrics() {
        const report = {};
        for (const [eventName, m] of Object.entries(this.metrics)) {
            report[eventName] = {
                ...m,
                averageProcessingTimeMs: m.processedCount > 0 
                    ? parseFloat((m.totalProcessingTimeMs / m.processedCount).toFixed(2)) 
                    : 0
            };
        }
        return report;
    }

    /**
     * Clear statistics
     */
    reset() {
        this.metrics = {};
    }
}

const eventMetrics = new EventMetrics();
module.exports = eventMetrics;
