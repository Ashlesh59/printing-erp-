const db = require('../../database/db');
const eventBus = require('../../events/EventBus');
const { EventTypes } = require('../../events/EventTypes');

/**
 * PurchasingService - Single Source of Truth for Purchase Orders,
 * Goods Receiving, Supplier Bills, Payments, Returns, Credits & Payable Ledger.
 */
const PurchasingService = {

    // ──────────────────────────────────────────────────────────────
    // Helper: Money and Math Safety
    // ──────────────────────────────────────────────────────────────
    roundMoney: (val) => {
        if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) return 0;
        return Math.round((val + Number.EPSILON) * 100) / 100;
    },

    assertPositive: (val, fieldName) => {
        const num = parseFloat(val);
        if (typeof num !== 'number' || isNaN(num) || !isFinite(num) || num <= 0) {
            throw new Error(`Invalid ${fieldName}: must be a positive number greater than zero.`);
        }
        return num;
    },

    assertNonNegative: (val, fieldName) => {
        const num = parseFloat(val);
        if (typeof num !== 'number' || isNaN(num) || !isFinite(num) || num < 0) {
            throw new Error(`Invalid ${fieldName}: cannot be negative.`);
        }
        return num;
    },

    generateDocNumber: (prefix) => {
        const d = new Date();
        const yyyymmdd = d.toISOString().slice(0, 10).replace(/-/g, '');
        const rand = Math.floor(1000 + Math.random() * 9000);
        return `${prefix}-${yyyymmdd}-${rand}`;
    },

    // ──────────────────────────────────────────────────────────────
    // Helper: Sync Derived Supplier Balance
    // ──────────────────────────────────────────────────────────────
    syncSupplierBalance: (supplierId, dbTx = db) => {
        const row = dbTx.prepare(`
            SELECT COALESCE(SUM(
                CASE
                    WHEN direction = 'CREDIT' THEN amount
                    WHEN direction = 'DEBIT' THEN -amount
                    ELSE 0
                END
            ), 0) as derived_balance
            FROM supplier_ledger
            WHERE supplier_id = ?
        `).get(supplierId);

        const derivedBalance = PurchasingService.roundMoney(row ? row.derived_balance : 0);
        dbTx.prepare('UPDATE suppliers SET outstanding_balance = ? WHERE id = ?').run(derivedBalance, supplierId);
        return derivedBalance;
    },

    // ──────────────────────────────────────────────────────────────
    // 1. Purchase Orders
    // ──────────────────────────────────────────────────────────────

    getPurchaseOrders: (filters = {}) => {
        let query = `
            SELECT po.*, s.name as supplier_name, s.phone as supplier_phone, s.email as supplier_email,
                   s.gstin as supplier_gstin, l.name as location_name
            FROM purchase_orders po
            JOIN suppliers s ON po.supplier_id = s.id
            LEFT JOIN inventory_locations l ON po.location_id = l.id
            WHERE 1=1
        `;
        const params = [];

        if (filters.status) {
            query += ' AND po.status = ?';
            params.push(filters.status);
        }
        if (filters.supplier_id) {
            query += ' AND po.supplier_id = ?';
            params.push(filters.supplier_id);
        }
        if (filters.search) {
            query += ' AND (po.po_number LIKE ? OR s.name LIKE ? OR po.notes LIKE ?)';
            const term = `%${filters.search}%`;
            params.push(term, term, term);
        }

        query += ' ORDER BY po.created_at DESC';
        return db.prepare(query).all(...params);
    },

    getPurchaseOrderById: (id) => {
        const po = db.prepare(`
            SELECT po.*, s.name as supplier_name, s.phone as supplier_phone, s.email as supplier_email,
                   s.gstin as supplier_gstin, s.address as supplier_address, l.name as location_name
            FROM purchase_orders po
            JOIN suppliers s ON po.supplier_id = s.id
            LEFT JOIN inventory_locations l ON po.location_id = l.id
            WHERE po.id = ?
        `).get(id);

        if (!po) return null;

        po.items = db.prepare(`
            SELECT poi.*, i.name as current_item_name, i.sku as current_sku, i.unit as current_unit
            FROM purchase_order_items poi
            LEFT JOIN inventory_items i ON poi.item_id = i.id
            WHERE poi.po_id = ?
        `).all(id);

        po.receipts = db.prepare(`
            SELECT gr.*, l.name as location_name
            FROM goods_receipts gr
            LEFT JOIN inventory_locations l ON gr.location_id = l.id
            WHERE gr.po_id = ?
            ORDER BY gr.created_at DESC
        `).all(id);

        po.bills = db.prepare(`
            SELECT * FROM supplier_bills WHERE po_id = ? ORDER BY created_at DESC
        `).all(id);

        return po;
    },

    createPurchaseOrder: (data, session = { user: { name: 'System', role: 'System' } }) => {
        const tx = db.transaction(() => {
            const idempotencyKey = data.idempotency_key || data.idempotencyKey || null;
            if (idempotencyKey) {
                const existing = db.prepare('SELECT id, po_number, grand_total, status FROM purchase_orders WHERE idempotency_key = ?').get(idempotencyKey);
                if (existing) {
                    return { success: true, poId: existing.id, po_number: existing.po_number, poNumber: existing.po_number, grandTotal: existing.grand_total, isDuplicate: true };
                }
            }

            const supplierId = parseInt(data.supplier_id);
            if (!supplierId || isNaN(supplierId)) throw new Error("A valid supplier is required.");

            const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
            if (!supplier) throw new Error("Supplier not found in local database.");
            if (supplier.is_archived) throw new Error("Cannot raise purchase order for an archived supplier.");

            if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
                throw new Error("Purchase order must contain at least one line item.");
            }

            const poNumber = data.po_number ? String(data.po_number).trim() : PurchasingService.generateDocNumber('PO');
            const orderDate = data.order_date || new Date().toISOString().split('T')[0];
            const expDeliveryDate = data.expected_delivery_date || null;
            const locationId = data.location_id ? parseInt(data.location_id) : (supplier.storage_location_id || 1);
            const notes = data.notes ? String(data.notes).trim() : '';
            const requestedStatus = data.status || 'Draft';
            const initialStatus = ['Draft', 'Approved', 'Ordered'].includes(requestedStatus) ? requestedStatus : 'Draft';

            let subtotal = 0;
            let taxAmount = 0;
            const preparedItems = [];

            for (let i = 0; i < data.items.length; i++) {
                const rawItem = data.items[i];
                const itemId = parseInt(rawItem.item_id);
                if (!itemId || isNaN(itemId)) throw new Error(`Line ${i + 1}: Invalid item selected.`);

                const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId);
                if (!item) throw new Error(`Line ${i + 1}: Item ID ${itemId} not found in inventory catalog.`);

                const orderedQty = PurchasingService.assertPositive(rawItem.qty || rawItem.ordered_qty, `Line ${i + 1} ordered quantity`);
                const unitCost = PurchasingService.assertNonNegative(rawItem.cost !== undefined ? rawItem.cost : (rawItem.unit_cost !== undefined ? rawItem.unit_cost : item.purchase_price), `Line ${i + 1} unit cost`);
                const taxRate = PurchasingService.assertNonNegative(rawItem.gst_rate !== undefined ? rawItem.gst_rate : (rawItem.tax_rate !== undefined ? rawItem.tax_rate : 18), `Line ${i + 1} tax rate`);

                const lineSubtotal = PurchasingService.roundMoney(orderedQty * unitCost);
                const lineTax = PurchasingService.roundMoney(lineSubtotal * (taxRate / 100));
                const lineTotal = PurchasingService.roundMoney(lineSubtotal + lineTax);

                subtotal += lineSubtotal;
                taxAmount += lineTax;

                preparedItems.push({
                    item_id: itemId,
                    supplier_sku: rawItem.supplier_sku || null,
                    item_name_snapshot: item.name,
                    sku_snapshot: item.sku,
                    unit_snapshot: item.unit || 'Units',
                    ordered_qty: orderedQty,
                    unit_cost: unitCost,
                    tax_rate: taxRate,
                    tax_amount: lineTax,
                    line_total: lineTotal,
                    target_location_id: rawItem.target_location_id ? parseInt(rawItem.target_location_id) : locationId
                });
            }

            subtotal = PurchasingService.roundMoney(subtotal);
            taxAmount = PurchasingService.roundMoney(taxAmount);
            const transportCost = PurchasingService.assertNonNegative(data.transport_cost || 0, 'transport cost');
            const discount = PurchasingService.assertNonNegative(data.discount || 0, 'discount');
            const grandTotal = PurchasingService.roundMoney(Math.max(0, subtotal + taxAmount + transportCost - discount));

            const cgst = PurchasingService.roundMoney(taxAmount / 2);
            const sgst = PurchasingService.roundMoney(taxAmount / 2);
            const igst = 0;

            const insertPoStmt = db.prepare(`
                INSERT INTO purchase_orders (
                    po_number, supplier_id, order_date, expected_delivery_date, location_id,
                    subtotal, tax_amount, cgst_amount, sgst_amount, igst_amount, transport_cost,
                    discount, grand_total, status, payment_status, notes, created_by,
                    idempotency_key
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Unpaid', ?, ?, ?)
            `);

            const poRes = insertPoStmt.run(
                poNumber, supplierId, orderDate, expDeliveryDate, locationId,
                subtotal, taxAmount, cgst, sgst, igst, transportCost,
                discount, grandTotal, initialStatus, notes, session.user ? session.user.name : 'System',
                idempotencyKey
            );
            const poId = poRes.lastInsertRowid;

            const insertItemStmt = db.prepare(`
                INSERT INTO purchase_order_items (
                    po_id, item_id, supplier_sku, item_name_snapshot, sku_snapshot, unit_snapshot,
                    ordered_qty, received_qty, returned_qty, cancelled_qty, unit_cost,
                    tax_rate, tax_amount, line_total, target_location_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
            `);

            for (const it of preparedItems) {
                insertItemStmt.run(
                    poId, it.item_id, it.supplier_sku, it.item_name_snapshot, it.sku_snapshot, it.unit_snapshot,
                    it.ordered_qty, it.unit_cost, it.tax_rate, it.tax_amount, it.line_total, it.target_location_id
                );
            }

            return {
                success: true,
                poId,
                po_number: poNumber,
                poNumber,
                grandTotal,
                status: initialStatus
            };
        });

        return tx();
    },

    approvePurchaseOrder: (poId, session = { user: { name: 'Admin', role: 'Admin' } }) => {
        const tx = db.transaction(() => {
            const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
            if (!po) throw new Error(`Purchase Order #${poId} not found.`);
            if (po.status !== 'Draft') {
                throw new Error(`Cannot approve Purchase Order in state '${po.status}'. Expected 'Draft'.`);
            }

            db.prepare(`
                UPDATE purchase_orders
                SET status = 'Approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(session.user ? session.user.name : 'Admin', poId);

            return { success: true, poId, status: 'Approved' };
        });
        return tx();
    },

    markPurchaseOrderOrdered: (poId, session = { user: { name: 'Operator', role: 'Operator' } }) => {
        const tx = db.transaction(() => {
            const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
            if (!po) throw new Error(`Purchase Order #${poId} not found.`);
            if (!['Draft', 'Approved'].includes(po.status)) {
                throw new Error(`Cannot mark Purchase Order in state '${po.status}' as Ordered.`);
            }

            db.prepare(`
                UPDATE purchase_orders
                SET status = 'Ordered'
                WHERE id = ?
            `).run(poId);

            return { success: true, poId, status: 'Ordered' };
        });
        return tx();
    },

    // ──────────────────────────────────────────────────────────────
    // 2. Goods Receiving & Stock-In
    // ──────────────────────────────────────────────────────────────

    receivePurchaseOrderItems: (data, session = { user: { name: 'Admin', role: 'Admin' } }) => {
        const tx = db.transaction(() => {
            const idempotencyKey = data.idempotency_key || data.idempotencyKey || null;
            if (idempotencyKey) {
                const existing = db.prepare('SELECT id, receipt_number, status FROM goods_receipts WHERE idempotency_key = ?').get(idempotencyKey);
                if (existing) {
                    return { success: true, receiptId: existing.id, receiptNumber: existing.receipt_number, isDuplicate: true };
                }
            }

            const poId = parseInt(data.po_id || data.poId);
            if (!poId || isNaN(poId)) throw new Error("A valid PO ID is required for receiving items.");

            const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
            if (!po) throw new Error(`Purchase Order #${poId} not found.`);

            if (['Cancelled', 'Closed', 'Fully Received'].includes(po.status)) {
                throw new Error(`Cannot receive items for Purchase Order in '${po.status}' state.`);
            }

            if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
                throw new Error("Receipt payload must contain at least one line item.");
            }

            const locationId = data.location_id ? parseInt(data.location_id) : (po.location_id || 1);
            const location = db.prepare('SELECT * FROM inventory_locations WHERE id = ?').get(locationId);
            if (!location) throw new Error(`Destination inventory location #${locationId} does not exist.`);

            const receiptNumber = data.receipt_number ? String(data.receipt_number).trim() : PurchasingService.generateDocNumber('REC');
            const receiptDate = data.receipt_date || new Date().toISOString().split('T')[0];
            const supplierDocRef = data.supplier_doc_ref || data.invoice_number || '';
            const notes = data.notes ? String(data.notes).trim() : '';

            // 1. Fetch current PO line items
            const poItems = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(poId);
            const poItemMap = new Map(poItems.map(item => [item.id, item]));

            let positiveCount = 0;
            const receiptLines = [];

            for (let i = 0; i < data.items.length; i++) {
                const line = data.items[i];
                const poItemId = parseInt(line.po_item_id || line.id);
                const poItem = poItemMap.get(poItemId);

                if (!poItem) {
                    throw new Error(`Line ${i + 1}: PO Item #${poItemId} does not belong to Purchase Order #${poId}.`);
                }

                const qtyReceived = parseFloat(line.qty_received !== undefined ? line.qty_received : line.qty);
                if (typeof qtyReceived !== 'number' || isNaN(qtyReceived) || qtyReceived < 0) {
                    throw new Error(`Line ${i + 1}: Received quantity cannot be negative.`);
                }

                if (qtyReceived === 0) continue; // Zero means line not included in this receipt batch
                positiveCount++;

                const remainingReceivable = PurchasingService.roundMoney(poItem.ordered_qty - poItem.received_qty - poItem.cancelled_qty);
                if (qtyReceived > remainingReceivable && !data.allowOverReceipt) {
                    throw new Error(`Line ${i + 1} (${poItem.item_name_snapshot}): Received quantity (${qtyReceived}) exceeds remaining ordered quantity (${remainingReceivable}).`);
                }

                // Verify inventory item exists
                const inventoryItem = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(poItem.item_id);
                if (!inventoryItem) {
                    throw new Error(`Critical Inventory Error: Target inventory product #${poItem.item_id} (${poItem.item_name_snapshot}) not found in catalog. Receipt aborted.`);
                }

                receiptLines.push({
                    po_item_id: poItemId,
                    item_id: poItem.item_id,
                    qty_received: qtyReceived,
                    unit_cost: poItem.unit_cost,
                    location_id: line.location_id ? parseInt(line.location_id) : locationId,
                    batch_number: line.batch_number || `${po.po_number}-${poItem.item_id}-${Date.now()}`,
                    inventory_item: inventoryItem,
                    po_item: poItem
                });
            }

            if (positiveCount === 0) {
                throw new Error("Cannot post a goods receipt with zero received items.");
            }

            // 2. Create Goods Receipt Header
            const insertReceiptStmt = db.prepare(`
                INSERT INTO goods_receipts (
                    receipt_number, po_id, supplier_id, receipt_date, location_id,
                    supplier_doc_ref, status, notes, created_by, idempotency_key
                ) VALUES (?, ?, ?, ?, ?, ?, 'Posted', ?, ?, ?)
            `);

            const receiptRes = insertReceiptStmt.run(
                receiptNumber, poId, po.supplier_id, receiptDate, locationId,
                supplierDocRef, notes, session.user ? session.user.name : 'System',
                idempotencyKey
            );
            const receiptId = receiptRes.lastInsertRowid;

            // 3. Process Each Receipt Line (Stock in + WAC update + Lot Batch + Transaction)
            const insertReceiptItemStmt = db.prepare(`
                INSERT INTO goods_receipt_items (
                    receipt_id, po_item_id, item_id, qty_received, unit_cost, location_id, batch_number
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            const updatePoItemStmt = db.prepare(`
                UPDATE purchase_order_items
                SET received_qty = received_qty + ?
                WHERE id = ?
            `);

            const updateItemStockStmt = db.prepare(`
                UPDATE inventory_items
                SET current_stock = current_stock + ?,
                    average_cost = ?,
                    last_purchase_price = ?,
                    last_purchase_date = ?
                WHERE id = ?
            `);

            const upsertLocStockStmt = db.prepare(`
                INSERT INTO inventory_location_stock (item_id, location_id, current_stock, reserved_stock)
                VALUES (?, ?, ?, 0)
                ON CONFLICT(item_id, location_id) DO UPDATE SET current_stock = current_stock + excluded.current_stock
            `);

            const insertBatchStmt = db.prepare(`
                INSERT INTO inventory_batches (
                    item_id, batch_number, supplier_batch, qty_received, qty_remaining, manufacturing_date, expiry_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            const insertStockTxStmt = db.prepare(`
                INSERT INTO stock_transactions (
                    item_id, type, qty, cost, reference_type, reference_id, reason, operator
                ) VALUES (?, 'purchase', ?, ?, 'goods_receipt', ?, ?, ?)
            `);

            for (const line of receiptLines) {
                // Insert goods receipt item
                insertReceiptItemStmt.run(
                    receiptId, line.po_item_id, line.item_id, line.qty_received, line.unit_cost, line.location_id, line.batch_number
                );

                // Update PO Item received quantity
                updatePoItemStmt.run(line.qty_received, line.po_item_id);

                // Recalculate Weighted Average Cost (WAC)
                const currentStock = line.inventory_item.current_stock;
                const oldAvgCost = line.inventory_item.average_cost || line.inventory_item.purchase_price || 0;
                const newTotalCost = (currentStock * oldAvgCost) + (line.qty_received * line.unit_cost);
                const newTotalStock = currentStock + line.qty_received;
                const newAvgCost = newTotalStock > 0 ? PurchasingService.roundMoney(newTotalCost / newTotalStock) : line.unit_cost;

                // Update inventory_items
                updateItemStockStmt.run(
                    line.qty_received, newAvgCost, line.unit_cost, receiptDate, line.item_id
                );

                // Update inventory_location_stock
                upsertLocStockStmt.run(line.item_id, line.location_id, line.qty_received);

                // Create tracking batch
                insertBatchStmt.run(
                    line.item_id, line.batch_number, supplierDocRef || po.po_number,
                    line.qty_received, line.qty_received, null, null
                );

                // Log stock transaction
                insertStockTxStmt.run(
                    line.item_id, line.qty_received, line.unit_cost, receiptId,
                    `Goods Receipt #${receiptNumber} for PO #${po.po_number}`, session.user ? session.user.name : 'System'
                );
            }

            // 4. Evaluate Overall PO Status Transition
            const updatedPoItems = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(poId);
            const isFullyReceived = updatedPoItems.every(item => (item.received_qty + item.cancelled_qty) >= item.ordered_qty);
            const nextPoStatus = isFullyReceived ? 'Fully Received' : 'Partially Received';

            db.prepare(`
                UPDATE purchase_orders
                SET status = ?, received_date = ?
                WHERE id = ?
            `).run(nextPoStatus, receiptDate, poId);

            return {
                success: true,
                receiptId,
                receiptNumber,
                receipt_number: receiptNumber,
                poStatus: nextPoStatus,
                linesReceived: receiptLines.length
            };
        });

        return tx();
    },

    getGoodsReceipts: (poId = null) => {
        let query = `
            SELECT gr.*, po.po_number, s.name as supplier_name, l.name as location_name
            FROM goods_receipts gr
            JOIN purchase_orders po ON gr.po_id = po.id
            JOIN suppliers s ON gr.supplier_id = s.id
            LEFT JOIN inventory_locations l ON gr.location_id = l.id
            WHERE 1=1
        `;
        const params = [];
        if (poId) {
            query += ' AND gr.po_id = ?';
            params.push(poId);
        }
        query += ' ORDER BY gr.created_at DESC';
        const receipts = db.prepare(query).all(...params);

        for (const r of receipts) {
            r.items = db.prepare(`
                SELECT gri.*, i.name as item_name, i.sku, i.unit
                FROM goods_receipt_items gri
                JOIN inventory_items i ON gri.item_id = i.id
                WHERE gri.receipt_id = ?
            `).all(r.id);
        }
        return receipts;
    },

    // ──────────────────────────────────────────────────────────────
    // 3. Supplier Bills & Liabilities
    // ──────────────────────────────────────────────────────────────

    postSupplierBill: (data, session = { user: { name: 'Admin', role: 'Admin' } }) => {
        const tx = db.transaction(() => {
            const idempotencyKey = data.idempotency_key || data.idempotencyKey || null;
            if (idempotencyKey) {
                const existing = db.prepare('SELECT id, bill_number, grand_total, status FROM supplier_bills WHERE idempotency_key = ?').get(idempotencyKey);
                if (existing) {
                    return { success: true, billId: existing.id, billNumber: existing.bill_number, isDuplicate: true };
                }
            }

            const supplierId = parseInt(data.supplier_id);
            if (!supplierId || isNaN(supplierId)) throw new Error("A valid supplier is required.");

            const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
            if (!supplier) throw new Error("Supplier not found.");

            const poId = data.po_id ? parseInt(data.po_id) : null;
            const billNumber = data.bill_number ? String(data.bill_number).trim() : PurchasingService.generateDocNumber('BILL');
            const supplierInvoiceRef = data.supplier_invoice_ref || data.invoice_number || '';
            const billDate = data.bill_date || new Date().toISOString().split('T')[0];
            const dueDate = data.due_date || null;
            const notes = data.notes ? String(data.notes).trim() : '';

            if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
                throw new Error("Supplier bill must contain at least one line item.");
            }

            let subtotal = 0;
            let taxAmount = 0;
            const billItems = [];

            for (let i = 0; i < data.items.length; i++) {
                const raw = data.items[i];
                const itemId = parseInt(raw.item_id);
                const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId);
                if (!item) throw new Error(`Bill line ${i + 1}: Inventory item #${itemId} not found.`);

                const qty = PurchasingService.assertPositive(raw.qty, `Bill line ${i + 1} quantity`);
                const unitCost = PurchasingService.assertNonNegative(raw.unit_cost !== undefined ? raw.unit_cost : item.purchase_price, `Bill line ${i + 1} unit cost`);
                const taxRate = PurchasingService.assertNonNegative(raw.tax_rate !== undefined ? raw.tax_rate : 18, `Bill line ${i + 1} tax rate`);

                const lineSub = PurchasingService.roundMoney(qty * unitCost);
                const lineTax = PurchasingService.roundMoney(lineSub * (taxRate / 100));
                const lineTot = PurchasingService.roundMoney(lineSub + lineTax);

                subtotal += lineSub;
                taxAmount += lineTax;

                billItems.push({
                    po_item_id: raw.po_item_id ? parseInt(raw.po_item_id) : null,
                    item_id: itemId,
                    qty,
                    unit_cost: unitCost,
                    tax_rate: taxRate,
                    tax_amount: lineTax,
                    line_total: lineTot
                });
            }

            subtotal = PurchasingService.roundMoney(subtotal);
            taxAmount = PurchasingService.roundMoney(taxAmount);
            const transportCost = PurchasingService.assertNonNegative(data.transport_cost || 0, 'transport cost');
            const discount = PurchasingService.assertNonNegative(data.discount || 0, 'discount');
            const grandTotal = PurchasingService.roundMoney(Math.max(0, subtotal + taxAmount + transportCost - discount));

            const cgst = PurchasingService.roundMoney(taxAmount / 2);
            const sgst = PurchasingService.roundMoney(taxAmount / 2);
            const igst = 0;

            const insertBillStmt = db.prepare(`
                INSERT INTO supplier_bills (
                    bill_number, supplier_id, po_id, supplier_invoice_ref, bill_date, due_date,
                    subtotal, tax_amount, cgst_amount, sgst_amount, igst_amount, transport_cost,
                    discount, grand_total, paid_amount, credited_amount, outstanding_amount,
                    status, notes, created_by, idempotency_key
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'Posted', ?, ?, ?)
            `);

            const billRes = insertBillStmt.run(
                billNumber, supplierId, poId, supplierInvoiceRef, billDate, dueDate,
                subtotal, taxAmount, cgst, sgst, igst, transportCost,
                discount, grandTotal, grandTotal, notes, session.user ? session.user.name : 'System',
                idempotencyKey
            );
            const billId = billRes.lastInsertRowid;

            const insertBillItemStmt = db.prepare(`
                INSERT INTO supplier_bill_items (
                    bill_id, po_item_id, item_id, qty, unit_cost, tax_rate, tax_amount, line_total
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const bi of billItems) {
                insertBillItemStmt.run(
                    billId, bi.po_item_id, bi.item_id, bi.qty, bi.unit_cost, bi.tax_rate, bi.tax_amount, bi.line_total
                );
            }

            // Record in Supplier Payable Ledger (CREDIT increases payable liability)
            db.prepare(`
                INSERT INTO supplier_ledger (
                    supplier_id, entry_date, entry_type, amount, direction, source_type, source_id, reason, created_by
                ) VALUES (?, ?, 'SUPPLIER_BILL', ?, 'CREDIT', 'supplier_bill', ?, ?, ?)
            `).run(
                supplierId, billDate, grandTotal, billId,
                `Posted Supplier Bill #${billNumber} (Inv: ${supplierInvoiceRef || 'N/A'})`,
                session.user ? session.user.name : 'System'
            );

            // Synchronize cached supplier balance
            const newBal = PurchasingService.syncSupplierBalance(supplierId, db);

            return {
                success: true,
                billId,
                billNumber,
                grandTotal,
                outstandingAmount: grandTotal,
                supplierBalance: newBal
            };
        });

        return tx();
    },

    getSupplierBills: (supplierId = null) => {
        let query = `
            SELECT b.*, s.name as supplier_name, po.po_number
            FROM supplier_bills b
            JOIN suppliers s ON b.supplier_id = s.id
            LEFT JOIN purchase_orders po ON b.po_id = po.id
            WHERE 1=1
        `;
        const params = [];
        if (supplierId) {
            query += ' AND b.supplier_id = ?';
            params.push(supplierId);
        }
        query += ' ORDER BY b.created_at DESC';
        return db.prepare(query).all(...params);
    },

    // ──────────────────────────────────────────────────────────────
    // 4. Supplier Payments & Settlement
    // ──────────────────────────────────────────────────────────────

    recordSupplierPayment: (data, session = { user: { name: 'Admin', role: 'Admin' } }) => {
        const tx = db.transaction(() => {
            const idempotencyKey = data.idempotency_key || data.idempotencyKey || null;
            if (idempotencyKey) {
                const existing = db.prepare('SELECT id, payment_number, amount, status FROM supplier_payments WHERE idempotency_key = ?').get(idempotencyKey);
                if (existing) {
                    return { success: true, paymentId: existing.id, paymentNumber: existing.payment_number, isDuplicate: true };
                }
            }

            const supplierId = parseInt(data.supplier_id);
            if (!supplierId || isNaN(supplierId)) throw new Error("A valid supplier is required.");

            const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
            if (!supplier) throw new Error("Supplier not found.");

            const amount = PurchasingService.assertPositive(data.amount, 'payment amount');
            const paymentNumber = data.payment_number ? String(data.payment_number).trim() : PurchasingService.generateDocNumber('PAY');
            const paymentDate = data.payment_date || new Date().toISOString().split('T')[0];
            const paymentMethod = data.payment_method || 'Bank Transfer';
            const referenceNumber = data.reference_number || '';
            const notes = data.notes ? String(data.notes).trim() : '';

            // 1. Process Allocations if supplied
            let totalAllocated = 0;
            const preparedAllocations = [];

            if (data.allocations && Array.isArray(data.allocations) && data.allocations.length > 0) {
                for (let i = 0; i < data.allocations.length; i++) {
                    const alloc = data.allocations[i];
                    const billId = parseInt(alloc.bill_id);
                    const allocAmount = PurchasingService.assertPositive(alloc.amount, `Allocation ${i + 1} amount`);

                    const bill = db.prepare('SELECT * FROM supplier_bills WHERE id = ?').get(billId);
                    if (!bill) throw new Error(`Allocation ${i + 1}: Supplier Bill #${billId} not found.`);
                    if (bill.supplier_id !== supplierId) {
                        throw new Error(`Allocation ${i + 1}: Bill #${bill.bill_number} does not belong to supplier #${supplierId}.`);
                    }

                    if (allocAmount > bill.outstanding_amount) {
                        throw new Error(`Allocation ${i + 1}: Allocated amount (₹${allocAmount}) exceeds bill outstanding balance (₹${bill.outstanding_amount}).`);
                    }

                    totalAllocated += allocAmount;
                    preparedAllocations.push({ bill_id: billId, amount: allocAmount, bill });
                }

                if (totalAllocated > amount) {
                    throw new Error(`Total bill allocations (₹${totalAllocated}) cannot exceed payment amount (₹${amount}).`);
                }
            }

            // 2. Insert Supplier Payment Record
            const insertPayStmt = db.prepare(`
                INSERT INTO supplier_payments (
                    payment_number, supplier_id, payment_date, amount, payment_method,
                    reference_number, notes, status, created_by, idempotency_key
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Recorded', ?, ?)
            `);

            const payRes = insertPayStmt.run(
                paymentNumber, supplierId, paymentDate, amount, paymentMethod,
                referenceNumber, notes, session.user ? session.user.name : 'System',
                idempotencyKey
            );
            const paymentId = payRes.lastInsertRowid;

            // 3. Apply Allocations to Bills
            const insertAllocStmt = db.prepare(`
                INSERT INTO supplier_payment_allocations (payment_id, bill_id, amount)
                VALUES (?, ?, ?)
            `);

            const updateBillStmt = db.prepare(`
                UPDATE supplier_bills
                SET paid_amount = paid_amount + ?,
                    outstanding_amount = outstanding_amount - ?,
                    status = CASE WHEN (outstanding_amount - ?) <= 0.001 THEN 'Paid' ELSE 'Partially Paid' END
                WHERE id = ?
            `);

            for (const alloc of preparedAllocations) {
                insertAllocStmt.run(paymentId, alloc.bill_id, alloc.amount);
                updateBillStmt.run(alloc.amount, alloc.amount, alloc.amount, alloc.bill_id);
            }

            // 4. Record in Supplier Payable Ledger (DEBIT decreases payable liability)
            db.prepare(`
                INSERT INTO supplier_ledger (
                    supplier_id, entry_date, entry_type, amount, direction, source_type, source_id, reason, created_by
                ) VALUES (?, ?, 'SUPPLIER_PAYMENT', ?, 'DEBIT', 'supplier_payment', ?, ?, ?)
            `).run(
                supplierId, paymentDate, amount, paymentId,
                `Supplier Payment #${paymentNumber} via ${paymentMethod} (Ref: ${referenceNumber || 'N/A'})`,
                session.user ? session.user.name : 'System'
            );

            // 5. Synchronize cached supplier balance
            const newBal = PurchasingService.syncSupplierBalance(supplierId, db);

            return {
                success: true,
                paymentId,
                paymentNumber,
                amount,
                totalAllocated,
                supplierBalance: newBal
            };
        });

        return tx();
    },

    reverseSupplierPayment: (paymentId, reason, session = { user: { name: 'Admin', role: 'Admin' } }) => {
        const tx = db.transaction(() => {
            const payment = db.prepare('SELECT * FROM supplier_payments WHERE id = ?').get(paymentId);
            if (!payment) throw new Error(`Supplier Payment #${paymentId} not found.`);
            if (payment.status === 'Reversed') throw new Error("This supplier payment has already been reversed.");

            // Un-allocate from bills
            const allocations = db.prepare('SELECT * FROM supplier_payment_allocations WHERE payment_id = ?').all(paymentId);
            for (const alloc of allocations) {
                db.prepare(`
                    UPDATE supplier_bills
                    SET paid_amount = MAX(0, paid_amount - ?),
                        outstanding_amount = outstanding_amount + ?,
                        status = CASE WHEN (paid_amount - ?) <= 0 THEN 'Posted' ELSE 'Partially Paid' END
                    WHERE id = ?
                `).run(alloc.amount, alloc.amount, alloc.amount, alloc.bill_id);
            }

            // Mark payment reversed
            db.prepare(`
                UPDATE supplier_payments
                SET status = 'Reversed', reversed_at = CURRENT_TIMESTAMP, reversal_reason = ?
                WHERE id = ?
            `).run(reason || 'Payment reversed', paymentId);

            // Add reverse CREDIT ledger entry
            db.prepare(`
                INSERT INTO supplier_ledger (
                    supplier_id, entry_date, entry_type, amount, direction, source_type, source_id, reason, created_by
                ) VALUES (?, CURRENT_DATE, 'PAYMENT_REVERSAL', ?, 'CREDIT', 'supplier_payment', ?, ?, ?)
            `).run(
                payment.supplier_id, payment.amount, paymentId,
                `Reversal of Payment #${payment.payment_number}: ${reason || 'Reversed by admin'}`,
                session.user ? session.user.name : 'System'
            );

            const newBal = PurchasingService.syncSupplierBalance(payment.supplier_id, db);
            return { success: true, supplierBalance: newBal };
        });
        return tx();
    },

    getSupplierPayments: (supplierId = null) => {
        let query = `
            SELECT p.*, s.name as supplier_name
            FROM supplier_payments p
            JOIN suppliers s ON p.supplier_id = s.id
            WHERE 1=1
        `;
        const params = [];
        if (supplierId) {
            query += ' AND p.supplier_id = ?';
            params.push(supplierId);
        }
        query += ' ORDER BY p.created_at DESC';
        const payments = db.prepare(query).all(...params);

        for (const p of payments) {
            p.allocations = db.prepare(`
                SELECT a.*, b.bill_number, b.grand_total as bill_total
                FROM supplier_payment_allocations a
                JOIN supplier_bills b ON a.bill_id = b.id
                WHERE a.payment_id = ?
            `).all(p.id);
        }
        return payments;
    },

    // ──────────────────────────────────────────────────────────────
    // 5. Purchase Returns & Credits
    // ──────────────────────────────────────────────────────────────

    createPurchaseReturn: (data, session = { user: { name: 'Admin', role: 'Admin' } }) => {
        const tx = db.transaction(() => {
            const idempotencyKey = data.idempotency_key || data.idempotencyKey || null;
            if (idempotencyKey) {
                const existing = db.prepare('SELECT id, return_number, credit_amount, status FROM purchase_returns WHERE idempotency_key = ?').get(idempotencyKey);
                if (existing) {
                    return { success: true, returnId: existing.id, returnNumber: existing.return_number, isDuplicate: true };
                }
            }

            const itemId = parseInt(data.item_id);
            if (!itemId || isNaN(itemId)) throw new Error("A valid inventory item is required.");

            const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId);
            if (!item) throw new Error("Inventory product not found.");

            const supplierId = parseInt(data.supplier_id || item.supplier_id || 1);
            const locationId = parseInt(data.location_id || item.storage_location_id || 1);
            const qty = PurchasingService.assertPositive(data.qty || data.qty_returned, 'return quantity');
            const unitCost = PurchasingService.assertNonNegative(data.unit_cost !== undefined ? data.unit_cost : item.average_cost, 'unit cost');
            const creditAmount = PurchasingService.assertNonNegative(data.credit_amount !== undefined ? data.credit_amount : (qty * unitCost), 'credit amount');
            const reason = data.reason ? String(data.reason).trim() : 'Defective / Damaged goods returned';
            const poId = data.po_id ? parseInt(data.po_id) : null;
            const receiptId = data.receipt_id ? parseInt(data.receipt_id) : null;
            const returnNumber = data.return_number ? String(data.return_number).trim() : PurchasingService.generateDocNumber('RET');

            // 1. Verify available on-hand stock at location
            const locStock = db.prepare('SELECT * FROM inventory_location_stock WHERE item_id = ? AND location_id = ?').get(itemId, locationId);
            const availableStock = locStock ? locStock.current_stock : 0;
            if (availableStock < qty) {
                throw new Error(`Insufficient on-hand stock at location #${locationId}. Available: ${availableStock}, Requested return: ${qty}.`);
            }

            // 2. Deduct physical stock
            db.prepare('UPDATE inventory_items SET current_stock = MAX(0, current_stock - ?) WHERE id = ?').run(qty, itemId);
            db.prepare('UPDATE inventory_location_stock SET current_stock = MAX(0, current_stock - ?) WHERE item_id = ? AND location_id = ?').run(qty, itemId, locationId);

            // 3. Insert Purchase Return record
            const insertRetStmt = db.prepare(`
                INSERT INTO purchase_returns (
                    return_number, po_id, receipt_id, supplier_id, item_id, location_id,
                    qty_returned, unit_cost, credit_amount, status, reason, created_by, idempotency_key
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Posted', ?, ?, ?)
            `);

            const retRes = insertRetStmt.run(
                returnNumber, poId, receiptId, supplierId, itemId, locationId,
                qty, unitCost, creditAmount, reason, session.user ? session.user.name : 'System',
                idempotencyKey
            );
            const returnId = retRes.lastInsertRowid;

            // 4. Log Stock Transaction (Negative quantity)
            db.prepare(`
                INSERT INTO stock_transactions (
                    item_id, type, qty, cost, reference_type, reference_id, reason, operator
                ) VALUES (?, 'return', ?, ?, 'purchase_return', ?, ?, ?)
            `).run(
                itemId, -qty, unitCost, returnId,
                `Purchase Return #${returnNumber}: ${reason}`, session.user ? session.user.name : 'System'
            );

            // 5. Update PO Item returned quantity if linked
            if (poId) {
                db.prepare(`
                    UPDATE purchase_order_items
                    SET returned_qty = returned_qty + ?
                    WHERE po_id = ? AND item_id = ?
                `).run(qty, poId, itemId);
            }

            // 6. Record in Supplier Payable Ledger (DEBIT reduces liability)
            if (creditAmount > 0) {
                db.prepare(`
                    INSERT INTO supplier_ledger (
                        supplier_id, entry_date, entry_type, amount, direction, source_type, source_id, reason, created_by
                    ) VALUES (?, CURRENT_DATE, 'PURCHASE_RETURN_CREDIT', ?, 'DEBIT', 'purchase_return', ?, ?, ?)
                `).run(
                    supplierId, creditAmount, returnId,
                    `Debit Note / Credit for Return #${returnNumber} (${item.name} x ${qty})`,
                    session.user ? session.user.name : 'System'
                );

                PurchasingService.syncSupplierBalance(supplierId, db);
            }

            return {
                success: true,
                returnId,
                returnNumber,
                creditAmount
            };
        });

        return tx();
    },

    getPurchaseReturns: (supplierId = null) => {
        let query = `
            SELECT pr.*, s.name as supplier_name, i.name as item_name, i.sku, i.unit, l.name as location_name
            FROM purchase_returns pr
            JOIN suppliers s ON pr.supplier_id = s.id
            JOIN inventory_items i ON pr.item_id = i.id
            LEFT JOIN inventory_locations l ON pr.location_id = l.id
            WHERE 1=1
        `;
        const params = [];
        if (supplierId) {
            query += ' AND pr.supplier_id = ?';
            params.push(supplierId);
        }
        query += ' ORDER BY pr.created_at DESC';
        return db.prepare(query).all(...params);
    },

    // ──────────────────────────────────────────────────────────────
    // 6. PO Cancellation & Closure
    // ──────────────────────────────────────────────────────────────

    cancelPurchaseOrder: (poId, reason = 'Cancelled by user', session = { user: { name: 'Admin', role: 'Admin' } }) => {
        const tx = db.transaction(() => {
            const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
            if (!po) throw new Error(`Purchase Order #${poId} not found.`);

            if (po.status === 'Cancelled' || po.status === 'Closed') {
                return { success: true, alreadyCancelled: true, status: po.status };
            }

            if (po.status === 'Fully Received') {
                throw new Error("Cannot cancel a fully received Purchase Order. Please use Purchase Return or Credit workflows.");
            }

            if (po.status === 'Partially Received') {
                // Cancel ONLY the remaining unreceived quantities
                db.prepare(`
                    UPDATE purchase_order_items
                    SET cancelled_qty = MAX(0, ordered_qty - received_qty)
                    WHERE po_id = ?
                `).run(poId);

                // Set PO status to Closed
                db.prepare(`
                    UPDATE purchase_orders
                    SET status = 'Closed', closed_at = CURRENT_TIMESTAMP, notes = COALESCE(notes, '') || ?
                    WHERE id = ?
                `).run(` [Remainder cancelled: ${reason}]`, poId);

                return { success: true, status: 'Closed', partialRemainderCancelled: true };
            }

            // For Draft, Approved, or Ordered with 0 receipts: Cancel completely
            db.prepare(`
                UPDATE purchase_order_items
                SET cancelled_qty = ordered_qty
                WHERE po_id = ?
            `).run(poId);

            db.prepare(`
                UPDATE purchase_orders
                SET status = 'Cancelled', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = ?
                WHERE id = ?
            `).run(reason, poId);

            return { success: true, status: 'Cancelled' };
        });

        return tx();
    },

    closePurchaseOrder: (poId, session = { user: { name: 'Admin', role: 'Admin' } }) => {
        const tx = db.transaction(() => {
            const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
            if (!po) throw new Error(`Purchase Order #${poId} not found.`);

            db.prepare(`
                UPDATE purchase_orders
                SET status = 'Closed', closed_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(poId);

            return { success: true, status: 'Closed' };
        });
        return tx();
    },

    // ──────────────────────────────────────────────────────────────
    // 7. Supplier Payable Ledger & Statements
    // ──────────────────────────────────────────────────────────────

    getSupplierLedger: (supplierId) => {
        return db.prepare(`
            SELECT * FROM supplier_ledger
            WHERE supplier_id = ?
            ORDER BY entry_date ASC, id ASC
        `).all(supplierId);
    },

    getSupplierStatement: (supplierId) => {
        const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
        if (!supplier) return null;

        const ledger = PurchasingService.getSupplierLedger(supplierId);
        let runningBalance = 0;
        const statementEntries = ledger.map(entry => {
            if (entry.direction === 'CREDIT') {
                runningBalance += entry.amount;
            } else {
                runningBalance -= entry.amount;
            }
            return {
                ...entry,
                running_balance: PurchasingService.roundMoney(runningBalance)
            };
        });

        const bills = PurchasingService.getSupplierBills(supplierId);
        const payments = PurchasingService.getSupplierPayments(supplierId);
        const returns = PurchasingService.getPurchaseReturns(supplierId);
        const purchaseOrders = PurchasingService.getPurchaseOrders({ supplier_id: supplierId });

        return {
            supplier,
            derived_balance: PurchasingService.roundMoney(runningBalance),
            cached_balance: supplier.outstanding_balance,
            is_reconciled: Math.abs(runningBalance - supplier.outstanding_balance) < 0.01,
            statement: statementEntries,
            bills,
            payments,
            returns,
            purchase_orders: purchaseOrders
        };
    },

    // ──────────────────────────────────────────────────────────────
    // 8. Purchasing Integrity & Reconciliation Audit
    // ──────────────────────────────────────────────────────────────

    getPurchasingIntegrityReport: () => {
        const issues = [];

        // 1. Check for Over-receipt in PO Lines
        const overReceivedLines = db.prepare(`
            SELECT poi.*, po.po_number, i.name as item_name
            FROM purchase_order_items poi
            JOIN purchase_orders po ON poi.po_id = po.id
            JOIN inventory_items i ON poi.item_id = i.id
            WHERE poi.received_qty > (poi.ordered_qty + 0.001)
        `).all();
        if (overReceivedLines.length > 0) {
            issues.push({
                severity: 'CRITICAL',
                type: 'OVER_RECEIPT',
                count: overReceivedLines.length,
                message: `${overReceivedLines.length} PO lines have received_qty exceeding ordered_qty.`,
                details: overReceivedLines
            });
        }

        // 2. Check for Cached Balance vs Ledger Mismatches
        const suppliers = db.prepare('SELECT id, name, outstanding_balance FROM suppliers').all();
        const balanceMismatches = [];
        for (const s of suppliers) {
            const row = db.prepare(`
                SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount WHEN direction = 'DEBIT' THEN -amount ELSE 0 END), 0) as derived
                FROM supplier_ledger WHERE supplier_id = ?
            `).get(s.id);
            const derived = PurchasingService.roundMoney(row ? row.derived : 0);
            if (Math.abs(derived - s.outstanding_balance) > 0.01) {
                balanceMismatches.push({
                    supplier_id: s.id,
                    supplier_name: s.name,
                    cached_balance: s.outstanding_balance,
                    derived_balance: derived,
                    diff: PurchasingService.roundMoney(derived - s.outstanding_balance)
                });
            }
        }
        if (balanceMismatches.length > 0) {
            issues.push({
                severity: 'HIGH',
                type: 'SUPPLIER_BALANCE_MISMATCH',
                count: balanceMismatches.length,
                message: `${balanceMismatches.length} suppliers have cached balances diverging from the immutable ledger.`,
                details: balanceMismatches
            });
        }

        // 3. Check for Orphaned Allocations or Over-Allocated Payments
        const overAllocatedPayments = db.prepare(`
            SELECT p.id, p.payment_number, p.amount, SUM(a.amount) as total_allocated
            FROM supplier_payments p
            JOIN supplier_payment_allocations a ON p.id = a.payment_id
            GROUP BY p.id
            HAVING total_allocated > (p.amount + 0.001)
        `).all();
        if (overAllocatedPayments.length > 0) {
            issues.push({
                severity: 'CRITICAL',
                type: 'PAYMENT_OVER_ALLOCATION',
                count: overAllocatedPayments.length,
                message: `${overAllocatedPayments.length} payments have allocations exceeding the paid amount.`,
                details: overAllocatedPayments
            });
        }

        // 4. Check for Bills with negative outstanding
        const negativeBills = db.prepare('SELECT * FROM supplier_bills WHERE outstanding_amount < -0.001').all();
        if (negativeBills.length > 0) {
            issues.push({
                severity: 'HIGH',
                type: 'NEGATIVE_BILL_OUTSTANDING',
                count: negativeBills.length,
                message: `${negativeBills.length} supplier bills have negative outstanding balances.`,
                details: negativeBills
            });
        }

        return {
            timestamp: new Date().toISOString(),
            status: issues.length === 0 ? 'HEALTHY' : 'WARNINGS_FOUND',
            issueCount: issues.length,
            issues
        };
    }
};

module.exports = PurchasingService;
