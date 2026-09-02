/**
 * Authoritative Order Service
 * 
 * Manages the entire lifecycle of an order:
 * - Validation & normalization
 * - File staging & safe commit
 * - Atomic database transaction (Customer, Order, Order Items, GST Invoice, Payments, Production, Print, Audit)
 * - Decoupled state machines
 * - Idempotency enforcement via submission_id
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app } = require('electron');
const db = require('../database/db');
const PricingEngine = require('./pricing-engine');
const ReconciliationService = require('./reconciliation-service');
const eventBus = require('../events/EventBus');
const { EventTypes } = require('../events/EventTypes');

class OrderService {
    /**
     * Gets permanent order storage directory
     */
    static getOrderPermanentDir(orderId, customerName = 'Walk-in') {
        const cleanName = customerName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const dateStr = new Date().toISOString().split('T')[0];
        const folderName = `Order_${dateStr}_${String(orderId).padStart(4, '0')}`;
        
        let baseDir;
        try {
            baseDir = app ? path.join(app.getPath('documents'), 'PrintShopManager') : path.join(os.homedir(), 'Documents', 'PrintShopManager');
        } catch (e) {
            baseDir = path.join(os.homedir(), 'Documents', 'PrintShopManager');
        }

        const fullPath = path.join(baseDir, 'Orders', cleanName, folderName);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
        return fullPath;
    }

    /**
     * Generate unique legal GST Invoice Number
     */
    static generateInvoiceNumber() {
        const today = new Date();
        const dateStr = today.getFullYear() + 
            String(today.getMonth() + 1).padStart(2, '0') + 
            String(today.getDate()).padStart(2, '0');
        
        const pattern = `GST-${dateStr}-%`;
        const lastInvoice = db.prepare('SELECT invoice_number FROM gst_invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1').get(pattern);
        
        let seq = 1;
        if (lastInvoice) {
            const parts = lastInvoice.invoice_number.split('-');
            const lastSeq = parseInt(parts[2], 10);
            if (!isNaN(lastSeq)) seq = lastSeq + 1;
        }
        
        return `GST-${dateStr}-${String(seq).padStart(4, '0')}`;
    }

    /**
     * Submits and commits a new order atomically
     * @param {Object} sender - WebContents sender
     * @param {Object} payload - Order parameters
     * @returns {Promise<Object>} Structured result
     */
    static async submitOrder(sender, payload = {}) {
        if (!payload || typeof payload !== 'object') {
            return { success: false, error: 'Invalid order payload', code: 'INVALID_PAYLOAD' };
        }

        // 1. Idempotency Check
        const submissionId = payload.submissionId || payload.submission_id || crypto.randomUUID();
        const existingOrder = db.prepare('SELECT * FROM orders WHERE submission_id = ?').get(submissionId);
        if (existingOrder) {
            console.log(`[OrderService] Idempotency match: returning existing order #${existingOrder.id}`);
            const inv = db.prepare('SELECT * FROM gst_invoices WHERE order_id = ?').get(existingOrder.id);
            const pj = db.prepare('SELECT * FROM production_jobs WHERE order_id = ?').get(existingOrder.id);
            const prn = db.prepare('SELECT * FROM print_jobs WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(existingOrder.id);

            return {
                success: true,
                isDuplicate: true,
                orderId: existingOrder.id,
                invoiceId: inv ? inv.id : null,
                invoiceNumber: inv ? inv.invoice_number : null,
                productionJobId: pj ? pj.id : null,
                printJobId: prn ? prn.id : null,
                orderStatus: existingOrder.status,
                paymentStatus: existingOrder.payment_status,
                printStatus: prn ? prn.status : 'Not Queued',
                grandTotal: existingOrder.total_price,
                warnings: []
            };
        }

        // 2. Validate Items
        const rawItems = Array.isArray(payload.items) && payload.items.length > 0 ? payload.items : [payload];
        if (rawItems.length === 0 || !rawItems[0]) {
            return { success: false, error: 'Order must contain at least one valid item', code: 'NO_ITEMS' };
        }

        // 3. Validate Source Files & Path Safety
        for (const item of rawItems) {
            const filePath = item.filePath || item.file_path;
            if (filePath && typeof filePath === 'string') {
                // Check path safety (prevent path traversal attacks)
                if (filePath.includes('..') || filePath.includes('\0')) {
                    return { success: false, error: `Unsafe file path detected: ${filePath}`, code: 'UNSAFE_PATH' };
                }
                if (!fs.existsSync(filePath)) {
                    return { success: false, error: `Source file does not exist: ${path.basename(filePath)}`, code: 'FILE_NOT_FOUND' };
                }
                try {
                    const stats = fs.statSync(filePath);
                    if (stats.size === 0) {
                        return { success: false, error: `File is empty (0 bytes): ${path.basename(filePath)}`, code: 'EMPTY_FILE' };
                    }
                } catch (e) {
                    return { success: false, error: `Cannot read source file: ${e.message}`, code: 'FILE_READ_ERROR' };
                }
            }
        }

        // 4. Calculate Authoritative Quantities & Pricing
        const pricingSnapshot = PricingEngine.calculateOrderPricing(rawItems, {
            customerState: payload.state || payload.stateType || 'Local',
            discount: payload.discount || payload.discountAmount || 0,
            gstin: payload.gstin || ''
        });

        // 5. Customer Identification (Walk-in vs Registered)
        let customerId = null;
        let customerNameSnapshot = payload.customerName || payload.name || 'Walk-in Customer';
        let customerPhoneSnapshot = payload.customerPhone || payload.phone || '';
        let customerGstinSnapshot = payload.customerGstin || payload.gstin || '';

        const cleanPhone = customerPhoneSnapshot.replace(/[^0-9]/g, '');
        // Only link customer record if genuine 10-digit phone provided and not generic placeholder
        if (cleanPhone.length >= 10 && cleanPhone !== '0000000000') {
            try {
                let cust = db.prepare('SELECT id, name, phone, gstin, state FROM customers WHERE phone = ?').get(cleanPhone);
                if (cust) {
                    customerId = cust.id;
                    customerNameSnapshot = cust.name;
                    if (customerGstinSnapshot && customerGstinSnapshot !== cust.gstin) {
                        db.prepare('UPDATE customers SET gstin = ? WHERE id = ?').run(customerGstinSnapshot, cust.id);
                    }
                } else if (payload.customerName && payload.customerName !== 'Guest Customer') {
                    const createRes = db.prepare(`
                        INSERT INTO customers (name, phone, gstin, state)
                        VALUES (?, ?, ?, ?)
                    `).run(payload.customerName, cleanPhone, customerGstinSnapshot || null, payload.state || 'Local');
                    customerId = createRes.lastInsertRowid;
                }
            } catch (custErr) {
                console.warn('[OrderService] Customer lookup warning:', custErr.message);
            }
        }

        // 6. Payment Allocation
        const paymentInput = payload.payment || {};
        const paymentAmount = Math.max(0, parseFloat(paymentInput.amount) || 0);
        const paymentMethod = paymentInput.method || paymentInput.paymentMethod || 'Cash';
        const paymentRef = paymentInput.reference || paymentInput.referenceNumber || null;

        let paymentStatus = 'Unpaid';
        let recordedPaidAmount = 0;

        if (paymentAmount >= pricingSnapshot.grandTotal && pricingSnapshot.grandTotal > 0) {
            paymentStatus = 'Paid';
            recordedPaidAmount = pricingSnapshot.grandTotal;
        } else if (paymentAmount > 0) {
            paymentStatus = 'Partially Paid';
            recordedPaidAmount = paymentAmount;
        }

        // 7. Action & Status Determination
        const action = (payload.action || 'SAVE').toUpperCase();
        let initialOrderStatus = 'Confirmed';
        let initialProdStatus = 'Waiting';
        let initialPrintStatus = 'Not Queued';

        if (action === 'SCHEDULE') {
            initialOrderStatus = 'Scheduled';
            initialProdStatus = 'Scheduled';
        } else if (action === 'SAVE_AND_PRINT') {
            initialOrderStatus = 'Confirmed';
            initialProdStatus = 'Waiting';
            initialPrintStatus = 'Queued';
        }

        // 8. Safe File Staging
        const stagingBase = ReconciliationService.getStagingBaseDir();
        const stageDir = path.join(stagingBase, `Order_${submissionId}`);
        const stagedFilePaths = [];

        try {
            if (!fs.existsSync(stageDir)) {
                fs.mkdirSync(stageDir, { recursive: true });
            }

            for (let i = 0; i < pricingSnapshot.items.length; i++) {
                const item = pricingSnapshot.items[i];
                if (item.filePath && fs.existsSync(item.filePath)) {
                    const ext = path.extname(item.filePath);
                    const safeName = `item_${i + 1}_${Date.now()}${ext}`;
                    const targetStagePath = path.join(stageDir, safeName);
                    fs.copyFileSync(item.filePath, targetStagePath);

                    // Compute SHA-256 checksum
                    const fileBuf = fs.readFileSync(targetStagePath);
                    const checksum = crypto.createHash('sha256').update(fileBuf).digest('hex');

                    stagedFilePaths.push({
                        itemIndex: i,
                        stagedPath: targetStagePath,
                        fileName: path.basename(item.filePath),
                        checksum
                    });
                }
            }
        } catch (stageErr) {
            // Clean up staging on failure
            try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (e) {}
            return { success: false, error: `File staging failed: ${stageErr.message}`, code: 'STAGING_ERROR' };
        }

        // 9. Atomic SQLite Transaction
        let committedOrderId = null;
        let committedInvoiceId = null;
        let committedInvoiceNumber = null;
        let committedProdJobId = null;
        let committedPrintJobId = null;

        const tx = db.transaction(() => {
            // 9.1 Insert Order
            const stmtOrder = db.prepare(`
                INSERT INTO orders (
                    submission_id, customer_id, customer_name_snapshot, customer_phone_snapshot,
                    customer_gstin_snapshot, total_price, subtotal, taxable_amount, gst_amount,
                    discount_amount, paid_amount, status, payment_status, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const resOrder = stmtOrder.run(
                submissionId,
                customerId,
                customerNameSnapshot,
                customerPhoneSnapshot,
                customerGstinSnapshot,
                pricingSnapshot.grandTotal,
                pricingSnapshot.subtotal,
                pricingSnapshot.taxableAmount,
                pricingSnapshot.gstAmount,
                pricingSnapshot.discountAmount,
                recordedPaidAmount,
                initialOrderStatus,
                paymentStatus,
                payload.notes || null
            );
            committedOrderId = resOrder.lastInsertRowid;

            // 9.2 Insert Order Items
            const stmtItem = db.prepare(`
                INSERT INTO order_items (
                    order_id, file_name, file_path, print_type, paper_size, sides,
                    source_pages, n_up, physical_sheets, logical_pages, pages, copies,
                    unit_price, total_price, price, notes, paper_id, extras_json,
                    product_id, print_profile_id, checksum
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (let i = 0; i < pricingSnapshot.items.length; i++) {
                const item = pricingSnapshot.items[i];
                const staged = stagedFilePaths.find(s => s.itemIndex === i);
                const extrasJson = Array.isArray(item.extras) ? JSON.stringify(item.extras) : null;

                stmtItem.run(
                    committedOrderId,
                    item.fileName,
                    staged ? staged.stagedPath : (item.filePath || null),
                    item.printType,
                    item.paperSize,
                    item.sides,
                    item.sourcePages,
                    item.nUp,
                    item.physicalSheets,
                    item.logicalPages,
                    item.physicalSheets, // legacy pages fallback
                    item.copies,
                    item.unitPrice,
                    item.totalPrice,
                    item.totalPrice,
                    item.notes || null,
                    item.paper_id || item.paperId || null,
                    extrasJson,
                    item.product_id || null,
                    item.print_profile_id || null,
                    staged ? staged.checksum : null
                );
            }

            // 9.3 Create GST Invoice (if enabled)
            if (pricingSnapshot.enableGst) {
                committedInvoiceNumber = this.generateInvoiceNumber();
                const stmtInvoice = db.prepare(`
                    INSERT INTO gst_invoices (
                        order_id, customer_id, invoice_number, invoice_date, subtotal,
                        cgst_total, sgst_total, igst_total, grand_total, state_type,
                        status, payment_status, paid_amount
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                const resInvoice = stmtInvoice.run(
                    committedOrderId,
                    customerId,
                    committedInvoiceNumber,
                    new Date().toISOString().split('T')[0],
                    pricingSnapshot.taxableAmount,
                    pricingSnapshot.cgstTotal,
                    pricingSnapshot.sgstTotal,
                    pricingSnapshot.igstTotal,
                    pricingSnapshot.grandTotal,
                    pricingSnapshot.stateType,
                    paymentStatus === 'Paid' ? 'Paid' : 'Issued',
                    paymentStatus,
                    recordedPaidAmount
                );
                committedInvoiceId = resInvoice.lastInsertRowid;

                const stmtInvItem = db.prepare(`
                    INSERT INTO gst_invoice_items (
                        invoice_id, description, hsn_sac, qty, rate, gst_rate,
                        taxable_value, cgst_amount, sgst_amount, igst_amount, total
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                for (const item of pricingSnapshot.items) {
                    stmtInvItem.run(
                        committedInvoiceId,
                        `${item.paperSize} Document Printing (${item.printType === 'color' ? 'Color' : 'B/W'}, ${item.sides})`,
                        '998911',
                        item.copies,
                        item.unitPrice,
                        item.gstRate,
                        item.taxableValue,
                        item.cgstAmount,
                        item.sgstAmount,
                        item.igstAmount,
                        item.totalPrice
                    );
                }
            }

            // 9.4 Record Payment (if collected)
            if (recordedPaidAmount > 0) {
                const recordedBy = typeof sender?.role === 'string' ? sender.role : (Array.isArray(sender?.role) ? sender.role[0] : 'Operator');
                const stmtPayment = db.prepare(`
                    INSERT INTO payments (
                        order_id, invoice_id, amount, payment_method, reference_number,
                        status, recorded_by
                    ) VALUES (?, ?, ?, ?, ?, 'Completed', ?)
                `);
                stmtPayment.run(
                    committedOrderId,
                    committedInvoiceId,
                    recordedPaidAmount,
                    paymentMethod,
                    paymentRef,
                    recordedBy
                );
            }

            // 9.5 Create Production Job
            const scheduleDetails = payload.scheduleDetails || {};
            const finalJobTitle = `${customerNameSnapshot} — Order #${committedOrderId}`;
            const stmtProd = db.prepare(`
                INSERT INTO production_jobs (
                    order_id, customer_id, job_name, status, priority,
                    assigned_printer, assigned_operator, paper_size, color_mode,
                    total_pages, copies, scheduled_start, due_time, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const resProd = stmtProd.run(
                committedOrderId,
                customerId,
                finalJobTitle,
                initialProdStatus,
                scheduleDetails.priority || 'Normal',
                scheduleDetails.assignedPrinter || payload.default_printer || null,
                scheduleDetails.operator || 'Operator',
                pricingSnapshot.items[0]?.paperSize || 'A4',
                pricingSnapshot.items[0]?.printType || 'B&W',
                pricingSnapshot.items.reduce((s, i) => s + i.physicalSheets, 0),
                pricingSnapshot.items[0]?.copies || 1,
                scheduleDetails.scheduledStart || null,
                scheduleDetails.dueTime || null,
                payload.notes || null
            );
            committedProdJobId = resProd.lastInsertRowid;

            // 9.6 Create Print Job (if Save & Print)
            if (action === 'SAVE_AND_PRINT') {
                const stmtPrint = db.prepare(`
                    INSERT INTO print_jobs (
                        order_id, file_path, printer_name, status, copies, pages
                    ) VALUES (?, ?, ?, 'Queued', ?, ?)
                `);

                const resPrint = stmtPrint.run(
                    committedOrderId,
                    stagedFilePaths[0]?.stagedPath || null,
                    payload.default_printer || 'Default',
                    pricingSnapshot.items[0]?.copies || 1,
                    pricingSnapshot.items.reduce((s, i) => s + i.physicalSheets, 0)
                );
                committedPrintJobId = resPrint.lastInsertRowid;
            }

            // 9.7 Audit activity
            try {
                db.prepare(`
                    INSERT INTO activities (description, type)
                    VALUES (?, 'order_created')
                `).run(`Order #${committedOrderId} created (${paymentStatus}) - ₹${pricingSnapshot.grandTotal}`);
            } catch (e) {}
        });

        // Execute transaction
        try {
            tx();
        } catch (dbErr) {
            // Clean up staging files on DB rollback
            try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (e) {}
            console.error('[OrderService] Transaction rollback:', dbErr);
            return { success: false, error: `Database transaction failed: ${dbErr.message}`, code: 'DB_ERROR' };
        }

        // 10. Commit Staged Files to Permanent Order Storage
        try {
            const finalDir = this.getOrderPermanentDir(committedOrderId, customerNameSnapshot);
            const committedPaths = [];

            for (const staged of stagedFilePaths) {
                const finalPath = path.join(finalDir, staged.fileName);
                fs.copyFileSync(staged.stagedPath, finalPath);
                committedPaths.push({ itemIndex: staged.itemIndex, finalPath });
            }

            // Update permanent paths in DB
            const updateItemStmt = db.prepare('UPDATE order_items SET file_path = ? WHERE order_id = ? AND id = (SELECT id FROM order_items WHERE order_id = ? LIMIT 1 OFFSET ?)');
            committedPaths.forEach((cp, idx) => {
                updateItemStmt.run(cp.finalPath, committedOrderId, committedOrderId, idx);
            });

            // Clean up staging folder now that commit succeeded
            fs.rmSync(stageDir, { recursive: true, force: true });
        } catch (commitErr) {
            console.warn('[OrderService] Warning moving staged files to permanent storage:', commitErr.message);
        }

        // 11. Async Print Spooling (For Save & Print)
        if (action === 'SAVE_AND_PRINT' && committedPrintJobId) {
            setImmediate(async () => {
                try {
                    const { printFile } = require('../printer');
                    const firstItem = pricingSnapshot.items[0];
                    const printOptions = {
                        printerName: payload.default_printer || 'Default',
                        printType: firstItem?.printType || 'B&W',
                        paperSize: firstItem?.paperSize || 'A4',
                        sides: firstItem?.sides || 'Single',
                        copies: firstItem?.copies || 1,
                        orderId: committedOrderId,
                        printJobId: committedPrintJobId
                    };
                    
                    const printPayload = stagedFilePaths.map(s => ({ path: s.stagedPath, ext: path.extname(s.stagedPath) }));
                    await printFile(printPayload, printOptions.printerName, printOptions);
                } catch (printErr) {
                    console.error(`[OrderService] Async print spool error for order #${committedOrderId}:`, printErr.message);
                }
            });
        }

        // Publish EDA Event
        eventBus.publish(EventTypes.ORDER_CREATED, {
            orderId: committedOrderId,
            invoiceId: committedInvoiceId,
            grandTotal: pricingSnapshot.grandTotal,
            paymentStatus
        }, { sourceModule: 'OrderService' });

        return {
            success: true,
            orderId: committedOrderId,
            invoiceId: committedInvoiceId,
            invoiceNumber: committedInvoiceNumber,
            productionJobId: committedProdJobId,
            printJobId: committedPrintJobId,
            orderStatus: initialOrderStatus,
            paymentStatus,
            printStatus: initialPrintStatus,
            grandTotal: pricingSnapshot.grandTotal,
            warnings: []
        };
    }

    /**
     * Cancels an existing order safely
     * @param {Object} sender 
     * @param {number} orderId 
     * @param {string} reason 
     */
    static cancelOrder(sender, orderId, reason = 'User requested cancellation') {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        if (!order) {
            return { success: false, error: 'Order not found', code: 'NOT_FOUND' };
        }

        if (order.status === 'Cancelled') {
            return { success: true, message: 'Order is already cancelled', alreadyCancelled: true };
        }

        if (order.status === 'Completed') {
            return { success: false, error: 'Cannot cancel a completed order', code: 'CANNOT_CANCEL_COMPLETED' };
        }

        const isPaid = order.payment_status === 'Paid' || order.payment_status === 'Partially Paid';
        const finalPaymentStatus = isPaid ? 'Refunded' : 'Voided';

        const tx = db.transaction(() => {
            // Update order
            db.prepare(`
                UPDATE orders 
                SET status = 'Cancelled', payment_status = ?, notes = COALESCE(notes || ' | ', '') || ?
                WHERE id = ?
            `).run(finalPaymentStatus, `[Cancelled: ${reason}]`, orderId);

            // Update production jobs
            db.prepare(`
                UPDATE production_jobs 
                SET status = 'Cancelled', notes = COALESCE(notes || ' | ', '') || ?
                WHERE order_id = ? AND status NOT IN ('Completed', 'Delivered')
            `).run(`[Cancelled: ${reason}]`, orderId);

            // Cancel queued print jobs
            db.prepare(`
                UPDATE print_jobs 
                SET status = 'Cancelled', error_message = ?
                WHERE order_id = ? AND status IN ('Queued', 'Preparing')
            `).run(`Cancelled by user (${reason})`, orderId);

            // Cancel invoice
            db.prepare(`
                UPDATE gst_invoices 
                SET status = 'Cancelled', payment_status = ?
                WHERE order_id = ?
            `).run(finalPaymentStatus, orderId);

            // Log activity
            try {
                db.prepare('INSERT INTO activities (description, type) VALUES (?, ?)').run(`Order #${orderId} cancelled: ${reason}`, 'order_cancelled');
            } catch (e) {}
        });

        try {
            tx();
            return { success: true, orderId, orderStatus: 'Cancelled', paymentStatus: finalPaymentStatus };
        } catch (err) {
            return { success: false, error: err.message, code: 'DB_ERROR' };
        }
    }

    /**
     * Retries printing for an existing order without duplicating business records
     */
    static async retryPrint(sender, orderId, options = {}) {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        if (!order) {
            return { success: false, error: 'Order not found', code: 'NOT_FOUND' };
        }

        const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
        if (!items || items.length === 0) {
            return { success: false, error: 'Order has no items to print', code: 'NO_ITEMS' };
        }

        const targetPrinter = options.printerName || 'Default';
        const printPayload = items.map(item => ({
            path: item.file_path,
            ext: path.extname(item.file_path || '.pdf')
        }));

        // Insert new print job attempt
        let newPrintJobId = null;
        try {
            const res = db.prepare(`
                INSERT INTO print_jobs (order_id, file_path, printer_name, status, copies, pages, attempt_count)
                VALUES (?, ?, ?, 'Queued', ?, ?, (SELECT IFNULL(MAX(attempt_count), 0) + 1 FROM print_jobs WHERE order_id = ?))
            `).run(
                orderId,
                items[0]?.file_path || null,
                targetPrinter,
                items[0]?.copies || 1,
                items.reduce((s, i) => s + (i.physical_sheets || i.pages || 1), 0),
                orderId
            );
            newPrintJobId = res.lastInsertRowid;
        } catch (e) {
            console.error('[OrderService] Retry print job DB error:', e);
        }

        // Trigger printer
        try {
            const { printFile } = require('../printer');
            const printOptions = {
                printerName: targetPrinter,
                orderId,
                printJobId: newPrintJobId,
                ...options
            };
            const printResult = await printFile(printPayload, targetPrinter, printOptions);
            return {
                success: printResult.success,
                orderId,
                printJobId: newPrintJobId,
                error: printResult.error
            };
        } catch (err) {
            return { success: false, error: err.message, code: 'PRINT_ERROR' };
        }
    }

    /**
     * Records an incremental payment for an order
     */
    static recordPayment(sender, payload = {}) {
        const orderId = parseInt(payload.orderId, 10);
        const amount = Math.max(0, parseFloat(payload.amount) || 0);
        const method = payload.paymentMethod || 'Cash';
        const ref = payload.referenceNumber || null;

        if (isNaN(orderId) || amount <= 0) {
            return { success: false, error: 'Valid order ID and positive payment amount are required.', code: 'INVALID_INPUT' };
        }

        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        if (!order) return { success: false, error: 'Order not found', code: 'NOT_FOUND' };

        const currentPaid = parseFloat(order.paid_amount) || 0;
        const grandTotal = parseFloat(order.total_price) || 0;
        const newPaid = Math.min(grandTotal, currentPaid + amount);

        let newPaymentStatus = 'Partially Paid';
        if (newPaid >= grandTotal) {
            newPaymentStatus = 'Paid';
        }

        const recordedBy = typeof sender?.role === 'string' ? sender.role : (Array.isArray(sender?.role) ? sender.role[0] : 'Operator');
        const tx = db.transaction(() => {
            // Insert payment ledger record
            db.prepare(`
                INSERT INTO payments (order_id, invoice_id, amount, payment_method, reference_number, status, recorded_by)
                VALUES (?, (SELECT id FROM gst_invoices WHERE order_id = ?), ?, ?, ?, 'Completed', ?)
            `).run(orderId, orderId, amount, method, ref, recordedBy);

            // Update order
            db.prepare(`
                UPDATE orders 
                SET paid_amount = ?, payment_status = ?
                WHERE id = ?
            `).run(newPaid, newPaymentStatus, orderId);

            // Update GST Invoice
            db.prepare(`
                UPDATE gst_invoices 
                SET paid_amount = ?, payment_status = ?, status = CASE WHEN ? = 'Paid' THEN 'Paid' ELSE status END
                WHERE order_id = ?
            `).run(newPaid, newPaymentStatus, newPaymentStatus, orderId);
        });

        try {
            tx();
            return { success: true, orderId, newPaidAmount: newPaid, paymentStatus: newPaymentStatus };
        } catch (err) {
            return { success: false, error: err.message, code: 'DB_ERROR' };
        }
    }
}

module.exports = OrderService;
