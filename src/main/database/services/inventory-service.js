const db = require('../db');
const InventoryRepository = require('../repositories/inventory-repository');
const EventRepository = require('../repositories/event-repository');
const NotificationService = require('./notification-service');
const eventBus = require('../../events/EventBus');
const { EventTypes } = require('../../events/EventTypes');

const InventoryService = {
    // Items CRUD
    getItems: () => {
        return InventoryRepository.getItems();
    },
    getItemById: (id) => {
        return InventoryRepository.getItemById(id);
    },
    createItem: (data, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const itemId = InventoryRepository.createItem(data);
            
            // Log Opening Stock Transaction
            const openingQty = parseFloat(data.opening_stock !== undefined ? data.opening_stock : data.current_stock) || 0;
            if (openingQty > 0) {
                InventoryRepository.addTransaction(
                    itemId, 'opening', openingQty, parseFloat(data.purchase_price) || 0,
                    'opening', itemId, 'Initial opening stock allocation', operator, role
                );
            }

            // Sync default location stock level
            const defaultLocId = parseInt(data.storage_location_id) || 1;
            InventoryRepository.updateLocationStock(itemId, defaultLocId, openingQty);

            // Log Event via EventBus
            eventBus.publish(EventTypes.INVENTORY_ADJUSTED, { itemId, isCreated: true, newData: data }, { sourceModule: 'InventoryService', userId: operator, role });
            
            // Check alerts
            InventoryService.checkStockAlerts(itemId);
            
            return itemId;
        });
        return transaction();
    },
    updateItem: (id, data, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const old = InventoryRepository.getItemById(id);
            if (!old) throw new Error("Item not found");

            // Explicit zero-preservation check
            const minStock = data.minimum_stock !== undefined ? parseFloat(data.minimum_stock) : old.minimum_stock;
            const maxStock = data.maximum_stock !== undefined ? parseFloat(data.maximum_stock) : old.maximum_stock;
            const reorderLevel = data.reorder_level !== undefined ? parseFloat(data.reorder_level) : old.reorder_level;
            const purchasePrice = data.purchase_price !== undefined ? parseFloat(data.purchase_price) : old.purchase_price;
            const sellingPrice = data.selling_price !== undefined ? parseFloat(data.selling_price) : old.selling_price;
            const gsmVal = data.gsm !== undefined ? (data.gsm === null || data.gsm === '' ? null : parseInt(data.gsm)) : old.gsm;
            const sheetsVal = data.sheets_per_ream !== undefined ? (data.sheets_per_ream === null || data.sheets_per_ream === '' ? null : parseInt(data.sheets_per_ream)) : old.sheets_per_ream;

            // Update item details
            db.prepare(`
                UPDATE inventory_items SET
                    sku = ?, barcode = ?, name = ?, category_id = ?, brand = ?, supplier_id = ?,
                    description = ?, unit = ?, minimum_stock = ?, maximum_stock = ?, reorder_level = ?,
                    purchase_price = ?, selling_price = ?, storage_location_id = ?, expiry_date = ?,
                    notes = ?, status = ?, size = ?, gsm = ?, finish = ?, color_type = ?, sheets_per_ream = ?
                WHERE id = ?
            `).run(
                data.sku !== undefined ? data.sku : old.sku,
                data.barcode !== undefined ? data.barcode : old.barcode,
                data.name !== undefined ? data.name : old.name,
                data.category_id !== undefined ? parseInt(data.category_id) : old.category_id,
                data.brand !== undefined ? data.brand : old.brand,
                data.supplier_id !== undefined ? (data.supplier_id ? parseInt(data.supplier_id) : null) : old.supplier_id,
                data.description !== undefined ? data.description : old.description,
                data.unit !== undefined ? data.unit : old.unit,
                isNaN(minStock) ? old.minimum_stock : minStock,
                isNaN(maxStock) ? old.maximum_stock : maxStock,
                isNaN(reorderLevel) ? old.reorder_level : reorderLevel,
                isNaN(purchasePrice) ? old.purchase_price : purchasePrice,
                isNaN(sellingPrice) ? old.selling_price : sellingPrice,
                data.storage_location_id !== undefined ? (data.storage_location_id ? parseInt(data.storage_location_id) : null) : old.storage_location_id,
                data.expiry_date !== undefined ? data.expiry_date : old.expiry_date,
                data.notes !== undefined ? data.notes : old.notes,
                data.status !== undefined ? data.status : old.status,
                data.size !== undefined ? data.size : old.size,
                gsmVal,
                data.finish !== undefined ? data.finish : old.finish,
                data.color_type !== undefined ? data.color_type : old.color_type,
                sheetsVal,
                id
            );

            // Log Event via EventBus
            eventBus.publish(EventTypes.INVENTORY_ADJUSTED, { itemId: id, isUpdated: true, oldData: old, newData: data }, { sourceModule: 'InventoryService', userId: operator, role });
            
            // Check alerts
            InventoryService.checkStockAlerts(id);
        });
        transaction();
        return { success: true };
    },
    softDeleteItem: (id, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const item = InventoryRepository.getItemById(id);
            if (!item) throw new Error("Item not found");

            // Block delete if active reservations exist
            try {
                const activeRes = db.prepare("SELECT COUNT(*) as count FROM inventory_reservations WHERE item_id = ? AND status = 'Active'").get(id);
                if (activeRes && activeRes.count > 0) {
                    throw new Error(`Cannot delete item "${item.name}" because it has ${activeRes.count} active stock reservations.`);
                }
            } catch (e) {
                if (e.message.includes('active stock reservations')) throw e;
            }

            // Block delete if referenced in open purchase orders
            try {
                const pendingPo = db.prepare(`
                    SELECT COUNT(*) as count 
                    FROM purchase_order_items poi
                    JOIN purchase_orders po ON poi.po_id = po.id
                    WHERE poi.item_id = ? AND po.status IN ('Draft', 'Approved', 'Ordered', 'Partially Received')
                `).get(id);
                if (pendingPo && pendingPo.count > 0) {
                    throw new Error(`Cannot delete item "${item.name}" because it is part of ${pendingPo.count} open purchase orders.`);
                }
            } catch (e) {
                if (e.message.includes('open purchase orders') || e.message.includes('active stock reservations')) throw e;
            }

            InventoryRepository.softDeleteItem(id);
            eventBus.publish(EventTypes.INVENTORY_ADJUSTED, { itemId: id, isDeleted: true, name: item.name }, { sourceModule: 'InventoryService', userId: operator, role });
        });
        transaction();
        return { success: true };
    },

    // Stock Adjustments (Stock In / Out / Waste)
    adjustStock: (data, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const item = db.prepare('SELECT current_stock, reserved_stock, average_cost, name FROM inventory_items WHERE id = ?').get(data.item_id);
            if (!item) throw new Error("Stock item not found");

            const qty = parseFloat(data.qty);
            if (isNaN(qty) || qty === 0) throw new Error("Invalid quantity");

            const locationId = parseInt(data.location_id) || 1;
            const locStock = InventoryRepository.getLocationStock(data.item_id, locationId);
            
            // Unit conversion
            let finalQty = qty;
            if (data.from_unit && data.to_unit && data.from_unit !== data.to_unit) {
                const conv = db.prepare('SELECT factor FROM unit_conversions WHERE item_id = ? AND from_unit = ? AND to_unit = ?')
                              .get(data.item_id, data.from_unit, data.to_unit);
                if (conv) {
                    finalQty = qty * conv.factor;
                }
            }

            const newLocStock = locStock.current_stock + finalQty;
            const newGlobalStock = item.current_stock + finalQty;

            // Enforce negative stock & reservation rules
            const settings = db.prepare('SELECT allow_negative_stock FROM inventory_settings WHERE id = 1').get();
            const allowNegative = settings ? settings.allow_negative_stock === 1 : false;

            const reservedStock = item.reserved_stock || 0;
            if (newGlobalStock < reservedStock && !allowNegative) {
                throw new Error(`Insufficient available stock for "${item.name}". Current: ${item.current_stock}, Reserved: ${reservedStock}, Available: ${item.current_stock - reservedStock}, Requested: ${Math.abs(finalQty)}`);
            }

            // Update item quantities
            InventoryRepository.updateItemStock(data.item_id, newGlobalStock);
            InventoryRepository.updateLocationStock(data.item_id, locationId, newLocStock);

            // Record transaction
            const txId = InventoryRepository.addTransaction(
                data.item_id, data.type, finalQty, parseFloat(data.cost) || item.average_cost,
                data.ref_type, data.ref_id, data.reason, operator, role
            );

            // Log event via EventBus
            eventBus.publish(EventTypes.INVENTORY_ADJUSTED, { itemId: data.item_id, qty: finalQty, type: data.type, locationId, reason: data.reason }, { sourceModule: 'InventoryService', userId: operator, role });
            
            // Check alerts
            InventoryService.checkStockAlerts(data.item_id);

            return { success: true, new_stock: newGlobalStock, transactionId: txId };
        });
        return transaction();
    },

    // Reverses a previous stock transaction exactly (No guessing, no deleting ledger entries)
    reverseTransaction: (transactionId, reason = 'Manual transaction reversal', operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const original = InventoryRepository.getTransactionById(transactionId);
            if (!original) throw new Error("Transaction not found");
            if (original.is_reversed === 1) throw new Error("Transaction has already been reversed");
            if (original.reversal_of_id) throw new Error("Cannot reverse a reversal transaction");

            const item = InventoryRepository.getItemByIdRaw(original.item_id);
            if (!item) throw new Error("Associated inventory item not found");

            const locId = original.location_id || item.storage_location_id || 1;
            const locStock = InventoryRepository.getLocationStock(original.item_id, locId);

            const inverseQty = -original.qty;
            const newGlobalStock = item.current_stock + inverseQty;
            const newLocStock = locStock.current_stock + inverseQty;

            const reservedStock = item.reserved_stock || 0;
            if (newGlobalStock < reservedStock) {
                throw new Error(`Cannot reverse transaction: Resulting stock (${newGlobalStock}) would be less than active reservations (${reservedStock}).`);
            }

            InventoryRepository.updateItemStock(original.item_id, newGlobalStock);
            InventoryRepository.updateLocationStock(original.item_id, locId, newLocStock);

            const revType = inverseQty > 0 ? 'manual_in' : 'manual_out';
            const revTxId = InventoryRepository.addTransaction(
                original.item_id,
                revType,
                inverseQty,
                original.cost,
                original.reference_type,
                original.reference_id,
                `Reversal of Tx #${transactionId}: ${reason}`,
                operator,
                role,
                transactionId
            );

            InventoryRepository.markTransactionReversed(transactionId);
            InventoryService.checkStockAlerts(original.item_id);

            eventBus.publish(EventTypes.INVENTORY_ADJUSTED, {
                itemId: original.item_id,
                qty: inverseQty,
                type: 'reversal',
                reversalOfId: transactionId
            }, { sourceModule: 'InventoryService', userId: operator, role });

            return { success: true, reversalTransactionId: revTxId, newStock: newGlobalStock };
        });
        return transaction();
    },

    // Stock Alerts
    checkStockAlerts: (itemId) => {
        const item = db.prepare('SELECT current_stock, minimum_stock, name FROM inventory_items WHERE id = ?').get(itemId);
        if (!item) return;

        // Clear active alerts for item
        try {
            db.prepare("DELETE FROM notifications WHERE reference_id = ? AND type IN ('low_stock', 'critical_stock')").run(itemId);
            db.prepare("DELETE FROM inventory_alerts WHERE item_id = ? AND status = 'active'").run(itemId);
        } catch (e) {}

        if (item.current_stock <= 0) {
            const msg = `CRITICAL: "${item.name}" is OUT of stock! (Current: ${item.current_stock})`;
            try {
                db.prepare("INSERT INTO inventory_alerts (item_id, type, message, status) VALUES (?, 'out_of_stock', ?, 'active')").run(itemId, msg);
            } catch (e) {}

            eventBus.publish(EventTypes.INVENTORY_LOW_STOCK, {
                itemId,
                type: 'critical_stock',
                message: msg,
                priority: 'Critical'
            }, { sourceModule: 'InventoryService' });
        } else if (item.current_stock <= item.minimum_stock) {
            const msg = `WARNING: "${item.name}" is running low. (Current: ${item.current_stock}, Minimum: ${item.minimum_stock})`;
            try {
                db.prepare("INSERT INTO inventory_alerts (item_id, type, message, status) VALUES (?, 'low_stock', ?, 'active')").run(itemId, msg);
            } catch (e) {}

            eventBus.publish(EventTypes.INVENTORY_LOW_STOCK, {
                itemId,
                type: 'low_stock',
                message: msg,
                priority: 'High'
            }, { sourceModule: 'InventoryService' });
        }
    },

    // Unit Conversions
    saveUnitConversion: (itemId, fromUnit, toUnit, factor) => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO unit_conversions (item_id, from_unit, to_unit, factor)
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(itemId, fromUnit, toUnit, factor);
    }
};

module.exports = InventoryService;

