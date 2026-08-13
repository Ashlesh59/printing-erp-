const { app } = require('electron');
const path = require('path');
const fs = require('fs');


const Database = require('better-sqlite3');

app.whenReady().then(async () => {
    // Clean up any pre-existing database files in fallback path and userData path to ensure clean run
    try {
        const dbPaths = [
            path.resolve(__dirname, '../database/database.db'),
            path.resolve(__dirname, '../database/database.db-journal'),
            path.resolve(__dirname, '../database/database.db-wal'),
            path.join(app.getPath('userData'), 'database', 'database.db'),
            path.join(app.getPath('userData'), 'database', 'database.db-journal'),
            path.join(app.getPath('userData'), 'database', 'database.db-wal')
        ];
        dbPaths.forEach(p => {
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
                console.log(`[TEST SETUP] Cleaned up DB file: ${p}`);
            }
        });
    } catch(e) {
        console.warn("[TEST SETUP] Warning: Failed to clean up DB files:", e);
    }

    console.log("=========================================");
    console.log("RUNNING DATABASE SECURITY SYSTEM TEST SUITE");
    console.log("=========================================");

    const backupService = require('./src/main/database/services/backup-service');
    const dbService = require('./src/main/database/db');
    const schema = require('./src/main/database/schema');

    let failed = false;
    function assert(condition, message) {
        if (condition) {
            console.log(`[PASS] ${message}`);
        } else {
            console.error(`[FAIL] ${message}`);
            failed = true;
        }
    }

    try {
        // Initialize DB schema
        schema.initDatabase();

        const autoDir = backupService.folders.automatic;
        const manualDir = backupService.folders.manual;
        const migrationDir = backupService.folders.migration;
        const tempDir = backupService.folders.temp;

        // Clear directories for test consistency
        const clearDir = (dir) => {
            if (fs.existsSync(dir)) {
                fs.readdirSync(dir).forEach(f => {
                    try { fs.unlinkSync(path.join(dir, f)); } catch(e) {}
                });
            }
        };
        clearDir(autoDir);
        clearDir(manualDir);
        clearDir(migrationDir);
        clearDir(tempDir);

        // Test 1: Manual Backup
        console.log("\n--- Test 1: Manual Backup ---");
        const manualRes = await backupService.performBackup('manual');
        assert(manualRes.success === true, "Manual backup completes successfully");
        assert(fs.existsSync(manualRes.path), "Manual backup file exists on disk");
        assert(manualRes.path.includes('Manual'), "Manual backup is saved in correct subfolder");

        // Test 2: Backup Verification
        console.log("\n--- Test 2: Backup Verification ---");
        const verifyRes = backupService.verifyBackupFile(manualRes.path);
        assert(verifyRes.success === true, "Healthy backup file verification succeeds");

        // Test 3: Corrupted Backup Verification
        console.log("\n--- Test 3: Corrupted Backup Verification ---");
        const corruptPath = path.join(manualDir, 'backup_corrupt_test.db.gz');
        fs.writeFileSync(corruptPath, Buffer.from("GARBAGE CORRUPTED DATABASE DATA"));
        const verifyCorruptRes = backupService.verifyBackupFile(corruptPath);
        assert(verifyCorruptRes.success === false, "Corrupted backup file verification fails as expected");
        try { fs.unlinkSync(corruptPath); } catch(e) {}

        // Test 4: Rotation
        console.log("\n--- Test 4: Rotation ---");
        // Create 35 dummy automatic files
        for (let i = 1; i <= 35; i++) {
            const name = `backup_2026-07-13_12-${String(i).padStart(2, '0')}_automatic.db.gz`;
            const filePath = path.join(autoDir, name);
            fs.writeFileSync(filePath, Buffer.from("dummy data"));
            const time = Date.now() - (36 - i) * 60 * 1000;
            fs.utimesSync(filePath, new Date(time), new Date(time));
        }
        
        backupService.performBackupSync('automatic'); // Triggers rotation
        const autoFiles = fs.readdirSync(autoDir).filter(f => f.endsWith('.db.gz'));
        assert(autoFiles.length === 30, `Rotation keeps exactly 30 automatic backups (found ${autoFiles.length})`);
        
        // Test 5: Database Health Stats
        console.log("\n--- Test 5: Database Health Stats ---");
        dbService.exec("INSERT OR IGNORE INTO customers (name, phone) VALUES ('Test Customer', '9999999999')");
        const health = backupService.getDatabaseHealth();
        assert(health.status === 'Healthy' || health.status === 'Warning', "Database status computed successfully");
        assert(health.customerCount > 0, "Customers count is correct");
        assert(health.databaseSize > 0, "Database size is valid");

        // Test 6: Safety Backup & Restore Rollback
        console.log("\n--- Test 6: Safety Backup & Restore Rollback ---");
        await backupService.createSafetyBackup('test_op');
        assert(fs.existsSync(path.join(tempDir, 'temp_safety_test_op.db.gz')), "Safety backup file is created");
        
        const rollbackRes = backupService.rollbackSafetyBackup('test_op');
        assert(rollbackRes.success === true, "Rollback from safety backup succeeds");
        assert(!fs.existsSync(path.join(tempDir, 'temp_safety_test_op.db.gz')), "Safety backup file is cleaned up after rollback");

        // Test 7: Integrity Checks & Optimize
        console.log("\n--- Test 7: Integrity Checks & Optimize ---");
        const integrityHealthy = backupService.runIntegrityChecks();
        assert(integrityHealthy === true, "Database integrity checks pass");

        // Test 8: Restoration
        console.log("\n--- Test 8: Restoration ---");
        const validBackup = await backupService.performBackup('manual');
        
        // Modify data to verify restore overrides it
        dbService.exec("UPDATE customers SET name = 'Modified Name' WHERE phone = '9999999999'");
        
        // Mock app relaunch/exit
        const originalRelaunch = app.relaunch;
        const originalExit = app.exit;
        let relaunchCalled = false;
        app.relaunch = () => { relaunchCalled = true; };
        app.exit = (code) => { console.log(`[TEST] App exit mocked with code: ${code}`); };
        
        const restoreRes = await backupService.restoreBackup(validBackup.path);
        
        app.relaunch = originalRelaunch;
        app.exit = originalExit;

        assert(restoreRes.success === true, "Database restore completes successfully");
        const customer = dbService.prepare("SELECT name FROM customers WHERE phone = '9999999999'").get();
        assert(customer.name === 'Test Customer', "Restored database has original data intact");

        console.log("\n=========================================");
        if (failed) {
            console.error("TEST SUITE FAILED!");
            process.exit(1);
        } else {
            console.log("ALL TESTS PASSED SUCCESSFULLY!");
            process.exit(0);
        }
    } catch (err) {
        console.error("Test execution crashed:", err);
        process.exit(1);
    }
});
