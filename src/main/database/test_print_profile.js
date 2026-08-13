const db = require('./db');
const { initDatabase } = require('./schema');
const { PrintProfileModel, ProductModel, PrintAuditLogModel } = require('./models');
const DeviceManager = require('../device-manager');

async function runTests() {
    console.log("==================================================");
    console.log("RUNNING ENTERPRISE PRINT PROFILE ENGINE UNIT TESTS");
    console.log("==================================================");

    // Initialize Database & Run Migrations
    initDatabase();
    console.log("✓ Database migrations verified!");

    // Clean up any test records
    db.exec(`
        DELETE FROM products WHERE name LIKE 'TEST_%';
        DELETE FROM print_profiles WHERE name LIKE 'TEST_%';
        DELETE FROM print_audit_logs WHERE product_name LIKE 'TEST_%';
        DELETE FROM calibration_profiles WHERE printer_name LIKE 'TEST_%';
        DELETE FROM printer_group_members WHERE printer_name LIKE 'TEST_%';
        DELETE FROM printer_groups WHERE name LIKE 'TEST_%';
    `);

    // ==========================================
    // 1. TEST PRINT PROFILE CRUD
    // ==========================================
    console.log("\n1. Testing PrintProfileModel CRUD...");
    
    // Create Profile
    const profileData = {
        name: 'TEST_Color_A4_Duplex',
        printer_name: 'TEST_Printer_Main',
        paper_size: 'A4',
        paper_source: 'Tray 2',
        paper_type: 'Plain',
        paper_weight: 80,
        orientation: 'portrait',
        scaling: 'fit',
        custom_scale: 100,
        duplex_mode: 'longEdge',
        alignment: 'center',
        n_up: 1,
        margins_type: 'custom',
        bleed: 1.5,
        binding_margin: 5.0,
        margin_top: 10.0,
        margin_bottom: 10.0,
        margin_left: 15.0,
        margin_right: 15.0,
        color_mode: 'color',
        print_quality: 'Normal',
        resolution_dpi: '600',
        finishing_lamination: 'None',
        finishing_stapling: 'None',
        finishing_hole_punch: 'None',
        crop_marks: 1,
        is_favorite: 1
    };

    const createProfileRes = PrintProfileModel.create(profileData);
    if (!createProfileRes.success || !createProfileRes.id) {
        throw new Error("Failed to create Print Profile: " + createProfileRes.error);
    }
    const profileId = createProfileRes.id;
    console.log(`- Created Profile ID: ${profileId}`);

    // Retrieve Profile
    const allProfiles = PrintProfileModel.getAll();
    const fetchedProfile = allProfiles.find(p => p.id === profileId);
    if (!fetchedProfile || fetchedProfile.paper_source !== 'Tray 2' || fetchedProfile.binding_margin !== 5.0) {
        throw new Error("Print Profile retrieval failed or fields mismatched!");
    }
    console.log("✓ Profile retrieval verified!");

    // Update Profile
    const updateRes = PrintProfileModel.update(profileId, {
        ...profileData,
        paper_source: 'Tray 3',
        binding_margin: 10.0
    });
    if (!updateRes.success) {
        throw new Error("Failed to update print profile: " + updateRes.error);
    }
    const updatedProfile = db.prepare('SELECT * FROM print_profiles WHERE id = ?').get(profileId);
    if (updatedProfile.paper_source !== 'Tray 3' || updatedProfile.binding_margin !== 10.0) {
        throw new Error("Print Profile update verification failed!");
    }
    console.log("✓ Profile update verified!");

    // Duplicate Profile
    const dupRes = PrintProfileModel.duplicate(profileId);
    if (!dupRes.success || !dupRes.id) {
        throw new Error("Failed to duplicate print profile: " + dupRes.error);
    }
    const dupProfile = db.prepare('SELECT * FROM print_profiles WHERE id = ?').get(dupRes.id);
    if (dupProfile.name !== 'TEST_Color_A4_Duplex Copy' || dupProfile.paper_source !== 'Tray 3') {
        throw new Error("Print Profile duplication properties mismatched!");
    }
    console.log(`✓ Profile duplication verified (ID: ${dupRes.id})!`);

    // Clean up duplicated profile
    PrintProfileModel.delete(dupRes.id);

    // ==========================================
    // 2. TEST PRODUCT CRUD
    // ==========================================
    console.log("\n2. Testing ProductModel CRUD...");

    const productData = {
        name: 'TEST_A4_Color_Brochure',
        category: 'Brochures',
        description: 'Glossy A4 color folding brochures',
        print_profile_id: profileId,
        is_active: 1,
        is_favorite: 1
    };

    const createProductRes = ProductModel.create(productData);
    if (!createProductRes.success || !createProductRes.id) {
        throw new Error("Failed to create Product: " + createProductRes.error);
    }
    const productId = createProductRes.id;
    console.log(`- Created Product ID: ${productId}`);

    // Retrieve Product
    const allProducts = ProductModel.getAll();
    const fetchedProduct = allProducts.find(p => p.id === productId);
    if (!fetchedProduct || fetchedProduct.print_profile_id !== profileId || fetchedProduct.is_active !== 1) {
        throw new Error("Product retrieval validation failed!");
    }
    console.log("✓ Product retrieval verified!");

    // Update Product
    const updateProdRes = ProductModel.update(productId, {
        ...productData,
        description: 'Updated test description',
        is_active: 0
    });
    if (!updateProdRes.success) {
        throw new Error("Failed to update Product: " + updateProdRes.error);
    }
    const updatedProd = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (updatedProd.description !== 'Updated test description' || updatedProd.is_active !== 0) {
        throw new Error("Product update validation failed!");
    }
    console.log("✓ Product update verified!");


    // ==========================================
    // 3. TEST DEVICE MANAGER & CALIBRATION & GROUPS
    // ==========================================
    console.log("\n3. Testing Device & Calibration Manager...");

    // Set mock printer capabilities
    db.prepare(`
        INSERT INTO device_capabilities (
            device_name, display_name, driver_name, status, last_scanned, can_duplex, can_color, paper_sizes_json, paper_sources_json, resolutions_json
        ) VALUES ('TEST_Printer_Main', 'TEST Printer Main', 'TEST_Driver', 'Online', CURRENT_TIMESTAMP, 1, 1, '["A4"]', '["Tray 2"]', '[]')
        ON CONFLICT(device_name) DO UPDATE SET status = 'Online'
    `).run();
    db.prepare(`
        INSERT INTO device_capabilities (
            device_name, display_name, driver_name, status, last_scanned, can_duplex, can_color, paper_sizes_json, paper_sources_json, resolutions_json
        ) VALUES ('TEST_Printer_Backup', 'TEST Printer Backup', 'TEST_Driver', 'Online', CURRENT_TIMESTAMP, 1, 1, '["A4"]', '["Tray 2"]', '[]')
        ON CONFLICT(device_name) DO UPDATE SET status = 'Online'
    `).run();

    // Save calibration offsets
    const calRes = DeviceManager.saveCalibration('TEST_Printer_Main', {
        offset_x: 1.5,
        offset_y: -0.8,
        scale_x: 1.002,
        scale_y: 0.998,
        margin_compensation: 0.5,
        paper_feed_offset: 0.2,
        calibration_test_results: 'Perfect alignment'
    });
    if (!calRes.success) {
        throw new Error("Failed to save physical calibration offsets: " + calRes.error);
    }
    const cal = DeviceManager.getCalibration('TEST_Printer_Main');
    if (cal.offset_x !== 1.5 || cal.scale_x !== 1.002) {
        throw new Error("Physical calibration offsets mismatches!");
    }
    console.log("✓ Calibration offsets storage verified!");

    // Save Printer Group
    const groupResId = DeviceManager.saveGroup({
        name: 'TEST_Failover_Group',
        description: 'Test backup print pool',
        printers: ['TEST_Printer_Main', 'TEST_Printer_Backup']
    });
    if (!groupResId) {
        throw new Error("Failed to save printer group!");
    }
    console.log(`- Created Printer Group ID: ${groupResId}`);

    // Verify Sibling Failover remapping Suggestion
    // 1. Mark main printer offline
    db.prepare("UPDATE device_capabilities SET status = 'Offline' WHERE device_name = 'TEST_Printer_Main'").run();
    const compatList = DeviceManager.getCompatiblePrintersInGroup('TEST_Printer_Main');
    if (compatList.length === 0 || compatList[0].name !== 'TEST_Printer_Backup') {
        throw new Error("Device failover suggested re-mapping failed!");
    }
    console.log("✓ Device Group failover Suggestion verified!");


    // ==========================================
    // 4. TEST AUDIT LOGGER & REPRINT HISTORY
    // ==========================================
    console.log("\n4. Testing PrintAuditLogModel & Reprint History...");

    const auditLogData = {
        order_id: 9999,
        customer_id: 111,
        operator_name: 'TestOperator',
        product_id: productId,
        product_name: 'TEST_A4_Color_Brochure',
        print_profile_id: profileId,
        print_profile_name: 'TEST_Color_A4_Duplex',
        print_profile_snapshot_json: JSON.stringify(profileData),
        printer_name: 'TEST_Printer_Backup',
        driver_name: 'TEST_Driver',
        paper_size: 'A4',
        paper_source: 'Tray 2',
        pages: 8,
        copies: 3,
        inventory_used_json: JSON.stringify([{ itemId: 1, itemName: 'A4 Paper', qty: 12 }]),
        duration_ms: 1200,
        status: 'Completed',
        error_message: null,
        is_simulated: 0
    };

    const logRes = PrintAuditLogModel.logJob(auditLogData);
    if (!logRes.success || !logRes.id) {
        throw new Error("Failed to log print audit entry: " + logRes.error);
    }
    const auditId = logRes.id;
    console.log(`- Created Audit Log ID: ${auditId}`);

    // Fetch Logs
    const allLogs = PrintAuditLogModel.getLogs(10);
    const fetchedLog = allLogs.find(l => l.id === auditId);
    if (!fetchedLog || fetchedLog.copies !== 3 || fetchedLog.operator_name !== 'TestOperator') {
        throw new Error("Print audit log values mismatched!");
    }
    console.log("✓ Print run audit logging verified!");

    // Clean up test records
    db.exec(`
        DELETE FROM products WHERE name LIKE 'TEST_%';
        DELETE FROM print_profiles WHERE name LIKE 'TEST_%';
        DELETE FROM print_audit_logs WHERE product_name LIKE 'TEST_%';
        DELETE FROM calibration_profiles WHERE printer_name LIKE 'TEST_%';
        DELETE FROM printer_group_members WHERE printer_name LIKE 'TEST_%';
        DELETE FROM printer_groups WHERE name LIKE 'TEST_%';
    `);
    
    console.log("\n==================================================");
    console.log("ALL ENTERPRISE PRINT PROFILE ENGINE TESTS PASSED!");
    console.log("==================================================");
}

runTests().catch(err => {
    console.error("\n❌ TESTS FAILED:", err);
    process.exit(1);
});
