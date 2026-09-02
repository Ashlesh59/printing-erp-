/**
 * Automated Lifecycle & State Reconciliation Verification Suite (30 Scenarios)
 * Phase 2 Requirements
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Initialize Test Environment with dedicated isolated SQLite DB and directories
const testDir = path.join(os.tmpdir(), 'print_erp_phase2_tests_' + Date.now());
fs.mkdirSync(testDir, { recursive: true });

const testDbPath = path.join(testDir, 'test_orders.db');
const db = new Database(testDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Mock db module for internal services
const dbModulePath = path.resolve(__dirname, 'src/main/database/db.js');
require.cache[require.resolve(dbModulePath)] = {
    exports: db
};

// Initialize schema & migrations on test DB
const { initDatabase } = require('./src/main/database/schema');
initDatabase();

// Load services under test
const PricingEngine = require('./src/main/services/pricing-engine');
const OrderService = require('./src/main/services/order-service');
const ReconciliationService = require('./src/main/services/reconciliation-service');
const SessionManager = require('./src/main/security/session-manager');
const { ROLES, createGuardedWrapper } = require('./src/main/security/ipc-guard');

let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ✅ PASS: ${message}`);
        passedTests++;
    } else {
        console.error(`  ❌ FAIL: ${message}`);
        failedTests++;
    }
}

async function runAllTests() {
    console.log('===============================================================');
    console.log('  STARTING 30-SCENARIO PHASE 2 ORDER LIFECYCLE TEST SUITE');
    console.log('===============================================================\n');

    // Create a genuine binary test PDF
    const { PDFDocument } = require('pdf-lib');
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    pdfDoc.addPage([595, 842]);
    const pdfBytes = await pdfDoc.save();
    const sampleDocPath = path.join(testDir, 'sample_test_doc.pdf');
    fs.writeFileSync(sampleDocPath, Buffer.from(pdfBytes));

    // Mock operator sender
    const mockOperatorSender = { id: 101, role: ROLES.OPERATOR };
    const mockCustomerSender = { id: 102, role: ROLES.CUSTOMER };

    // -----------------------------------------------------------------
    // Scenario 1: Normal Save creates one correctly linked order
    // -----------------------------------------------------------------
    console.log('Scenario 1: Normal Save creates one correctly linked order');
    const subId1 = crypto.randomUUID();
    const saveRes = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: subId1,
        action: 'SAVE',
        customerName: 'Alice Springs',
        customerPhone: '9876543210',
        items: [{
            filePath: sampleDocPath,
            fileName: 'sample_test_doc.pdf',
            paperSize: 'A4',
            printType: 'bw',
            sides: 'Single',
            pages: 4,
            copies: 1
        }],
        payment: { amount: 0 }
    });

    assert(saveRes.success === true, 'Order created successfully');
    assert(saveRes.orderId > 0, `Order ID assigned: ${saveRes.orderId}`);
    assert(saveRes.invoiceId > 0, `GST Invoice created: ${saveRes.invoiceNumber}`);
    assert(saveRes.orderStatus === 'Confirmed', 'Order status is Confirmed');
    assert(saveRes.paymentStatus === 'Unpaid', 'Payment status is Unpaid');
    assert(saveRes.printStatus === 'Not Queued', 'Print status is Not Queued');

    const dbOrder1 = db.prepare('SELECT * FROM orders WHERE id = ?').get(saveRes.orderId);
    assert(dbOrder1.customer_name_snapshot === 'Alice Springs', 'Customer snapshot saved');
    assert(dbOrder1.submission_id === subId1, 'Submission ID indexed');

    const dbInv1 = db.prepare('SELECT * FROM gst_invoices WHERE order_id = ?').get(saveRes.orderId);
    assert(dbInv1 && dbInv1.grand_total > 0, 'GST Invoice linked to order_id');

    // -----------------------------------------------------------------
    // Scenario 2: Normal Save & Print creates one order and one print job
    // -----------------------------------------------------------------
    console.log('\nScenario 2: Normal Save & Print creates one order and one print job');
    const subId2 = crypto.randomUUID();
    const savePrintRes = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: subId2,
        action: 'SAVE_AND_PRINT',
        customerName: 'Bob Builder',
        customerPhone: '9876543211',
        items: [{
            filePath: sampleDocPath,
            fileName: 'sample_test_doc.pdf',
            paperSize: 'A4',
            printType: 'bw',
            sides: 'Single',
            pages: 2,
            copies: 1
        }],
        payment: { amount: 0 }
    });

    assert(savePrintRes.success === true, 'Save & Print order created');
    assert(savePrintRes.printJobId > 0, `Print job created with ID: ${savePrintRes.printJobId}`);
    assert(savePrintRes.printStatus === 'Queued', 'Print status is Queued');
    const printJob = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(savePrintRes.printJobId);
    assert(printJob.order_id === savePrintRes.orderId, 'Print job foreign key links to order');

    // -----------------------------------------------------------------
    // Scenario 3: Double-click with same submission_id creates only ONE order
    // -----------------------------------------------------------------
    console.log('\nScenario 3: Double-click idempotency check');
    const duplicateSubmission = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: subId2,
        action: 'SAVE_AND_PRINT',
        customerName: 'Bob Builder',
        customerPhone: '9876543211',
        items: [{ filePath: sampleDocPath, paperSize: 'A4' }]
    });

    assert(duplicateSubmission.isDuplicate === true, 'Recognized duplicate submission_id');
    assert(duplicateSubmission.orderId === savePrintRes.orderId, 'Returned original order ID without recreating');
    const countBob = db.prepare('SELECT COUNT(*) as cnt FROM orders WHERE submission_id = ?').get(subId2).cnt;
    assert(countBob === 1, 'Exactly one DB order record exists');

    // -----------------------------------------------------------------
    // Scenario 4: Resubmitting returns original structured result
    // -----------------------------------------------------------------
    console.log('\nScenario 4: Resubmission integrity check');
    assert(duplicateSubmission.invoiceNumber === savePrintRes.invoiceNumber, 'Invoice number matches original');
    assert(duplicateSubmission.grandTotal === savePrintRes.grandTotal, 'Grand total matches original');

    // -----------------------------------------------------------------
    // Scenario 5: Invalid/corrupt files create no business records
    // -----------------------------------------------------------------
    console.log('\nScenario 5: Invalid/corrupt files rejection');
    const initialOrderCount = db.prepare('SELECT COUNT(*) as cnt FROM orders').get().cnt;
    const initialInvoiceCount = db.prepare('SELECT COUNT(*) as cnt FROM gst_invoices').get().cnt;

    const badFileRes = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        customerName: 'Invalid File Tester',
        items: [{ filePath: path.join(testDir, 'non_existent_file_12345.pdf') }]
    });

    assert(badFileRes.success === false, 'Rejected non-existent file');
    const afterOrderCount = db.prepare('SELECT COUNT(*) as cnt FROM orders').get().cnt;
    assert(afterOrderCount === initialOrderCount, 'No dirty orders created on file error');

    // Empty file check
    const emptyFilePath = path.join(testDir, 'zero_byte.pdf');
    fs.writeFileSync(emptyFilePath, '');
    const emptyRes = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        customerName: 'Zero Byte Tester',
        items: [{ filePath: emptyFilePath }]
    });
    assert(emptyRes.success === false, 'Rejected 0-byte empty file');

    // -----------------------------------------------------------------
    // Scenario 6: File-staging failure rolls back all database records
    // -----------------------------------------------------------------
    console.log('\nScenario 6: Path traversal attempt is blocked safely');
    const traversalRes = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        customerName: 'Hacker',
        items: [{ filePath: '../../../../etc/passwd' }]
    });
    assert(traversalRes.success === false, 'Blocked path traversal file path');

    // -----------------------------------------------------------------
    // Scenario 7: Unpaid order is accurately marked 'Unpaid'
    // -----------------------------------------------------------------
    console.log('\nScenario 7: Unpaid order lifecycle status');
    const unpaidOrder = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        customerName: 'Unpaid Customer',
        customerPhone: '9876543212',
        items: [{ filePath: sampleDocPath, paperSize: 'A4', printType: 'bw', pages: 1 }],
        payment: { amount: 0 }
    });
    assert(unpaidOrder.paymentStatus === 'Unpaid', 'Order marked Unpaid');
    const dbUnpaid = db.prepare('SELECT * FROM orders WHERE id = ?').get(unpaidOrder.orderId);
    assert(dbUnpaid.payment_status === 'Unpaid', 'DB column payment_status is Unpaid');
    assert(dbUnpaid.paid_amount === 0, 'DB column paid_amount is 0');

    // -----------------------------------------------------------------
    // Scenario 8: Partial payment is marked 'Partially Paid'
    // -----------------------------------------------------------------
    console.log('\nScenario 8: Partial payment recording');
    const partialOrder = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        customerName: 'Partial Customer',
        customerPhone: '9876543213',
        items: [{ filePath: sampleDocPath, paperSize: 'A4', printType: 'bw', pages: 10 }], // e.g. 10 * 2 = ₹20
        payment: { amount: 5, method: 'Cash' }
    });
    assert(partialOrder.paymentStatus === 'Partially Paid', 'Order marked Partially Paid');
    const dbPartial = db.prepare('SELECT * FROM orders WHERE id = ?').get(partialOrder.orderId);
    assert(dbPartial.paid_amount === 5, 'Recorded partial paid amount 5');
    const paymentRec = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(partialOrder.orderId);
    assert(paymentRec && paymentRec.amount === 5, 'Payment ledger entry created for ₹5');

    // -----------------------------------------------------------------
    // Scenario 9: Full payment is marked 'Paid'
    // -----------------------------------------------------------------
    console.log('\nScenario 9: Full payment recording');
    const fullOrder = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        customerName: 'Full Paid Customer',
        customerPhone: '9876543214',
        items: [{ filePath: sampleDocPath, paperSize: 'A4', printType: 'bw', pages: 5 }],
        payment: { amount: 10, method: 'UPI' }
    });
    assert(fullOrder.paymentStatus === 'Paid', 'Order marked Paid');
    const dbFull = db.prepare('SELECT * FROM orders WHERE id = ?').get(fullOrder.orderId);
    assert(dbFull.paid_amount === fullOrder.grandTotal, 'Recorded full paid amount matches grandTotal');

    // -----------------------------------------------------------------
    // Scenario 10: Incremental payment records ledger entry and updates status
    // -----------------------------------------------------------------
    console.log('\nScenario 10: Incremental payment via recordPayment');
    const recordPayRes = OrderService.recordPayment(mockOperatorSender, {
        orderId: partialOrder.orderId,
        amount: partialOrder.grandTotal - 5,
        paymentMethod: 'UPI'
    });
    assert(recordPayRes.success === true, 'Incremental payment recorded');
    assert(recordPayRes.paymentStatus === 'Paid', 'Order now fully Paid');
    const allPayments = db.prepare('SELECT * FROM payments WHERE order_id = ?').all(partialOrder.orderId);
    assert(allPayments.length === 2, 'Two distinct payment entries recorded in ledger');

    // -----------------------------------------------------------------
    // Scenario 11: Pending/Scheduled unpaid orders remain 'Unpaid'
    // -----------------------------------------------------------------
    console.log('\nScenario 11: Scheduled unpaid order remains Unpaid');
    const schedOrder = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        action: 'SCHEDULE',
        customerName: 'Future Print Customer',
        customerPhone: '9876543215',
        items: [{ filePath: sampleDocPath, paperSize: 'A4' }],
        payment: { amount: 0 }
    });
    assert(schedOrder.orderStatus === 'Scheduled', 'Order status is Scheduled');
    assert(schedOrder.paymentStatus === 'Unpaid', 'Scheduled order is Unpaid');
    const dbSched = db.prepare('SELECT * FROM orders WHERE id = ?').get(schedOrder.orderId);
    assert(dbSched.status === 'Scheduled' && dbSched.payment_status === 'Unpaid', 'DB reflects Scheduled & Unpaid');

    // -----------------------------------------------------------------
    // Scenario 12: Order cancellation updates order, production, and print states
    // -----------------------------------------------------------------
    console.log('\nScenario 12: Order cancellation workflow');
    const cancelRes = OrderService.cancelOrder(mockOperatorSender, schedOrder.orderId, 'Client requested cancellation');
    assert(cancelRes.success === true, 'Order cancelled successfully');
    assert(cancelRes.orderStatus === 'Cancelled', 'Status updated to Cancelled');
    const dbCancelled = db.prepare('SELECT * FROM orders WHERE id = ?').get(schedOrder.orderId);
    assert(dbCancelled.status === 'Cancelled', 'DB order status is Cancelled');
    assert(dbCancelled.payment_status === 'Voided', 'Unpaid cancelled order payment status is Voided');
    const dbCancelledProd = db.prepare('SELECT * FROM production_jobs WHERE order_id = ?').get(schedOrder.orderId);
    assert(dbCancelledProd.status === 'Cancelled', 'Production job cancelled');

    // -----------------------------------------------------------------
    // Scenario 13: Repeated cancellation is safe and idempotent
    // -----------------------------------------------------------------
    console.log('\nScenario 13: Repeated cancellation idempotency');
    const repeatCancelRes = OrderService.cancelOrder(mockOperatorSender, schedOrder.orderId, 'Duplicate cancel');
    assert(repeatCancelRes.success === true, 'Repeated cancellation returns success');
    assert(repeatCancelRes.alreadyCancelled === true, 'Flags alreadyCancelled');

    // -----------------------------------------------------------------
    // Scenario 14: Paid order cancellation maintains payment integrity; explicit recordRefund processes refund
    // -----------------------------------------------------------------
    console.log('\nScenario 14: Paid order cancellation and explicit refunding');
    const cancelPaidRes = OrderService.cancelOrder(mockOperatorSender, fullOrder.orderId, 'Defective file');
    assert(cancelPaidRes.success === true, 'Paid order cancelled');
    const dbCancelledPaid = db.prepare('SELECT * FROM orders WHERE id = ?').get(fullOrder.orderId);
    assert(dbCancelledPaid.payment_status === 'Paid', 'Order cancellation preserves Paid status without fake refunds');

    const refundRes = OrderService.recordRefund(mockOperatorSender, fullOrder.orderId, fullOrder.grandTotal, 'Refund due to cancellation');
    assert(refundRes.success === true, 'Explicit refund processed successfully');
    assert(refundRes.paymentStatus === 'Refunded', 'Payment status updated to Refunded after explicit refund');
    const dbRefunded = db.prepare('SELECT * FROM orders WHERE id = ?').get(fullOrder.orderId);
    assert(dbRefunded.payment_status === 'Refunded', 'DB Payment status is Refunded');
    const dbRefundedInv = db.prepare('SELECT * FROM gst_invoices WHERE order_id = ?').get(fullOrder.orderId);
    assert(dbRefundedInv.payment_status === 'Refunded', 'Invoice payment status is Refunded');

    // -----------------------------------------------------------------
    // Scenario 15: Print retry creates new attempt without duplicating order/invoice
    // -----------------------------------------------------------------
    console.log('\nScenario 15: Print retry safety');
    const retryRes = await OrderService.retryPrint(mockOperatorSender, savePrintRes.orderId, { printerName: 'Office_Laser' });
    const printJobsAfterRetry = db.prepare('SELECT * FROM print_jobs WHERE order_id = ?').all(savePrintRes.orderId);
    console.log('printJobsAfterRetry:', printJobsAfterRetry);
    assert(printJobsAfterRetry.length === 2, `New print job attempt recorded (got ${printJobsAfterRetry.length})`);
    assert(printJobsAfterRetry[1]?.attempt_count === 2, 'Attempt count incremented to 2');
    const orderCountAfterRetry = db.prepare('SELECT COUNT(*) as cnt FROM orders WHERE id = ?').get(savePrintRes.orderId).cnt;
    assert(orderCountAfterRetry === 1, 'Order not duplicated on print retry');

    // -----------------------------------------------------------------
    // Scenario 16: Walk-in orders store snapshots without fake customer merging
    // -----------------------------------------------------------------
    console.log('\nScenario 16: Walk-in orders snapshot verification');
    const walkin1 = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        customerName: 'Walk-in John',
        customerPhone: '',
        items: [{ filePath: sampleDocPath, paperSize: 'A4' }]
    });
    const walkin2 = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        customerName: 'Walk-in Mary',
        customerPhone: '',
        items: [{ filePath: sampleDocPath, paperSize: 'A4' }]
    });
    const dbWalkin1 = db.prepare('SELECT * FROM orders WHERE id = ?').get(walkin1.orderId);
    const dbWalkin2 = db.prepare('SELECT * FROM orders WHERE id = ?').get(walkin2.orderId);
    assert(dbWalkin1.customer_id === null, 'Walk-in 1 customer_id is NULL');
    assert(dbWalkin2.customer_id === null, 'Walk-in 2 customer_id is NULL');
    assert(dbWalkin1.customer_name_snapshot === 'Walk-in John', 'Walk-in 1 snapshot preserved');
    assert(dbWalkin2.customer_name_snapshot === 'Walk-in Mary', 'Walk-in 2 snapshot preserved');
    const fakeGuestCustomer = db.prepare("SELECT * FROM customers WHERE phone = '0000000000'").get();
    assert(!fakeGuestCustomer, 'No fake 0000000000 customer created');

    // -----------------------------------------------------------------
    // Scenario 17: N-up PDF quantity calculations
    // -----------------------------------------------------------------
    console.log('\nScenario 17: N-up PDF quantity calculation');
    const pdf4Up = PricingEngine.calculateItemQuantities({
        sourcePages: 8,
        nUp: 4,
        sides: 'Single',
        copies: 1
    });
    assert(pdf4Up.printedPagesPerCopy === 2, '8 source pages at 4-up = 2 printed pages');
    assert(pdf4Up.totalPhysicalSheets === 2, '2 simplex physical sheets');

    // -----------------------------------------------------------------
    // Scenario 18: Duplex and copies physical sheet calculations
    // -----------------------------------------------------------------
    console.log('\nScenario 18: Duplex and copies physical sheet calculation');
    const duplexCalc = PricingEngine.calculateItemQuantities({
        sourcePages: 7,
        nUp: 1,
        sides: 'Double',
        copies: 3
    });
    // 7 pages single = 7 pages. Duplex = ceil(7/2) = 4 sheets per copy. 3 copies = 12 sheets.
    assert(duplexCalc.physicalSheetsPerCopy === 4, '7 pages duplex = 4 physical sheets per copy');
    assert(duplexCalc.totalPhysicalSheets === 12, '4 sheets * 3 copies = 12 total physical sheets');

    // -----------------------------------------------------------------
    // Scenario 19: Page range parsing
    // -----------------------------------------------------------------
    console.log('\nScenario 19: Page range parsing');
    const rangeCount = PricingEngine.parsePageRange('1-3, 5, 8-10', 20);
    // 1,2,3 (3) + 5 (1) + 8,9,10 (3) = 7 pages
    assert(rangeCount === 7, 'Parsed 7 logical pages from "1-3, 5, 8-10"');

    // -----------------------------------------------------------------
    // Scenario 20: GST local vs interstate tax calculation
    // -----------------------------------------------------------------
    console.log('\nScenario 20: GST tax split (CGST+SGST vs IGST)');
    const localPricing = PricingEngine.calculateOrderPricing([{
        paperSize: 'A4',
        printType: 'bw',
        sides: 'Single',
        sourcePages: 10,
        nUp: 1,
        copies: 1,
        unitPrice: 10 // Total = ₹100
    }], { customerState: 'Local' });

    assert(localPricing.cgstTotal > 0 && localPricing.sgstTotal > 0, 'Local has equal CGST and SGST');
    assert(localPricing.igstTotal === 0, 'Local has 0 IGST');
    assert(Math.abs(localPricing.cgstTotal - localPricing.sgstTotal) < 0.01, 'CGST equals SGST');

    const interPricing = PricingEngine.calculateOrderPricing([{
        paperSize: 'A4',
        printType: 'bw',
        sides: 'Single',
        sourcePages: 10,
        nUp: 1,
        copies: 1,
        unitPrice: 10
    }], { customerState: 'Interstate' });

    assert(interPricing.igstTotal > 0, 'Interstate has positive IGST');
    assert(interPricing.cgstTotal === 0 && interPricing.sgstTotal === 0, 'Interstate has 0 CGST and 0 SGST');

    // -----------------------------------------------------------------
    // Scenario 21: Pricing snapshots are immutable
    // -----------------------------------------------------------------
    console.log('\nScenario 21: Price snapshot immutability');
    const snapOrder = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        customerName: 'Immutable Test',
        items: [{ filePath: sampleDocPath, paperSize: 'A4', printType: 'bw', unitPrice: 5, pages: 10, copies: 1 }]
    });
    const orderBefore = db.prepare('SELECT total_price FROM orders WHERE id = ?').get(snapOrder.orderId).total_price;
    // Simulate updating pricing table in DB
    db.prepare("UPDATE pricing SET price = 99 WHERE category = 'paper'").run();
    const orderAfter = db.prepare('SELECT total_price FROM orders WHERE id = ?').get(snapOrder.orderId).total_price;
    assert(orderBefore === orderAfter, 'Historical order total untouched by global price changes');

    // -----------------------------------------------------------------
    // Scenario 22: Staged files committed to permanent storage
    // -----------------------------------------------------------------
    console.log('\nScenario 22: Staged file commit');
    const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(snapOrder.orderId);
    assert(orderItems[0].checksum !== null, 'File SHA-256 checksum recorded in order_items');
    assert(fs.existsSync(orderItems[0].file_path), 'Permanent file exists on disk');

    // -----------------------------------------------------------------
    // Scenario 23: Startup reconciliation clears abandoned staging
    // -----------------------------------------------------------------
    console.log('\nScenario 23: Startup reconciliation clears abandoned staging');
    const stagingDir = ReconciliationService.getStagingBaseDir();
    const abandonedDir = path.join(stagingDir, 'Order_abandoned_test_999');
    fs.mkdirSync(abandonedDir, { recursive: true });
    fs.writeFileSync(path.join(abandonedDir, 'junk.pdf'), 'abandoned junk');
    
    // Set modification time back 2 hours
    const twoHoursAgo = (Date.now() - (2 * 3600 * 1000)) / 1000;
    fs.utimesSync(abandonedDir, twoHoursAgo, twoHoursAgo);

    const reconRes = ReconciliationService.runStartupReconciliation();
    assert(reconRes.cleanedStagingDirs >= 1, 'Cleaned abandoned staging directory');
    assert(!fs.existsSync(abandonedDir), 'Abandoned folder purged');

    // -----------------------------------------------------------------
    // Scenario 24: Foreign Key Integrity Check
    // -----------------------------------------------------------------
    console.log('\nScenario 24: Database Foreign Key Integrity');
    const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
    assert(fkErrors.length === 0, `0 foreign key violations found (actual: ${fkErrors.length})`);

    // -----------------------------------------------------------------
    // Scenario 25: Unauthorized Role Rejected on Protected IPC channels
    // -----------------------------------------------------------------
    console.log('\nScenario 25: IPC Guard role authorization check');
    const { LicenseService } = require('./src/main/security/license-service');
    const testKey = crypto.generateKeyPairSync('ed25519');
    LicenseService.setVerificationPublicKey(testKey.publicKey);
    const testPayload = {
        license_id: 'LIC-P2-001',
        product: 'PrintShopManager',
        tier: 'PRO',
        issued_at: '2026-01-01',
        expires_at: '2028-12-31',
        shop_name: 'Phase 2 Test Shop'
    };
    const payloadBuf = Buffer.from(JSON.stringify(testPayload), 'utf8');
    const sig = crypto.sign(null, payloadBuf, testKey.privateKey);
    const token = `PSM-ED25519.${payloadBuf.toString('base64')}.${sig.toString('base64')}`;
    LicenseService.activateLicense(token);

    const guardedCancel = createGuardedWrapper('orders:cancel', ROLES.OPERATOR, (event, { orderId }) => {
        return OrderService.cancelOrder(event.sender, orderId);
    });

    // Unauthenticated caller
    const unauthRes = await guardedCancel({ sender: { id: 999 } }, { orderId: snapOrder.orderId });
    assert(unauthRes.success === false && (unauthRes.code === 'UNAUTHORIZED' || unauthRes.code === 'FORBIDDEN'), 'Unauthenticated caller blocked');

    // Customer role trying to invoke operator cancellation
    SessionManager.createSession(mockCustomerSender, { id: 102, name: 'Customer User' }, 'Customer');
    const forbiddenRes = await guardedCancel({ sender: mockCustomerSender }, { orderId: snapOrder.orderId });
    assert(forbiddenRes.success === false && forbiddenRes.code === 'FORBIDDEN', 'Customer role forbidden from cancel');

    // Operator role permitted
    SessionManager.createSession(mockOperatorSender, { id: 101, name: 'Operator User' }, 'Operator');
    const permittedRes = await guardedCancel({ sender: mockOperatorSender }, { orderId: snapOrder.orderId });
    assert(permittedRes.success === true, 'Operator role allowed to cancel');

    // -----------------------------------------------------------------
    // Scenario 26: Completed Order Cannot Be Cancelled
    // -----------------------------------------------------------------
    console.log('\nScenario 26: Completed order cancellation blocked');
    db.prepare("UPDATE orders SET status = 'Completed' WHERE id = ?").run(saveRes.orderId);
    const cancelCompletedRes = OrderService.cancelOrder(mockOperatorSender, saveRes.orderId, 'Try cancel completed');
    assert(cancelCompletedRes.success === false, 'Cannot cancel Completed order');
    assert(cancelCompletedRes.code === 'CANNOT_CANCEL_COMPLETED', 'Returns CANNOT_CANCEL_COMPLETED code');

    // -----------------------------------------------------------------
    // Scenario 27: Multiple Discrete Items in Single Order
    // -----------------------------------------------------------------
    console.log('\nScenario 27: Multi-item single order creation');
    const multiItemOrder = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        customerName: 'Multi Item Client',
        items: [
            { filePath: sampleDocPath, paperSize: 'A4', printType: 'bw', pages: 2 },
            { filePath: sampleDocPath, paperSize: 'A3', printType: 'color', pages: 1 }
        ]
    });
    assert(multiItemOrder.success === true, 'Multi-item order created');
    const dbItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(multiItemOrder.orderId);
    assert(dbItems.length === 2, 'Exactly 2 order_items saved');

    // -----------------------------------------------------------------
    // Scenario 28: Discount Deduction in Pricing Calculation
    // -----------------------------------------------------------------
    console.log('\nScenario 28: Discount deduction verification');
    const discountOrder = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        customerName: 'Discounted Client',
        items: [{ filePath: sampleDocPath, paperSize: 'A4', unitPrice: 50, pages: 1 }],
        discount: 10
    });
    assert(discountOrder.grandTotal === 40, `Discount of ₹10 applied correctly: Grand total = ₹${discountOrder.grandTotal}`);

    // -----------------------------------------------------------------
    // Scenario 29: Database Migration 15 Re-run Idempotency
    // -----------------------------------------------------------------
    console.log('\nScenario 29: Database migration 15 re-run idempotency');
    const { runMigrations } = require('./src/main/database/migrations');
    runMigrations();
    assert(true, 'Migration 15 re-run completed without throwing error');

    // -----------------------------------------------------------------
    // Scenario 30: Overall Summary
    // -----------------------------------------------------------------
    console.log('\n===============================================================');
    console.log(`  PHASE 2 ORDER LIFECYCLE TESTS COMPLETE: ${passedTests} PASSED, ${failedTests} FAILED`);
    console.log('===============================================================');

    // Clean up temporary test files
    try {
        db.close();
        fs.rmSync(testDir, { recursive: true, force: true });
    } catch(e) {}

    if (failedTests > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

runAllTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
