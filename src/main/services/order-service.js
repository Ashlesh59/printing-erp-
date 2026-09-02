/**
 * Authoritative Order Service
 * 
 * Manages the entire lifecycle of an order:
 * - Validation & normalization
 * - File staging & safe commit directly to verified permanent storage
 * - Atomic database transaction (Customer, Order, Order Items, GST Invoice, Payments, Production, Print, Audit, Reservations)
 * - Decoupled state machines
 * - Idempotency enforcement via submission_id
 * - Strict financial accounting (no overpayment, explicit refund tracking)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app } = require('electron');
const db = require('../database/db');
const PricingEngine = require('./pricing-engine');
const eventBus = require('../events/EventBus');
const { EventTypes } = require('../events/EventTypes');

class OrderService {
    /**
     * Gets permanent order storage directory
     */
    static getOrderPermanentDir(identifier, customerName = 'Walk-in') {
        const cleanName = String(customerName).replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'walk_in';
        const dateStr = new Date().toISOString().split('T')[0];
        const cleanId = String(identifier).replace(/[^a-z0-9_-]/gi, '_');
        const folderName = `Order_${dateStr}_${cleanId}`;
        
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
     * @param {Object} senderOrPayload - WebContents sender or order payload
     * @param {Object} payloadOrSender - Order parameters or session
     * @returns {Promise<Object>} Structured result
     */
    static async submitOrder(senderOrPayload, payloadOrSender = {}) {
        let sender, payload;
        if (senderOrPayload && (senderOrPayload.items || senderOrPayload.customer || senderOrPayload.submission_id || senderOrPayload.submissionId)) {
            payload = senderOrPayload;
            sender = payloadOrSender;
        } else {
            sender = senderOrPayload;
            payload = payloadOrSender;
        }

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

        // 5. Payment Allocation Check
        const paymentInput = payload.payment || {};
        const paymentAmount = Math.max(0, parseFloat(paymentInput.amount) || 0);
        const paymentMethod = paymentInput.method || paymentInput.paymentMethod || 'Cash';
        const paymentRef = paymentInput.reference || paymentInput.referenceNumber || null;

        if (paymentAmount > pricingSnapshot.grandTotal + 0.001 && pricingSnapshot.grandTotal > 0) {
            return {
                success: false,
                error: `Payment amount (₹${paymentAmount.toFixed(2)}) cannot exceed order total (₹${pricingSnapshot.grandTotal.toFixed(2)}).`,
                code: 'OVERPAYMENT_NOT_ALLOWED'
            };
        }

        let paymentStatus = 'Unpaid';
        let recordedPaidAmount = 0;
        if (paymentAmount >= pricingSnapshot.grandTotal && pricingSnapshot.grandTotal > 0) {
            paymentStatus = 'Paid';
            recordedPaidAmount = pricingSnapshot.grandTotal;
        } else if (paymentAmount > 0) {
            paymentStatus = 'Partially Paid';
            recordedPaidAmount = paymentAmount;
        }

        // 6. Action & Status Determination
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

        // 7. Prepare Permanent Order Directory & Stage Permanent Files BEFORE DB Commit
        let customerNameSnapshot = payload.customerName || payload.name || 'Walk-in Customer';
        let customerPhoneSnapshot = payload.customerPhone || payload.phone || '';
        let customerGstinSnapshot = payload.customerGstin || payload.gstin || '';
        const cleanPhone = customerPhoneSnapshot.replace(/[^0-9]/g, '');

        const permanentDir = this.getOrderPermanentDir(submissionId, customerNameSnapshot);
        const permanentFileRecords = [];
        const newlyCreatedFiles = [];

        try {
            for (let i = 0; i < pricingSnapshot.items.length; i++) {
                const item = pricingSnapshot.items[i];
                if (item.filePath && fs.existsSync(item.filePath)) {
                    const ext = path.extname(item.filePath) || '.pdf';
                    const baseName = path.basename(item.filePath, ext);
                    const safeFileName = `item_${i + 1}_${Date.now()}_${baseName.replace(/[^a-z0-9_-]/gi, '_')}${ext}`;
                    const targetPermanentPath = path.join(permanentDir, safeFileName);

                    // Copy file to permanent storage
                    fs.copyFileSync(item.filePath, targetPermanentPath);
                    newlyCreatedFiles.push(targetPermanentPath);

                    // Compute SHA-256 Checksum on permanent file
                    const fileBuf = fs.readFileSync(targetPermanentPath);
                    const checksum = crypto.createHash('sha256').update(fileBuf).digest('hex');

                    permanentFileRecords.push({
                        itemIndex: i,
                        permanentPath: targetPermanentPath,
                        fileName: path.basename(item.filePath),
                        checksum
                    });
                }
            }
        } catch (copyErr) {
            // Clean up any files copied so far
            for (const f of newlyCreatedFiles) {
                try { fs.unlinkSync(f); } catch (e) {}
            }
            return {
                success: false,
                error: `Permanent file storage commit failed: ${copyErr.message}`,
                code: 'FILE_COMMIT_ERROR'
            };
        }

        // 8. Atomic SQLite Transaction (Customer, Order, Items, GST Invoice, Payment, Production, Print, Reservation)
        let committedOrderId = null;
        let committedInvoiceId = null;
        let committedInvoiceNumber = null;
        let committedProdJobId = null;
        let committedPrintJobId = null;
        const recordedBy = typeof sender?.role === 'string' ? sender.role : (Array.isArray(sender?.role) ? sender.role[0] : 'Operator');

        const tx = db.transaction(() => {
            // 8.1 Customer Unit of Work (Inside Transaction)
            let customerId = null;
            if (cleanPhone.length >= 10 && cleanPhone !== '0000000000') {
                let cust = db.prepare('SELECT id, name, phone, gstin, state FROM customers WHERE phone = ?').get(cleanPhone);
                if (cust) {
                    customerId = cust.id;
                    customerNameSnapshot = cust.name;
                    if (customerGstinSnapshot && customerGstinSnapshot !== cust.gstin) {
                        db.prepare('UPDATE customers SET gstin = ? WHERE id = ?').run(customerGstinSnapshot, cust.id);
                    }
                } else if (payload.customerName && payload.customerName !== 'Guest Customer' && payload.customerName !== 'Walk-in Customer') {
                    const createRes = db.prepare(`
                        INSERT INTO customers (name, phone, gstin, state)
                        VALUES (?, ?, ?, ?)
                    `).run(payload.customerName, cleanPhone, customerGstinSnapshot || null, payload.state || 'Local');
                    customerId = createRes.lastInsertRowid;
                }
            }

            // 8.2 Insert Order
            const stmtOrder = db.prepare(`
                INSERT INTO orders (
                    submission_id, customer_id, customer_name_snapshot, customer_phone_snapshot,
                    customer_gstin_snapshot, total_price, subtotal, taxable_amount, gst_amount,
                    discount_amount, paid_amount, status, payment_status, notes, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                payload.notes || null,
                payload.source || 'Manual'
            );
            committedOrderId = resOrder.lastInsertRowid;

            // 8.3 Insert Order Items (storing verified permanent paths)
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
                const perm = permanentFileRecords.find(p => p.itemIndex === i);
                const finalFilePath = perm ? perm.permanentPath : (item.filePath || null);
                const finalChecksum = perm ? perm.checksum : null;
                const extrasJson = Array.isArray(item.extras) ? JSON.stringify(item.extras) : null;

                stmtItem.run(
                    committedOrderId,
                    item.fileName,
                    finalFilePath,
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
                    finalChecksum
                );
            }

            // 8.4 Create GST Invoice (if enabled)
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

            // 8.5 Record Payment (if collected)
            if (recordedPaidAmount > 0) {
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

            // 8.6 Create Production Job
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

            // 8.7 Create Print Job (storing permanent file path)
            if (action === 'SAVE_AND_PRINT') {
                const primaryPermPath = permanentFileRecords[0]?.permanentPath || (pricingSnapshot.items[0]?.filePath || null);
                const stmtPrint = db.prepare(`
                    INSERT INTO print_jobs (
                        order_id, file_path, printer_name, status, copies, pages
                    ) VALUES (?, ?, ?, 'Queued', ?, ?)
                `);

                const resPrint = stmtPrint.run(
                    committedOrderId,
                    primaryPermPath,
                    payload.default_printer || 'Default',
                    pricingSnapshot.items[0]?.copies || 1,
                    pricingSnapshot.items.reduce((s, i) => s + i.physicalSheets, 0)
                );
                committedPrintJobId = resPrint.lastInsertRowid;
            }

            // 8.8 Stock Reservation Integration (Phase 4 Unit of Work)
            try {
                const ReservationService = require('../database/services/reservation-service');
                if (ReservationService && typeof ReservationService.reserve === 'function') {
                    ReservationService.reserve(committedOrderId, {
                        locationId: payload.locationId || 1,
                        pages: pricingSnapshot.items[0]?.sourcePages || 1,
                        copies: pricingSnapshot.items[0]?.copies || 1
                    }, recordedBy, sender?.role || 'Operator');
                }
            } catch (resErr) {
                // Stock reservation logged
                console.warn('[OrderService] Stock reservation warning:', resErr.message);
            }

            // 8.9 Audit Activity
            try {
                db.prepare(`
                    INSERT INTO activities (description, type)
                    VALUES (?, 'order_created')
                `).run(`Order #${committedOrderId} created (${paymentStatus}) - ₹${pricingSnapshot.grandTotal}`);
            } catch (e) {}
        });

        // Execute Transaction
        try {
            tx();
        } catch (dbErr) {
            // Clean up created permanent files on database transaction rollback
            for (const f of newlyCreatedFiles) {
                try { fs.unlinkSync(f); } catch (e) {}
            }
            console.error('[OrderService] Transaction rollback:', dbErr);
            return { success: false, error: `Database transaction failed: ${dbErr.message}`, code: 'DB_ERROR' };
        }

        // 9. Async Print Queue Submission (For Save & Print) using verified permanent files
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
                    
                    const printPayload = permanentFileRecords.map(p => ({
                        path: p.permanentPath,
                        ext: path.extname(p.permanentPath)
                    }));

                    if (printPayload.length > 0) {
                        await printFile(printPayload, printOptions.printerName, printOptions);
                    }
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
     * Cancels an existing order safely (Does NOT fake refund without explicit refund entry)
     * @param {Object} senderOrPayload 
     * @param {number|Object} orderIdOrPayload 
     * @param {string} reasonArg 
     */
    static cancelOrder(senderOrPayload, orderIdOrPayload, reasonArg = 'User requested cancellation') {
        let orderId, reason, sender;

        if (senderOrPayload && (senderOrPayload.user || senderOrPayload.role)) {
            sender = senderOrPayload;
            if (typeof orderIdOrPayload === 'object' && orderIdOrPayload !== null) {
                orderId = parseInt(orderIdOrPayload.orderId || orderIdOrPayload.id, 10);
                reason = orderIdOrPayload.reason || reasonArg;
            } else {
                orderId = parseInt(orderIdOrPayload, 10);
                reason = reasonArg;
            }
        } else if (typeof senderOrPayload === 'object' && senderOrPayload !== null) {
            orderId = parseInt(senderOrPayload.orderId || senderOrPayload.id, 10);
            reason = senderOrPayload.reason || reasonArg;
            sender = orderIdOrPayload || { role: 'Operator' };
        } else {
            orderId = parseInt(senderOrPayload, 10);
            reason = reasonArg;
            sender = { role: 'Operator' };
        }

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
        const finalPaymentStatus = isPaid ? order.payment_status : 'Voided';

        const tx = db.transaction(() => {
            // Update order status and payment status
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
                SET status = 'Cancelled'
                WHERE order_id = ?
            `).run(orderId);

            // Release inventory reservation if active
            try {
                const ReservationService = require('../database/services/reservation-service');
                if (ReservationService && typeof ReservationService.release === 'function') {
                    ReservationService.release(orderId, sender?.role || 'Operator', 'Order Cancellation');
                }
            } catch (e) {}

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
     * Records an explicit refund for a cancelled or adjusted order
     */
    static recordRefund(senderOrPayload, payloadOrId = {}, amountArg = null, reasonArg = null) {
        let orderId, refundAmount, reason, method, sender;

        if (senderOrPayload && (senderOrPayload.user || senderOrPayload.role)) {
            sender = senderOrPayload;
            if (typeof payloadOrId === 'object' && payloadOrId !== null) {
                orderId = parseInt(payloadOrId.orderId || payloadOrId.id, 10);
                refundAmount = Math.max(0, parseFloat(payloadOrId.amount || payloadOrId.refundAmount) || 0);
                reason = payloadOrId.reason || 'Customer refund';
                method = payloadOrId.paymentMethod || payloadOrId.refundMethod || 'Cash';
            } else {
                orderId = parseInt(payloadOrId, 10);
                refundAmount = Math.max(0, parseFloat(amountArg) || 0);
                reason = reasonArg || 'Customer refund';
                method = 'Cash';
            }
        } else if (typeof senderOrPayload === 'object' && senderOrPayload !== null) {
            orderId = parseInt(senderOrPayload.orderId || senderOrPayload.id, 10);
            refundAmount = Math.max(0, parseFloat(senderOrPayload.amount || senderOrPayload.refundAmount) || 0);
            reason = senderOrPayload.reason || 'Customer refund';
            method = senderOrPayload.paymentMethod || senderOrPayload.refundMethod || 'Cash';
            sender = payloadOrId || { role: 'Operator' };
        }

        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        if (!order) return { success: false, error: 'Order not found', code: 'NOT_FOUND' };

        const currentPaid = parseFloat(order.paid_amount) || 0;
        if (refundAmount <= 0) {
            // Default to full refund if amount not explicitly specified
            refundAmount = currentPaid;
        }

        if (refundAmount > currentPaid && currentPaid > 0) {
            return {
                success: false,
                error: `Refund amount (₹${refundAmount.toFixed(2)}) cannot exceed collected payment (₹${currentPaid.toFixed(2)}).`,
                code: 'EXCESSIVE_REFUND'
            };
        }

        const newPaid = Math.max(0, currentPaid - refundAmount);
        const newPaymentStatus = newPaid === 0 ? 'Refunded' : 'Partially Paid';
        const recordedBy = typeof sender?.role === 'string' ? sender.role : (Array.isArray(sender?.role) ? sender.role[0] : 'Operator');

        const tx = db.transaction(() => {
            // Insert refund record into payments ledger (negative entry)
            db.prepare(`
                INSERT INTO payments (order_id, invoice_id, amount, payment_method, reference_number, status, recorded_by)
                VALUES (?, (SELECT id FROM gst_invoices WHERE order_id = ? LIMIT 1), ?, ?, ?, 'Completed', ?)
            `).run(orderId, orderId, -refundAmount, method, `Refund: ${reason}`, recordedBy);

            // Update order paid_amount and payment_status
            db.prepare(`
                UPDATE orders 
                SET paid_amount = ?, payment_status = ?
                WHERE id = ?
            `).run(newPaid, newPaymentStatus, orderId);

            // Update GST Invoice
            db.prepare(`
                UPDATE gst_invoices 
                SET paid_amount = ?, payment_status = ?
                WHERE order_id = ?
            `).run(newPaid, newPaymentStatus, orderId);

            // Log activity
            try {
                db.prepare('INSERT INTO activities (description, type) VALUES (?, ?)').run(`Refund of ₹${refundAmount.toFixed(2)} recorded for Order #${orderId}: ${reason}`, 'order_refund');
            } catch (e) {}
        });

        try {
            tx();
            return { success: true, orderId, refundAmount, newPaidAmount: newPaid, paymentStatus: newPaymentStatus };
        } catch (err) {
            return { success: false, error: err.message, code: 'DB_ERROR' };
        }
    }

    /**
     * Alias for recordRefund
     */
    static refundOrder(senderOrPayload, payloadOrId, amountArg, reasonArg) {
        return this.recordRefund(senderOrPayload, payloadOrId, amountArg, reasonArg);
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

        // Trigger printer asynchronously to avoid blocking UI on hardware spooling
        try {
            const { printFile } = require('../printer');
            const printOptions = {
                printerName: targetPrinter,
                orderId,
                printJobId: newPrintJobId,
                ...options
            };
            
            setImmediate(async () => {
                try {
                    await printFile(printPayload, targetPrinter, printOptions);
                } catch (err) {
                    console.error(`[OrderService] Async retry print error for order #${orderId}:`, err.message);
                }
            });

            return {
                success: true,
                orderId,
                printJobId: newPrintJobId
            };
        } catch (err) {
            return { success: false, error: err.message, code: 'PRINT_ERROR' };
        }
    }

    /**
     * Records an incremental payment for an order (Rejects overpayment)
     */
    static recordPayment(senderOrPayload, payloadOrSender = {}) {
        let sender, payload;
        if (senderOrPayload && (senderOrPayload.orderId || senderOrPayload.order_id)) {
            payload = senderOrPayload;
            sender = payloadOrSender;
        } else {
            sender = senderOrPayload;
            payload = payloadOrSender;
        }

        const orderId = parseInt(payload.orderId || payload.order_id, 10);
        const amount = Math.max(0, parseFloat(payload.amount) || 0);
        const method = payload.paymentMethod || payload.payment_method || 'Cash';
        const ref = payload.referenceNumber || payload.reference_number || null;

        if (isNaN(orderId) || amount <= 0) {
            return { success: false, error: 'Valid order ID and positive payment amount are required.', code: 'INVALID_INPUT' };
        }

        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        if (!order) return { success: false, error: 'Order not found', code: 'NOT_FOUND' };

        const currentPaid = parseFloat(order.paid_amount) || 0;
        const grandTotal = parseFloat(order.total_price) || 0;
        const remainingBalance = grandTotal - currentPaid;

        if (amount > remainingBalance + 0.001) {
            return {
                success: false,
                error: `Payment amount (₹${amount.toFixed(2)}) exceeds remaining balance (₹${Math.max(0, remainingBalance).toFixed(2)}).`,
                code: 'OVERPAYMENT_NOT_ALLOWED'
            };
        }

        const newPaid = Math.min(grandTotal, currentPaid + amount);
        let newPaymentStatus = 'Partially Paid';
        if (newPaid >= grandTotal - 0.001) {
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

            // Log activity
            try {
                db.prepare('INSERT INTO activities (description, type) VALUES (?, ?)').run(`Payment of ₹${amount} received for Order #${orderId} (${method})`, 'payment_recorded');
            } catch (e) {}
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

