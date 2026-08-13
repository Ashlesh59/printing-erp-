const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('./database/db');

function cleanupTempFiles() {
    let filesDeleted = 0;
    let spaceSaved = 0;

    // 1. Clean OS Temp folder
    const tempDir = os.tmpdir();
    try {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
            if (file.startsWith('unified_print_') || file.startsWith('temp_work_') || file.startsWith('test_print_')) {
                const filePath = path.join(tempDir, file);
                try {
                    const stats = fs.statSync(filePath);
                    const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
                    // Delete files older than 2 hours or if they are print outputs
                    if (ageHours > 2) {
                        spaceSaved += stats.size;
                        fs.unlinkSync(filePath);
                        filesDeleted++;
                    }
                } catch(e) {}
            }
        }
    } catch(e) {
        console.error("Failed to read temp directory:", e);
    }

    // 2. Clean Customers folders (Optional: delete older than 30 days)
    let app;
    try { app = require('electron').app; } catch(e) {}
    const baseDocsDir = (app && typeof app.getPath === 'function') ? path.join(app.getPath('documents'), 'PrintShopManager') : path.join(os.homedir(), 'Documents', 'PrintShopManager');
    const customersDir = path.join(baseDocsDir, 'Customers');
    if (fs.existsSync(customersDir)) {
        try {
            const folders = fs.readdirSync(customersDir);
            for (const folder of folders) {
                const folderPath = path.join(customersDir, folder);
                if (fs.statSync(folderPath).isDirectory()) {
                    const subfolders = fs.readdirSync(folderPath);
                    for (const sub of subfolders) {
                        const subPath = path.join(folderPath, sub);
                        if (fs.statSync(subPath).isDirectory()) {
                            const files = fs.readdirSync(subPath);
                            for (const file of files) {
                                if (file.startsWith('Unified_Order_')) {
                                    const filePath = path.join(subPath, file);
                                    try {
                                        const stats = fs.statSync(filePath);
                                        const ageDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
                                        if (ageDays > 30) {
                                            spaceSaved += stats.size;
                                            fs.unlinkSync(filePath);
                                            filesDeleted++;
                                        }
                                    } catch(e) {}
                                }
                            }
                        }
                    }
                }
            }
        } catch(e) {
            console.error("Failed to read customers directory:", e);
        }
    }

    const spaceMB = (spaceSaved / (1024 * 1024)).toFixed(2);
    return { success: true, filesDeleted, spaceSavedMB: spaceMB };
}

function optimizeDatabase() {
    let rowsDeleted = 0;
    try {
        // Delete print jobs and history older than 30 days
        const prunes = [
            db.prepare("DELETE FROM print_jobs WHERE created_at < date('now', '-30 days')"),
            db.prepare("DELETE FROM event_history WHERE timestamp < date('now', '-30 days')"),
            db.prepare("DELETE FROM activities WHERE created_at < date('now', '-30 days')")
        ];
        
        const transaction = db.transaction(() => {
            let deleted = 0;
            for (const stmt of prunes) {
                const info = stmt.run();
                deleted += info.changes;
            }
            return deleted;
        });

        rowsDeleted = transaction();

        // Shrink the database file
        db.exec("VACUUM");

        return { success: true, rowsDeleted };
    } catch (e) {
        console.error("Failed to optimize database:", e);
        return { success: false, error: e.message };
    }
}

module.exports = { cleanupTempFiles, optimizeDatabase };
