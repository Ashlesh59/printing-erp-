const db = require('./db');
const InventoryRepository = require('./repositories/inventory-repository');
const InventoryService = require('./services/inventory-service');
const RecipeService = require('./services/recipe-service');
const ReservationService = require('./services/reservation-service');
const POService = require('./services/po-service');
const TransferService = require('./services/transfer-service');
const ForecastService = require('./services/forecast-service');
const ValuationService = require('./services/valuation-service');
const NotificationService = require('./services/notification-service');
const CountService = require('./services/count-service');
const PurchasingService = require('../services/purchasing/purchasing-service');

const InventoryModel = {
    // ──────────────────────────────────────────────────────────────
    // Categories
    // ──────────────────────────────────────────────────────────────
    getCategories: () => {
        return InventoryRepository.getCategories();
    },
    createCategory: (data) => {
        try {
            const stmt = db.prepare('INSERT INTO inventory_categories (name, description) VALUES (?, ?)');
            const res = stmt.run(data.name.trim(), data.description || '');
            return { success: true, id: res.lastInsertRowid };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    updateCategory: (id, data) => {
        try {
            const stmt = db.prepare('UPDATE inventory_categories SET name = ?, description = ? WHERE id = ?');
            stmt.run(data.name.trim(), data.description || '', id);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    deleteCategory: (id) => {
        try {
            const inUse = db.prepare('SELECT COUNT(*) as count FROM inventory_items WHERE category_id = ?').get(id);
            if (inUse.count > 0) return { success: false, error: "Category linked to active items" };
            db.prepare('DELETE FROM inventory_categories WHERE id = ?').run(id);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    // ──────────────────────────────────────────────────────────────
    // Suppliers
    // ──────────────────────────────────────────────────────────────
    getSuppliers: () => {
        return db.prepare("SELECT * FROM suppliers WHERE is_archived = 0 ORDER BY name ASC").all();
    },
    getAllSuppliersIncludingArchived: () => {
        return db.prepare("SELECT * FROM suppliers ORDER BY name ASC").all();
    },
    createSupplier: (data) => {
        try {
            const openBal = PurchasingService.roundMoney(parseFloat(data.opening_balance || data.outstanding_balance) || 0);
            const stmt = db.prepare('INSERT INTO suppliers (name, phone, email, gstin, address, payment_terms, opening_balance, outstanding_balance, is_archived) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)');
            const res = stmt.run(data.name.trim(), data.phone || '', data.email || '', data.gstin || '', data.address || '', data.payment_terms || '', openBal);
            const supplierId = res.lastInsertRowid;

            if (openBal !== 0) {
                const direction = openBal > 0 ? 'CREDIT' : 'DEBIT';
                db.prepare(`
                    INSERT INTO supplier_ledger (
                        supplier_id, entry_date, entry_type, amount, direction, source_type, source_id, reason, created_by
                    ) VALUES (?, CURRENT_DATE, 'OPENING_BALANCE', ?, ?, 'manual', ?, 'Opening Balance', 'System')
                `).run(supplierId, Math.abs(openBal), direction, supplierId);

                PurchasingService.syncSupplierBalance(supplierId, db);
            }

            return { success: true, id: supplierId };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    updateSupplier: (id, data) => {
        try {
            const stmt = db.prepare('UPDATE suppliers SET name = ?, phone = ?, email = ?, gstin = ?, address = ?, payment_terms = ? WHERE id = ?');
            stmt.run(data.name.trim(), data.phone || '', data.email || '', data.gstin || '', data.address || '', data.payment_terms || '', id);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    deleteSupplier: (id) => {
        try {
            // Check if supplier has any historical transactions
            const poCount = db.prepare('SELECT COUNT(*) as count FROM purchase_orders WHERE supplier_id = ?').get(id).count;
            const billCount = db.prepare('SELECT COUNT(*) as count FROM supplier_bills WHERE supplier_id = ?').get(id).count;
            const payCount = db.prepare('SELECT COUNT(*) as count FROM supplier_payments WHERE supplier_id = ?').get(id).count;
            const retCount = db.prepare('SELECT COUNT(*) as count FROM purchase_returns WHERE supplier_id = ?').get(id).count;
            const itemsUse = db.prepare('SELECT COUNT(*) as count FROM inventory_items WHERE supplier_id = ?').get(id).count;

            if (poCount > 0 || billCount > 0 || payCount > 0 || retCount > 0 || itemsUse > 0) {
                // Archive supplier safely
                db.prepare('UPDATE suppliers SET is_archived = 1 WHERE id = ?').run(id);
                return { success: true, archived: true, message: "Supplier has linked transaction history and was archived safely." };
            }

            db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    // ──────────────────────────────────────────────────────────────
    // Locations
    // ──────────────────────────────────────────────────────────────
    getLocations: () => {
        return InventoryRepository.getLocations();
    },
    createLocation: (data) => {
        try {
            const stmt = db.prepare('INSERT INTO inventory_locations (name, description) VALUES (?, ?)');
            const res = stmt.run(data.name.trim(), data.description || '');
            return { success: true, id: res.lastInsertRowid };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    updateLocation: (id, data) => {
        try {
            const stmt = db.prepare('UPDATE inventory_locations SET name = ?, description = ? WHERE id = ?');
            stmt.run(data.name.trim(), data.description || '', id);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    deleteLocation: (id) => {
        try {
            const inUse = db.prepare('SELECT COUNT(*) as count FROM inventory_items WHERE storage_location_id = ?').get(id);
            if (inUse.count > 0) return { success: false, error: "Location linked to active items" };
            db.prepare('DELETE FROM inventory_locations WHERE id = ?').run(id);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    // ──────────────────────────────────────────────────────────────
    // Stock Items
    // ──────────────────────────────────────────────────────────────
    getItems: () => {
        return InventoryService.getItems();
    },
    getItemById: (id) => {
        return InventoryService.getItemById(id);
    },
    createItem: (data) => {
        try {
            const itemId = InventoryService.createItem(data, data.operator, data.role);
            return { success: true, id: itemId };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    updateItem: (id, data) => {
        try {
            return InventoryService.updateItem(id, data, data.operator, data.role);
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    deleteItem: (id) => {
        try {
            return InventoryService.softDeleteItem(id);
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    // ──────────────────────────────────────────────────────────────
    // Adjustments
    // ──────────────────────────────────────────────────────────────
    adjustStock: (data) => {
        try {
            return InventoryService.adjustStock(data, data.operator, data.role);
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    getStockTransactions: (itemId = null) => {
        return InventoryRepository.getTransactions(itemId);
    },

    // ──────────────────────────────────────────────────────────────
    // Purchase Orders & Purchasing Engine
    // ──────────────────────────────────────────────────────────────
    getPurchaseOrders: (filters) => {
        return PurchasingService.getPurchaseOrders(filters);
    },
    getPurchaseOrderById: (id) => {
        return PurchasingService.getPurchaseOrderById(id);
    },
    createPurchaseOrder: (data) => {
        try {
            return PurchasingService.createPurchaseOrder(data, { user: { name: data.operator || 'Admin', role: data.role || 'Admin' } });
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    approvePurchaseOrder: (poId, data) => {
        try {
            return PurchasingService.approvePurchaseOrder(poId, { user: { name: data?.operator || 'Admin', role: data?.role || 'Admin' } });
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    markPurchaseOrderOrdered: (poId, data) => {
        try {
            return PurchasingService.markPurchaseOrderOrdered(poId, { user: { name: data?.operator || 'Operator', role: data?.role || 'Operator' } });
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    receivePurchaseOrder: (poId, data) => {
        try {
            const payload = {
                po_id: poId,
                ...data
            };
            return PurchasingService.receivePurchaseOrderItems(payload, { user: { name: data.operator || 'Admin', role: data.role || 'Admin' } });
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    cancelPurchaseOrder: (poId, data) => {
        try {
            const reason = data ? data.reason || 'Cancelled by user' : 'Cancelled by user';
            return PurchasingService.cancelPurchaseOrder(poId, reason, { user: { name: data?.operator || 'Admin', role: data?.role || 'Admin' } });
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    getGoodsReceipts: (poId) => {
        return PurchasingService.getGoodsReceipts(poId);
    },
    getSupplierBills: (supplierId) => {
        return PurchasingService.getSupplierBills(supplierId);
    },
    postSupplierBill: (data) => {
        try {
            return PurchasingService.postSupplierBill(data, { user: { name: data.operator || 'Admin', role: data.role || 'Admin' } });
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    getSupplierPayments: (supplierId) => {
        return PurchasingService.getSupplierPayments(supplierId);
    },
    recordSupplierPayment: (data) => {
        try {
            return PurchasingService.recordSupplierPayment(data, { user: { name: data.operator || 'Admin', role: data.role || 'Admin' } });
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    reverseSupplierPayment: (paymentId, data) => {
        try {
            return PurchasingService.reverseSupplierPayment(paymentId, data?.reason, { user: { name: data?.operator || 'Admin', role: data?.role || 'Admin' } });
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    getPurchaseReturns: (supplierId) => {
        return PurchasingService.getPurchaseReturns(supplierId);
    },
    createPurchaseReturn: (data) => {
        try {
            return PurchasingService.createPurchaseReturn(data, { user: { name: data.operator || 'Admin', role: data.role || 'Admin' } });
        } catch (e) {
            return { success: false, error: e.message };
        }
    },
    getSupplierStatement: (supplierId) => {
        return PurchasingService.getSupplierStatement(supplierId);
    },
    getPurchasingIntegrityReport: () => {
        return PurchasingService.getPurchasingIntegrityReport();
    },

    // ──────────────────────────────────────────────────────────────
    // Alerts & Settings
    // ──────────────────────────────────────────────────────────────
    getAlerts: () => {
        try {
            return db.prepare(`
                SELECT a.*, i.name as item_name, i.sku, i.current_stock, i.minimum_stock, c.name as category_name
                FROM inventory_alerts a
                JOIN inventory_items i ON a.item_id = i.id
                LEFT JOIN inventory_categories c ON i.category_id = c.id
                WHERE a.status = 'active'
                ORDER BY a.created_at DESC
            `).all();
        } catch (e) {
            console.error('[InventoryModel] getAlerts error:', e.message);
            return [];
        }
    },
    getSettings: () => {
        return db.prepare('SELECT * FROM inventory_settings WHERE id = 1').get() || { allow_negative_stock: 0, low_stock_threshold_percent: 15 };
    },
    updateSettings: (data) => {
        try {
            db.prepare(`
                UPDATE inventory_settings
                SET allow_negative_stock = ?, low_stock_threshold_percent = ?
                WHERE id = 1
            `).run(data.allow_negative_stock ? 1 : 0, parseFloat(data.low_stock_threshold_percent) || 15);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    // ──────────────────────────────────────────────────────────────
    // Deductions on Checkout
    // ──────────────────────────────────────────────────────────────
    deductOrderStock: (orderId, orderData) => {
        // Direct conversion of deductions into reservation fulfillment model
        // Checkout will reserve stock, and completion fulfills reservation
        try {
            ReservationService.reserve(orderId, orderData);
            // Since checkout defaults orders to 'Completed' in printshop manager,
            // we immediately fulfill/consume the reservation
            if (!orderData.status || orderData.status === 'Completed') {
                return ReservationService.fulfill(orderId);
            }
            return { success: true };
        } catch(e) {
            console.error(`Order deduction error:`, e);
            throw e;
        }
    },

    // ──────────────────────────────────────────────────────────────
    // Dashboard Stats & Valuation Aggregations
    // ──────────────────────────────────────────────────────────────
    getDashboardStats: () => {
        const totalProducts = db.prepare("SELECT COUNT(*) as count FROM inventory_items WHERE status!='Deleted'").get().count;
        const totalValue = ValuationService.calculateTotalValuation('AVERAGE');
        
        const lowStockCount = db.prepare(`
            SELECT COUNT(*) as count FROM inventory_items 
            WHERE status!='Deleted' AND current_stock <= minimum_stock AND current_stock > 0
        `).get().count;

        const outOfStockCount = db.prepare(`
            SELECT COUNT(*) as count FROM inventory_items 
            WHERE status!='Deleted' AND current_stock <= 0
        `).get().count;

        const todayCons = db.prepare(`
            SELECT ABS(SUM(qty)) as total FROM stock_transactions
            WHERE type='order' AND date(created_at) = date('now', 'localtime')
        `).get().total || 0;

        const monthlyCons = db.prepare(`
            SELECT ABS(SUM(qty)) as total FROM stock_transactions
            WHERE type='order' AND date(created_at) >= date('now', '-30 days')
        `).get().total || 0;

        const pendingPOs = db.prepare("SELECT COUNT(*) as count FROM purchase_orders WHERE status='Pending' OR status='Ordered'").get().count;
        const recentPurchaseVal = db.prepare(`
            SELECT SUM(grand_total) as total FROM purchase_orders
            WHERE status='Received' AND date(received_date) >= date('now', '-30 days')
        `).get().total || 0;

        const topUsedItems = db.prepare(`
            SELECT i.name, ABS(SUM(t.qty)) as qty, i.unit
            FROM stock_transactions t
            JOIN inventory_items i ON t.item_id = i.id
            WHERE t.type = 'order'
            GROUP BY t.item_id
            ORDER BY qty DESC LIMIT 5
        `).all();

        const paperUsageDays = db.prepare(`
            SELECT date(created_at) as date_label, ABS(SUM(qty)) as qty
            FROM stock_transactions
            WHERE type='order' AND date(created_at) >= date('now', '-12 days')
            GROUP BY date_label
            ORDER BY date_label ASC
        `).all();

        const purchaseTrends = db.prepare(`
            SELECT strftime('%Y-%m', received_date) as month_label, SUM(grand_total) as total
            FROM purchase_orders
            WHERE status='Received' AND received_date >= date('now', '-6 months')
            GROUP BY month_label
            ORDER BY month_label ASC
        `).all();

        return {
            totalProducts,
            totalValue,
            lowStockCount,
            outOfStockCount,
            todayConsumption: todayCons,
            monthlyConsumption: monthlyCons,
            pendingPOs,
            recentPurchaseVal,
            topUsedItems,
            paperUsageDays,
            purchaseTrends
        };
    },
    getInventoryReports: (startDate, endDate) => {
        const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const end = endDate || new Date().toISOString().split('T')[0];

        const consumption = db.prepare(`
            SELECT i.name, i.sku, c.name as category, ABS(SUM(t.qty)) as qty_consumed, i.unit, SUM(ABS(t.qty) * t.cost) as cost_valuation
            FROM stock_transactions t
            JOIN inventory_items i ON t.item_id = i.id
            JOIN inventory_categories c ON i.category_id = c.id
            WHERE t.type='order' AND date(t.created_at) BETWEEN ? AND ?
            GROUP BY t.item_id
            ORDER BY qty_consumed DESC
        `).all(start, end);

        const purchases = db.prepare(`
            SELECT po.po_number, s.name as supplier_name, po.received_date, po.grand_total, po.payment_status
            FROM purchase_orders po
            JOIN suppliers s ON po.supplier_id = s.id
            WHERE po.status='Received' AND date(po.received_date) BETWEEN ? AND ?
            ORDER BY po.received_date DESC
        `).all(start, end);

        const stockValuations = db.prepare(`
            SELECT i.name, i.sku, c.name as category, i.current_stock, i.unit, i.average_cost, (i.current_stock * i.average_cost) as total_value
            FROM inventory_items i
            JOIN inventory_categories c ON i.category_id = c.id
            WHERE i.status != 'Deleted'
            ORDER BY total_value DESC
        `).all();

        return {
            consumption,
            purchases,
            stockValuations,
            dateRange: { start, end }
        };
    }
};

module.exports = InventoryModel;
