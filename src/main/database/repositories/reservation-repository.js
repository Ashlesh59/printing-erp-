const db = require('../db');

const ReservationRepository = {
    getReservationsByOrder: (orderId) => {
        return db.prepare(`
            SELECT r.*, i.name as item_name, i.sku, l.name as location_name
            FROM inventory_reservations r
            JOIN inventory_items i ON r.item_id = i.id
            JOIN inventory_locations l ON r.location_id = l.id
            WHERE r.order_id = ?
        `).all(orderId);
    },
    getActiveReservations: () => {
        return db.prepare(`
            SELECT r.*, i.name as item_name, i.sku, l.name as location_name
            FROM inventory_reservations r
            JOIN inventory_items i ON r.item_id = i.id
            JOIN inventory_locations l ON r.location_id = l.id
            WHERE r.status = 'Active'
        `).all();
    },
    createReservation: (orderId, itemId, locationId, qty) => {
        const stmt = db.prepare(`
            INSERT INTO inventory_reservations (order_id, item_id, location_id, qty_reserved, status)
            VALUES (?, ?, ?, ?, 'Active')
        `);
        const res = stmt.run(orderId, itemId, locationId, qty);
        return res.lastInsertRowid;
    },
    updateReservationStatus: (orderId, status) => {
        db.prepare(`
            UPDATE inventory_reservations
            SET status = ?
            WHERE order_id = ?
        `).run(status, orderId);
    },
    deleteReservationsByOrder: (orderId) => {
        db.prepare('DELETE FROM inventory_reservations WHERE order_id = ?').run(orderId);
    }
};

module.exports = ReservationRepository;
