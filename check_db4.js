const dbPath = require('path').join(process.env.APPDATA, 'printshopmanager', 'database', 'database.db');
const db = require('better-sqlite3')(dbPath);
console.log("Order 260 items:", db.prepare('SELECT * FROM order_items WHERE order_id = 260').all());
console.log("getRecentOrders output:", db.prepare(`
SELECT o.id, o.customer_id, o.total_price as price, o.status, o.notes, o.created_at, 
       c.name as customer_name, c.phone as customer_phone,
       IFNULL(SUM(oi.pages * oi.copies), 0) as pages,
       IFNULL(SUM(oi.copies), 0) as copies,
       IFNULL(GROUP_CONCAT(oi.file_name, ', '), '') as file_name,
       IFNULL(MIN(oi.file_path), '') as file_path,
       IFNULL(MIN(oi.print_type), '') as print_type,
       IFNULL(MIN(oi.paper_size), '') as paper_size,
       IFNULL(MIN(oi.sides), 'Single') as sides
FROM orders o 
LEFT JOIN customers c ON o.customer_id = c.id 
LEFT JOIN order_items oi ON o.id = oi.order_id
WHERE o.id IN (259, 260)
GROUP BY o.id
ORDER BY o.created_at DESC LIMIT 5
`).all());
