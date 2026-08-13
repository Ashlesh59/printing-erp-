const db = require('../db');
const InventoryRepository = require('../repositories/inventory-repository');
const EventRepository = require('../repositories/event-repository');
const InventoryService = require('./inventory-service');

const CountService = {
    createCount: (data, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const itemId = parseInt(data.item_id);
            const locationId = parseInt(data.location_id) || 1;
            const actualCount = parseFloat(data.actual_count);

            const locStock = InventoryRepository.getLocationStock(itemId, locationId);
            const systemStock = locStock.current_stock;
            const difference = actualCount - systemStock;

            const stmt = db.prepare(`
                INSERT INTO physical_stock_counts (item_id, location_id, system_stock, actual_count, difference, operator, reason, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')
            `);
            const res = stmt.run(itemId, locationId, systemStock, actualCount, difference, operator, data.reason || '');
            const countId = res.lastInsertRowid;

            EventRepository.logEvent('PhysicalCountCreated', countId, { itemId, locationId, systemStock, actualCount, difference }, operator, role, data.reason);
            return countId;
        });
        return transaction();
    },
    approveCount: (countId, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const count = db.prepare('SELECT * FROM physical_stock_counts WHERE id = ?').get(countId);
            if (!count) throw new Error("Stock count record not found");
            if (count.status !== 'Pending') throw new Error("Stock count already resolved");

            // Update DB count record status to Approved
            db.prepare("UPDATE physical_stock_counts SET status = 'Approved' WHERE id = ?").run(countId);

            // Fetch current stock values
            const locStock = InventoryRepository.getLocationStock(count.item_id, count.location_id);
            const item = InventoryRepository.getItemByIdRaw(count.item_id);

            // Re-calculate difference to handle intermediate stock movements
            const currentSystem = locStock.current_stock;
            const finalDifference = count.actual_count - currentSystem;

            // Commit adjustment
            if (finalDifference !== 0) {
                const adjType = finalDifference > 0 ? 'manual_in' : 'manual_out';
                
                InventoryRepository.updateLocationStock(count.item_id, count.location_id, count.actual_count);
                InventoryRepository.updateItemStock(count.item_id, item.current_stock + finalDifference);

                InventoryRepository.addTransaction(
                    count.item_id, adjType, finalDifference, item.average_cost,
                    'stocktake', countId, `Stocktake Correction - Count Session #${countId}`, operator, role
                );

                InventoryService.checkStockAlerts(count.item_id);
            }

            EventRepository.logEvent('PhysicalCountApproved', countId, { countId, finalDifference }, operator, role, 'Approved stocktake correction');
            return { success: true };
        });
        return transaction();
    },
    getStockCounts: () => {
        return db.prepare(`
            SELECT c.*, i.name as item_name, i.sku, l.name as location_name
            FROM physical_stock_counts c
            JOIN inventory_items i ON c.item_id = i.id
            JOIN inventory_locations l ON c.location_id = l.id
            ORDER BY c.created_at DESC
        `).all();
    }
};

module.exports = CountService;
