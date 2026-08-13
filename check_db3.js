const dbPath = require('path').join(process.env.APPDATA, 'printshopmanager', 'database', 'database.db');
const db = require('better-sqlite3')(dbPath);
console.log("DB Orders:", db.prepare('SELECT id, status, customer_id, created_at FROM orders ORDER BY id DESC LIMIT 5').all());
console.log("DB Workflow:", db.prepare('SELECT name, action_type FROM workflow_steps').all());
