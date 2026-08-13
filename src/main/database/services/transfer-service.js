const db = require('../db');
const InventoryRepository = require('../repositories/inventory-repository');
const EventRepository = require('../repositories/event-repository');

const TransferService = {
    transferStock: (data, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const itemId = parseInt(data.item_id);
            const fromLocId = parseInt(data.from_location_id);
            const toLocId = parseInt(data.to_location_id);
            const qty = parseFloat(data.qty);

            if (isNaN(qty) || qty <= 0) throw new Error("Invalid transfer quantity");
            if (fromLocId === toLocId) throw new Error("Source and target locations must be different");

            const fromStock = InventoryRepository.getLocationStock(itemId, fromLocId);
            const toStock = InventoryRepository.getLocationStock(itemId, toLocId);
            const item = InventoryRepository.getItemByIdRaw(itemId);

            if (fromStock.current_stock < qty) {
                throw new Error(`Insufficient stock in source location. Available: ${fromStock.current_stock}`);
            }

            // Perform transfer
            InventoryRepository.updateLocationStock(itemId, fromLocId, fromStock.current_stock - qty);
            InventoryRepository.updateLocationStock(itemId, toLocId, toStock.current_stock + qty);

            // Log Transaction history
            const stmt = db.prepare(`
                INSERT INTO warehouse_transfers (item_id, from_location_id, to_location_id, qty, operator, reason)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            const res = stmt.run(itemId, fromLocId, toLocId, qty, operator, data.reason || '');
            const transferId = res.lastInsertRowid;

            // Log stock movement audit transaction
            InventoryRepository.addTransaction(
                itemId, 'internal', -qty, item.average_cost,
                'transfer', transferId, `Transferred out to Location #${toLocId}`, operator, role
            );
            InventoryRepository.addTransaction(
                itemId, 'internal', qty, item.average_cost,
                'transfer', transferId, `Transferred in from Location #${fromLocId}`, operator, role
            );

            // Log event
            EventRepository.logEvent('TransferCompleted', transferId, { itemId, fromLocId, toLocId, qty }, operator, role, data.reason);

            return { success: true, transfer_id: transferId };
        });
        return transaction();
    },
    getTransfers: () => {
        return db.prepare(`
            SELECT t.*, i.name as item_name, i.sku, l1.name as from_location_name, l2.name as to_location_name
            FROM warehouse_transfers t
            JOIN inventory_items i ON t.item_id = i.id
            JOIN inventory_locations l1 ON t.from_location_id = l1.id
            JOIN inventory_locations l2 ON t.to_location_id = l2.id
            ORDER BY t.created_at DESC
        `).all();
    }
};

module.exports = TransferService;
