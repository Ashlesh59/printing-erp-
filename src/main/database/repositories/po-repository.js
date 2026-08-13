const db = require('../db');

const PORepository = {
    // PO Header
    getPOs: () => {
        return db.prepare(`
            SELECT po.*, s.name as supplier_name
            FROM purchase_orders po
            JOIN suppliers s ON po.supplier_id = s.id
            ORDER BY po.created_at DESC
        `).all();
    },
    getPOById: (id) => {
        const po = db.prepare(`
            SELECT po.*, s.name as supplier_name, s.phone as supplier_phone, s.email as supplier_email, s.gstin as supplier_gstin, s.address as supplier_address
            FROM purchase_orders po
            JOIN suppliers s ON po.supplier_id = s.id
            WHERE po.id = ?
        `).get(id);

        if (po) {
            po.items = db.prepare(`
                SELECT poi.*, i.name as item_name, i.sku, i.unit
                FROM purchase_order_items poi
                JOIN inventory_items i ON poi.item_id = i.id
                WHERE poi.po_id = ?
            `).all(id);
        }
        return po;
    },
    createPO: (data) => {
        const stmt = db.prepare(`
            INSERT INTO purchase_orders (
                po_number, supplier_id, order_date, subtotal, gst_amount, transport_cost, discount, grand_total, payment_status, status, invoice_number, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const res = stmt.run(
            data.po_number, data.supplier_id, data.order_date,
            data.subtotal, data.gst_amount, data.transport_cost,
            data.discount, data.grand_total, data.payment_status,
            data.status || 'Pending', data.invoice_number, data.notes
        );
        return res.lastInsertRowid;
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
        const stmt = db.prepare(`
            INSERT INTO purchase_order_items (po_id, item_id, qty, cost, gst_rate, total)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(poId, itemId, qty, cost, gstRate, total);
    },

    // Supplier Outstandings
    updateSupplierBalance: (supplierId, change) => {
        db.prepare('UPDATE suppliers SET outstanding_balance = outstanding_balance + ? WHERE id = ?')
          .run(change, supplierId);
    },

    // Purchase Returns
    createReturn: (poId, supplierId, itemId, qty, refund) => {
        const stmt = db.prepare(`
            INSERT INTO purchase_returns (po_id, supplier_id, item_id, qty_returned, refund_amount)
            VALUES (?, ?, ?, ?, ?)
        `);
        const res = stmt.run(poId, supplierId, itemId, qty, refund);
        return res.lastInsertRowid;
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
