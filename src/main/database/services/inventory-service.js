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
            const openingQty = parseFloat(data.opening_stock) || 0;
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

            // Update item details
            db.prepare(`
                UPDATE inventory_items SET
                    sku = ?, barcode = ?, name = ?, category_id = ?, brand = ?, supplier_id = ?,
                    description = ?, unit = ?, minimum_stock = ?, maximum_stock = ?, reorder_level = ?,
                    purchase_price = ?, selling_price = ?, storage_location_id = ?, expiry_date = ?,
                    notes = ?, status = ?, size = ?, gsm = ?, finish = ?, color_type = ?, sheets_per_ream = ?
                WHERE id = ?
            `).run(
                data.sku || old.sku, data.barcode || old.barcode, data.name || old.name,
                parseInt(data.category_id) || old.category_id, data.brand || old.brand,
                data.supplier_id ? parseInt(data.supplier_id) : old.supplier_id,
                data.description || old.description, data.unit || old.unit,
                parseFloat(data.minimum_stock) || old.minimum_stock,
                parseFloat(data.maximum_stock) || old.maximum_stock,
                parseFloat(data.reorder_level) || old.reorder_level,
                parseFloat(data.purchase_price) || old.purchase_price,
                parseFloat(data.selling_price) || old.selling_price,
                data.storage_location_id ? parseInt(data.storage_location_id) : old.storage_location_id,
                data.expiry_date || old.expiry_date, data.notes || old.notes,
                data.status || old.status, data.size || old.size,
                data.gsm ? parseInt(data.gsm) : old.gsm, data.finish || old.finish,
                data.color_type || old.color_type,
                data.sheets_per_ream ? parseInt(data.sheets_per_ream) : old.sheets_per_ream,
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

            InventoryRepository.softDeleteItem(id);
            eventBus.publish(EventTypes.INVENTORY_ADJUSTED, { itemId: id, isDeleted: true, name: item.name }, { sourceModule: 'InventoryService', userId: operator, role });
        });
        transaction();
        return { success: true };
    },

    // Stock Adjustments (Stock In / Out / Waste)
    adjustStock: (data, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const item = db.prepare('SELECT current_stock, average_cost, name FROM inventory_items WHERE id = ?').get(data.item_id);
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

            // Enforce negative stock rules
            const settings = db.prepare('SELECT allow_negative_stock FROM inventory_settings WHERE id = 1').get();
            const allowNegative = settings ? settings.allow_negative_stock === 1 : false;

            if (newGlobalStock < 0 && !allowNegative) {
                throw new Error(`Insufficient stock for "${item.name}". Available: ${item.current_stock}, Requested: ${qty}`);
            }

            // Update item quantities
            InventoryRepository.updateItemStock(data.item_id, newGlobalStock);
            InventoryRepository.updateLocationStock(data.item_id, locationId, newLocStock);

            // Record transaction
            InventoryRepository.addTransaction(
                data.item_id, data.type, finalQty, parseFloat(data.cost) || item.average_cost,
                data.ref_type, data.ref_id, data.reason, operator, role
            );

            // Log event via EventBus
            eventBus.publish(EventTypes.INVENTORY_ADJUSTED, { itemId: data.item_id, qty: finalQty, type: data.type, locationId, reason: data.reason }, { sourceModule: 'InventoryService', userId: operator, role });
            
            // Check alerts
            InventoryService.checkStockAlerts(data.item_id);

            return { success: true, new_stock: newGlobalStock };
        });
        return transaction();
    },

    // Stock Alerts
    checkStockAlerts: (itemId) => {
        const item = db.prepare('SELECT current_stock, minimum_stock, name FROM inventory_items WHERE id = ?').get(itemId);
        if (!item) return;

        // Clear active alerts for item
        db.prepare("DELETE FROM notifications WHERE reference_id = ? AND type IN ('low_stock', 'critical_stock')").run(itemId);

        if (item.current_stock <= 0) {
            eventBus.publish(EventTypes.INVENTORY_LOW_STOCK, {
                itemId,
                type: 'critical_stock',
                message: `CRITICAL: "${item.name}" is OUT of stock! (Current: 0)`,
                priority: 'Critical'
            }, { sourceModule: 'InventoryService' });
        } else if (item.current_stock <= item.minimum_stock) {
            eventBus.publish(EventTypes.INVENTORY_LOW_STOCK, {
                itemId,
                type: 'low_stock',
                message: `WARNING: "${item.name}" is running low. (Current: ${item.current_stock}, Minimum: ${item.minimum_stock})`,
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
