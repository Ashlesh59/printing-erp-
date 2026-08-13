const db = require('../db');

const NotificationRepository = {
    getNotifications: (unreadOnly = true) => {
        if (unreadOnly) {
            return db.prepare(`SELECT * FROM notifications WHERE status = 'Unread' ORDER BY priority DESC, created_at DESC`).all();
        }
        return db.prepare(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100`).all();
    },
    createNotification: (type, message, refId = null, priority = 'Medium', expiryDate = null) => {
        const stmt = db.prepare(`
            INSERT INTO notifications (type, message, reference_id, status, priority, expiry_date)
            VALUES (?, ?, ?, 'Unread', ?, ?)
        `);
        const res = stmt.run(type, message, refId, priority, expiryDate);
        return res.lastInsertRowid;
    },
    markRead: (id) => {
        db.prepare(`UPDATE notifications SET status = 'Read' WHERE id = ?`).run(id);
    },
    dismissAll: () => {
        db.prepare(`UPDATE notifications SET status = 'Dismissed' WHERE status = 'Unread'`).run();
    }
};

module.exports = NotificationRepository;
