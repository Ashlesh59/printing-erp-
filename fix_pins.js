const { app } = require('electron');
const path = require('path');

app.setName('printshopmanager');

app.whenReady().then(() => {
    let dbDir = path.join(app.getPath('userData'), 'database');
    const dbPath = path.join(dbDir, 'database.db');
    console.log("Using DB at: " + dbPath);

    const Database = require('./node_modules/better-sqlite3');
    const db = new Database(dbPath);
    const pinSecurity = require('./src/main/security/pin-security.js');

    try {
        const adminPin = '684920';
        const operatorPin = '715938';

        const hashedAdmin = pinSecurity.hashPinSync(adminPin);
        const hashedOperator = pinSecurity.hashPinSync(operatorPin);

        const updateStmt = db.prepare("UPDATE users SET pin = ?, reset_required = 0 WHERE role = ?");
        
        const adminResult = updateStmt.run(hashedAdmin, 'Admin');
        const operatorResult = updateStmt.run(hashedOperator, 'Operator');
        
        console.log("PINs have been reset successfully.");
        console.log("Admin updated: " + adminResult.changes);
        console.log("Operator updated: " + operatorResult.changes);
        console.log("---");
        console.log("Admin PIN is now: " + adminPin);
        console.log("Operator PIN is now: " + operatorPin);
    } catch (e) {
        console.error("Error updating PINs: ", e);
    }
    process.exit(0);
});
