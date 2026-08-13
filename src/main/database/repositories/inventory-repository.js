const db = require('../db');

const InventoryRepository = {
    // ──────────────────────────────────────────────────────────────
    // Items
    // ──────────────────────────────────────────────────────────────
    getItems: () => {
        return db.prepare(`
            SELECT i.*, c.name as category_name, s.name as supplier_name, l.name as location_name
            FROM inventory_items i
            LEFT JOIN inventory_categories c ON i.category_id = c.id
            LEFT JOIN suppliers s ON i.supplier_id = s.id
            LEFT JOIN inventory_locations l ON i.storage_location_id = l.id
            WHERE i.status != 'Deleted'
            ORDER BY i.name
        `).all();
    },
    getItemById: (id) => {
        return db.prepare(`
            SELECT i.*, c.name as category_name, s.name as supplier_name, l.name as location_name
            FROM inventory_items i
            LEFT JOIN inventory_categories c ON i.category_id = c.id
            LEFT JOIN suppliers s ON i.supplier_id = s.id
            LEFT JOIN inventory_locations l ON i.storage_location_id = l.id
            WHERE i.id = ? AND i.status != 'Deleted'
        `).get(id);
    },
    getItemByIdRaw: (id) => {
        // Includes deleted items for recovery/compatibility
        return db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
    },
    createItem: (data) => {
        const stmt = db.prepare(`
            INSERT INTO inventory_items (
                sku, barcode, name, category_id, brand, supplier_id, description, unit,
                opening_stock, current_stock, reserved_stock, minimum_stock, maximum_stock, reorder_level,
                purchase_price, selling_price, average_cost, last_purchase_price, storage_location_id,
                expiry_date, notes, status, size, gsm, finish, color_type, sheets_per_ream
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const res = stmt.run(
            data.sku, data.barcode, data.name, data.category_id, data.brand, data.supplier_id,
            data.description, data.unit, data.opening_stock, data.current_stock, data.minimum_stock,
            data.maximum_stock, data.reorder_level, data.purchase_price, data.selling_price,
            data.average_cost, data.last_purchase_price, data.storage_location_id, data.expiry_date,
            data.notes, data.status || 'Active', data.size, data.gsm, data.finish, data.color_type, data.sheets_per_ream
        );
        return res.lastInsertRowid;
    },
    updateItemStock: (itemId, newStock) => {
        db.prepare('UPDATE inventory_items SET current_stock = ? WHERE id = ?').run(newStock, itemId);
    },
    updateItemReservation: (itemId, newReserved) => {
        db.prepare('UPDATE inventory_items SET reserved_stock = ? WHERE id = ?').run(newReserved, itemId);
    },
    updateItemAverageCost: (itemId, avgCost, lastPrice) => {
        db.prepare(`
            UPDATE inventory_items
            SET average_cost = ?, last_purchase_price = ?, last_purchase_date = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(avgCost, lastPrice, itemId);
    },
    softDeleteItem: (id) => {
        db.prepare("UPDATE inventory_items SET status = 'Deleted' WHERE id = ?").run(id);
    },

    // ──────────────────────────────────────────────────────────────
    // Location Stock Levels
    // ──────────────────────────────────────────────────────────────
    ensureLocationStockRecord: (itemId, locationId) => {
        db.prepare(`
            INSERT OR IGNORE INTO inventory_location_stock (item_id, location_id, current_stock, reserved_stock)
            VALUES (?, ?, 0, 0)
        `).run(itemId, locationId);
    },
    getLocationStock: (itemId, locationId) => {
        InventoryRepository.ensureLocationStockRecord(itemId, locationId);
        return db.prepare('SELECT * FROM inventory_location_stock WHERE item_id = ? AND location_id = ?').get(itemId, locationId);
    },
    updateLocationStock: (itemId, locationId, newStock) => {
        InventoryRepository.ensureLocationStockRecord(itemId, locationId);
        db.prepare('UPDATE inventory_location_stock SET current_stock = ? WHERE item_id = ? AND location_id = ?')
          .run(newStock, itemId, locationId);
    },
    updateLocationReservation: (itemId, locationId, newReserved) => {
        InventoryRepository.ensureLocationStockRecord(itemId, locationId);
        db.prepare('UPDATE inventory_location_stock SET reserved_stock = ? WHERE item_id = ? AND location_id = ?')
          .run(newReserved, itemId, locationId);
    },

    // ──────────────────────────────────────────────────────────────
    // Transactions
    // ──────────────────────────────────────────────────────────────
    addTransaction: (itemId, type, qty, cost, refType = null, refId = null, reason = '', operator = 'System', role = 'System') => {
        const stmt = db.prepare(`
            INSERT INTO stock_transactions (item_id, type, qty, cost, reference_type, reference_id, reason, operator)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(itemId, type, qty, cost, refType, refId, reason, `${operator} (${role})`);
    },
    getTransactions: (itemId = null, limit = 200) => {
        if (itemId) {
            return db.prepare(`
                SELECT t.*, i.name as item_name, i.sku
                FROM stock_transactions t
                JOIN inventory_items i ON t.item_id = i.id
                WHERE t.item_id = ?
                ORDER BY t.created_at DESC
                LIMIT ?
            `).all(itemId, limit);
        }
        return db.prepare(`
            SELECT t.*, i.name as item_name, i.sku
            FROM stock_transactions t
            JOIN inventory_items i ON t.item_id = i.id
            ORDER BY t.created_at DESC
            LIMIT ?
        `).all(limit);
    },

    // ──────────────────────────────────────────────────────────────
    // Soft Delete-supported CRUD for Aux Tables
    // ──────────────────────────────────────────────────────────────
    getCategories: () => {
        return db.prepare("SELECT * FROM inventory_categories WHERE name != 'Deleted' ORDER BY name").all();
    },
    getSuppliers: () => {
        return db.prepare("SELECT * FROM suppliers WHERE name != 'Deleted' ORDER BY name").all();
    },
    getLocations: () => {
        return db.prepare("SELECT * FROM inventory_locations WHERE name != 'Deleted' ORDER BY name").all();
    }
};

module.exports = InventoryRepository;
