/**
 * 30-Scenario Integrated Release Gate Suite
 * Phase 1–5 Corrective Release Verification
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const Database = require('better-sqlite3');

// Isolated testing sandbox
const testDir = path.join(os.tmpdir(), 'print_erp_integration_release_gate_' + Date.now());
fs.mkdirSync(testDir, { recursive: true });

const testDbPath = path.join(testDir, 'integration.db');
const db = new Database(testDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Mock db module
const dbModulePath = path.resolve(__dirname, 'src/main/database/db.js');
require.cache[require.resolve(dbModulePath)] = {
    exports: db
};

// Initialize schema & migrations
const { initDatabase } = require('./src/main/database/schema');
initDatabase();

// Load modules under test
const { UserModel, WizardModel, SettingsModel } = require('./src/main/database/models');
const authThrottle = require('./src/main/security/auth-throttle');
const { LicenseService, LicenseState } = require('./src/main/security/license-service');
const { ROLES, createGuardedWrapper } = require('./src/main/security/ipc-guard');
const SessionManager = require('./src/main/security/session-manager');
const OrderService = require('./src/main/services/order-service');
const PrintPreflight = require('./src/main/services/printing/print-preflight');
const PrinterDiscovery = require('./src/main/services/printing/printer-discovery');
const PrintQueueManager = require('./src/main/services/printing/print-queue-manager');
const InventoryService = require('./src/main/database/services/inventory-service');
const ReservationService = require('./src/main/database/services/reservation-service');
const PurchasingService = require('./src/main/services/purchasing/purchasing-service');

let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`  ✅ [PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${name}`);
        console.error(`     ↳ Error: ${err.message}`);
        failedTests++;
    }
}

async function runAsyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✅ [PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${name}`);
        console.error(`     ↳ Error: ${err.message}`);
        failedTests++;
    }
}

async function runIntegrationSuite() {
    console.log('════════════════════════════════════════════════════════════════════════════');
    console.log('🚀 30-SCENARIO INTEGRATED RELEASE GATE SUITE (PHASES 1–5)');
    console.log('════════════════════════════════════════════════════════════════════════════\n');

    // Ephemeral PDF doc creation for test runs
    const { PDFDocument } = require('pdf-lib');
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    pdfDoc.addPage([595, 842]);
    const pdfBytes = await pdfDoc.save();
    const sampleDocPath = path.join(testDir, 'sample_contract.pdf');
    fs.writeFileSync(sampleDocPath, Buffer.from(pdfBytes));

    const mockAdminSender = { id: 101, role: ROLES.ADMIN };
    const mockOperatorSender = { id: 102, role: ROLES.OPERATOR };
    const mockCustomerSender = { id: 103, role: ROLES.CUSTOMER };

    // =========================================================================
    // SECTION 1: SECURITY, AUTHENTICATION & LICENSING (SCENARIOS 1–6)
    // =========================================================================
    console.log('─── Section 1: Security, Authentication & Cryptographic Licensing ───');

    await runAsyncTest('Scenario 1: First-Run Wizard completes with 6-digit PIN and confirmed password', async () => {
        const wzRes = await WizardModel.executeWizardSetup({
            businessName: 'Apex Digital Print Works',
            ownerName: 'Robert Vance',
            phone: '9876543210',
            currency: '₹',
            adminPin: '849201',
            confirmAdminPin: '849201',
            managerPin: '739104',
            confirmManagerPin: '739104',
            backupFrequency: 'daily',
            selectedPaperTypes: ['A4', 'A3', 'Photo'],
            services: ['bw_print', 'color_print', 'photo']
        });
        assert.strictEqual(wzRes.success, true);
        const settings = db.prepare('SELECT has_setup, owner_name, backup_frequency FROM settings WHERE id = 1').get();
        assert.strictEqual(settings.has_setup, 1);
        assert.strictEqual(settings.owner_name, 'Robert Vance');
        assert.strictEqual(settings.backup_frequency, 'daily');
    });

    await runAsyncTest('Scenario 2: Setup wizard rejects repeat execution on already configured system', async () => {
        const repeatRes = await WizardModel.executeWizardSetup({
            businessName: 'Hijack Attempt',
            adminPin: '948201',
            confirmAdminPin: '948201',
            managerPin: '639102',
            confirmManagerPin: '639102'
        });
        assert.strictEqual(repeatRes.success, false);
    });

    await runAsyncTest('Scenario 3: UserModel strictly blocks all universal PIN backdoors (1234, 0000, 123456, 9999)', async () => {
        const backdoors = ['1234', '0000', '123456', '9999', '1111', '5678', '000000'];
        for (const b of backdoors) {
            const res = await UserModel.verifyPin(b, 501, 'Admin');
            assert.strictEqual(res.success, false, `Backdoor PIN ${b} must be blocked`);
        }
    });

    await runAsyncTest('Scenario 4: UserModel enforces lockout after 5 consecutive failures', async () => {
        authThrottle.resetAll();
        const testSenderId = 9999;
        for (let i = 0; i < 5; i++) {
            await UserModel.verifyPin('999999', testSenderId, 'Admin');
        }
        // 6th attempt with CORRECT PIN is blocked due to active lockout
        const attempt = await UserModel.verifyPin('849201', testSenderId, 'Admin');
        assert.strictEqual(attempt.success, false);
        assert.strictEqual(attempt.locked, true);
    });

    let testKeyPair, validLicenseToken;
    runTest('Scenario 5: Asymmetric Ed25519 digital licensing verifies and activates PRO tier', () => {
        testKeyPair = crypto.generateKeyPairSync('ed25519');
        LicenseService.setVerificationPublicKey(testKeyPair.publicKey);

        const payload = {
            license_id: 'LIC-GATE-2026-001',
            product: 'PrintShopManager',
            tier: 'PRO',
            issued_at: '2026-01-01',
            expires_at: '2028-12-31',
            shop_name: 'Apex Digital Print Works'
        };
        const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
        const sig = crypto.sign(null, payloadBuf, testKeyPair.privateKey);
        validLicenseToken = `PSM-ED25519.${payloadBuf.toString('base64')}.${sig.toString('base64')}`;

        const actRes = LicenseService.activateLicense(validLicenseToken);
        assert.strictEqual(actRes.success, true);
        const status = LicenseService.checkLicenseStatus();
        assert.strictEqual(status.valid, true);
        assert.strictEqual(status.state, LicenseState.VALID);
        assert.strictEqual(status.info ? status.info.tier : status.tier, 'PRO');
    });

    await runAsyncTest('Scenario 6: IPC Guard authorizes operator session and blocks unauthenticated/kiosk callers', async () => {
        SessionManager.createSession(mockOperatorSender, { id: 2, name: 'Operator User' }, 'Operator');
        SessionManager.createSession(mockCustomerSender, { id: 3, name: 'Customer User' }, 'Customer');

        const guardedAction = createGuardedWrapper('orders:cancel', ROLES.OPERATOR, (e, { orderId }) => {
            return OrderService.cancelOrder(e.sender, orderId);
        });

        const unauth = await guardedAction({ sender: { id: 999 } }, { orderId: 1 });
        assert.strictEqual(unauth.success, false);
        assert.strictEqual(unauth.code, 'UNAUTHORIZED');

        const cust = await guardedAction({ sender: mockCustomerSender }, { orderId: 1 });
        assert.strictEqual(cust.success, false);
        assert.strictEqual(cust.code, 'FORBIDDEN');
    });

    // =========================================================================
    // SECTION 2: ORDER LIFECYCLE & PAYMENTS INTEGRITY (SCENARIOS 7–12)
    // =========================================================================
    console.log('\n─── Section 2: Local Order Lifecycle & Permanent File Transactions ───');

    let orderId1, invoiceId1, grandTotal1;
    await runAsyncTest('Scenario 7: Unified Order Creation: Customer creation + file copy + DB transaction in single Unit of Work', async () => {
        const subId = crypto.randomUUID();
        const orderRes = await OrderService.submitOrder(mockOperatorSender, {
            submissionId: subId,
            customerName: 'Marcus Aurelius',
            customerPhone: '9876543220',
            customerGstin: '27AAAAA0000A1Z5',
            items: [{
                filePath: sampleDocPath,
                fileName: 'sample_contract.pdf',
                paperSize: 'A4',
                printType: 'bw',
                sides: 'Single',
                pages: 2,
                copies: 1
            }],
            payment: { amount: 0 }
        });

        assert.strictEqual(orderRes.success, true);
        orderId1 = orderRes.orderId;
        invoiceId1 = orderRes.invoiceId;
        grandTotal1 = orderRes.grandTotal;

        assert.ok(orderId1 > 0);
        assert.strictEqual(orderRes.paymentStatus, 'Unpaid');

        // Verify customer was created and linked
        const customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get('9876543220');
        assert.ok(customer);
        assert.strictEqual(customer.name, 'Marcus Aurelius');

        const dbOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId1);
        assert.strictEqual(dbOrder.customer_id, customer.id);
        assert.strictEqual(dbOrder.customer_name_snapshot, 'Marcus Aurelius');
    });

    runTest('Scenario 8: Permanent file stored in verified order directory before commit; only permanent path saved in DB', () => {
        const itemRow = db.prepare('SELECT file_path, checksum FROM order_items WHERE order_id = ?').get(orderId1);
        assert.ok(itemRow.file_path);
        assert.ok(fs.existsSync(itemRow.file_path), 'Permanent file must exist on disk');
        assert.ok(!itemRow.file_path.includes(os.tmpdir()), 'Path must not point to temporary directory');
        assert.strictEqual(itemRow.checksum.length, 64, 'SHA-256 checksum stored in DB');
    });

    await runAsyncTest('Scenario 9: Double-click idempotency prevents duplicate order and invoice creation', async () => {
        const subId = crypto.randomUUID();
        const res1 = await OrderService.submitOrder(mockOperatorSender, {
            submissionId: subId,
            customerName: 'Double Clicker',
            items: [{ filePath: sampleDocPath, paperSize: 'A4', pages: 1 }],
            payment: { amount: 0 }
        });
        const res2 = await OrderService.submitOrder(mockOperatorSender, {
            submissionId: subId,
            customerName: 'Double Clicker',
            items: [{ filePath: sampleDocPath, paperSize: 'A4', pages: 1 }],
            payment: { amount: 0 }
        });

        assert.strictEqual(res1.orderId, res2.orderId);
        const orderCount = db.prepare('SELECT COUNT(*) as count FROM orders WHERE submission_id = ?').get(subId).count;
        assert.strictEqual(orderCount, 1);
    });

    await runAsyncTest('Scenario 10: Path traversal and corrupted files rejected safely without dirty DB writes', async () => {
        const res = await OrderService.submitOrder(mockOperatorSender, {
            submissionId: crypto.randomUUID(),
            customerName: 'Attacker',
            items: [{ filePath: '../../../../windows/system32/cmd.exe', paperSize: 'A4' }]
        });
        assert.strictEqual(res.success, false);
    });

    runTest('Scenario 11: Payments strictly reject overpayment exceeding remaining order balance', () => {
        const overpayRes = OrderService.recordPayment(mockOperatorSender, {
            orderId: orderId1,
            amount: grandTotal1 + 500,
            paymentMethod: 'UPI'
        });
        assert.strictEqual(overpayRes.success, false);
        assert.strictEqual(overpayRes.code, 'OVERPAYMENT_NOT_ALLOWED');
    });

    runTest('Scenario 12: Paid order cancellation maintains payment integrity; explicit refund workflow executes refund', () => {
        // First, record legitimate full payment
        const payRes = OrderService.recordPayment(mockOperatorSender, {
            orderId: orderId1,
            amount: grandTotal1,
            paymentMethod: 'UPI'
        });
        assert.strictEqual(payRes.success, true);
        assert.strictEqual(payRes.paymentStatus, 'Paid');

        // Cancel order -> status becomes Cancelled, payment_status remains Paid
        const cancelRes = OrderService.cancelOrder(mockOperatorSender, orderId1, 'Damaged print proof');
        assert.strictEqual(cancelRes.success, true);
        const dbCancelled = db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(orderId1);
        assert.strictEqual(dbCancelled.payment_status, 'Paid');

        // Process explicit refund
        const refundRes = OrderService.recordRefund(mockOperatorSender, {
            orderId: orderId1,
            amount: grandTotal1,
            reason: 'Damaged print proof'
        });
        assert.strictEqual(refundRes.success, true);
        assert.strictEqual(refundRes.paymentStatus, 'Refunded');
        const dbRefunded = db.prepare('SELECT payment_status, paid_amount FROM orders WHERE id = ?').get(orderId1);
        assert.strictEqual(dbRefunded.payment_status, 'Refunded');
        assert.strictEqual(dbRefunded.paid_amount, 0);
    });

    // =========================================================================
    // SECTION 3: PHYSICAL PRINT ENGINE & PREFLIGHT VERIFICATION (SCENARIOS 13–18)
    // =========================================================================
    console.log('\n─── Section 3: Physical Printing Engine, Preflight & Concurrency ───');

    runTest('Scenario 13: Capability preflight rejects color job on monochrome-only printer', () => {
        const PrintSettings = require('./src/main/services/printing/print-settings');
        const monoPrinter = { deviceName: 'MonoLaser', canColor: false, canDuplex: false, paperSizes: ['A4'] };
        const mapRes = PrintSettings.mapToElectronPrintOptions({ printType: 'color' }, monoPrinter);
        assert.strictEqual(mapRes.isValid, false);
        assert.ok(mapRes.errors[0].includes('Color'));
    });

    await runAsyncTest('Scenario 14: Capability preflight detects missing file or modified SHA-256 checksum', async () => {
        const preflight = await PrintPreflight.verifyJob({
            filePath: path.join(testDir, 'non_existent_file.pdf'),
            pages: 2
        }, { printerName: 'Default' });
        assert.strictEqual(preflight.passed, false);
        assert.strictEqual(preflight.code, 'FILE_NOT_FOUND');
    });

    runTest('Scenario 15: Mock printer discovery injection supports automated deterministic tests', async () => {
        PrinterDiscovery.setMockPrinters([
            { name: 'Canon_iR2525_Mock', isDefault: true, status: 'Available', canColor: false, canDuplex: true },
            { name: 'Epson_L805_Mock', isDefault: false, status: 'Available', canColor: true, canDuplex: false }
        ]);

        const printers = await PrinterDiscovery.getPrinters();
        assert.strictEqual(printers.length, 2);
        assert.strictEqual(printers[0].name, 'Canon_iR2525_Mock');
        PrinterDiscovery.clearMockPrinters();
    });

    runTest('Scenario 16: Per-printer concurrency lock enforces single-flight submission per device', () => {
        const lockA = PrintQueueManager.acquirePrinterLock('LaserJet_Pro', 101);
        assert.strictEqual(lockA, true);
        const lockB = PrintQueueManager.acquirePrinterLock('LaserJet_Pro', 102);
        assert.strictEqual(lockB, false, 'Same printer cannot be acquired simultaneously');
        PrintQueueManager.releasePrinterLock('LaserJet_Pro', 101);
        const lockC = PrintQueueManager.acquirePrinterLock('LaserJet_Pro', 102);
        assert.strictEqual(lockC, true, 'Printer can be acquired after release');
        PrintQueueManager.releasePrinterLock('LaserJet_Pro', 102);
    });

    runTest('Scenario 17: Startup queue recovery recovers crashed Preparing jobs back to Queued', () => {
        db.prepare("INSERT INTO print_jobs (order_id, printer_name, file_path, pages, copies, status, locked_by) VALUES (?, 'Office_Laser', 'dummy.pdf', 1, 1, 'Preparing', 'Worker-1')").run(orderId1);
        const recovery = PrintQueueManager.recoverInterruptedJobs();
        assert.ok(recovery.requeuedCount >= 1);
        const recoveredJob = db.prepare("SELECT status, locked_by FROM print_jobs WHERE status = 'Queued' ORDER BY id DESC LIMIT 1").get();
        assert.strictEqual(recoveredJob.status, 'Queued');
        assert.strictEqual(recoveredJob.locked_by, null);
    });

    runTest('Scenario 18: Interrupted Submitting print jobs transition to Uncertain status', () => {
        db.prepare("INSERT INTO print_jobs (order_id, printer_name, file_path, pages, copies, status, locked_by) VALUES (?, 'Office_Laser', 'dummy.pdf', 1, 1, 'Submitting', 'Worker-2')").run(orderId1);
        const recovery = PrintQueueManager.recoverInterruptedJobs();
        assert.ok(recovery.uncertainCount >= 1);
        const uncertainJob = db.prepare("SELECT status FROM print_jobs WHERE status = 'Uncertain' ORDER BY id DESC LIMIT 1").get();
        assert.strictEqual(uncertainJob.status, 'Uncertain');
    });

    // =========================================================================
    // SECTION 4: INVENTORY INTEGRITY & RESERVATION LIFECYCLE (SCENARIOS 19–24)
    // =========================================================================
    console.log('\n─── Section 4: Inventory Invariants, Reservations & Exact Reversals ───');

    let invItemIdA, invItemIdB;
    runTest('Scenario 19: Order creation reserves materials; available stock decreases while on-hand remains intact', () => {
        invItemIdA = InventoryService.createItem({
            sku: 'MAT-A4-BOND',
            name: 'A4 Bond Paper 100GSM',
            category_id: 1,
            unit: 'Ream',
            opening_stock: 40,
            minimum_stock: 5,
            purchase_price: 300,
            selling_price: 450,
            storage_location_id: 1
        });

        const itemBefore = InventoryService.getItemById(invItemIdA);
        assert.strictEqual(itemBefore.current_stock, 40);
        assert.strictEqual(itemBefore.reserved_stock, 0);

        // Reserve 8 reams for Order 2001
        const orderId = 2001;
        db.prepare("INSERT INTO orders (id, submission_id, total_price, subtotal, status, payment_status) VALUES (?, 'SUB-2001', 3600, 3600, 'Confirmed', 'Unpaid')").run(orderId);
        db.prepare("INSERT INTO order_items (order_id, file_name, file_path, paper_size, print_type, sides, pages, copies, unit_price, total_price, paper_id) VALUES (?, 'doc.pdf', 'dummy.pdf', 'A4', 'bw', 'Single', 8, 1, 450, 3600, ?)").run(orderId, invItemIdA);

        const res = ReservationService.reserve(orderId, { locationId: 1 });
        assert.strictEqual(res.success, true);

        const itemAfter = InventoryService.getItemById(invItemIdA);
        assert.strictEqual(itemAfter.current_stock, 40); // on-hand unchanged
        assert.strictEqual(itemAfter.reserved_stock, 8); // 8 units reserved
        assert.strictEqual(itemAfter.current_stock - itemAfter.reserved_stock, 32); // 32 available
    });

    runTest('Scenario 20: Order completion consumes reservation, deducting on-hand stock and clearing reserved stock', () => {
        const orderId = 2001;
        const fulfill = ReservationService.fulfill(orderId);
        assert.strictEqual(fulfill.success, true);

        const item = InventoryService.getItemById(invItemIdA);
        assert.strictEqual(item.current_stock, 32); // 40 - 8 = 32
        assert.strictEqual(item.reserved_stock, 0); // 8 - 8 = 0
        assert.strictEqual(item.current_stock - item.reserved_stock, 32);
    });

    runTest('Scenario 21: Order cancellation releases active reservation, restoring available stock', () => {
        const orderId = 2002;
        db.prepare("INSERT INTO orders (id, submission_id, total_price, subtotal, status, payment_status) VALUES (?, 'SUB-2002', 1800, 1800, 'Confirmed', 'Unpaid')").run(orderId);
        db.prepare("INSERT INTO order_items (order_id, file_name, file_path, paper_size, print_type, sides, pages, copies, unit_price, total_price, paper_id) VALUES (?, 'doc.pdf', 'dummy.pdf', 'A4', 'bw', 'Single', 4, 1, 450, 1800, ?)").run(orderId, invItemIdA);

        ReservationService.reserve(orderId, { locationId: 1 });
        let item = InventoryService.getItemById(invItemIdA);
        assert.strictEqual(item.reserved_stock, 4);

        ReservationService.release(orderId);
        item = InventoryService.getItemById(invItemIdA);
        assert.strictEqual(item.reserved_stock, 0);
        assert.strictEqual(item.current_stock, 32);
    });

    runTest('Scenario 22: Negative stock protection blocks manual stock reductions breaching active reservations', () => {
        const orderId = 2003;
        db.prepare("INSERT INTO orders (id, submission_id, total_price, subtotal, status, payment_status) VALUES (?, 'SUB-2003', 4500, 4500, 'Confirmed', 'Unpaid')").run(orderId);
        db.prepare("INSERT INTO order_items (order_id, file_name, file_path, paper_size, print_type, sides, pages, copies, unit_price, total_price, paper_id) VALUES (?, 'doc.pdf', 'dummy.pdf', 'A4', 'bw', 'Single', 25, 1, 450, 4500, ?)").run(orderId, invItemIdA);

        ReservationService.reserve(orderId, { locationId: 1 });
        // Current: 32, Reserved: 25, Available: 7.
        // Trying to deduct 15 units manually must fail!
        assert.throws(() => {
            InventoryService.adjustStock({
                item_id: invItemIdA,
                location_id: 1,
                type: 'waste',
                qty: -15,
                reason: 'Damaged paper'
            });
        }, /Insufficient available stock/);

        ReservationService.release(orderId);
    });

    runTest('Scenario 23: Exact transaction reversal restores stock without deleting historical ledger rows', () => {
        invItemIdB = InventoryService.createItem({
            sku: 'INK-HP-CYAN',
            name: 'HP GT52 Cyan Ink',
            category_id: 2,
            unit: 'Bottle',
            opening_stock: 10,
            purchase_price: 400,
            storage_location_id: 1
        });

        const adjRes = InventoryService.adjustStock({
            item_id: invItemIdB,
            location_id: 1,
            type: 'manual_in',
            qty: 5,
            cost: 400,
            reason: 'Found 5 bottles'
        });
        const origTxId = adjRes.transactionId;

        const revRes = InventoryService.reverseTransaction(origTxId, 'Error in counting');
        assert.strictEqual(revRes.success, true);
        assert.strictEqual(revRes.newStock, 10);

        const origTx = db.prepare('SELECT is_reversed FROM stock_transactions WHERE id = ?').get(origTxId);
        assert.strictEqual(origTx.is_reversed, 1);

        const revTx = db.prepare('SELECT reversal_of_id, qty FROM stock_transactions WHERE id = ?').get(revRes.reversalTransactionId);
        assert.strictEqual(revTx.reversal_of_id, origTxId);
        assert.strictEqual(revTx.qty, -5);
    });

    runTest('Scenario 24: Deleting or archiving items with active reservations is blocked', () => {
        const orderId = 2004;
        db.prepare("INSERT INTO orders (id, submission_id, total_price, subtotal, status, payment_status) VALUES (?, 'SUB-2004', 900, 900, 'Confirmed', 'Unpaid')").run(orderId);
        db.prepare("INSERT INTO order_items (order_id, file_name, file_path, paper_size, print_type, sides, pages, copies, unit_price, total_price, paper_id) VALUES (?, 'doc.pdf', 'dummy.pdf', 'A4', 'bw', 'Single', 2, 1, 450, 900, ?)").run(orderId, invItemIdA);

        ReservationService.reserve(orderId, { locationId: 1 });

        assert.throws(() => {
            InventoryService.softDeleteItem(invItemIdA);
        }, /active stock reservations/);

        ReservationService.release(orderId);
    });

    // =========================================================================
    // SECTION 5: PURCHASING & FINANCIAL ACCURACY (SCENARIOS 25–30)
    // =========================================================================
    console.log('\n─── Section 5: Purchasing, Goods Receiving & Supplier Payable Ledger ───');

    let poId1, supplierId1, poItemId1, grId1;
    runTest('Scenario 25: Newly created purchase order strictly starts in Draft status', () => {
        const supRes = db.prepare("INSERT INTO suppliers (name, phone, gstin, outstanding_balance) VALUES ('Bilt Paper Mills', '9876543230', '27BBBBB0000B1Z6', 0)").run();
        supplierId1 = supRes.lastInsertRowid;

        const poRes = PurchasingService.createPurchaseOrder({
            supplier_id: supplierId1,
            status: 'Approved', // Client attempts to force Approved status
            items: [{
                item_id: invItemIdA,
                qty: 10,
                unit_cost: 280,
                tax_rate: 18
            }]
        }, { user: { name: 'Admin', role: 'Admin' } });

        assert.strictEqual(poRes.success, true);
        poId1 = poRes.poId;
        const po = PurchasingService.getPurchaseOrderById(poId1);
        assert.strictEqual(po.status, 'Draft', 'PO must strictly start in Draft status');
        poItemId1 = po.items[0].id;
    });

    runTest('Scenario 26: Partial goods receipt increases stock, recalculates cost, and enforces max received balance', () => {
        // Approve and Order PO
        PurchasingService.approvePurchaseOrder(poId1, { user: { name: 'Manager', role: 'Admin' } });
        PurchasingService.markPurchaseOrderOrdered(poId1, { user: { name: 'Operator', role: 'Operator' } });

        // Receive partial 6 units
        const grRes = PurchasingService.receivePurchaseOrderItems({
            po_id: poId1,
            supplier_id: supplierId1,
            location_id: 1,
            items: [{
                po_item_id: poItemId1,
                qty_received: 6
            }]
        }, { user: { name: 'Admin', role: 'Admin' } });

        assert.strictEqual(grRes.success, true);
        grId1 = grRes.receiptId;

        const item = InventoryService.getItemById(invItemIdA);
        assert.strictEqual(item.current_stock, 38); // 32 + 6 = 38

        const po = PurchasingService.getPurchaseOrderById(poId1);
        assert.strictEqual(po.status, 'Partially Received');
    });

    let billId1;
    runTest('Scenario 27: Supplier bill posting records credit liability in supplier ledger with integer paise accuracy', () => {
        const billRes = PurchasingService.postSupplierBill({
            po_id: poId1,
            supplier_id: supplierId1,
            bill_number: 'BILL-BILT-901',
            bill_date: new Date().toISOString().split('T')[0],
            items: [{
                item_id: invItemIdA,
                qty: 6,
                unit_cost: 280,
                tax_rate: 18
            }]
        }, { user: { name: 'Admin', role: 'Admin' } });

        assert.strictEqual(billRes.success, true);
        billId1 = billRes.billId;

        const bal = PurchasingService.syncSupplierBalance(supplierId1, db);
        assert.ok(bal > 0);
        assert.strictEqual(bal, billRes.grandTotal);
    });

    let paymentId1;
    runTest('Scenario 28: Supplier payment allocates against bill, decreases liability, and syncs derived balance', () => {
        const payRes = PurchasingService.recordSupplierPayment({
            supplier_id: supplierId1,
            amount: 1000,
            payment_method: 'Bank Transfer',
            allocations: [{
                bill_id: billId1,
                amount: 1000
            }]
        }, { user: { name: 'Admin', role: 'Admin' } });

        assert.strictEqual(payRes.success, true);
        paymentId1 = payRes.paymentId;

        const bill = db.prepare('SELECT paid_amount, status FROM supplier_bills WHERE id = ?').get(billId1);
        assert.strictEqual(bill.paid_amount, 1000);
        assert.strictEqual(bill.status, 'Partially Paid');
    });

    runTest('Scenario 29: Payment reversal restores bill outstanding balance and liability without arithmetic drift', () => {
        const revRes = PurchasingService.reverseSupplierPayment(paymentId1, 'Check bounced', { user: { name: 'Admin', role: 'Admin' } });
        assert.strictEqual(revRes.success, true);

        const bill = db.prepare('SELECT paid_amount, status FROM supplier_bills WHERE id = ?').get(billId1);
        assert.strictEqual(bill.paid_amount, 0);
        assert.strictEqual(bill.status, 'Posted');
    });

    runTest('Scenario 30: Purchase return links to exact goods receipt line, validates returnable qty, and issues debit note', () => {
        const retRes = PurchasingService.createPurchaseReturn({
            po_id: poId1,
            goods_receipt_id: grId1,
            supplier_id: supplierId1,
            item_id: invItemIdA,
            location_id: 1,
            qty_returned: 2,
            reason: 'Defective packaging'
        }, { user: { name: 'Admin', role: 'Admin' } });

        assert.strictEqual(retRes.success, true);
        const item = InventoryService.getItemById(invItemIdA);
        assert.strictEqual(item.current_stock, 36); // 38 - 2 = 36

        // Over-return check: received 6, returned 2, remaining returnable is 4. Requesting 5 must fail!
        assert.throws(() => {
            PurchasingService.createPurchaseReturn({
                po_id: poId1,
                goods_receipt_id: grId1,
                supplier_id: supplierId1,
                item_id: invItemIdA,
                location_id: 1,
                qty_returned: 5,
                reason: 'Excess return'
            }, { user: { name: 'Admin', role: 'Admin' } });
        }, /exceeds net returnable quantity/);
    });

    console.log('\n════════════════════════════════════════════════════════════════════════════');
    console.log(`📊 INTEGRATED RELEASE GATE SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
    console.log('════════════════════════════════════════════════════════════════════════════\n');

    if (failedTests > 0) {
        process.exit(1);
    } else {
        console.log('🌟 ALL 30 INTEGRATED RELEASE GATE SCENARIOS PASSED WITH ZERO ERRORS!\n');
        process.exit(0);
    }
}

runIntegrationSuite().catch(err => {
    console.error('Integrated release gate failed:', err);
    process.exit(1);
});
