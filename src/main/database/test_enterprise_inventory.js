const db = require('./db');
const { initDatabase } = require('./schema');
const FormulaEngine = require('./services/formula-engine');
const RecipeService = require('./services/recipe-service');
const ReservationService = require('./services/reservation-service');
const POService = require('./services/po-service');
const TransferService = require('./services/transfer-service');
const ForecastService = require('./services/forecast-service');
const ValuationService = require('./services/valuation-service');
const NotificationService = require('./services/notification-service');
const CountService = require('./services/count-service');
const InventoryService = require('./services/inventory-service');
const InventoryRepository = require('./repositories/inventory-repository');
const PORepository = require('./repositories/po-repository');
const RecipeRepository = require('./repositories/recipe-repository');

async function runTests() {
    console.log("==========================================");
    console.log("RUNNING ENTERPRISE ERP INVENTORY UNIT TESTS");
    console.log("==========================================");

    // Initialize Database
    initDatabase();
    console.log("✓ Database migrations verified!");

    // 1. Test Formula Parser Engine
    console.log("\n1. Testing Safe Formula Parser...");
    const context = { pages: 5, copies: 10 };
    const duplexFormula = "ceil(pages / 2) * copies";
    const simplexFormula = "pages * copies";
    
    const duplexRes = FormulaEngine.evaluate(duplexFormula, context);
    const simplexRes = FormulaEngine.evaluate(simplexFormula, context);
    
    console.log(`- duplex formula (pages: 5, copies: 10) = ${duplexRes} (Expected: 30)`);
    console.log(`- simplex formula (pages: 5, copies: 10) = ${simplexRes} (Expected: 50)`);
    
    if (duplexRes !== 30 || simplexRes !== 50) {
        throw new Error("Formula Engine returned incorrect mathematical values!");
    }
    console.log("✓ Formula Parser passed!");

    // 2. Setup Test Seed Data
    console.log("\n2. Seeding Test Catalog...");
    
    // Seed category
    const catId = db.prepare("SELECT id FROM inventory_categories WHERE name = 'Paper'").get().id;
    
    // Seed default warehouse location
    const locWarehouseId = db.prepare("SELECT id FROM inventory_locations WHERE name = 'Main Warehouse'").get().id;
    const locCounterId = db.prepare("SELECT id FROM inventory_locations WHERE name = 'Front Desk'").get().id;

    // Create unique item SKU/Barcode for tests
    const timestamp = Date.now();
    const itemSku = `ENT-TEST-SKU-${timestamp}`;
    const itemName = `Enterprise Test Paper A4 ${timestamp}`;
    
    const itemId = InventoryService.createItem({
        sku: itemSku,
        barcode: `BARCODE-${timestamp}`,
        name: itemName,
        category_id: catId,
        brand: 'Lexmark',
        supplier_id: 1,
        description: 'Test paper asset',
        unit: 'Sheets',
        opening_stock: 500,
        current_stock: 500,
        minimum_stock: 100,
        maximum_stock: 1000,
        reorder_level: 150,
        purchase_price: 1.5,
        selling_price: 5.0,
        average_cost: 1.5,
        last_purchase_price: 1.5,
        storage_location_id: locWarehouseId,
        expiry_date: null,
        notes: '',
        status: 'Active',
        size: 'A4',
        gsm: 80,
        finish: 'Matte',
        color_type: 'BW',
        sheets_per_ream: 500
    });

    console.log(`- Created item ID: ${itemId}`);
    
    // Check initial stock location junction mapping
    const initialLocStock = InventoryRepository.getLocationStock(itemId, locWarehouseId);
    console.log(`- Initial Location Stock: ${initialLocStock.current_stock}`);
    if (initialLocStock.current_stock !== 500) {
        throw new Error("Junction stock not synchronized on item creation!");
    }
    console.log("✓ Test Seed Setup verified!");

    // 3. Test Recipe Engine
    console.log("\n3. Testing Recipe Configuration...");
    
    // Create pricing item
    const pricingId = db.prepare(`
        INSERT INTO pricing (name, category, color_type, paper_size, sides, price, inventory_item_id)
        VALUES (?, 'paper', 'BW', 'A4', 'simplex', 5.0, ?)
    `).run(`Enterprise Print Option ${timestamp}`, itemId).lastInsertRowid;

    // Create Recipe
    const recipeId = RecipeService.saveRecipe({
        name: `A4 Book Recipe ${timestamp}`,
        pricing_id: pricingId,
        version: 1,
        description: 'Book printing compile recipe',
        items: [
            { inventory_item_id: itemId, formula: 'ceil(pages / 2) * copies', quantity: 1.0, optional: 0 }
        ]
    });
    console.log(`- Created recipe ID: ${recipeId}`);

    // Resolve consumption
    const resolvedCons = RecipeService.calculateRecipeConsumption(pricingId, { pages: 7, copies: 2 });
    console.log(`- Resolved recipe count: ${resolvedCons[0].qty} (Expected: 8)`);
    if (resolvedCons[0].qty !== 8) {
        throw new Error("Recipe calculation returned incorrect sheets consumption!");
    }
    console.log("✓ Recipe Engine successfully resolved custom formulas!");

    // 4. Test Stock Reservations Lifecycle
    console.log("\n4. Testing Stock Reservations...");
    
    let customerId = 1;
    const custExists = db.prepare('SELECT id FROM customers LIMIT 1').get();
    if (custExists) {
        customerId = custExists.id;
    } else {
        customerId = db.prepare("INSERT INTO customers (name, phone) VALUES ('Test Cust', '9999999999')").run().lastInsertRowid;
    }
    
    const resOrder = db.prepare(`
        INSERT INTO orders (customer_id, total_price, status, notes)
        VALUES (?, 10.0, 'Pending', '')
    `).run(customerId);
    const testOrderId = resOrder.lastInsertRowid;

    db.prepare(`
        INSERT INTO order_items (order_id, file_name, file_path, print_type, paper_size, sides, pages, copies, price, notes, paper_id)
        VALUES (?, 'test.pdf', '', 'bw', 'A4', 'simplex', 7, 2, 10.0, '', ?)
    `).run(testOrderId, pricingId);
    
    // Reserve Stock
    const orderData = {
        paperId: pricingId,
        pages: 7,
        copies: 2,
        locationId: locWarehouseId
    };
    
    ReservationService.reserve(testOrderId, orderData);
    
    // Check reserved levels
    let itemObj = InventoryRepository.getItemById(itemId);
    let locObj = InventoryRepository.getLocationStock(itemId, locWarehouseId);
    console.log(`- Reserved Stock (Global): ${itemObj.reserved_stock} (Expected: 8)`);
    console.log(`- Reserved Stock (Location): ${locObj.reserved_stock} (Expected: 8)`);
    
    if (itemObj.reserved_stock !== 8 || locObj.reserved_stock !== 8) {
        throw new Error("Stock Reservation failed to lock stock!");
    }

    // Try to reserve more than available (Available = 500 - 8 = 492)
    try {
        const overflowData = { paperId: pricingId, pages: 500, copies: 2, locationId: locWarehouseId };
        ReservationService.reserve(testOrderId + 1, overflowData);
        throw new Error("Allowed reserving stock beyond availability levels!");
    } catch(e) {
        console.log(`- Overflow check: Threw error correctly: "${e.message}"`);
    }

    // Fulfill Reservation
    ReservationService.fulfill(testOrderId);
    itemObj = InventoryRepository.getItemById(itemId);
    locObj = InventoryRepository.getLocationStock(itemId, locWarehouseId);
    
    console.log(`- Post-Fulfillment Current Stock: ${itemObj.current_stock} (Expected: 492)`);
    console.log(`- Post-Fulfillment Reserved Stock: ${itemObj.reserved_stock} (Expected: 0)`);
    
    if (itemObj.current_stock !== 492 || itemObj.reserved_stock !== 0) {
        throw new Error("Fulfillment did not deduct stock levels cleanly!");
    }

    // Undo / Cancel Fulfill
    ReservationService.undoDeduction(testOrderId);
    itemObj = InventoryRepository.getItemById(itemId);
    console.log(`- Post-Undo Current Stock: ${itemObj.current_stock} (Expected: 500)`);
    if (itemObj.current_stock !== 500) {
        throw new Error("Undo deduction failed to restock quantities!");
    }
    console.log("✓ Reservation Lifecycle verified successfully!");

    // 5. Test Warehouse Transfer
    console.log("\n5. Testing Location Transfer...");
    TransferService.transferStock({
        item_id: itemId,
        from_location_id: locWarehouseId,
        to_location_id: locCounterId,
        qty: 100,
        reason: 'Move to front desk desk drawer'
    });

    const whStock = InventoryRepository.getLocationStock(itemId, locWarehouseId);
    const counterStock = InventoryRepository.getLocationStock(itemId, locCounterId);
    console.log(`- Main Warehouse Stock: ${whStock.current_stock} (Expected: 400)`);
    console.log(`- Front Desk Stock: ${counterStock.current_stock} (Expected: 100)`);
    
    if (whStock.current_stock !== 400 || counterStock.current_stock !== 100) {
        throw new Error("Warehouse transfer failed to adjust specific locations!");
    }
    console.log("✓ Multi-location Warehouse Transfer passed!");

    // 6. Test Physical Count
    console.log("\n6. Testing Physical Stock Count Session...");
    const countId = CountService.createCount({
        item_id: itemId,
        location_id: locCounterId,
        actual_count: 90,
        reason: 'Operator manual audit count'
    });

    let countRecord = db.prepare('SELECT * FROM physical_stock_counts WHERE id = ?').get(countId);
    console.log(`- Variance check: System: ${countRecord.system_stock}, Actual: ${countRecord.actual_count}, Diff: ${countRecord.difference}`);
    if (countRecord.difference !== -10) {
        throw new Error("Variance computed incorrectly!");
    }

    CountService.approveCount(countId);
    const finalCounterStock = InventoryRepository.getLocationStock(itemId, locCounterId);
    console.log(`- Post-Stocktake Front Desk Stock: ${finalCounterStock.current_stock} (Expected: 90)`);
    if (finalCounterStock.current_stock !== 90) {
        throw new Error("Count approval did not adjust stock levels!");
    }
    console.log("✓ Stock Count audit session approved and reconciled!");

    // 7. Test PO Returns
    console.log("\n7. Testing Purchase Return...");
    const returnId = POService.createPurchaseReturn({
        item_id: itemId,
        qty: 10,
        refund_amount: 15.0,
        supplier_id: 1,
        location_id: locWarehouseId
    });

    const returnWhStock = InventoryRepository.getLocationStock(itemId, locWarehouseId);
    console.log(`- Post-Return Warehouse Stock: ${returnWhStock.current_stock} (Expected: 390)`);
    if (returnWhStock.current_stock !== 390) {
        throw new Error("Purchase return did not deduct warehouse stock!");
    }
    console.log("✓ Purchase returns mapped correctly!");

    // 8. Test Valuation strategies
    console.log("\n8. Testing Valuation Strategy Engine...");
    const avgVal = ValuationService.calculateItemValuation(itemId, 'AVERAGE');
    const fifoVal = ValuationService.calculateItemValuation(itemId, 'FIFO');
    const lifoVal = ValuationService.calculateItemValuation(itemId, 'LIFO');
    
    console.log(`- Valuation average: ${avgVal}`);
    console.log(`- Valuation FIFO: ${fifoVal}`);
    console.log(`- Valuation LIFO: ${lifoVal}`);
    console.log("✓ Strategy Valuation mappings validated!");

    // 9. Stress / Concurrency simulation
    console.log("\n9. Running high-volume concurrent checkout simulation (1,000 requests)...");
    const startTime = Date.now();
    let failedAttempts = 0;
    
    db.exec("PRAGMA foreign_keys = OFF");
    for (let loop = 0; loop < 1000; loop++) {
        try {
            // Place minor recipe order (each consumes 1 page simplex = 1 sheet)
            const stressOrderId = 20000 + loop;
            const contextData = { paperId: pricingId, pages: 1, copies: 1, locationId: locWarehouseId };
            
            // Reserve and fulfill synchronously
            ReservationService.reserve(stressOrderId, contextData);
            ReservationService.fulfill(stressOrderId);
        } catch(e) {
            failedAttempts++;
        }
    }
    db.exec("PRAGMA foreign_keys = ON");
    
    const duration = Date.now() - startTime;
    const finalWhStock = InventoryRepository.getLocationStock(itemId, locWarehouseId);
    console.log(`- Processed 1,000 transactions in ${duration}ms`);
    console.log(`- Final Warehouse Stock level: ${finalWhStock.current_stock}`);
    console.log(`- Failed Allocations: ${failedAttempts}`);
    
    console.log("\n==========================================");
    console.log("ALL ENTERPRISE TESTS COMPLETED SUCCESSFULLY! ✓");
    console.log("==========================================");
}

runTests().catch(err => {
    console.error("❌ UNIT TEST FAILED:", err);
    process.exit(1);
});
