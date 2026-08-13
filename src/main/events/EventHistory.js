const db = require('../database/db');
const { CriticalEvents } = require('./EventTypes');

class EventHistory {
    /**
     * @param {number} maxInMemory - Maximum size of the circular in-memory log buffer
     */
    constructor(maxInMemory = 100) {
        this.inMemoryHistory = [];
        this.maxInMemory = maxInMemory;
    }

    /**
     * Append event details to history logs.
     * @param {Object} event - Standard event envelope
     */
    record(event) {
        // 1. Maintain sliding in-memory list
        this.inMemoryHistory.unshift(event);
        if (this.inMemoryHistory.length > this.maxInMemory) {
            this.inMemoryHistory.pop();
        }

        // 2. Selectively persist important (critical/audited) events to SQLite
        if (CriticalEvents.has(event.eventName)) {
            this.persistToDb(event);
        }
    }

    /**
     * Write event to database history log table.
     * @param {Object} event - Standard event envelope
     */
    persistToDb(event) {
        try {
            const stmt = db.prepare(`
                INSERT INTO event_history (id, event_name, timestamp, source_module, user_id, device_id, version, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                event.eventId,
                event.eventName,
                event.timestamp,
                event.sourceModule,
                event.userId,
                event.deviceId,
                event.version,
                JSON.stringify(event.payload)
            );
        } catch (err) {
            console.error(`[EventHistory] Error writing event "${event.eventId}" to database:`, err);
        }
    }

    /**
     * Retrieve rolling in-memory events list.
     */
    getInMemoryHistory() {
        return this.inMemoryHistory;
    }

    /**
     * Fetch persistent events from SQLite database.
     * @param {number} [limit=100] - Limit output count
     */
    getDbHistory(limit = 100) {
        try {
            return db.prepare('SELECT * FROM event_history ORDER BY timestamp DESC LIMIT ?').all(limit);
        } catch (err) {
            console.error('[EventHistory] Error querying events from SQLite:', err);
            return [];
        }
    }
}

const eventHistory = new EventHistory();
module.exports = eventHistory;
