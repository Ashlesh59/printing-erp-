const { app } = require('electron');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const os = require('os');
const eventBus = require('../../events/EventBus');
const { EventTypes } = require('../../events/EventTypes');

// Resolve the singleton DB connection
const db = require('../db');

// Resolve backup base directory dynamically
let backupBaseDir;
try {
    let app;
    try { app = require('electron').app; } catch(e) {}
    const base = (app && typeof app.getPath === 'function') ? path.join(app.getPath('documents'), 'PrintShopManager') : path.join(os.homedir(), 'Documents', 'PrintShopManager');
    backupBaseDir = path.join(base, 'Backups');
} catch (err) {
    backupBaseDir = path.join(process.cwd(), 'Backups');
}

const folders = {
    automatic: path.join(backupBaseDir, 'Automatic'),
    manual: path.join(backupBaseDir, 'Manual'),
    migration: path.join(backupBaseDir, 'BeforeMigration'),
    temp: path.join(backupBaseDir, 'Temp')
};

// Create folders recursively on initialize
Object.values(folders).forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

/**
 * Log database events to database_events table
 */
function logDatabaseEvent(operation, backupFile, durationMs, status, errorMessage = null) {
    try {
        const username = os.userInfo().username || 'System';
        const machine = os.hostname();
        const stmt = db.prepare(`
            INSERT INTO database_events (timestamp, username, machine, operation, backup_file, duration_ms, status, error_message)
            VALUES (CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(username, machine, operation, backupFile || null, durationMs, status, errorMessage);
    } catch (err) {
        console.error('[BackupService] Failed to write database event log:', err);
    }
}

/**
 * Format date for backup filenames (YYYY-MM-DD_HH-MM)
 */
function formatFilenameDate(date) {
    const pad = (num) => String(num).padStart(2, '0');
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    return `${yyyy}-${mm}-${dd}_${hh}-${min}`;
}

/**
 * Run SQLite PRAGMA checks and optimize
 */
function runIntegrityChecks() {
    try {
        const integrity = db.prepare('PRAGMA integrity_check').get();
        const integrityOk = integrity && integrity.integrity_check === 'ok';

        const foreignKey = db.prepare('PRAGMA foreign_key_check').all();
        const foreignKeyOk = foreignKey.length === 0;

        // Perform SQLite optimization
        db.exec('PRAGMA optimize');
        eventBus.publish(EventTypes.DATABASE_OPTIMIZED, { timestamp: new Date().toISOString() });

        if (!integrityOk || !foreignKeyOk) {
            eventBus.publish(EventTypes.DATABASE_CORRUPTION_DETECTED, {
                integrity: integrity ? integrity.integrity_check : 'error',
                foreignKeys: foreignKey
            });
            return false;
        }
        return true;
    } catch (err) {
        console.error('[BackupService] Integrity check crashed:', err);
        try {
            eventBus.publish(EventTypes.DATABASE_CORRUPTION_DETECTED, { error: err.message });
        } catch (e) {}
        return false;
    }
}

/**
 * Calculate database SHA-256 hash of a file
 */
function getFileChecksum(filePath) {
    const crypto = require('crypto');
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
}

/**
 * Perform backup
 * @param {string} type - 'automatic', 'manual', 'migration', or 'temp'
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
async function performBackup(type) {
    const startTime = Date.now();
    const folder = folders[type];
    if (!folder) {
        return { success: false, error: `Invalid backup type: ${type}` };
    }

    eventBus.publish(EventTypes.DATABASE_BACKUP_STARTED, { type });

    let tempBackupPath = null;
    try {
        // Flush write-ahead log to main db file
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

        const timestampStr = formatFilenameDate(new Date());
        const tempName = `temp_${timestampStr}.db`;
        tempBackupPath = path.join(folders.temp, tempName);

        // Transactional sqlite copy
        await db.backup(tempBackupPath);

        // Verify copied database integrity before compression
        if (!fs.existsSync(tempBackupPath)) {
            throw new Error('Backup file was not created.');
        }

        const stats = fs.statSync(tempBackupPath);
        if (stats.size === 0) {
            throw new Error('Backup file size is 0 bytes.');
        }

        // Attempt to open and verify copied DB
        const testDb = new Database(tempBackupPath);
        try {
            const check = testDb.prepare('PRAGMA integrity_check').get();
            if (!check || check.integrity_check !== 'ok') {
                throw new Error(`Copied DB integrity failed: ${check ? check.integrity_check : 'unknown'}`);
            }
            const fk = testDb.prepare('PRAGMA foreign_key_check').all();
            if (fk.length > 0) {
                throw new Error('Copied DB foreign key check failed.');
            }
        } finally {
            testDb.close();
        }

        // Compress file
        const rawBytes = fs.readFileSync(tempBackupPath);
        const compressed = zlib.gzipSync(rawBytes);

        const targetFileName = `backup_${timestampStr}_${type}.db.gz`;
        const targetPath = path.join(folder, targetFileName);
        fs.writeFileSync(targetPath, compressed);

        // Clean up temporary copy
        fs.unlinkSync(tempBackupPath);

        const duration = Date.now() - startTime;
        logDatabaseEvent('backup', targetFileName, duration, 'success');

        eventBus.publish(EventTypes.DATABASE_BACKUP_COMPLETED, {
            type,
            filename: targetFileName,
            size: compressed.length
        });

        // Trigger rotation if it's automatic or migration
        if (type === 'automatic' || type === 'migration') {
            rotateBackups();
        }

        return { success: true, path: targetPath, filename: targetFileName };
    } catch (err) {
        if (tempBackupPath && fs.existsSync(tempBackupPath)) {
            try { fs.unlinkSync(tempBackupPath); } catch (e) {}
        }
        const duration = Date.now() - startTime;
        logDatabaseEvent('backup', null, duration, 'failed', err.message);
        eventBus.publish(EventTypes.DATABASE_BACKUP_FAILED, { type, error: err.message });
        return { success: false, error: err.message };
    }
}

/**
 * Verify compressed backup file
 * @param {string} filePath
 * @returns {{success: boolean, error?: string}}
 */
function verifyBackupFile(filePath) {
    let tempExtractPath = null;
    try {
        if (!fs.existsSync(filePath)) {
            return { success: false, error: 'Backup file does not exist.' };
        }
        const compressedData = fs.readFileSync(filePath);
        const rawData = zlib.gunzipSync(compressedData);

        tempExtractPath = path.join(folders.temp, `verify_extract_${Date.now()}.db`);
        fs.writeFileSync(tempExtractPath, rawData);

        const testDb = new Database(tempExtractPath);
        try {
            const check = testDb.prepare('PRAGMA integrity_check').get();
            if (!check || check.integrity_check !== 'ok') {
                return { success: false, error: 'Integrity check returned errors.' };
            }
            const fk = testDb.prepare('PRAGMA foreign_key_check').all();
            if (fk.length > 0) {
                return { success: false, error: 'Foreign key constraints check failed.' };
            }
        } finally {
            testDb.close();
            if (fs.existsSync(tempExtractPath)) {
                fs.unlinkSync(tempExtractPath);
            }
        }
        return { success: true };
    } catch (err) {
        if (tempExtractPath && fs.existsSync(tempExtractPath)) {
            try { fs.unlinkSync(tempExtractPath); } catch (e) {}
        }
        return { success: false, error: err.message };
    }
}

/**
 * Delete a backup file
 */
function deleteBackupFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return { success: true };
        }
        return { success: false, error: 'File not found.' };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Rotate backups
 * Keep latest 30 Automatic backups, latest 10 BeforeMigration backups.
 * Never delete Manual backups automatically.
 */
function rotateBackups() {
    try {
        // Rotate Automatic
        const autoFiles = fs.readdirSync(folders.automatic)
            .filter(f => f.endsWith('.db.gz'))
            .map(f => ({ name: f, path: path.join(folders.automatic, f), stat: fs.statSync(path.join(folders.automatic, f)) }))
            .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs); // Newest first

        if (autoFiles.length > 30) {
            const toDelete = autoFiles.slice(30);
            toDelete.forEach(file => {
                try {
                    fs.unlinkSync(file.path);
                    console.log(`[BackupService] Rotated automatic backup deleted: ${file.name}`);
                } catch (e) {
                    console.error(`Failed to delete automatic backup: ${file.path}`, e);
                }
            });
        }

        // Rotate BeforeMigration
        const migrationFiles = fs.readdirSync(folders.migration)
            .filter(f => f.endsWith('.db.gz'))
            .map(f => ({ name: f, path: path.join(folders.migration, f), stat: fs.statSync(path.join(folders.migration, f)) }))
            .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs); // Newest first

        if (migrationFiles.length > 10) {
            const toDelete = migrationFiles.slice(10);
            toDelete.forEach(file => {
                try {
                    fs.unlinkSync(file.path);
                    console.log(`[BackupService] Rotated migration backup deleted: ${file.name}`);
                } catch (e) {
                    console.error(`Failed to delete migration backup: ${file.path}`, e);
                }
            });
        }
    } catch (err) {
        console.error('[BackupService] Rotation logic failed:', err);
    }
}

/**
 * Restore from database backup
 * @param {string} filePath
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function restoreBackup(filePath) {
    const startTime = Date.now();
    eventBus.publish(EventTypes.DATABASE_RESTORE_STARTED, { path: filePath });

    let safetyBackupFileName = null;
    let tempSafetyPath = null;
    try {
        if (!fs.existsSync(filePath)) {
            throw new Error('Backup file does not exist.');
        }

        // Decompress and verify the backup first
        const verifyRes = verifyBackupFile(filePath);
        if (!verifyRes.success) {
            throw new Error(`Backup file verification failed: ${verifyRes.error}`);
        }

        // 1. Create a safety backup in Temp
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        const timestampStr = formatFilenameDate(new Date());
        safetyBackupFileName = `backup_${timestampStr}_safety_before_restore.db.gz`;
        tempSafetyPath = path.join(folders.temp, safetyBackupFileName);

        const rawBytes = fs.readFileSync(db.dbPath);
        const compressed = zlib.gzipSync(rawBytes);
        fs.writeFileSync(tempSafetyPath, compressed);

        // 2. Read new database content from target backup
        const newDbCompressed = fs.readFileSync(filePath);
        const newDbRaw = zlib.gunzipSync(newDbCompressed);

        // 3. Close the active database connection safely
        db.close();

        // 4. Overwrite live database file
        fs.writeFileSync(db.dbPath, newDbRaw);

        // 5. Re-establish SQLite instance
        db.reopen();

        // 6. Verify restored database
        const integrity = db.prepare('PRAGMA integrity_check').get();
        if (!integrity || integrity.integrity_check !== 'ok') {
            throw new Error(`Restored database integrity failed: ${integrity ? integrity.integrity_check : 'unknown'}`);
        }
        const fk = db.prepare('PRAGMA foreign_key_check').all();
        if (fk.length > 0) {
            throw new Error('Restored database constraint checks failed.');
        }

        // Restore verified! Delete safety file
        if (fs.existsSync(tempSafetyPath)) {
            fs.unlinkSync(tempSafetyPath);
        }

        const duration = Date.now() - startTime;
        logDatabaseEvent('restore', path.basename(filePath), duration, 'success');
        eventBus.publish(EventTypes.DATABASE_RESTORE_COMPLETED, { path: filePath });

        // Relaunch the app immediately
        if (app) {
            setTimeout(() => {
                app.relaunch();
                app.exit(0);
            }, 1000);
        }

        return { success: true };
    } catch (err) {
        console.error('[BackupService] Restore failed, rolling back:', err);
        
        // Rollback attempt
        if (tempSafetyPath && fs.existsSync(tempSafetyPath)) {
            try {
                const safetyCompressed = fs.readFileSync(tempSafetyPath);
                const safetyRaw = zlib.gunzipSync(safetyCompressed);
                
                // Write back original database
                fs.writeFileSync(db.dbPath, safetyRaw);
                
                // Reopen original connection
                db.reopen();
                
                fs.unlinkSync(tempSafetyPath);
            } catch (rollbackErr) {
                console.error('[BackupService] Rollback crashed:', rollbackErr);
            }
        }

        const duration = Date.now() - startTime;
        logDatabaseEvent('restore', path.basename(filePath), duration, 'failed', err.message);
        eventBus.publish(EventTypes.DATABASE_RESTORE_FAILED, { path: filePath, error: err.message });
        return { success: false, error: err.message };
    }
}

/**
 * Scan backup folders and return clean list of backup files
 */
function getBackupHistory() {
    const list = [];
    
    const scanFolder = (folderPath, type) => {
        if (!fs.existsSync(folderPath)) return;
        const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.db.gz'));
        files.forEach(f => {
            const fullPath = path.join(folderPath, f);
            const stat = fs.statSync(fullPath);
            list.push({
                name: f,
                path: fullPath,
                type: type,
                size: stat.size,
                mtime: stat.mtime.toISOString()
            });
        });
    };

    scanFolder(folders.automatic, 'Automatic');
    scanFolder(folders.manual, 'Manual');
    scanFolder(folders.migration, 'BeforeMigration');

    // Sort by modified time descending (newest first)
    return list.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
}

/**
 * Run safe counts helper
 */
function safeGetCount(sql) {
    try {
        const res = db.prepare(sql).get();
        return res ? (res.count || 0) : 0;
    } catch (e) {
        return 0;
    }
}

/**
 * Compile shop owner database health indicators
 */
function getDatabaseHealth() {
    let dbSize = 0;
    try {
        if (fs.existsSync(db.dbPath)) {
            dbSize = fs.statSync(db.dbPath).size;
        }
    } catch (e) {}

    let lastBackup = 'Never';
    let lastRestore = 'Never';
    let lastBackupStatus = 'unknown';

    try {
        const lastBackupRow = db.prepare(`
            SELECT timestamp, status FROM database_events 
            WHERE operation = 'backup' 
            ORDER BY timestamp DESC LIMIT 1
        `).get();
        if (lastBackupRow) {
            lastBackup = lastBackupRow.timestamp;
            lastBackupStatus = lastBackupRow.status;
        }

        const lastRestoreRow = db.prepare(`
            SELECT timestamp FROM database_events 
            WHERE operation = 'restore' AND status = 'success' 
            ORDER BY timestamp DESC LIMIT 1
        `).get();
        if (lastRestoreRow) {
            lastRestore = lastRestoreRow.timestamp;
        }
    } catch (e) {}

    // Run simple checks
    let status = 'Healthy';
    let integrityStatus = 'Verified';
    try {
        const check = db.prepare('PRAGMA integrity_check').get();
        if (!check || check.integrity_check !== 'ok') {
            status = 'Corrupted';
            integrityStatus = 'Error';
        } else {
            // Check if last backup is more than 7 days old
            if (lastBackup !== 'Never') {
                const backupDate = new Date(lastBackup.replace(' ', 'T') + 'Z');
                const diffTime = Math.abs(Date.now() - backupDate.getTime());
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                if (diffDays > 7 || lastBackupStatus === 'failed') {
                    status = 'Warning';
                }
            } else {
                status = 'Warning';
            }
        }
    } catch (err) {
        status = 'Corrupted';
        integrityStatus = 'Error';
    }

    return {
        status,
        databaseSize: dbSize,
        lastBackup,
        lastRestore,
        autoBackupStatus: 'Active',
        integrityStatus,
        customerCount: safeGetCount('SELECT COUNT(*) as count FROM customers'),
        orderCount: safeGetCount('SELECT COUNT(*) as count FROM orders'),
        inventoryItemCount: safeGetCount("SELECT COUNT(*) as count FROM inventory_items WHERE status != 'Deleted'"),
        supplierCount: safeGetCount('SELECT COUNT(*) as count FROM suppliers')
    };
}

/**
 * Create a quick safety backup in the Temp folder before sensitive operations
 */
async function createSafetyBackup(opName) {
    try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        const tempName = `temp_safety_${opName}.db.gz`;
        const tempPath = path.join(folders.temp, tempName);

        const rawBytes = fs.readFileSync(db.dbPath);
        const compressed = zlib.gzipSync(rawBytes);
        fs.writeFileSync(tempPath, compressed);
        
        console.log(`[BackupService] Safety backup created for operation: ${opName}`);
        return { success: true };
    } catch (err) {
        console.error(`[BackupService] Safety backup failed for ${opName}:`, err);
        return { success: false, error: err.message };
    }
}

/**
 * Remove safety backup upon successful completion of operation
 */
function commitSafetyBackup(opName) {
    try {
        const tempName = `temp_safety_${opName}.db.gz`;
        const tempPath = path.join(folders.temp, tempName);
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
            console.log(`[BackupService] Safety backup committed (deleted) for operation: ${opName}`);
        }
        return { success: true };
    } catch (err) {
        console.error(`[BackupService] Failed to commit safety backup for ${opName}:`, err);
        return { success: false, error: err.message };
    }
}

/**
 * Rollback to safety backup if operation crashes
 */
function rollbackSafetyBackup(opName) {
    try {
        const tempName = `temp_safety_${opName}.db.gz`;
        const tempPath = path.join(folders.temp, tempName);
        if (fs.existsSync(tempPath)) {
            console.log(`[BackupService] Rolling back database from safety backup: ${opName}`);
            const safetyCompressed = fs.readFileSync(tempPath);
            const safetyRaw = zlib.gunzipSync(safetyCompressed);

            fs.writeFileSync(db.dbPath, safetyRaw);

            // Reopen original connection
            db.reopen();

            fs.unlinkSync(tempPath);
            console.log(`[BackupService] Database rolled back successfully for: ${opName}`);
            return { success: true };
        }
        return { success: false, error: 'No safety backup found.' };
    } catch (err) {
        console.error(`[BackupService] Failed to rollback safety backup for ${opName}:`, err);
        return { success: false, error: err.message };
    }
}

/**
 * Perform backup synchronously (for migrations or startup context)
 * @param {string} type - 'automatic', 'manual', 'migration', or 'temp'
 * @returns {{success: boolean, path?: string, error?: string}}
 */
function performBackupSync(type) {
    const startTime = Date.now();
    const folder = folders[type];
    if (!folder) {
        return { success: false, error: `Invalid backup type: ${type}` };
    }

    let tempBackupPath = null;
    try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

        const originalDbPath = db.dbPath;
        const timestampStr = formatFilenameDate(new Date());
        const tempName = `temp_sync_${timestampStr}.db`;
        tempBackupPath = path.join(folders.temp, tempName);

        // Synchronous file copy
        fs.copyFileSync(originalDbPath, tempBackupPath);

        // Verify copied database integrity
        if (!fs.existsSync(tempBackupPath)) {
            throw new Error('Backup file was not created.');
        }

        const stats = fs.statSync(tempBackupPath);
        if (stats.size === 0) {
            throw new Error('Backup file size is 0 bytes.');
        }

        const testDb = new Database(tempBackupPath);
        try {
            const check = testDb.prepare('PRAGMA integrity_check').get();
            if (!check || check.integrity_check !== 'ok') {
                throw new Error(`Copied DB integrity failed: ${check ? check.integrity_check : 'unknown'}`);
            }
        } finally {
            testDb.close();
        }

        // Compress file
        const rawBytes = fs.readFileSync(tempBackupPath);
        const compressed = zlib.gzipSync(rawBytes);

        const targetFileName = `backup_${timestampStr}_${type}.db.gz`;
        const targetPath = path.join(folder, targetFileName);
        fs.writeFileSync(targetPath, compressed);

        // Clean up temporary copy
        fs.unlinkSync(tempBackupPath);

        const duration = Date.now() - startTime;
        logDatabaseEvent('backup', targetFileName, duration, 'success');

        if (type === 'automatic' || type === 'migration') {
            rotateBackups();
        }

        return { success: true, path: targetPath, filename: targetFileName };
    } catch (err) {
        if (tempBackupPath && fs.existsSync(tempBackupPath)) {
            try { fs.unlinkSync(tempBackupPath); } catch (e) {}
        }
        const duration = Date.now() - startTime;
        logDatabaseEvent('backup', null, duration, 'failed', err.message);
        return { success: false, error: err.message };
    }
}

module.exports = {
    performBackup,
    performBackupSync,
    verifyBackupFile,
    deleteBackupFile,
    restoreBackup,
    getBackupHistory,
    getDatabaseHealth,
    runIntegrityChecks,
    createSafetyBackup,
    commitSafetyBackup,
    rollbackSafetyBackup,
    backupBaseDir,
    folders
};
