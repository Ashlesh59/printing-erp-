const db = require('../db');
const PurchasingService = require('../../services/purchasing/purchasing-service');

const PORepository = {
    // PO Header
    getPOs: (filters) => {
        return PurchasingService.getPurchaseOrders(filters);
    },
    getPOById: (id) => {
        return PurchasingService.getPurchaseOrderById(id);
    },
    createPO: (data) => {
        const res = PurchasingService.createPurchaseOrder(data);
        return res.poId;
    },
    updatePOStatus: (poId, status, receivedDate = null) => {
        if (receivedDate) {
            db.prepare(`
                UPDATE purchase_orders
                SET status = ?, received_date = ?
                WHERE id = ?
            `).run(status, receivedDate, poId);
        } else {
            db.prepare(`
                UPDATE purchase_orders
                SET status = ?
                WHERE id = ?
            `).run(status, poId);
        }
    },
    updatePOPaymentStatus: (poId, status) => {
        db.prepare(`
            UPDATE purchase_orders
            SET payment_status = ?
            WHERE id = ?
        `).run(status, poId);
    },

    // PO Line Items
    createPOItem: (poId, itemId, qty, cost, gstRate, total) => {
        const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId);
        const name = item ? item.name : `Item #${itemId}`;
        const sku = item ? item.sku : `SKU-${itemId}`;
        const unit = item ? item.unit : 'Units';

        const stmt = db.prepare(`
            INSERT INTO purchase_order_items (
                po_id, item_id, item_name_snapshot, sku_snapshot, unit_snapshot,
                ordered_qty, received_qty, returned_qty, cancelled_qty, unit_cost, gst_rate, tax_rate, tax_amount, line_total
            ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
        `);
        const taxAmount = (qty * cost * (gstRate / 100));
        stmt.run(poId, itemId, name, sku, unit, qty, cost, gstRate, gstRate, taxAmount, total);
    },

    // Supplier Outstandings (delegates to append-only ledger sync)
    updateSupplierBalance: (supplierId, change) => {
        if (change !== 0) {
            const direction = change > 0 ? 'CREDIT' : 'DEBIT';
            db.prepare(`
                INSERT INTO supplier_ledger (
                    supplier_id, entry_date, entry_type, amount, direction, source_type, source_id, reason, created_by
                ) VALUES (?, CURRENT_DATE, 'MANUAL_CORRECTION', ?, ?, 'manual', NULL, 'Manual balance adjustment via repository', 'System')
            `).run(supplierId, Math.abs(change), direction);

            PurchasingService.syncSupplierBalance(supplierId, db);
        }
    },

    // Purchase Returns
    createReturn: (poId, supplierId, itemId, qty, refund) => {
        const res = PurchasingService.createPurchaseReturn({
            po_id: poId,
            supplier_id: supplierId,
            item_id: itemId,
            qty_returned: qty,
            credit_amount: refund,
            reason: 'Returned to supplier'
        });
        return res.returnId;
    },

    // Batches
    createBatch: (itemId, batchNumber, supplierBatch, qty, mfgDate, expDate) => {
        const stmt = db.prepare(`
            INSERT INTO inventory_batches (item_id, batch_number, supplier_batch, qty_received, qty_remaining, manufacturing_date, expiry_date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const res = stmt.run(itemId, batchNumber, supplierBatch, qty, qty, mfgDate, expDate);
        return res.lastInsertRowid;
    },
    getBatchesByItem: (itemId) => {
        return db.prepare(`
            SELECT * FROM inventory_batches
            WHERE item_id = ? AND qty_remaining > 0
            ORDER BY expiry_date ASC, created_at ASC
        `).all(itemId);
    },
    deductFromBatch: (batchId, qty) => {
        db.prepare(`
            UPDATE inventory_batches
            SET qty_remaining = MAX(0, qty_remaining - ?)
            WHERE id = ?
        `).run(qty, batchId);
    }
};

module.exports = PORepository;

