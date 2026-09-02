/**
 * Phase 4 Comprehensive Automated Verification Suite
 * Enterprise Inventory Management, Stock Reservations & Reversal Integrity
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const Database = require('better-sqlite3');

// Dedicated isolated test DB
const testDir = path.join(os.tmpdir(), 'print_erp_phase4_tests_' + Date.now());
fs.mkdirSync(testDir, { recursive: true });

const testDbPath = path.join(testDir, 'test_inventory.db');
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

// Load services under test
const InventoryService = require('./src/main/database/services/inventory-service');
const ReservationService = require('./src/main/database/services/reservation-service');
const InventoryRepository = require('./src/main/database/repositories/inventory-repository');

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

async function runAsyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failedTests++;
    }
}

async function runAllTests() {
    console.log("\n=======================================================");
    console.log("  PHASE 4 INVENTORY & STOCK RESERVATIONS INTEGRITY     ");
    console.log("=======================================================\n");

    let itemIdA, itemIdB, locMainId = 1, locSecondaryId;

    // 1. Setup locations and items
    runTest("1. Setup Warehouse Locations & Base Items", () => {
        const locRes = db.prepare("INSERT INTO inventory_locations (name, type, description) VALUES ('Secondary Rack', 'Shelf', 'Shelf 2')").run();
        locSecondaryId = locRes.lastInsertRowid;

        itemIdA = InventoryService.createItem({
            sku: 'PAP-A4-80G',
            name: 'A4 Copier Paper 80GSM',
            category_id: 1,
            unit: 'Ream',
            opening_stock: 50,
            minimum_stock: 10,
            maximum_stock: 100,
            reorder_level: 15,
            purchase_price: 250,
            selling_price: 350,
            storage_location_id: locMainId
        });

        itemIdB = InventoryService.createItem({
            sku: 'INK-CANON-BK',
            name: 'Canon GI-790 Black Ink',
            category_id: 2,
            unit: 'Bottle',
            opening_stock: 20,
            minimum_stock: 5,
            reorder_level: 8,
            purchase_price: 450,
            selling_price: 650,
            storage_location_id: locMainId
        });

        const itemA = InventoryService.getItemById(itemIdA);
        assert.strictEqual(itemA.current_stock, 50);
        assert.strictEqual(itemA.reserved_stock, 0);
    });

    // 2. Stock Invariants & Available Stock
    runTest("2. Available Stock Calculation Invariant", () => {
        const itemA = InventoryService.getItemById(itemIdA);
        const available = itemA.current_stock - (itemA.reserved_stock || 0);
        assert.strictEqual(available, 50);
    });

    // 3. Stock Reservations on Order Creation
    runTest("3. Reserve Stock for Active Order", () => {
        const orderId = 1001;
        // Create mock order and order items in DB
        db.prepare("INSERT INTO orders (id, submission_id, total_price, subtotal, status, payment_status) VALUES (?, 'SUB-1001', 700, 700, 'Confirmed', 'Unpaid')").run(orderId);
        db.prepare("INSERT INTO order_items (order_id, file_name, file_path, paper_size, print_type, sides, pages, copies, unit_price, total_price, paper_id) VALUES (?, 'sample.pdf', 'dummy.pdf', 'A4', 'bw', 'Single', 10, 1, 35, 350, ?)").run(orderId, itemIdA);

        const res = ReservationService.reserve(orderId, { locationId: locMainId });
        assert.strictEqual(res.success, true);

        const updatedItem = InventoryService.getItemById(itemIdA);
        assert.strictEqual(updatedItem.current_stock, 50); // on-hand unchanged
        assert.strictEqual(updatedItem.reserved_stock, 10); // 10 units reserved
        assert.strictEqual(updatedItem.current_stock - updatedItem.reserved_stock, 40); // 40 available
    });

    // 4. Over-reservation Protection
    runTest("4. Reject Reservation Exceeding Available Stock", () => {
        const orderId2 = 1002;
        db.prepare("INSERT INTO orders (id, submission_id, total_price, subtotal, status, payment_status) VALUES (?, 'SUB-1002', 2000, 2000, 'Confirmed', 'Unpaid')").run(orderId2);
        db.prepare("INSERT INTO order_items (order_id, file_name, file_path, paper_size, print_type, sides, pages, copies, unit_price, total_price, paper_id) VALUES (?, 'bulk.pdf', 'dummy.pdf', 'A4', 'bw', 'Single', 45, 1, 35, 1575, ?)").run(orderId2, itemIdA);

        // Available is 40. Requesting 45 should throw error!
        assert.throws(() => {
            ReservationService.reserve(orderId2, { locationId: locMainId });
        }, /Insufficient available stock/);
    });

    // 5. Stock Adjustment Cannot Breach Active Reservations
    runTest("5. Stock Reduction Cannot Reduce Below Reserved Quantity", () => {
        // Current: 50, Reserved: 10, Available: 40.
        // Trying to manually deduct 45 units should fail!
        assert.throws(() => {
            InventoryService.adjustStock({
                item_id: itemIdA,
                location_id: locMainId,
                type: 'waste',
                qty: -45,
                reason: 'Damaged reams'
            });
        }, /Insufficient available stock/);

        // Deducting 20 units is allowed (leaving 30 on-hand, 10 reserved, 20 available)
        const adj = InventoryService.adjustStock({
            item_id: itemIdA,
            location_id: locMainId,
            type: 'waste',
            qty: -20,
            reason: 'Damaged reams'
        });
        assert.strictEqual(adj.success, true);
        assert.strictEqual(adj.new_stock, 30);
    });

    // 6. Reservation Fulfillment on Order Completion
    runTest("6. Fulfill Reservation: Consumes Reserved Stock and Deducts On-hand", () => {
        const orderId = 1001;
        const fulfillRes = ReservationService.fulfill(orderId);
        assert.strictEqual(fulfillRes.success, true);

        const item = InventoryService.getItemById(itemIdA);
        assert.strictEqual(item.current_stock, 20); // 30 - 10 = 20
        assert.strictEqual(item.reserved_stock, 0); // 10 - 10 = 0
        assert.strictEqual(item.current_stock - item.reserved_stock, 20);

        // Check reservation status in DB
        const resRec = db.prepare("SELECT status FROM inventory_reservations WHERE order_id = ?").get(orderId);
        assert.strictEqual(resRec.status, 'Consumed');
    });

    // 7. Order Cancellation Releases Active Reservation
    runTest("7. Release Active Reservation upon Order Cancellation", () => {
        const orderId3 = 1003;
        db.prepare("INSERT INTO orders (id, submission_id, total_price, subtotal, status, payment_status) VALUES (?, 'SUB-1003', 350, 350, 'Confirmed', 'Unpaid')").run(orderId3);
        db.prepare("INSERT INTO order_items (order_id, file_name, file_path, paper_size, print_type, sides, pages, copies, unit_price, total_price, paper_id) VALUES (?, 'a4.pdf', 'dummy.pdf', 'A4', 'bw', 'Single', 5, 1, 35, 175, ?)").run(orderId3, itemIdA);

        ReservationService.reserve(orderId3, { locationId: locMainId });
        let item = InventoryService.getItemById(itemIdA);
        assert.strictEqual(item.reserved_stock, 5);

        // Cancel order -> releases reservation
        ReservationService.release(orderId3);
        item = InventoryService.getItemById(itemIdA);
        assert.strictEqual(item.reserved_stock, 0);
        assert.strictEqual(item.current_stock, 20); // on hand untouched

        const resRec = db.prepare("SELECT status FROM inventory_reservations WHERE order_id = ?").get(orderId3);
        assert.strictEqual(resRec.status, 'Released');
    });

    // 8. Exact Transaction Reversal
    runTest("8. Exact Transaction Reversal without Ledger Deletion", () => {
        // Create manual addition of 15 units
        const addRes = InventoryService.adjustStock({
            item_id: itemIdB,
            location_id: locMainId,
            type: 'manual_in',
            qty: 15,
            cost: 450,
            reason: 'Found extra inventory'
        });
        assert.strictEqual(addRes.success, true);
        const originalTxId = addRes.transactionId;
        assert.ok(originalTxId > 0);

        let itemB = InventoryService.getItemById(itemIdB);
        assert.strictEqual(itemB.current_stock, 35); // 20 + 15 = 35

        // Reverse the transaction
        const revRes = InventoryService.reverseTransaction(originalTxId, 'Mistake in count');
        assert.strictEqual(revRes.success, true);
        assert.strictEqual(revRes.newStock, 20); // restored back to 20

        // Verify original transaction is marked reversed and NOT deleted
        const origTx = InventoryRepository.getTransactionById(originalTxId);
        assert.strictEqual(origTx.is_reversed, 1);

        // Verify reversal transaction exists referencing originalTxId
        const revTx = InventoryRepository.getTransactionById(revRes.reversalTransactionId);
        assert.ok(revTx.type === 'manual_out' || revTx.type === 'reversal', 'Reversal transaction has appropriate type');
        assert.strictEqual(revTx.qty, -15);
        assert.strictEqual(revTx.reversal_of_id, originalTxId);

        // Prevent double reversal
        assert.throws(() => {
            InventoryService.reverseTransaction(originalTxId, 'Duplicate reversal');
        }, /already been reversed/);

        // Prevent reversing a reversal
        assert.throws(() => {
            InventoryService.reverseTransaction(revRes.reversalTransactionId, 'Reverse of reversal');
        }, /Cannot reverse a reversal/);
    });

    // 9. Zero-Value Preservation on Item Update
    runTest("9. Preserve Valid 0 Values on Item Updates", () => {
        InventoryService.updateItem(itemIdA, {
            minimum_stock: 0,
            reorder_level: 0,
            purchase_price: 0,
            selling_price: 0
        });

        const updated = InventoryService.getItemById(itemIdA);
        assert.strictEqual(updated.minimum_stock, 0);
        assert.strictEqual(updated.reorder_level, 0);
        assert.strictEqual(updated.purchase_price, 0);
        assert.strictEqual(updated.selling_price, 0);
    });

    // 10. Protection against Deleting Items with Active Reservations
    runTest("10. Block Deleting Item with Active Reservations", () => {
        const orderId4 = 1004;
        db.prepare("INSERT INTO orders (id, submission_id, total_price, subtotal, status, payment_status) VALUES (?, 'SUB-1004', 350, 350, 'Confirmed', 'Unpaid')").run(orderId4);
        db.prepare("INSERT INTO order_items (order_id, file_name, file_path, paper_size, print_type, sides, pages, copies, unit_price, total_price, paper_id) VALUES (?, 'a4_2.pdf', 'dummy.pdf', 'A4', 'bw', 'Single', 5, 1, 35, 175, ?)").run(orderId4, itemIdA);

        ReservationService.reserve(orderId4, { locationId: locMainId });

        // Attempt soft delete -> must throw error
        assert.throws(() => {
            InventoryService.softDeleteItem(itemIdA);
        }, /active stock reservations/);

        // Release reservation and soft delete succeeds
        ReservationService.release(orderId4);
        const delRes = InventoryService.softDeleteItem(itemIdA);
        assert.strictEqual(delRes.success, true);
    });

    console.log("\n-------------------------------------------------------");
    console.log(`Results: ${passedTests} passed, ${failedTests} failed`);
    console.log("-------------------------------------------------------\n");

    if (failedTests > 0) {
        process.exit(1);
    } else {
        console.log("✅ ALL PHASE 4 INVENTORY TESTS PASSED SUCCESSFULLY!\n");
        process.exit(0);
    }
}

runAllTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
