const { app } = require('electron');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let dbDir;
let dbPath;
const fallbackDbDir = path.join(__dirname, '../../../../database');

if (process.env.TEST_DB_PATH) {
    dbPath = process.env.TEST_DB_PATH;
    dbDir = path.dirname(dbPath);
} else {
    try {
        if (app) {
            dbDir = path.join(app.getPath('userData'), 'database');
        }
    } catch (e) {
        // Fallback for non-Electron test execution environment
    }

    if (!dbDir) {
        dbDir = fallbackDbDir;
    }
    dbPath = path.join(dbDir, 'database.db');
}

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const fallbackDbPath = path.join(fallbackDbDir, 'database.db');

// Auto-migrate database from old relative folder to persistent userData folder if needed
if (dbPath !== fallbackDbPath && !fs.existsSync(dbPath) && fs.existsSync(fallbackDbPath)) {
    try {
        console.log(`Migrating existing database from ${fallbackDbPath} to ${dbPath}`);
        fs.copyFileSync(fallbackDbPath, dbPath);
    } catch (err) {
        console.error("Failed to migrate database file:", err);
    }
}

function createDbInstance(targetPath) {
    const instance = new Database(targetPath, { timeout: 5000 });
    try {
        instance.pragma('journal_mode = WAL');
        instance.pragma('busy_timeout = 5000');
        instance.pragma('foreign_keys = ON');
        instance.pragma('synchronous = NORMAL');
        instance.pragma('temp_store = MEMORY');
        instance.pragma('cache_size = -16000');
        instance.pragma('mmap_size = 268435456');
    } catch (e) {
        console.warn("Failed to set SQLite pragmas:", e);
    }
    return instance;
}

let currentDb = createDbInstance(dbPath);

const dbWrapper = {
    // Expose underlying path
    dbPath,

    // Proxy Methods
    prepare(sql) {
        return currentDb.prepare(sql);
    },
    transaction(fn) {
        return currentDb.transaction(fn);
    },
    exec(sql) {
        return currentDb.exec(sql);
    },
    pragma(sql, options) {
        return currentDb.pragma(sql, options);
    },
    close() {
        return currentDb.close();
    },
    backup(targetPath, options) {
        return currentDb.backup(targetPath, options);
    },

    // Proxy properties
    get name() {
        return currentDb.name;
    },
    get open() {
        return currentDb.open;
    },
    get inTransaction() {
        return currentDb.inTransaction;
    },
    get readonly() {
        return currentDb.readonly;
    },

    // Reopen helper (closes old connection and opens a new one)
    reopen(newPath = dbPath) {
        try {
            currentDb.close();
        } catch (e) {
            console.warn("Error closing database connection during reopen:", e);
        }
        currentDb = createDbInstance(newPath);
    }
};

module.exports = dbWrapper;
