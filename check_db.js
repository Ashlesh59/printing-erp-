const db = require('better-sqlite3')('src/main/database/data.db');
console.log(db.prepare('SELECT id, status, customer_id, created_at FROM orders ORDER BY id DESC LIMIT 5').all());
require('electron').app.quit();
