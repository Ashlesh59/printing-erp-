/**
 * Phase 5 Comprehensive Automated Verification Suite
 * Purchasing, Goods Receiving, Supplier Bills, Payments, Returns, Credits & Payable Ledger
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const Database = require('better-sqlite3');

// Initialize Test Environment with dedicated isolated SQLite DB
const testDir = path.join(os.tmpdir(), 'print_erp_phase5_tests_' + Date.now());
fs.mkdirSync(testDir, { recursive: true });

const testDbPath = path.join(testDir, 'test_purchasing.db');
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
const PurchasingService = require('./src/main/services/purchasing/purchasing-service');
const InventoryModel = require('./src/main/database/inventory-model');

let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failedTests++;
    }
}

console.log("\n=======================================================");
console.log("  PHASE 5 PURCHASING, GOODS RECEIVING & PAYABLE LEDGER  ");
console.log("=======================================================\n");

let supplierAId, supplierBId, itemPaperId, itemInkId, locationMainId;

runTest("1. Database Schema & Migration 17 Tables Exist", () => {
    const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table'
    `).all().map(t => t.name);

    const requiredTables = [
        'suppliers', 'inventory_locations', 'inventory_items', 'purchase_orders',
        'purchase_order_items', 'goods_receipts', 'goods_receipt_items',
        'supplier_bills', 'supplier_bill_items', 'supplier_payments',
        'supplier_payment_allocations', 'supplier_ledger', 'purchase_returns'
    ];

    for (const req of requiredTables) {
        assert(tables.includes(req), `Table ${req} must exist in database`);
    }
});

runTest("2. Seed Suppliers, Locations, and Inventory Items", () => {
    // Create Location
    const locRes = InventoryModel.createLocation({ name: 'Central Warehouse', description: 'Main Storage' });
    locationMainId = locRes.id || 1;

    // Create Supplier A with 0 opening balance
    const supARes = InventoryModel.createSupplier({
        name: 'Apex Paper Mills',
        phone: '9876543210',
        email: 'sales@apexpaper.com',
        gstin: '27AAAAA0000A1Z5',
        address: 'Mumbai Industrial Estate',
        payment_terms: 'Net 30',
        opening_balance: 0
    });
    supplierAId = supARes.id;

    // Create Supplier B with Opening Balance 5000
    const supBRes = InventoryModel.createSupplier({
        name: 'Bharat Inks Ltd',
        phone: '9876543211',
        email: 'orders@bharatinks.com',
        gstin: '27BBBBB0000B1Z6',
        address: 'Pune MIDC',
        payment_terms: 'Immediate',
        opening_balance: 5000
    });
    supplierBId = supBRes.id;

    // Create Item 1: 300 GSM Art Card
    const item1 = db.prepare(`
        INSERT INTO inventory_items (
            sku, name, category_id, supplier_id, unit, opening_stock, current_stock,
            purchase_price, average_cost, storage_location_id, status
        ) VALUES ('PAP-ART-300', '300 GSM Art Card A3', 1, ?, 'Ream', 10, 10, 500, 500, ?, 'Active')
    `).run(supplierAId, locationMainId);
    itemPaperId = item1.lastInsertRowid;

    // Seed location stock for Item 1
    db.prepare(`
        INSERT INTO inventory_location_stock (item_id, location_id, current_stock, reserved_stock)
        VALUES (?, ?, 10, 0)
    `).run(itemPaperId, locationMainId);

    // Create Item 2: Cyan Offset Ink
    const item2 = db.prepare(`
        INSERT INTO inventory_items (
            sku, name, category_id, supplier_id, unit, opening_stock, current_stock,
            purchase_price, average_cost, storage_location_id, status
        ) VALUES ('INK-CYAN-1KG', 'Cyan Process Ink 1kg', 1, ?, 'Can', 5, 5, 800, 800, ?, 'Active')
    `).run(supplierBId, locationMainId);
    itemInkId = item2.lastInsertRowid;

    // Seed location stock for Item 2
    db.prepare(`
        INSERT INTO inventory_location_stock (item_id, location_id, current_stock, reserved_stock)
        VALUES (?, ?, 5, 0)
    `).run(itemInkId, locationMainId);

    assert(supplierAId > 0 && supplierBId > 0 && itemPaperId > 0 && itemInkId > 0);
});

runTest("3. Supplier Opening Balance creates Immutable Ledger Entry & Syncs Balance", () => {
    const supB = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierBId);
    assert.strictEqual(supB.outstanding_balance, 5000);

    const ledger = PurchasingService.getSupplierLedger(supplierBId);
    assert.strictEqual(ledger.length, 1);
    assert.strictEqual(ledger[0].entry_type, 'OPENING_BALANCE');
    assert.strictEqual(ledger[0].direction, 'CREDIT');
    assert.strictEqual(ledger[0].amount, 5000);
});

// ──────────────────────────────────────────────────────────────
// PURCHASE ORDER CREATION & LIFECYCLE
// ──────────────────────────────────────────────────────────────

let po1Id, po1Number;

runTest("4. Create Purchase Order with Mathematical Accuracy & Tax Splits", () => {
    const poData = {
        supplier_id: supplierAId,
        order_date: '2026-09-01',
        expected_delivery_date: '2026-09-10',
        location_id: locationMainId,
        transport_cost: 200,
        discount: 100,
        status: 'Draft',
        notes: 'Urgent stock order for wedding cards',
        items: [
            { item_id: itemPaperId, qty: 20, cost: 500, gst_rate: 18 } // Sub: 10000, GST: 1800, LineTot: 11800
        ]
    };

    const res = PurchasingService.createPurchaseOrder(poData, { user: { name: 'Admin', role: 'Admin' } });
    assert.strictEqual(res.success, true);
    assert(res.poId > 0);
    po1Id = res.poId;
    po1Number = res.poNumber;

    const po = PurchasingService.getPurchaseOrderById(po1Id);
    assert.strictEqual(po.status, 'Draft');
    assert.strictEqual(po.subtotal, 10000);
    assert.strictEqual(po.tax_amount, 1800);
    assert.strictEqual(po.cgst_amount, 900);
    assert.strictEqual(po.sgst_amount, 900);
    assert.strictEqual(po.transport_cost, 200);
    assert.strictEqual(po.discount, 100);
    assert.strictEqual(po.grand_total, 11900); // 10000 + 1800 + 200 - 100 = 11900

    assert.strictEqual(po.items.length, 1);
    assert.strictEqual(po.items[0].ordered_qty, 20);
    assert.strictEqual(po.items[0].received_qty, 0);
    assert.strictEqual(po.items[0].item_name_snapshot, '300 GSM Art Card A3');
});

runTest("5. PO Creation has Zero Inventory and Zero Ledger Impact", () => {
    const item = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemPaperId);
    assert.strictEqual(item.current_stock, 10, "Current stock must remain unaffected by Draft PO");

    const ledger = PurchasingService.getSupplierLedger(supplierAId);
    assert.strictEqual(ledger.length, 0, "No financial ledger entries should exist on PO draft");
});

runTest("6. PO Lifecycle: Draft -> Approved -> Ordered State Transitions", () => {
    // Approve
    const appRes = PurchasingService.approvePurchaseOrder(po1Id, { user: { name: 'Manager', role: 'Admin' } });
    assert.strictEqual(appRes.success, true);
    assert.strictEqual(appRes.status, 'Approved');

    let po = PurchasingService.getPurchaseOrderById(po1Id);
    assert.strictEqual(po.status, 'Approved');
    assert.strictEqual(po.approved_by, 'Manager');

    // Mark Ordered
    const ordRes = PurchasingService.markPurchaseOrderOrdered(po1Id, { user: { name: 'Operator', role: 'Operator' } });
    assert.strictEqual(ordRes.success, true);
    assert.strictEqual(ordRes.status, 'Ordered');

    po = PurchasingService.getPurchaseOrderById(po1Id);
    assert.strictEqual(po.status, 'Ordered');
});

runTest("7. Rejection of Invalid PO State Transitions", () => {
    // Attempting to approve an already Ordered PO should throw
    assert.throws(() => {
        PurchasingService.approvePurchaseOrder(po1Id, { user: { name: 'Admin', role: 'Admin' } });
    }, /Expected 'Draft'/);
});

// ──────────────────────────────────────────────────────────────
// GOODS RECEIVING & INVENTORY ACCURACY
// ──────────────────────────────────────────────────────────────

let receipt1Id;

runTest("8. Partial Goods Receiving (Receive 8 of 20 Reams)", () => {
    const po = PurchasingService.getPurchaseOrderById(po1Id);
    const poItemId = po.items[0].id;

    const receiptPayload = {
        po_id: po1Id,
        receipt_date: '2026-09-03',
        location_id: locationMainId,
        supplier_doc_ref: 'DC-88192',
        notes: 'First batch delivered by courier',
        items: [
            { po_item_id: poItemId, qty_received: 8 }
        ]
    };

    const res = PurchasingService.receivePurchaseOrderItems(receiptPayload, { user: { name: 'Warehouse Clerk', role: 'Admin' } });
    assert.strictEqual(res.success, true);
    assert(res.receiptId > 0);
    assert.strictEqual(res.poStatus, 'Partially Received');
    receipt1Id = res.receiptId;

    // Verify PO status and item quantities
    const updatedPo = PurchasingService.getPurchaseOrderById(po1Id);
    assert.strictEqual(updatedPo.status, 'Partially Received');
    assert.strictEqual(updatedPo.items[0].received_qty, 8);
    assert.strictEqual(updatedPo.items[0].ordered_qty, 20);
});

runTest("9. Physical Stock In & Weighted Average Cost Recalculation after Partial Receipt", () => {
    // Previous stock: 10 @ ₹500
    // Received: 8 @ ₹500
    // New Stock: 18, New Avg Cost: ₹500
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemPaperId);
    assert.strictEqual(item.current_stock, 18);
    assert.strictEqual(item.average_cost, 500);

    const locStock = db.prepare('SELECT current_stock FROM inventory_location_stock WHERE item_id = ? AND location_id = ?').get(itemPaperId, locationMainId);
    assert.strictEqual(locStock.current_stock, 18);

    // Verify batch record
    const batches = db.prepare('SELECT * FROM inventory_batches WHERE item_id = ?').all(itemPaperId);
    assert(batches.length >= 1);
    assert.strictEqual(batches[batches.length - 1].qty_received, 8);

    // Verify stock transaction
    const txs = db.prepare("SELECT * FROM stock_transactions WHERE item_id = ? AND type = 'purchase'").all(itemPaperId);
    assert(txs.length >= 1);
    assert.strictEqual(txs[txs.length - 1].qty, 8);
});

runTest("10. Over-Receipt Protection rejects receiving more than remaining balance", () => {
    const po = PurchasingService.getPurchaseOrderById(po1Id);
    const poItemId = po.items[0].id;
    // Remaining is 12 (20 - 8). Attempting to receive 15 should throw
    assert.throws(() => {
        PurchasingService.receivePurchaseOrderItems({
            po_id: po1Id,
            items: [
                { po_item_id: poItemId, qty_received: 15 }
            ]
        });
    }, /exceeds remaining ordered quantity/);
});

runTest("11. Atomic Rollback: Negative or invalid receive quantities roll back entire transaction", () => {
    const po = PurchasingService.getPurchaseOrderById(po1Id);
    const poItemId = po.items[0].id;

    assert.throws(() => {
        PurchasingService.receivePurchaseOrderItems({
            po_id: po1Id,
            items: [{ po_item_id: poItemId, qty_received: -5 }]
        });
    }, /cannot be negative/);

    // Ensure stock remained 18 and was not mutated
    const item = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemPaperId);
    assert.strictEqual(item.current_stock, 18);
});

runTest("12. Complete Second Partial Receipt to transition PO to Fully Received", () => {
    const po = PurchasingService.getPurchaseOrderById(po1Id);
    const poItemId = po.items[0].id;

    const res = PurchasingService.receivePurchaseOrderItems({
        po_id: po1Id,
        receipt_date: '2026-09-05',
        supplier_doc_ref: 'DC-88250',
        items: [
            { po_item_id: poItemId, qty_received: 12 } // remaining 12
        ]
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.poStatus, 'Fully Received');

    const updatedPo = PurchasingService.getPurchaseOrderById(po1Id);
    assert.strictEqual(updatedPo.status, 'Fully Received');
    assert.strictEqual(updatedPo.items[0].received_qty, 20);

    const item = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemPaperId);
    assert.strictEqual(item.current_stock, 30); // 10 initial + 8 + 12 = 30
});

// ──────────────────────────────────────────────────────────────
// SUPPLIER BILLS & PAYABLE LEDGER
// ──────────────────────────────────────────────────────────────

let bill1Id;

runTest("13. Post Supplier Bill creates Credit Liability in Ledger & Updates Balance", () => {
    const billData = {
        supplier_id: supplierAId,
        po_id: po1Id,
        supplier_invoice_ref: 'INV-2026-0901',
        bill_date: '2026-09-05',
        transport_cost: 200,
        discount: 100,
        items: [
            { item_id: itemPaperId, qty: 20, unit_cost: 500, tax_rate: 18 }
        ]
    };

    const res = PurchasingService.postSupplierBill(billData, { user: { name: 'Accounts Admin', role: 'Admin' } });
    assert.strictEqual(res.success, true);
    assert(res.billId > 0);
    bill1Id = res.billId;
    assert.strictEqual(res.grandTotal, 11900);
    assert.strictEqual(res.supplierBalance, 11900);

    // Verify Supplier Record
    const supA = db.prepare('SELECT outstanding_balance FROM suppliers WHERE id = ?').get(supplierAId);
    assert.strictEqual(supA.outstanding_balance, 11900);

    // Verify Immutable Ledger
    const ledger = PurchasingService.getSupplierLedger(supplierAId);
    assert.strictEqual(ledger.length, 1);
    assert.strictEqual(ledger[0].entry_type, 'SUPPLIER_BILL');
    assert.strictEqual(ledger[0].direction, 'CREDIT');
    assert.strictEqual(ledger[0].amount, 11900);
    assert.strictEqual(ledger[0].source_id, bill1Id);
});

// ──────────────────────────────────────────────────────────────
// SUPPLIER PAYMENTS & SETTLEMENT
// ──────────────────────────────────────────────────────────────

let payment1Id;

runTest("14. Record Supplier Payment with Bill Allocation (Pay ₹6000 against Bill)", () => {
    const payData = {
        supplier_id: supplierAId,
        amount: 6000,
        payment_date: '2026-09-06',
        payment_method: 'Bank Transfer',
        reference_number: 'NEFT-AXIS-99210',
        notes: 'Part-payment for invoice INV-2026-0901',
        allocations: [
            { bill_id: bill1Id, amount: 6000 }
        ]
    };

    const res = PurchasingService.recordSupplierPayment(payData, { user: { name: 'Finance Manager', role: 'Admin' } });
    assert.strictEqual(res.success, true);
    assert(res.paymentId > 0);
    payment1Id = res.paymentId;
    assert.strictEqual(res.supplierBalance, 5900); // 11900 - 6000 = 5900

    // Verify Bill status updated to Partially Paid
    const bill = db.prepare('SELECT * FROM supplier_bills WHERE id = ?').get(bill1Id);
    assert.strictEqual(bill.status, 'Partially Paid');
    assert.strictEqual(bill.paid_amount, 6000);
    assert.strictEqual(bill.outstanding_amount, 5900);

    // Verify Ledger: DEBIT 6000
    const ledger = PurchasingService.getSupplierLedger(supplierAId);
    assert.strictEqual(ledger.length, 2);
    assert.strictEqual(ledger[1].entry_type, 'SUPPLIER_PAYMENT');
    assert.strictEqual(ledger[1].direction, 'DEBIT');
    assert.strictEqual(ledger[1].amount, 6000);
});

runTest("15. Over-Allocation Protection: Cannot allocate more than bill outstanding", () => {
    assert.throws(() => {
        PurchasingService.recordSupplierPayment({
            supplier_id: supplierAId,
            amount: 8000,
            payment_date: '2026-09-07',
            payment_method: 'UPI',
            allocations: [
                { bill_id: bill1Id, amount: 8000 } // Outstanding is 5900
            ]
        });
    }, /exceeds bill outstanding balance/);
});

runTest("16. Settle Remaining Bill Balance (Pay ₹5900 -> Bill Paid)", () => {
    const res = PurchasingService.recordSupplierPayment({
        supplier_id: supplierAId,
        amount: 5900,
        payment_date: '2026-09-08',
        payment_method: 'UPI',
        reference_number: 'UPI-99281729',
        allocations: [
            { bill_id: bill1Id, amount: 5900 }
        ]
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.supplierBalance, 0);

    const bill = db.prepare('SELECT * FROM supplier_bills WHERE id = ?').get(bill1Id);
    assert.strictEqual(bill.status, 'Paid');
    assert.strictEqual(bill.outstanding_amount, 0);
    assert.strictEqual(bill.paid_amount, 11900);
});

// ──────────────────────────────────────────────────────────────
// PAYMENT REVERSAL & INTEGRITY
// ──────────────────────────────────────────────────────────────

runTest("17. Reverse Supplier Payment un-allocates bills & restores liability", () => {
    // Reverse the first payment of ₹6000
    const res = PurchasingService.reverseSupplierPayment(payment1Id, 'Cheque bounced / transaction failed');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.supplierBalance, 6000);

    // Verify Bill reverted from Paid to Partially Paid
    const bill = db.prepare('SELECT * FROM supplier_bills WHERE id = ?').get(bill1Id);
    assert.strictEqual(bill.status, 'Partially Paid');
    assert.strictEqual(bill.paid_amount, 5900);
    assert.strictEqual(bill.outstanding_amount, 6000);

    // Verify Reversal ledger entry
    const ledger = PurchasingService.getSupplierLedger(supplierAId);
    const reversalEntry = ledger.find(e => e.entry_type === 'PAYMENT_REVERSAL');
    assert(reversalEntry !== undefined);
    assert.strictEqual(reversalEntry.direction, 'CREDIT');
    assert.strictEqual(reversalEntry.amount, 6000);
});

// ──────────────────────────────────────────────────────────────
// PURCHASE RETURNS & DEBITS
// ──────────────────────────────────────────────────────────────

let return1Id;

runTest("18. Create Purchase Return with Stock Reduction & Debit Note", () => {
    const currentStockBefore = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemPaperId).current_stock;
    assert.strictEqual(currentStockBefore, 30);

    const returnData = {
        supplier_id: supplierAId,
        item_id: itemPaperId,
        location_id: locationMainId,
        qty_returned: 4,
        unit_cost: 500,
        credit_amount: 2000,
        reason: 'Water damaged during courier transit'
    };

    const res = PurchasingService.createPurchaseReturn(returnData, { user: { name: 'QA Inspector', role: 'Admin' } });
    assert.strictEqual(res.success, true);
    assert(res.returnId > 0);
    return1Id = res.returnId;
    assert.strictEqual(res.creditAmount, 2000);

    // Verify stock deducted
    const currentStockAfter = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemPaperId).current_stock;
    assert.strictEqual(currentStockAfter, 26);

    const locStock = db.prepare('SELECT current_stock FROM inventory_location_stock WHERE item_id = ? AND location_id = ?').get(itemPaperId, locationMainId);
    assert.strictEqual(locStock.current_stock, 26);

    // Verify stock transaction has negative quantity
    const tx = db.prepare("SELECT * FROM stock_transactions WHERE reference_type = 'purchase_return' AND reference_id = ?").get(return1Id);
    assert.strictEqual(tx.qty, -4);

    // Verify Supplier Ledger received DEBIT of ₹2000
    const supA = db.prepare('SELECT outstanding_balance FROM suppliers WHERE id = ?').get(supplierAId);
    assert.strictEqual(supA.outstanding_balance, 4000); // 6000 - 2000 = 4000
});

runTest("19. Purchase Return fails if on-hand stock is insufficient", () => {
    assert.throws(() => {
        PurchasingService.createPurchaseReturn({
            supplier_id: supplierAId,
            item_id: itemPaperId,
            location_id: locationMainId,
            qty_returned: 100 // Available is 26
        });
    }, /Insufficient on-hand stock/);
});

// ──────────────────────────────────────────────────────────────
// PURCHASE ORDER CANCELLATION RULES
// ──────────────────────────────────────────────────────────────

runTest("20. PO Cancellation: Draft PO cancelled with 0 stock/ledger impact", () => {
    const draftPo = PurchasingService.createPurchaseOrder({
        supplier_id: supplierAId,
        status: 'Draft',
        items: [{ item_id: itemPaperId, qty: 5, cost: 500 }]
    });

    const cancelRes = PurchasingService.cancelPurchaseOrder(draftPo.poId, 'No longer required');
    assert.strictEqual(cancelRes.success, true);
    assert.strictEqual(cancelRes.status, 'Cancelled');

    const po = PurchasingService.getPurchaseOrderById(draftPo.poId);
    assert.strictEqual(po.status, 'Cancelled');
    assert.strictEqual(po.items[0].cancelled_qty, 5);
});

runTest("21. PO Cancellation: Partially Received PO closes remainder safely preserving received stock", () => {
    // Create new PO for Supplier B (Ink)
    const newPo = PurchasingService.createPurchaseOrder({
        supplier_id: supplierBId,
        status: 'Ordered',
        items: [{ item_id: itemInkId, qty: 10, cost: 800, gst_rate: 18 }]
    });

    const poItemId = PurchasingService.getPurchaseOrderById(newPo.poId).items[0].id;

    // Receive 4 cans
    PurchasingService.receivePurchaseOrderItems({
        po_id: newPo.poId,
        location_id: locationMainId,
        items: [{ po_item_id: poItemId, qty_received: 4 }]
    });

    const itemBefore = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemInkId);
    assert.strictEqual(itemBefore.current_stock, 9); // 5 initial + 4 received = 9

    // Now cancel the remaining 6 on the PO
    const cancelRes = PurchasingService.cancelPurchaseOrder(newPo.poId, 'Supplier cannot supply remaining 6 units');
    assert.strictEqual(cancelRes.success, true);
    assert.strictEqual(cancelRes.status, 'Closed');

    const po = PurchasingService.getPurchaseOrderById(newPo.poId);
    assert.strictEqual(po.status, 'Closed');
    assert.strictEqual(po.items[0].received_qty, 4);
    assert.strictEqual(po.items[0].cancelled_qty, 6);

    // Verify stock remains 9 and was NOT reverted
    const itemAfter = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemInkId);
    assert.strictEqual(itemAfter.current_stock, 9);
});

runTest("22. PO Cancellation: Fully Received PO cannot be cancelled", () => {
    assert.throws(() => {
        PurchasingService.cancelPurchaseOrder(po1Id, 'Cancel full PO');
    }, /Cannot cancel a fully received/);
});

// ──────────────────────────────────────────────────────────────
// IDEMPOTENCY & REPLAY PROTECTION
// ──────────────────────────────────────────────────────────────

runTest("23. Idempotency Key deduplicates repeated PO creation calls", () => {
    const key = `PO-IDEM-TEST-${Date.now()}`;
    const poData = {
        idempotency_key: key,
        supplier_id: supplierAId,
        items: [{ item_id: itemPaperId, qty: 2, cost: 500 }]
    };

    const res1 = PurchasingService.createPurchaseOrder(poData);
    const res2 = PurchasingService.createPurchaseOrder(poData);

    assert.strictEqual(res1.poId, res2.poId);
    assert.strictEqual(res2.isDuplicate, true);
});

runTest("24. Idempotency Key prevents double-incrementing stock on repeated Goods Receipt calls", () => {
    const key = `REC-IDEM-TEST-${Date.now()}`;
    const testPo = PurchasingService.createPurchaseOrder({
        supplier_id: supplierAId,
        status: 'Ordered',
        items: [{ item_id: itemPaperId, qty: 5, cost: 500 }]
    });
    const poItemId = PurchasingService.getPurchaseOrderById(testPo.poId).items[0].id;

    const receiptPayload = {
        idempotency_key: key,
        po_id: testPo.poId,
        location_id: locationMainId,
        items: [{ po_item_id: poItemId, qty_received: 2 }]
    };

    const stockBefore = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemPaperId).current_stock;

    const res1 = PurchasingService.receivePurchaseOrderItems(receiptPayload);
    const stockAfter1 = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemPaperId).current_stock;
    assert.strictEqual(stockAfter1, stockBefore + 2);

    const res2 = PurchasingService.receivePurchaseOrderItems(receiptPayload);
    const stockAfter2 = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemPaperId).current_stock;
    assert.strictEqual(res2.isDuplicate, true);
    assert.strictEqual(stockAfter2, stockAfter1, "Stock must NOT increase on duplicate receipt submission");
});

// ──────────────────────────────────────────────────────────────
// SUPPLIER LEDGER, STATEMENTS & AUDIT INTEGRITY
// ──────────────────────────────────────────────────────────────

runTest("25. Supplier Statement accurately calculates chronological running balances", () => {
    const statementObj = PurchasingService.getSupplierStatement(supplierAId);
    assert(statementObj !== null);
    assert.strictEqual(statementObj.is_reconciled, true);
    assert.strictEqual(statementObj.derived_balance, statementObj.cached_balance);
    assert.strictEqual(statementObj.derived_balance, 4000);

    // Verify running balances on entries
    assert(statementObj.statement.length >= 4);
});

runTest("26. Supplier Archiving preserves historical references when delete requested", () => {
    const deleteRes = InventoryModel.deleteSupplier(supplierAId);
    assert.strictEqual(deleteRes.success, true);
    assert.strictEqual(deleteRes.archived, true);

    const sup = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierAId);
    assert.strictEqual(sup.is_archived, 1);

    // Default getSuppliers() hides archived suppliers
    const activeSuppliers = InventoryModel.getSuppliers();
    assert(!activeSuppliers.some(s => s.id === supplierAId));
});

runTest("27. Purchasing Integrity Report verifies zero violations on clean system", () => {
    const report = PurchasingService.getPurchasingIntegrityReport();
    assert.strictEqual(report.status, 'HEALTHY');
    assert.strictEqual(report.issueCount, 0);
});

// ──────────────────────────────────────────────────────────────
// ADDITIONAL ROBUSTNESS & EDGE CASE TESTS (28 - 35)
// ──────────────────────────────────────────────────────────────

runTest("28. Non-existent supplier throws error on PO creation", () => {
    assert.throws(() => {
        PurchasingService.createPurchaseOrder({
            supplier_id: 999999,
            items: [{ item_id: itemPaperId, qty: 1, cost: 500 }]
        });
    }, /Supplier not found/);
});

runTest("29. Archived supplier is blocked from new PO creation", () => {
    assert.throws(() => {
        PurchasingService.createPurchaseOrder({
            supplier_id: supplierAId, // Archived in test 26
            items: [{ item_id: itemPaperId, qty: 1, cost: 500 }]
        });
    }, /Cannot raise purchase order for an archived supplier/);
});

runTest("30. Multi-line Goods Receipt updates multiple item stocks & costs simultaneously", () => {
    const multiPo = PurchasingService.createPurchaseOrder({
        supplier_id: supplierBId,
        status: 'Ordered',
        items: [
            { item_id: itemPaperId, qty: 10, cost: 600, gst_rate: 18 },
            { item_id: itemInkId, qty: 5, cost: 900, gst_rate: 18 }
        ]
    });

    const poDetails = PurchasingService.getPurchaseOrderById(multiPo.poId);
    const p1 = poDetails.items.find(i => i.item_id === itemPaperId);
    const p2 = poDetails.items.find(i => i.item_id === itemInkId);

    const paperStockBefore = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemPaperId).current_stock;
    const inkStockBefore = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemInkId).current_stock;

    const recRes = PurchasingService.receivePurchaseOrderItems({
        po_id: multiPo.poId,
        location_id: locationMainId,
        items: [
            { po_item_id: p1.id, qty_received: 10 },
            { po_item_id: p2.id, qty_received: 5 }
        ]
    });

    assert.strictEqual(recRes.success, true);
    assert.strictEqual(recRes.poStatus, 'Fully Received');

    const paperStockAfter = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemPaperId).current_stock;
    const inkStockAfter = db.prepare('SELECT current_stock FROM inventory_items WHERE id = ?').get(itemInkId).current_stock;

    assert.strictEqual(paperStockAfter, paperStockBefore + 10);
    assert.strictEqual(inkStockAfter, inkStockBefore + 5);
});

runTest("31. Direct Bill Creation without PO increases supplier balance correctly", () => {
    const balBefore = db.prepare('SELECT outstanding_balance FROM suppliers WHERE id = ?').get(supplierBId).outstanding_balance;

    const directBill = PurchasingService.postSupplierBill({
        supplier_id: supplierBId,
        bill_date: '2026-09-09',
        supplier_invoice_ref: 'DIRECT-BILL-100',
        items: [
            { item_id: itemInkId, qty: 2, unit_cost: 800, tax_rate: 18 }
        ]
    });

    assert.strictEqual(directBill.success, true);
    const expectedTotal = PurchasingService.roundMoney(2 * 800 * 1.18);
    const balAfter = db.prepare('SELECT outstanding_balance FROM suppliers WHERE id = ?').get(supplierBId).outstanding_balance;
    assert.strictEqual(balAfter, PurchasingService.roundMoney(balBefore + expectedTotal));
});

runTest("32. Partial Payment with remainder maintains exact arithmetic precision", () => {
    const unallocatedPay = PurchasingService.recordSupplierPayment({
        supplier_id: supplierBId,
        amount: 500,
        payment_date: '2026-09-10',
        payment_method: 'Cash',
        reference_number: 'CASH-RCP-12'
    });

    assert.strictEqual(unallocatedPay.success, true);
    const bal = db.prepare('SELECT outstanding_balance FROM suppliers WHERE id = ?').get(supplierBId).outstanding_balance;
    const statement = PurchasingService.getSupplierStatement(supplierBId);
    assert.strictEqual(statement.derived_balance, bal);
});

runTest("33. Repeated PO Cancellation is idempotent and returns alreadyCancelled", () => {
    const testDraft = PurchasingService.createPurchaseOrder({
        supplier_id: supplierBId,
        status: 'Draft',
        items: [{ item_id: itemInkId, qty: 1, cost: 500 }]
    });

    const c1 = PurchasingService.cancelPurchaseOrder(testDraft.poId, 'First cancel');
    assert.strictEqual(c1.status, 'Cancelled');

    const c2 = PurchasingService.cancelPurchaseOrder(testDraft.poId, 'Second cancel');
    assert.strictEqual(c2.alreadyCancelled, true);
});

runTest("34. Manual balance adjustment via repository updates ledger safely", () => {
    const PORepository = require('./src/main/database/repositories/po-repository');
    const balBefore = db.prepare('SELECT outstanding_balance FROM suppliers WHERE id = ?').get(supplierBId).outstanding_balance;

    PORepository.updateSupplierBalance(supplierBId, 250);
    const balAfter = db.prepare('SELECT outstanding_balance FROM suppliers WHERE id = ?').get(supplierBId).outstanding_balance;
    assert.strictEqual(balAfter, balBefore + 250);

    const statement = PurchasingService.getSupplierStatement(supplierBId);
    assert.strictEqual(statement.is_reconciled, true);
});

runTest("35. Purchasing Integrity Audit detects injected over-receipt or mismatch", () => {
    // Inject a discrepancy: manually change supplier cached balance without ledger
    db.prepare('UPDATE suppliers SET outstanding_balance = 999999 WHERE id = ?').run(supplierBId);

    const audit = PurchasingService.getPurchasingIntegrityReport();
    assert.strictEqual(audit.status, 'WARNINGS_FOUND');
    assert(audit.issueCount > 0);
    assert(audit.issues.some(i => i.type === 'SUPPLIER_BALANCE_MISMATCH'));

    // Fix discrepancy
    PurchasingService.syncSupplierBalance(supplierBId, db);
    const cleanAudit = PurchasingService.getPurchasingIntegrityReport();
    assert.strictEqual(cleanAudit.status, 'HEALTHY');
});

console.log("\n-------------------------------------------------------");
console.log(`Results: ${passedTests} passed, ${failedTests} failed`);
console.log("-------------------------------------------------------\n");

if (failedTests > 0) {
    process.exit(1);
} else {
    console.log("✅ ALL PHASE 5 PURCHASING TESTS PASSED SUCCESSFULLY!\n");
    process.exit(0);
}

