const db = require('../db');
const os = require('os');

const EventRepository = {
    logEvent: (eventType, aggregateId, data, operator = 'System', role = 'System', reason = '', deviceName = null) => {
        try {
            const device = deviceName || os.hostname();
            const payload = JSON.stringify(data);
            const stmt = db.prepare(`
                INSERT INTO inventory_events (event_type, aggregate_id, event_data, operator, operator_role, device, reason, ip)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(eventType, String(aggregateId), payload, operator, role, device, reason, '127.0.0.1');
        } catch (e) {
            console.error("Failed to log inventory event:", e);
        }
    },
    getEvents: (limit = 100) => {
        return db.prepare(`SELECT * FROM inventory_events ORDER BY created_at DESC LIMIT ?`).all(limit);
    },
    getEventsByAggregate: (aggregateId) => {
        return db.prepare(`SELECT * FROM inventory_events WHERE aggregate_id = ? ORDER BY created_at ASC`).all(String(aggregateId));
    }
};

module.exports = EventRepository;
