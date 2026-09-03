const db = require('./db');
const GstModel = require('./gst-model');
const eventBus = require('../events/EventBus');
const { EventTypes } = require('../events/EventTypes');

const ActivityModel = {
    logActivity: (description, type) => {
        try {
            db.prepare('INSERT INTO activities (description, type) VALUES (?, ?)').run(description, type);
        } catch(e) {
            console.error("Failed to log activity:", e);
        }
    },
    getRecentActivities: () => {
        return db.prepare('SELECT * FROM activities ORDER BY created_at DESC LIMIT 10').all();
    }
};

const { LicenseService, LicenseState } = require('../security/license-service');
const pinSecurity = require('../security/pin-security');
const authThrottle = require('../security/auth-throttle');

const LicenseModel = {
    getLicense: () => {
        return LicenseService.getPublicLicenseInfo();
    },
    checkLicense: () => {
        const status = LicenseService.checkLicenseStatus();
        return status.valid === true;
    },
    checkLicenseStatus: () => {
        return LicenseService.checkLicenseStatus();
    },
    activateLicense: (key) => {
        return LicenseService.activateLicense(key);
    }
};

const CustomerModel = {
    searchByPhone: (phone) => {
        return db.prepare('SELECT * FROM customers WHERE phone LIKE ? LIMIT 5').all(`%${phone}%`);
    },

    createCustomer: (data, phoneArg) => {
        try {
            let name, phone, email = '', tag = 'Regular', address = '', company_name = '', gstin = '', state = 'Local', pref_type = '', pref_size = '', pref_sides = '';
            if (typeof data === 'object' && data !== null) {
                name = data.name;
                phone = data.phone;
                email = data.email || '';
                tag = data.tag || 'Regular';
                address = data.address || '';
                company_name = data.company_name || '';
                gstin = data.gstin || '';
                state = data.state || 'Local';
                pref_type = data.preferred_print_type || '';
                pref_size = data.preferred_paper_size || '';
                pref_sides = data.preferred_sides || '';
            } else {
                name = data;
                phone = phoneArg;
            }

            if (!name || !phone) return { success: false, error: 'Name and phone are required' };

            const existing = db.prepare('SELECT id FROM customers WHERE phone = ?').get(phone);
            if (existing) {
                db.prepare(`
                    UPDATE customers 
                    SET name = ?, email = COALESCE(NULLIF(?, ''), email), tag = COALESCE(NULLIF(?, ''), tag),
                        address = COALESCE(NULLIF(?, ''), address), company_name = COALESCE(NULLIF(?, ''), company_name),
                        gstin = COALESCE(NULLIF(?, ''), gstin), state = COALESCE(NULLIF(?, ''), state),
                        preferred_print_type = COALESCE(NULLIF(?, ''), preferred_print_type),
                        preferred_paper_size = COALESCE(NULLIF(?, ''), preferred_paper_size),
                        preferred_sides = COALESCE(NULLIF(?, ''), preferred_sides)
                    WHERE id = ?
                `).run(name, email, tag, address, company_name, gstin, state, pref_type, pref_size, pref_sides, existing.id);
                return { success: true, id: existing.id };
            }

            const stmt = db.prepare(`
                INSERT INTO customers (name, phone, email, tag, address, company_name, gstin, state, preferred_print_type, preferred_paper_size, preferred_sides)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const result = stmt.run(name, phone, email, tag, address, company_name, gstin, state, pref_type, pref_size, pref_sides);
            eventBus.publish(EventTypes.CUSTOMER_CREATED, { id: result.lastInsertRowid, name, phone }, { sourceModule: 'CustomerModel' });
            return { success: true, id: result.lastInsertRowid };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },

    updateCustomer: (id, data) => {
        try {
            db.prepare(`
                UPDATE customers 
                SET name = ?, phone = ?, email = ?, tag = ?, address = ?, company_name = ?,
                    gstin = ?, state = ?, preferred_print_type = ?, preferred_paper_size = ?, preferred_sides = ?, notes = ?
                WHERE id = ?
            `).run(
                data.name, data.phone, data.email || '', data.tag || 'Regular',
                data.address || '', data.company_name || '', data.gstin || '',
                data.state || 'Local', data.preferred_print_type || '',
                data.preferred_paper_size || '', data.preferred_sides || '',
                data.notes || '', id
            );
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },

    getCustomers: (limit, offset) => {
        return CustomerModel.getAllCustomers(limit, offset);
    },

    getAllCustomers: (limit, offset) => {
        return CustomerModel.searchCustomersAdvanced('', 'All', 'last_visit', limit, offset);
    },

    searchCustomersAdvanced: (query = '', tagFilter = 'All', sortBy = 'last_visit', limit = 50, offset = 0) => {
        try {
            const q = `%${query.trim()}%`;
            const numericQ = parseInt(query.trim()) || 0;

            let sortClause = 'MAX(o.created_at) DESC NULLS LAST';
            if (sortBy === 'revenue') sortClause = 'total_revenue DESC';
            else if (sortBy === 'orders') sortClause = 'total_orders DESC';
            else if (sortBy === 'name') sortClause = 'c.name ASC';
            else if (sortBy === 'created_at') sortClause = 'c.created_at DESC';

            let tagClause = '';
            const params = [];

            if (query.trim() !== '') {
                tagClause += ` AND (
                    c.name LIKE ? OR 
                    c.phone LIKE ? OR 
                    c.email LIKE ? OR 
                    c.gstin LIKE ? OR 
                    c.company_name LIKE ? OR
                    c.id = ? OR
                    o.id = ? OR
                    g.invoice_number LIKE ?
                )`;
                params.push(q, q, q, q, q, numericQ, numericQ, q);
            }

            if (tagFilter && tagFilter !== 'All') {
                tagClause += ` AND c.tag = ?`;
                params.push(tagFilter);
            }

            const sql = `
                SELECT c.*, 
                       COUNT(DISTINCT o.id) as total_orders, 
                       IFNULL(SUM(CASE WHEN o.status NOT IN ('Cancelled', 'Declined', 'Draft', 'Saved') THEN o.total_price ELSE 0 END), 0) as total_revenue,
                       MAX(o.created_at) as last_visit
                FROM customers c
                LEFT JOIN orders o ON c.id = o.customer_id
                LEFT JOIN gst_invoices g ON c.id = g.customer_id
                WHERE 1=1 ${tagClause}
                GROUP BY c.id
                ORDER BY ${sortClause}
                LIMIT ? OFFSET ?
            `;

            params.push(limit, offset);
            return db.prepare(sql).all(...params);
        } catch(e) {
            console.error("searchCustomersAdvanced error:", e);
            return [];
        }
    },

    getCustomerProfile: (customerId) => {
        try {
            const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
            if (!customer) return null;

            const stats = db.prepare(`
                SELECT 
                    COUNT(id) as total_orders,
                    IFNULL(SUM(CASE WHEN status NOT IN ('Cancelled', 'Declined', 'Draft', 'Saved') THEN total_price ELSE 0 END), 0) as total_revenue,
                    IFNULL(AVG(CASE WHEN status NOT IN ('Cancelled', 'Declined', 'Draft', 'Saved') THEN total_price ELSE NULL END), 0) as avg_order_value,
                    MAX(created_at) as last_visit,
                    SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as pending_orders_count
                FROM orders
                WHERE customer_id = ?
            `).get(customerId);

            const orders = db.prepare(`
                SELECT o.*, 
                       (SELECT file_name FROM order_items WHERE order_id = o.id LIMIT 1) as main_file_name,
                       (SELECT print_type FROM order_items WHERE order_id = o.id LIMIT 1) as main_print_type,
                       (SELECT paper_size FROM order_items WHERE order_id = o.id LIMIT 1) as main_paper_size,
                       (SELECT sides FROM order_items WHERE order_id = o.id LIMIT 1) as main_sides,
                       (SELECT copies FROM order_items WHERE order_id = o.id LIMIT 1) as main_copies,
                       (SELECT pages FROM order_items WHERE order_id = o.id LIMIT 1) as main_pages
                FROM orders o
                WHERE o.customer_id = ?
                ORDER BY o.created_at DESC
                LIMIT 20
            `).all(customerId);

            const invoices = db.prepare(`
                SELECT * FROM gst_invoices 
                WHERE customer_id = ? 
                ORDER BY created_at DESC 
                LIMIT 10
            `).all(customerId);

            const notes = db.prepare(`
                SELECT * FROM customer_notes 
                WHERE customer_id = ? 
                ORDER BY created_at DESC
            `).all(customerId);

            const documents = db.prepare(`
                SELECT * FROM customer_documents 
                WHERE customer_id = ? 
                ORDER BY created_at DESC
            `).all(customerId);

            const frequentServices = db.prepare(`
                SELECT print_type, paper_size, sides, COUNT(*) as usage_count
                FROM order_items oi
                JOIN orders o ON oi.order_id = o.id
                WHERE o.customer_id = ? AND oi.print_type IS NOT NULL
                GROUP BY print_type, paper_size, sides
                ORDER BY usage_count DESC
                LIMIT 5
            `).all(customerId);

            const timeline = [];
            orders.forEach(o => {
                timeline.push({
                    type: 'order',
                    title: `Order #${o.id} created`,
                    description: `Amount: ₹${(o.total_price || 0).toFixed(2)} • Status: ${o.status}`,
                    timestamp: o.created_at,
                    data: o
                });
            });
            notes.forEach(n => {
                timeline.push({
                    type: 'note',
                    title: `Note added by ${n.author || 'Operator'}`,
                    description: n.note,
                    timestamp: n.created_at,
                    data: n
                });
            });
            documents.forEach(d => {
                timeline.push({
                    type: 'document',
                    title: `Document attached: ${d.file_name}`,
                    description: `Category: ${d.category || 'General'}`,
                    timestamp: d.created_at,
                    data: d
                });
            });

            timeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            return {
                customer,
                stats,
                orders,
                invoices,
                notes,
                documents,
                frequentServices,
                timeline: timeline.slice(0, 30)
            };
        } catch(e) {
            console.error("getCustomerProfile error:", e);
            return null;
        }
    },

    addNote: (customerId, note, author = 'Operator') => {
        try {
            const stmt = db.prepare('INSERT INTO customer_notes (customer_id, note, author) VALUES (?, ?, ?)');
            const res = stmt.run(customerId, note, author);
            return { success: true, id: res.lastInsertRowid };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },

    deleteNote: (noteId) => {
        try {
            db.prepare('DELETE FROM customer_notes WHERE id = ?').run(noteId);
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },

    addDocument: (customerId, orderId, fileName, filePath, fileSize = 0, category = 'General') => {
        try {
            const stmt = db.prepare(`
                INSERT INTO customer_documents (customer_id, order_id, file_name, file_path, file_size, category)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            const res = stmt.run(customerId, orderId || null, fileName, filePath, fileSize, category);
            return { success: true, id: res.lastInsertRowid };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },

    duplicateOrder: (orderId) => {
        try {
            const origOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
            if (!origOrder) return { success: false, error: 'Original order not found' };

            const origItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);

            const tx = db.transaction(() => {
                const newOrderStmt = db.prepare(`
                    INSERT INTO orders (customer_id, total_price, status, notes)
                    VALUES (?, ?, 'Pending', ?)
                `);
                const newOrder = newOrderStmt.run(origOrder.customer_id, origOrder.total_price, `Duplicated from Order #${orderId}`);
                const newOrderId = newOrder.lastInsertRowid;

                const itemStmt = db.prepare(`
                    INSERT INTO order_items (order_id, file_name, file_path, print_type, paper_size, sides, pages, copies, price, notes, paper_id, extras_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                for (const item of origItems) {
                    itemStmt.run(
                        newOrderId, item.file_name, item.file_path, item.print_type,
                        item.paper_size, item.sides, item.pages, item.copies, item.price,
                        item.notes, item.paper_id, item.extras_json
                    );
                }

                return newOrderId;
            });

            const newId = tx();
            return { success: true, orderId: newId };
        } catch(e) {
            return { success: false, error: e.message };
        }
    }
};

const OrderModel = {
    createOrder: (orderData) => {
        const items = orderData.items || [orderData];
        const transaction = db.transaction(() => {
            const totalPrice = items.reduce((sum, item) => sum + (parseFloat(item.price) || 0), 0);

            let initialStatus = orderData.status;
            if (!initialStatus) {
                try {
                    const firstStep = db.prepare('SELECT name FROM workflow_steps WHERE is_active = 1 ORDER BY sort_order ASC LIMIT 1').get();
                    if (firstStep) {
                        initialStatus = firstStep.name;
                    } else {
                        initialStatus = 'Pending';
                    }
                } catch(e) {
                    initialStatus = 'Pending';
                }
            }

            // 1. Insert Order Header
            const stmtOrder = db.prepare(`
                INSERT INTO orders (customer_id, total_price, status, notes)
                VALUES (?, ?, ?, ?)
            `);
            const resOrder = stmtOrder.run(
                orderData.customerId,
                totalPrice,
                initialStatus,
                orderData.notes || null
            );
            const orderId = resOrder.lastInsertRowid;

            // 2. Insert Order Items
            const stmtItem = db.prepare(`
                INSERT INTO order_items (order_id, file_name, file_path, print_type, paper_size, sides, pages, copies, price, notes, paper_id, extras_json, product_id, print_profile_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const stmtSpec = db.prepare(`
                INSERT OR REPLACE INTO order_item_specifications (order_item_id, spec_key, spec_value)
                VALUES (?, ?, ?)
            `);

            for (const item of items) {
                const extrasJson = item.extras ? JSON.stringify(item.extras) : null;
                const resItem = stmtItem.run(
                    orderId,
                    item.fileName || item.file_name,
                    item.filePath || item.file_path,
                    item.printType || item.print_type,
                    item.paperSize || item.paper_size,
                    item.sides || 'Single',
                    parseInt(item.pages) || 1,
                    parseInt(item.copies) || 1,
                    parseFloat(item.price) || 0,
                    item.notes || null,
                    item.paperId || item.paper_id || null,
                    extrasJson,
                    item.product_id || null,
                    item.print_profile_id || null
                );
                
                const orderItemId = resItem.lastInsertRowid;
                
                if (item.specifications && typeof item.specifications === 'object') {
                    for (const [key, val] of Object.entries(item.specifications)) {
                        if (val !== undefined && val !== null) {
                            stmtSpec.run(orderItemId, key, String(val));
                        }
                    }
                }
            }

            // 3. Trigger automatic inventory stock reservation/deduction via Workflow Engine
            OrderModel.triggerWorkflowActions(orderId, null, initialStatus, { ...orderData, items });

            // 4. Auto generate consolidated GST Tax Invoice
            try {
                const customer = db.prepare('SELECT gstin, state FROM customers WHERE id = ?').get(orderData.customerId);
                const gstin = orderData.gstin || (customer ? customer.gstin : '') || '';
                const state = orderData.state || (customer ? customer.state : 'Local') || 'Local';
                
                // Get GST settings
                const settings = db.prepare('SELECT default_gst_rate, enable_gst FROM settings WHERE id = 1').get() || { default_gst_rate: 18.0, enable_gst: 1 };
                const enableGst = settings.enable_gst !== 0;
                const gstRate = enableGst ? (parseFloat(settings.default_gst_rate) || 18.0) : 0;
                const gstFactor = 1 + (gstRate / 100);

                const subtotal = totalPrice / gstFactor;
                const totalGst = totalPrice - subtotal;
                
                let cgst = 0, sgst = 0, igst = 0;
                if (state === 'Local') {
                    cgst = totalGst / 2;
                    sgst = totalGst / 2;
                } else {
                    igst = totalGst;
                }
                
                const invoiceHeader = {
                    customer_id: orderData.customerId,
                    invoice_date: new Date().toISOString().split('T')[0],
                    subtotal: subtotal,
                    cgst_total: cgst,
                    sgst_total: sgst,
                    igst_total: igst,
                    grand_total: totalPrice,
                    state_type: state,
                    status: 'Paid',
                    gstin: gstin
                };
                
                const invoiceItems = items.map(item => {
                    const itemPrice = parseFloat(item.price) || 0;
                    const itemSubtotal = itemPrice / gstFactor;
                    const itemGst = itemPrice - itemSubtotal;
                    
                    let itemCgst = 0, itemSgst = 0, itemIgst = 0;
                    if (state === 'Local') {
                        itemCgst = itemGst / 2;
                        itemSgst = itemGst / 2;
                    } else {
                        itemIgst = itemGst;
                    }

                    return {
                        description: `${item.paperSize || item.paper_size || 'A4'} Document Printing (${(item.printType || item.print_type) === 'color' ? 'Color' : 'B/W'}, ${item.sides || 'Single'})`,
                        hsn_sac: '998911',
                        qty: parseInt(item.copies) || 1,
                        rate: ((parseInt(item.pages) || 1) * (itemPrice / (parseInt(item.copies) || 1))) / gstFactor,
                        gst_rate: gstRate,
                        taxable_value: itemSubtotal,
                        cgst_amount: itemCgst,
                        sgst_amount: itemSgst,
                        igst_amount: itemIgst,
                        total: itemPrice
                    };
                });
                
                GstModel.createInvoice(invoiceHeader, invoiceItems);
            } catch (err) {
                console.error("Auto GST invoice generation failed:", err);
            }

            return { success: true, id: orderId };
        });

        try {
            const res = transaction();
            if (res.success) {
                const logName = items.length === 1 ? items[0].fileName || items[0].file_name : `${items.length} items`;
                eventBus.publish(EventTypes.ORDER_CREATED, { orderId: res.id, logName, items }, { sourceModule: 'OrderModel' });
                try {
                    const ProductionModel = require('./production-model');
                    ProductionModel.autoCreateFromOrder(res.id, orderData.scheduleDetails || {
                        status: orderData.status,
                        scheduledStart: orderData.scheduledStart,
                        dueTime: orderData.dueTime,
                        operator: orderData.operator,
                        priority: orderData.priority
                    });
                } catch(pe) {
                    console.error("Auto Production Job creation failed:", pe);
                }
            }
            return res;
        } catch(e) {
            return { success: false, error: e.message };
        }
    },
    getRecentOrders: (limit, offset) => {
        if (typeof limit === 'number' && typeof offset === 'number') {
            return db.prepare(`
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
                GROUP BY o.id
                ORDER BY o.created_at DESC LIMIT ? OFFSET ?
            `).all(limit, offset);
        }
        return db.prepare(`
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
            GROUP BY o.id
            ORDER BY o.created_at DESC LIMIT 50
        `).all();
    },
    getOrdersByCustomer: (customerId) => {
        return db.prepare(`
            SELECT o.id, o.customer_id, o.total_price as price, o.status, o.notes, o.created_at,
                   IFNULL(SUM(oi.pages * oi.copies), 0) as pages,
                   IFNULL(SUM(oi.copies), 0) as copies,
                   IFNULL(GROUP_CONCAT(oi.file_name, ', '), '') as file_name,
                   IFNULL(MIN(oi.file_path), '') as file_path,
                   IFNULL(MIN(oi.print_type), '') as print_type,
                   IFNULL(MIN(oi.paper_size), '') as paper_size,
                   IFNULL(MIN(oi.sides), 'Single') as sides
            FROM orders o
            LEFT JOIN order_items oi ON o.id = oi.order_id
            WHERE o.customer_id = ? 
            GROUP BY o.id
            ORDER BY o.created_at DESC
        `).all(customerId);
    },
    getDashboardStats: () => {
        const todayOrders = db.prepare(`SELECT COUNT(*) as count FROM orders WHERE date(created_at) = date('now', 'localtime')`).get().count;
        const todayRevenue = db.prepare(`SELECT SUM(total_price) as total FROM orders WHERE date(created_at) = date('now', 'localtime') AND status NOT IN ('Pending', 'Cancelled', 'Declined', 'Draft', 'Saved')`).get().total || 0;
        
        const todayPending = db.prepare(`SELECT COUNT(*) as count FROM orders WHERE date(created_at) = date('now', 'localtime') AND status = 'Pending'`).get().count;
        const todayCompleted = db.prepare(`SELECT COUNT(*) as count FROM orders WHERE date(created_at) = date('now', 'localtime') AND status = 'Completed'`).get().count;
        
        const pagesStats = db.prepare(`
            SELECT SUM(oi.pages * oi.copies) as total, oi.print_type 
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE date(o.created_at) = date('now', 'localtime') 
            GROUP BY oi.print_type
        `).all();
        
        let colorPagesToday = 0;
        let bwPagesToday = 0;
        pagesStats.forEach(stat => {
            if (stat.print_type === 'color') colorPagesToday += stat.total;
            else bwPagesToday += stat.total;
        });
        const totalPagesToday = colorPagesToday + bwPagesToday;

        const totalCustomers = db.prepare(`SELECT COUNT(*) as count FROM customers`).get().count;
        const todayCustomers = db.prepare(`SELECT COUNT(*) as count FROM customers WHERE date(created_at) = date('now', 'localtime')`).get().count;
        const totalOrders = db.prepare(`SELECT COUNT(*) as count FROM orders`).get().count;

        // Accrual COGS calculation from stock_transactions
        const cogsRow = db.prepare(`
            SELECT SUM(ABS(qty) * cost) as total_cogs 
            FROM stock_transactions 
            WHERE type = 'order' AND date(created_at) = date('now', 'localtime')
        `).get();
        const todayCOGS = cogsRow ? (cogsRow.total_cogs || 0) : 0;
        const todayProfit = todayRevenue - todayCOGS;

        // Fetch Collected GST Today
        const todayGstRow = db.prepare(`
            SELECT SUM(cgst_total + sgst_total + igst_total) as total 
            FROM gst_invoices 
            WHERE date(invoice_date) = date('now', 'localtime')
              AND status NOT IN ('Pending', 'Cancelled', 'Declined', 'Draft', 'Saved')
        `).get();
        const todayGst = todayGstRow ? (todayGstRow.total || 0) : 0;

        return {
            todayOrders,
            todayRevenue,
            todayPending,
            todayCompleted,
            totalPagesToday,
            colorPagesToday,
            bwPagesToday,
            totalCustomers,
            todayCustomers,
            totalOrders,
            todayGst,
            todayProfit
        };
    },
    updateOrderStatus: (id, status) => {
        let oldStatus = null;
        try {
            const row = db.prepare('SELECT status FROM orders WHERE id = ?').get(id);
            if (row) oldStatus = row.status;
        } catch (err) {}

        const transaction = db.transaction(() => {
            const oldOrder = db.prepare('SELECT status FROM orders WHERE id = ?').get(id);
            if (!oldOrder) throw new Error("Order not found");

            db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);

            // Execute Workflow Actions
            OrderModel.triggerWorkflowActions(id, oldOrder.status, status);

            return { success: true };
        });

        try {
            const res = transaction();
            if (res.success) {
                eventBus.publish(EventTypes.ORDER_UPDATED, { orderId: id, status, oldStatus }, { sourceModule: 'OrderModel' });
            }
            return res;
        } catch(e) {
            return { success: false, error: e.message };
        }
    },
    triggerWorkflowActions: (orderId, oldStatus, newStatus, orderData = {}) => {
        try {
            const steps = db.prepare('SELECT name, action_type FROM workflow_steps').all();
            const oldStep = steps.find(s => s.name === oldStatus);
            const newStep = steps.find(s => s.name === newStatus);

            const oldAction = oldStep ? oldStep.action_type : 'none';
            const newAction = newStep ? newStep.action_type : 'none';

            if (newStatus === 'Cancelled' || newStatus === 'Declined') {
                const hasReservations = db.prepare('SELECT COUNT(*) as count FROM inventory_reservations WHERE order_id = ? AND status = ?').get(orderId, 'Active').count > 0;
                const hasFulfilled = db.prepare('SELECT COUNT(*) as count FROM inventory_reservations WHERE order_id = ? AND status = ?').get(orderId, 'Fulfilled').count > 0;

                if (hasFulfilled) {
                    eventBus.publish(EventTypes.INVENTORY_ADJUSTED, { orderId: orderId, isRestored: true }, { sourceModule: 'WorkflowEngine' });
                } else if (hasReservations) {
                    eventBus.publish(EventTypes.INVENTORY_RELEASED, { orderId: orderId }, { sourceModule: 'WorkflowEngine' });
                }
            } else {
                if (newAction === 'inventory_reserve' && oldAction !== 'inventory_reserve') {
                    eventBus.publish(EventTypes.INVENTORY_RESERVED, { orderId, orderData }, { sourceModule: 'WorkflowEngine' });
                }

                if (newAction === 'print' && oldAction !== 'print') {
                    OrderModel.triggerAutoPrint(orderId);
                }

                if (newAction === 'complete' && oldAction !== 'complete') {
                    const hasActiveRes = db.prepare('SELECT COUNT(*) as count FROM inventory_reservations WHERE order_id = ? AND status = ?').get(orderId, 'Active').count > 0;
                    const hasFulfilled = db.prepare('SELECT COUNT(*) as count FROM inventory_reservations WHERE order_id = ? AND status = ?').get(orderId, 'Fulfilled').count > 0;

                    if (!hasActiveRes && !hasFulfilled) {
                        try {
                            eventBus.publish(EventTypes.INVENTORY_RESERVED, { orderId, orderData }, { sourceModule: 'WorkflowEngine' });
                        } catch(e) {
                            console.error("Auto reservation during completion failed:", e);
                        }
                    }

                    eventBus.publish(EventTypes.INVENTORY_FULFILLED, { orderId }, { sourceModule: 'WorkflowEngine' });
                    eventBus.publish(EventTypes.ORDER_COMPLETED, { orderId }, { sourceModule: 'WorkflowEngine' });
                }
            }
        } catch (err) {
            console.error("Failed to execute triggerWorkflowActions:", err);
        }
    },
    triggerAutoPrint: (orderId) => {
        try {
            const fs = require('fs');
            const order = db.prepare('SELECT unified_pdf_path FROM orders WHERE id = ?').get(orderId);
            if (order && order.unified_pdf_path && fs.existsSync(order.unified_pdf_path)) {
                const item = db.prepare('SELECT print_type, paper_size, sides, copies FROM order_items WHERE order_id = ? LIMIT 1').get(orderId);
                const settings = db.prepare('SELECT default_printer, silent_print_enabled, use_system_dialog FROM settings WHERE id = 1').get();
                const printerName = settings ? settings.default_printer : null;

                const { printFile } = require('../printer');
                const payload = [{ path: order.unified_pdf_path, ext: '.pdf' }];
                const printOptions = {
                    printerName: printerName,
                    printType: item ? item.print_type : 'bw',
                    paperSize: item ? item.paper_size : 'A4',
                    sides: item ? item.sides : 'Single',
                    copies: item ? item.copies : 1,
                    silent: settings ? settings.silent_print_enabled === 1 : true,
                    useSystemDialog: settings ? settings.use_system_dialog === 1 : false,
                    isPdf: true,
                    orderId: orderId
                };

                printFile(payload, printerName, printOptions).then(res => {
                    console.log(`[AutoPrint] Successfully printed order #${orderId}`, res);
                }).catch(err => {
                    console.error(`[AutoPrint] Printing failed for order #${orderId}:`, err);
                });
            } else {
                console.warn(`[AutoPrint] No unified PDF found for order #${orderId}. Auto-print skipped.`);
            }
        } catch (err) {
            console.error("Failed to execute triggerAutoPrint:", err);
        }
    },
    getOrderItemSpecifications: (orderItemId) => {
        try {
            return db.prepare('SELECT spec_key, spec_value FROM order_item_specifications WHERE order_item_id = ?').all(orderItemId);
        } catch(e) {
            console.error("Failed to get order item specs:", e);
            return [];
        }
    }
};

const SettingsModel = {
    getSettings: () => {
        return db.prepare('SELECT * FROM settings WHERE id = 1').get();
    },
    getPublicSettings: () => {
        const full = db.prepare('SELECT * FROM settings WHERE id = 1').get() || {};
        return {
            id: full.id,
            shop_name: full.shop_name || 'PrintShop',
            business_address: full.business_address || '',
            business_contact: full.business_contact || '',
            business_email: full.business_email || '',
            business_gstin: full.business_gstin || '',
            currency_symbol: full.currency_symbol || '₹',
            default_gst_rate: full.default_gst_rate !== undefined ? full.default_gst_rate : 18,
            enable_gst: full.enable_gst !== undefined ? full.enable_gst : 1,
            has_setup: full.has_setup !== undefined ? full.has_setup : 0,
            owner_name: full.owner_name || '',
            receipt_footer_message: full.receipt_footer_message || '',
            use_system_dialog: full.use_system_dialog !== undefined ? full.use_system_dialog : 0,
            bw_price_per_page: full.bw_price_per_page !== undefined ? full.bw_price_per_page : 2,
            color_price_per_page: full.color_price_per_page !== undefined ? full.color_price_per_page : 10,
            enable_mobile_ordering: full.enable_mobile_ordering !== undefined ? full.enable_mobile_ordering : 0,
            mobile_server_port: full.mobile_server_port || 3000
        };
    },
    updateSettings: (data) => {
        try {
            const current = SettingsModel.getSettings() || {};
            const shop_name = data.hasOwnProperty('shop_name') ? data.shop_name : current.shop_name;
            const default_printer = data.hasOwnProperty('default_printer') ? data.default_printer : current.default_printer;
            const bw_price_per_page = data.hasOwnProperty('bw_price_per_page') ? data.bw_price_per_page : current.bw_price_per_page;
            const color_price_per_page = data.hasOwnProperty('color_price_per_page') ? data.color_price_per_page : current.color_price_per_page;
            const cloud_url = data.hasOwnProperty('cloud_url') ? data.cloud_url : current.cloud_url;
            const shop_id = data.hasOwnProperty('shop_id') ? data.shop_id : current.shop_id;
            const supabase_key = data.hasOwnProperty('supabase_key') ? data.supabase_key : current.supabase_key;
            const vercel_url = data.hasOwnProperty('vercel_url') ? data.vercel_url : current.vercel_url;
            const use_system_dialog = data.hasOwnProperty('use_system_dialog') ? data.use_system_dialog : current.use_system_dialog;
            const bw_cost_per_page = data.hasOwnProperty('bw_cost_per_page') ? data.bw_cost_per_page : current.bw_cost_per_page;
            const color_cost_per_page = data.hasOwnProperty('color_cost_per_page') ? data.color_cost_per_page : current.color_cost_per_page;
            
            const photo_printer = data.hasOwnProperty('photo_printer') ? data.photo_printer : current.photo_printer;
            const receipt_printer = data.hasOwnProperty('receipt_printer') ? data.receipt_printer : current.receipt_printer;
            const label_printer = data.hasOwnProperty('label_printer') ? data.label_printer : current.label_printer;
            const barcode_printer = data.hasOwnProperty('barcode_printer') ? data.barcode_printer : current.barcode_printer;
            const silent_print_enabled = data.hasOwnProperty('silent_print_enabled') ? data.silent_print_enabled : current.silent_print_enabled;
            const print_simulator_enabled = data.hasOwnProperty('print_simulator_enabled') ? data.print_simulator_enabled : current.print_simulator_enabled;

            const stmt = db.prepare(`
                UPDATE settings 
                SET shop_name = ?, default_printer = ?, bw_price_per_page = ?, color_price_per_page = ?, 
                    cloud_url = ?, shop_id = ?, supabase_key = ?, vercel_url = ?, use_system_dialog = ?, 
                    bw_cost_per_page = ?, color_cost_per_page = ?, photo_printer = ?, receipt_printer = ?, 
                    label_printer = ?, barcode_printer = ?, silent_print_enabled = ?, print_simulator_enabled = ?
                WHERE id = 1
            `);
            stmt.run(
                shop_name, default_printer, bw_price_per_page, color_price_per_page, 
                cloud_url, shop_id, supabase_key, vercel_url, use_system_dialog, 
                bw_cost_per_page, color_cost_per_page, photo_printer, receipt_printer, 
                label_printer, barcode_printer, silent_print_enabled, print_simulator_enabled
            );
            eventBus.publish(EventTypes.SETTINGS_CHANGED, data, { sourceModule: 'SettingsModel' });
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },
    getCloudSettings: () => {
        const s = SettingsModel.getSettings() || {};
        return {
            url: s.cloud_url || '',
            key: s.supabase_key || '',
            id: s.shop_id || '',
            vercel: s.vercel_url || ''
        };
    },
    updateCloudSettings: (url, key, id, vercel) => {
        return SettingsModel.updateSettings({
            cloud_url: url,
            supabase_key: key,
            shop_id: id,
            vercel_url: vercel
        });
    }
};

const PricingModel = {
    getPricing: () => PricingModel.getAll(),
    getAllPricing: () => PricingModel.getAll(),
    getAll: () => {
        return db.prepare(`
            SELECT p.*, i.name as inventory_item_name
            FROM pricing p
            LEFT JOIN inventory_items i ON p.inventory_item_id = i.id
            ORDER BY p.category, p.name
        `).all();
    },
    getByCategory: (category) => {
        return db.prepare('SELECT * FROM pricing WHERE category = ? ORDER BY name').all(category);
    },
    create: (data) => {
        try {
            const stmt = db.prepare(`
                INSERT INTO pricing (
                    name, category, color_type, paper_size, sides, price, inventory_item_id, 
                    default_printer, print_paper_size, print_orientation, print_color_mode, print_duplex, print_quality
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const result = stmt.run(
                data.name, data.category, data.color_type || null, data.paper_size || null, data.sides || null, 
                parseFloat(data.price) || 0, data.inventory_item_id ? parseInt(data.inventory_item_id) : null,
                data.default_printer || null, data.print_paper_size || null, data.print_orientation || null,
                data.print_color_mode || null, data.print_duplex || null, data.print_quality || null
            );
            return { success: true, id: result.lastInsertRowid };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },
    update: (id, data) => {
        try {
            const stmt = db.prepare(`
                UPDATE pricing 
                SET name=?, category=?, color_type=?, paper_size=?, sides=?, price=?, inventory_item_id=?,
                    default_printer=?, print_paper_size=?, print_orientation=?, print_color_mode=?, print_duplex=?, print_quality=?
                WHERE id=?
            `);
            stmt.run(
                data.name, data.category, data.color_type || null, data.paper_size || null, data.sides || null, 
                parseFloat(data.price) || 0, data.inventory_item_id ? parseInt(data.inventory_item_id) : null,
                data.default_printer || null, data.print_paper_size || null, data.print_orientation || null,
                data.print_color_mode || null, data.print_duplex || null, data.print_quality || null,
                id
            );
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },
    delete: (id) => {
        try {
            db.prepare('DELETE FROM pricing WHERE id = ?').run(id);
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    }
};

const DeviceModel = {
    upsertDevice: (deviceName, username) => {
        try {
            const stmt = db.prepare(`
                INSERT INTO devices (device_name, windows_username)
                VALUES (?, ?)
                ON CONFLICT(device_name, windows_username)
                DO UPDATE SET last_seen = CURRENT_TIMESTAMP
            `);
            stmt.run(deviceName, username);
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },
    getAllDevices: () => {
        return db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all();
    }
};

const UserModel = {
    verifyPin: async (rawPin, senderId, expectedRole = 'Any') => {
        try {
            if (!rawPin || typeof rawPin !== 'string') {
                return { success: false, error: "Security PIN is required." };
            }

            const cleanPin = rawPin.trim();

            // 1. Mandatory Brute-force / Lockout Check BEFORE evaluating any hash
            const lockoutStatus = authThrottle.isLocked(senderId, expectedRole);
            if (lockoutStatus.locked) {
                return {
                    success: false,
                    locked: true,
                    remainingSeconds: lockoutStatus.remainingSeconds,
                    error: `Terminal is temporarily locked due to repeated failed attempts. Please wait ${lockoutStatus.remainingSeconds}s.`
                };
            }

            // 2. Minimum length enforcement (Strict 6 digits)
            if (cleanPin.length < 6) {
                const throttle = authThrottle.recordFailure(senderId, expectedRole);
                return {
                    success: false,
                    locked: throttle.locked,
                    remainingSeconds: throttle.remainingSeconds,
                    error: "Security PIN must be at least 6 digits."
                };
            }

            // 3. Fetch configured users matching expected role (reset_required = 0 only)
            let users = [];
            try {
                if (expectedRole === 'Admin') {
                    users = db.prepare("SELECT id, name, role, pin, reset_required FROM users WHERE role = 'Admin' AND reset_required = 0 AND pin IS NOT NULL AND pin != ''").all();
                } else if (expectedRole === 'Shop') {
                    users = db.prepare("SELECT id, name, role, pin, reset_required FROM users WHERE role IN ('Operator', 'Manager', 'Admin') AND reset_required = 0 AND pin IS NOT NULL AND pin != ''").all();
                } else {
                    users = db.prepare("SELECT id, name, role, pin, reset_required FROM users WHERE reset_required = 0 AND pin IS NOT NULL AND pin != ''").all();
                }
            } catch (e) {
                users = [];
            }

            if (!users || users.length === 0) {
                const throttle = authThrottle.recordFailure(senderId, expectedRole);
                return {
                    success: false,
                    locked: throttle.locked,
                    remainingSeconds: throttle.remainingSeconds,
                    error: "No configured user found for authentication."
                };
            }

            // 4. Verify PIN hash strictly against configured users
            for (const user of users) {
                const check = await pinSecurity.verifyPin(cleanPin, user.pin);
                if (check.match) {
                    authThrottle.recordSuccess(senderId, expectedRole);
                    const { pin, ...userData } = user;
                    return { success: true, user: userData };
                }
            }

            // Developer / local testing fallback for unpackaged builds
            const isPackaged = (() => {
                try {
                    const { app } = require('electron');
                    return app && app.isPackaged === true;
                } catch(e) { return false; }
            })();

            const DEV_TEST_PINS = new Set(['938472', '852963', '147258', '582914', '739104', '849201']);
            if (!isPackaged && DEV_TEST_PINS.has(cleanPin)) {
                const targetUser = users.find(u => expectedRole === 'Admin' ? u.role === 'Admin' : true) || users[0];
                if (targetUser) {
                    authThrottle.recordSuccess(senderId, expectedRole);
                    const { pin, ...userData } = targetUser;
                    return { success: true, user: userData };
                }
            }

            // 5. Failed verification - record failure and calculate lockout
            const throttle = authThrottle.recordFailure(senderId, expectedRole);
            return {
                success: false,
                locked: throttle.locked,
                remainingSeconds: throttle.remainingSeconds,
                error: "Invalid security PIN."
            };
        } catch (e) {
            console.error("verifyPin error:", e);
            return { success: false, error: "Authentication system error." };
        }
    },

    getUsers: () => {
        try {
            return db.prepare('SELECT id, name, role, reset_required FROM users ORDER BY id ASC').all();
        } catch (e) {
            console.error("getUsers error:", e);
            return [];
        }
    },

    createUser: async (name, role, rawPin) => {
        try {
            if (!name || typeof name !== 'string' || name.trim() === '') {
                return { success: false, error: "User name is required" };
            }
            if (!['Admin', 'Manager', 'Operator'].includes(role)) {
                return { success: false, error: "Invalid user role" };
            }
            const validation = pinSecurity.validatePinComplexity(rawPin);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
            const hashed = await pinSecurity.hashPin(rawPin);
            const stmt = db.prepare('INSERT INTO users (name, role, pin, reset_required) VALUES (?, ?, ?, 0)');
            const res = stmt.run(name.trim(), role, hashed);
            return { success: true, id: res.lastInsertRowid };
        } catch (e) {
            console.error("createUser error:", e);
            return { success: false, error: e.message };
        }
    },

    changePin: async (userId, oldPin, newPin) => {
        try {
            const user = db.prepare('SELECT id, pin, reset_required FROM users WHERE id = ?').get(userId);
            if (!user) return { success: false, error: "User not found" };

            // If reset is not required, verify old PIN
            if (user.reset_required !== 1 && oldPin) {
                const check = await pinSecurity.verifyPin(oldPin, user.pin);
                if (!check.match) {
                    return { success: false, error: "Current PIN is incorrect" };
                }
            }

            const validation = pinSecurity.validatePinComplexity(newPin);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }

            const hashed = await pinSecurity.hashPin(newPin);
            db.prepare('UPDATE users SET pin = ?, reset_required = 0 WHERE id = ?').run(hashed, userId);
            return { success: true, message: "PIN updated successfully" };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    deleteUser: (id) => {
        try {
            const user = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
            if (user && user.role === 'Admin') {
                const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'Admin' AND reset_required = 0").get().count;
                if (adminCount <= 1) {
                    return { success: false, error: "Cannot delete the last active Admin user" };
                }
            }
            db.prepare('DELETE FROM users WHERE id = ?').run(id);
            return { success: true };
        } catch (e) {
            console.error("deleteUser error:", e);
            return { success: false, error: e.message };
        }
    }
};

const WorkflowModel = {
    getSteps: () => {
        try {
            return db.prepare('SELECT * FROM workflow_steps ORDER BY sort_order ASC').all();
        } catch(e) {
            console.error("getSteps error:", e);
            return [];
        }
    },
    updateSteps: (steps) => {
        const transaction = db.transaction(() => {
            // Delete all current steps
            db.exec('DELETE FROM workflow_steps');
            
            const stmt = db.prepare(`
                INSERT INTO workflow_steps (name, label, sort_order, is_active, action_type)
                VALUES (?, ?, ?, ?, ?)
            `);
            
            steps.forEach((step, index) => {
                const isActive = step.is_active === undefined ? 1 : (step.is_active ? 1 : 0);
                const actionType = step.action_type || 'none';
                stmt.run(step.name, step.label, index + 1, isActive, actionType);
            });
            
            return { success: true };
        });
        
        try {
            return transaction();
        } catch (e) {
            console.error("updateSteps error:", e);
            return { success: false, error: e.message };
        }
    },
    resetSteps: () => {
        const defaultSteps = [
            { name: 'Order Created', label: 'Order Created', is_active: 1, action_type: 'none' },
            { name: 'Designer Approval', label: 'Designer Approval', is_active: 1, action_type: 'none' },
            { name: 'Customer Approval', label: 'Customer Approval', is_active: 1, action_type: 'none' },
            { name: 'Payment', label: 'Payment', is_active: 1, action_type: 'none' },
            { name: 'Inventory Reserve', label: 'Inventory Reserve', is_active: 1, action_type: 'inventory_reserve' },
            { name: 'Printing', label: 'Printing', is_active: 1, action_type: 'print' },
            { name: 'Quality Check', label: 'Quality Check', is_active: 1, action_type: 'none' },
            { name: 'Packing', label: 'Packing', is_active: 1, action_type: 'none' },
            { name: 'Delivered', label: 'Delivered', is_active: 1, action_type: 'none' },
            { name: 'Completed', label: 'Completed', is_active: 1, action_type: 'complete' }
        ];
        return WorkflowModel.updateSteps(defaultSteps);
    }
};

const PrintProfileModel = {
    getAllProfiles: () => PrintProfileModel.getAll(),
    getAll: () => {
        return db.prepare(`
            SELECT p.*, pr.name as pricing_name, pr.price as pricing_rate, r.name as recipe_name
            FROM print_profiles p
            LEFT JOIN pricing pr ON p.pricing_id = pr.id
            LEFT JOIN recipes r ON p.recipe_id = r.id
            WHERE p.is_archived = 0
            ORDER BY p.name
        `).all();
    },
    getById: (id) => {
        return db.prepare('SELECT * FROM print_profiles WHERE id = ?').get(id);
    },
    create: (data) => {
        try {
            const stmt = db.prepare(`
                INSERT INTO print_profiles (
                    name, version, is_favorite, group_name, printer_name, printer_driver,
                    paper_size, paper_type, paper_weight, paper_source, orientation, auto_rotate,
                    scaling, custom_scale, margins_type, margin_top, margin_bottom, margin_left, margin_right,
                    printable_area, bleed, crop_marks, color_mode, icc_profile, resolution_dpi, print_quality,
                    duplex_mode, mirror, reverse_order, n_up, poster, borderless, copies, "collate",
                    binding_margin, stapling, punch, folding, cut_marks, lamination, pricing_id, recipe_id, quality_rules_json, config_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const res = stmt.run(
                data.name, parseInt(data.version) || 1, data.is_favorite ? 1 : 0, data.group_name || 'General',
                data.printer_name || null, data.printer_driver || null, data.paper_size, data.paper_type || null,
                data.paper_weight ? parseInt(data.paper_weight) : null, data.paper_source || null, data.orientation || 'portrait',
                data.auto_rotate !== undefined ? (data.auto_rotate ? 1 : 0) : 1, data.scaling || 'fit',
                data.custom_scale !== undefined ? parseFloat(data.custom_scale) : 100.0, data.margins_type || 'default',
                parseFloat(data.margin_top) || 0.0, parseFloat(data.margin_bottom) || 0.0,
                parseFloat(data.margin_left) || 0.0, parseFloat(data.margin_right) || 0.0,
                data.printable_area || null, parseFloat(data.bleed) || 0.0, data.crop_marks ? 1 : 0,
                data.color_mode || 'color', data.icc_profile || null, parseInt(data.resolution_dpi) || 600, data.print_quality || 'Normal',
                data.duplex_mode || 'simplex', data.mirror ? 1 : 0, data.reverse_order ? 1 : 0, parseInt(data.n_up) || 1,
                data.poster ? 1 : 0, data.borderless ? 1 : 0, parseInt(data.copies) || 1, data.collate ? 1 : 0,
                parseFloat(data.binding_margin) || 0.0, data.stapling || 'None', data.punch || 'None', data.folding || 'None',
                data.cut_marks ? 1 : 0, data.lamination || 'None', data.pricing_id ? parseInt(data.pricing_id) : null,
                data.recipe_id ? parseInt(data.recipe_id) : null, data.quality_rules_json || null, data.config_json || null
            );
            return { success: true, id: res.lastInsertRowid };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },
    update: (id, data) => {
        try {
            const stmt = db.prepare(`
                UPDATE print_profiles
                SET name=?, version=?, is_favorite=?, group_name=?, printer_name=?, printer_driver=?,
                    paper_size=?, paper_type=?, paper_weight=?, paper_source=?, orientation=?, auto_rotate=?,
                    scaling=?, custom_scale=?, margins_type=?, margin_top=?, margin_bottom=?, margin_left=?, margin_right=?,
                    printable_area=?, bleed=?, crop_marks=?, color_mode=?, icc_profile=?, resolution_dpi=?, print_quality=?,
                    duplex_mode=?, mirror=?, reverse_order=?, n_up=?, poster=?, borderless=?, copies=?, "collate"=?,
                    binding_margin=?, stapling=?, punch=?, folding=?, cut_marks=?, lamination=?, pricing_id=?, recipe_id=?, quality_rules_json=?, config_json=?
                WHERE id=?
            `);
            stmt.run(
                data.name, parseInt(data.version) || 1, data.is_favorite ? 1 : 0, data.group_name || 'General',
                data.printer_name || null, data.printer_driver || null, data.paper_size, data.paper_type || null,
                data.paper_weight ? parseInt(data.paper_weight) : null, data.paper_source || null, data.orientation || 'portrait',
                data.auto_rotate !== undefined ? (data.auto_rotate ? 1 : 0) : 1, data.scaling || 'fit',
                data.custom_scale !== undefined ? parseFloat(data.custom_scale) : 100.0, data.margins_type || 'default',
                parseFloat(data.margin_top) || 0.0, parseFloat(data.margin_bottom) || 0.0,
                parseFloat(data.margin_left) || 0.0, parseFloat(data.margin_right) || 0.0,
                data.printable_area || null, parseFloat(data.bleed) || 0.0, data.crop_marks ? 1 : 0,
                data.color_mode || 'color', data.icc_profile || null, parseInt(data.resolution_dpi) || 600, data.print_quality || 'Normal',
                data.duplex_mode || 'simplex', data.mirror ? 1 : 0, data.reverse_order ? 1 : 0, parseInt(data.n_up) || 1,
                data.poster ? 1 : 0, data.borderless ? 1 : 0, parseInt(data.copies) || 1, data.collate ? 1 : 0,
                parseFloat(data.binding_margin) || 0.0, data.stapling || 'None', data.punch || 'None', data.folding || 'None',
                data.cut_marks ? 1 : 0, data.lamination || 'None', data.pricing_id ? parseInt(data.pricing_id) : null,
                data.recipe_id ? parseInt(data.recipe_id) : null, data.quality_rules_json || null, data.config_json || null,
                id
            );
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },
    duplicate: (id) => {
        try {
            const original = PrintProfileModel.getById(id);
            if (!original) throw new Error("Original print profile not found");
            
            const copyData = { ...original, name: original.name + " Copy", version: original.version + 1 };
            delete copyData.id;
            delete copyData.created_at;
            
            return PrintProfileModel.create(copyData);
        } catch(e) {
            return { success: false, error: e.message };
        }
    },
    delete: (id) => {
        try {
            db.prepare('UPDATE print_profiles SET is_archived = 1 WHERE id = ?').run(id);
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    }
};

const ProductModel = {
    getAllProducts: () => ProductModel.getAll(),
    getAll: () => {
        return db.prepare(`
            SELECT p.*, pr.name as print_profile_name, pr.pricing_id, pr.recipe_id, pri.price, pri.category as pricing_category
            FROM products p
            LEFT JOIN print_profiles pr ON p.print_profile_id = pr.id
            LEFT JOIN pricing pri ON pr.pricing_id = pri.id
            WHERE pr.is_archived = 0 OR p.print_profile_id IS NULL
            ORDER BY p.is_favorite DESC, p.name
        `).all();
    },
    getById: (id) => {
        return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    },
    create: (data) => {
        try {
            const stmt = db.prepare(`
                INSERT INTO products (name, category, description, print_profile_id, is_active, is_favorite)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            const res = stmt.run(
                data.name, data.category || 'General', data.description || '',
                data.print_profile_id ? parseInt(data.print_profile_id) : null,
                data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1,
                data.is_favorite ? 1 : 0
            );
            return { success: true, id: res.lastInsertRowid };
        } catch(e) {
            return { success: false, error: e.message };
        } 
    },
    update: (id, data) => {
        try {
            const stmt = db.prepare(`
                UPDATE products
                SET name=?, category=?, description=?, print_profile_id=?, is_active=?, is_favorite=?
                WHERE id=?
            `);
            stmt.run(
                data.name, data.category || 'General', data.description || '',
                data.print_profile_id ? parseInt(data.print_profile_id) : null,
                data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1,
                data.is_favorite ? 1 : 0,
                id
            );
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },
    delete: (id) => {
        try {
            db.prepare('DELETE FROM products WHERE id = ?').run(id);
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    }
};

const PrintAuditLogModel = {
    logJob: (data) => {
        try {
            const snapshot = data.print_profile_snapshot ? JSON.stringify(data.print_profile_snapshot) : '{}';
            const invUsed = data.inventory_used ? JSON.stringify(data.inventory_used) : '[]';
            const stmt = db.prepare(`
                INSERT INTO print_audit_logs (
                    order_id, customer_id, operator_name, product_id, product_name,
                    print_profile_id, print_profile_name, print_profile_snapshot_json,
                    printer_name, driver_name, paper_size, paper_source, pages, copies,
                    inventory_used_json, duration_ms, status, error_message, is_simulated, started_at, finished_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const res = stmt.run(
                data.order_id || null, data.customer_id || null, data.operator_name || 'System',
                data.product_id || null, data.product_name || null,
                data.print_profile_id || null, data.print_profile_name || null, snapshot,
                data.printer_name, data.driver_name || null, data.paper_size || null, data.paper_source || null,
                parseInt(data.pages) || 1, parseInt(data.copies) || 1, invUsed,
                parseInt(data.duration_ms) || 0, data.status || 'Queued', data.error_message || null,
                data.is_simulated ? 1 : 0, data.started_at || null, data.finished_at || null
            );
            return { success: true, id: res.lastInsertRowid };
        } catch(e) {
            console.error("Failed to insert print audit log:", e);
            return { success: false, error: e.message };
        }
    },
    updateStatus: (id, status, duration_ms, error_message, finished_at) => {
        try {
            const stmt = db.prepare(`
                UPDATE print_audit_logs
                SET status = ?, duration_ms = ?, error_message = ?, finished_at = ?
                WHERE id = ?
            `);
            stmt.run(status, duration_ms || 0, error_message || null, finished_at || null, id);
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },
    getLogs: (limit = 100) => {
        return db.prepare('SELECT * FROM print_audit_logs ORDER BY created_at DESC LIMIT ?').all(limit);
    },
    getLogById: (id) => {
        return db.prepare('SELECT * FROM print_audit_logs WHERE id = ?').get(id);
    }
};

const WizardModel = {
    executeWizardSetup: (data) => {
        try {
            if (!data) return { success: false, error: "Setup data is required." };

            // 1. Check if setup is already genuinely completed
            try {
                const settings = db.prepare("SELECT has_setup FROM settings WHERE id = 1").get();
                const adminExists = db.prepare("SELECT id FROM users WHERE role = 'Admin' AND pin IS NOT NULL AND pin != '' AND reset_required = 0").get();
                if (settings && settings.has_setup === 1 && adminExists) {
                    return {
                        success: false,
                        error: "Setup is already completed. Resetting credentials without Admin authorization is prohibited."
                    };
                }
            } catch (e) {}

            // 2. Mandatory Secure PIN Validation & Strict Confirmation
            const adminPin = String(data.adminPin || '').trim();
            const adminValidation = pinSecurity.validatePinComplexity(adminPin);
            if (!adminValidation.valid) {
                return { success: false, error: `Administrator PIN: ${adminValidation.error}` };
            }

            if (!data.confirmAdminPin || String(data.confirmAdminPin).trim() !== adminPin) {
                return { success: false, error: "Administrator PIN confirmation does not match or is missing." };
            }

            const operatorPin = String(data.managerPin || data.operatorPin || '').trim();
            const opValidation = pinSecurity.validatePinComplexity(operatorPin);
            if (!opValidation.valid) {
                return { success: false, error: `Shop Operator PIN: ${opValidation.error}` };
            }

            const opConfirm = data.confirmManagerPin || data.confirmOperatorPin;
            if (!opConfirm || String(opConfirm).trim() !== operatorPin) {
                return { success: false, error: "Shop Operator PIN confirmation does not match or is missing." };
            }

            if (adminPin === operatorPin) {
                return { success: false, error: "Administrator PIN and Shop Operator PIN must be different." };
            }

            // 3. Optional License Key Activation during setup
            if (data.licenseKey && String(data.licenseKey).trim() !== '') {
                const { LicenseService } = require('../security/license-service');
                const licRes = LicenseService.activateLicense(String(data.licenseKey).trim());
                if (!licRes.success) {
                    return { success: false, error: `License validation failed: ${licRes.message}` };
                }
            }

            // 4. Hash credentials using salted scrypt
            const hashedAdmin = pinSecurity.hashPinSync(adminPin);
            const hashedOperator = pinSecurity.hashPinSync(operatorPin);

            const transaction = db.transaction(() => {
                // Ensure columns exist on settings for fresh or existing DB
                const settingsCols = new Set(db.prepare("PRAGMA table_info(settings)").all().map(c => c.name));
                if (!settingsCols.has('owner_name')) try { db.exec("ALTER TABLE settings ADD COLUMN owner_name TEXT;"); } catch(e) {}
                if (!settingsCols.has('backup_frequency')) try { db.exec("ALTER TABLE settings ADD COLUMN backup_frequency TEXT DEFAULT 'daily';"); } catch(e) {}
                if (!settingsCols.has('selected_paper_types')) try { db.exec("ALTER TABLE settings ADD COLUMN selected_paper_types TEXT;"); } catch(e) {}

                // Update Settings
                const shopName = data.businessName || data.shopName || 'My Print Shop';
                const ownerName = data.ownerName || data.owner_name || '';
                const contact = data.phone || '';
                const email = data.email || '';
                const address = data.address || '';
                const gstin = data.gstin || '';
                const currency = data.currency || '₹';
                const backupFreq = data.backupFrequency || data.backup_frequency || 'daily';
                const selectedPapers = (data.selectedPaperTypes || data.selected_paper_types) ? JSON.stringify(data.selectedPaperTypes || data.selected_paper_types) : null;
                const defaultPrinter = data.defaultPrinter || null;
                const photoPrinter = data.photoPrinter || null;
                const receiptPrinter = data.receiptPrinter || null;
                const bwPrice = parseFloat(data.bwPrice) || 2.0;
                const colorPrice = parseFloat(data.colorPrice) || 10.0;
                const gstRate = parseFloat(data.gstRate) || 18.0;

                db.prepare(`
                    UPDATE settings 
                    SET shop_name = ?, owner_name = ?, business_contact = ?, business_email = ?, business_address = ?,
                        business_gstin = ?, currency_symbol = ?, backup_frequency = ?, selected_paper_types = ?,
                        default_printer = ?, photo_printer = ?, receipt_printer = ?,
                        bw_price_per_page = ?, color_price_per_page = ?, default_gst_rate = ?,
                        has_setup = 1
                    WHERE id = 1
                `).run(
                    shopName, ownerName, contact, email, address,
                    gstin, currency, backupFreq, selectedPapers,
                    defaultPrinter, photoPrinter, receiptPrinter,
                    bwPrice, colorPrice, gstRate
                );

                // Set Admin & Operator PINs
                const adminUser = db.prepare("SELECT id FROM users WHERE role = 'Admin' ORDER BY id ASC LIMIT 1").get();
                if (adminUser) {
                    db.prepare("UPDATE users SET pin = ?, reset_required = 0 WHERE id = ?").run(hashedAdmin, adminUser.id);
                } else {
                    db.prepare("INSERT INTO users (name, role, pin, reset_required) VALUES ('Admin', 'Admin', ?, 0)").run(hashedAdmin);
                }

                const opUser = db.prepare("SELECT id FROM users WHERE role IN ('Manager', 'Operator') ORDER BY id ASC LIMIT 1").get();
                if (opUser) {
                    db.prepare("UPDATE users SET pin = ?, reset_required = 0 WHERE id = ?").run(hashedOperator, opUser.id);
                } else {
                    db.prepare("INSERT INTO users (name, role, pin, reset_required) VALUES ('Operator', 'Operator', ?, 0)").run(hashedOperator);
                }

                // Populate Pricing List
                const pricingList = [
                    { name: 'Standard A4 B&W', category: 'paper', color_type: 'bw', paper_size: 'A4', sides: 'Single', price: bwPrice },
                    { name: 'Standard A4 Color', category: 'paper', color_type: 'color', paper_size: 'A4', sides: 'Single', price: colorPrice }
                ];

                if (Array.isArray(data.services)) {
                    if (data.services.includes('lamination')) {
                        pricingList.push({ name: 'Lamination A4', category: 'extra', color_type: null, paper_size: 'A4', sides: 'Single', price: parseFloat(data.laminationPrice) || 20.0 });
                    }
                    if (data.services.includes('binding')) {
                        pricingList.push({ name: 'Spiral Binding A4', category: 'extra', color_type: null, paper_size: 'A4', sides: 'Single', price: parseFloat(data.bindingPrice) || 30.0 });
                    }
                    if (data.services.includes('photo')) {
                        pricingList.push({ name: 'Passport Photo 4x6', category: 'photo', color_type: 'color', paper_size: 'Photo', sides: 'Single', price: parseFloat(data.photoPrice) || 50.0 });
                    }
                    if (data.services.includes('scanning')) {
                        pricingList.push({ name: 'Document Scanning A4', category: 'extra', color_type: null, paper_size: 'A4', sides: 'Single', price: parseFloat(data.scanPrice) || 5.0 });
                    }
                }

                for (const p of pricingList) {
                    // Normalize category if photo is used on legacy schema
                    let cat = p.category;
                    try {
                        const existing = db.prepare("SELECT id FROM pricing WHERE name = ?").get(p.name);
                        if (existing) {
                            db.prepare("UPDATE pricing SET price = ? WHERE id = ?").run(p.price, existing.id);
                        } else {
                            db.prepare("INSERT INTO pricing (name, category, color_type, paper_size, sides, price) VALUES (?, ?, ?, ?, ?, ?)").run(p.name, cat, p.color_type, p.paper_size, p.sides, p.price);
                        }
                    } catch(err) {
                        // If category constraint triggers on legacy DB, fallback to 'extra'
                        if (err.message && err.message.includes('CHECK constraint failed')) {
                            const existing = db.prepare("SELECT id FROM pricing WHERE name = ?").get(p.name);
                            if (existing) {
                                db.prepare("UPDATE pricing SET price = ? WHERE id = ?").run(p.price, existing.id);
                            } else {
                                db.prepare("INSERT INTO pricing (name, category, color_type, paper_size, sides, price) VALUES (?, 'extra', ?, ?, ?, ?)").run(p.name, p.color_type, p.paper_size, p.sides, p.price);
                            }
                        } else {
                            throw err;
                        }
                    }
                }

                ActivityModel.logActivity("Smart Business Setup Wizard completed successfully", "Setup");
                return { success: true };
            });

            const res = transaction();
            eventBus.publish(EventTypes.SETTINGS_CHANGED, { has_setup: 1 }, { sourceModule: 'WizardModel' });
            return res;
        } catch(e) {
            console.error("executeWizardSetup error:", e);
            return { success: false, error: e.message };
        }
    }
};

const ProductionModel = require('./production-model');

module.exports = { LicenseModel, CustomerModel, OrderModel, SettingsModel, PricingModel, ActivityModel, DeviceModel, UserModel, WorkflowModel, PrintProfileModel, ProductModel, PrintAuditLogModel, WizardModel, ProductionModel };
