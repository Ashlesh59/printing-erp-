const db = require('./db');

function initDatabase() {
    // Fast Startup Integrity Check
    try {
        const integrity = db.prepare('PRAGMA quick_check(1)').get();
        const integrityOk = integrity && (integrity.quick_check === 'ok' || integrity.integrity_check === 'ok');
        
        if (!integrityOk) {
            console.error("[SCHEMA] Critical: Database integrity check failed on startup!");
            global.isDatabaseCorrupted = true;
            return;
        }
    } catch (err) {
        console.error("[SCHEMA] Failed to execute startup database integrity check:", err);
        global.isDatabaseCorrupted = true;
        return;
    }

    // Database Events Log Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS database_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            username TEXT,
            machine TEXT,
            operation TEXT,
            backup_file TEXT,
            duration_ms INTEGER,
            status TEXT,
            error_message TEXT
        )
    `);

    // Customers Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT UNIQUE NOT NULL,
            email TEXT,
            tag TEXT DEFAULT 'Regular',
            address TEXT,
            company_name TEXT,
            gstin TEXT,
            state TEXT DEFAULT 'Local',
            preferred_print_type TEXT,
            preferred_paper_size TEXT,
            preferred_sides TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Customer helper columns migration check for legacy DBs
    const custMigrations = [
        `ALTER TABLE customers ADD COLUMN email TEXT`,
        `ALTER TABLE customers ADD COLUMN tag TEXT DEFAULT 'Regular'`,
        `ALTER TABLE customers ADD COLUMN address TEXT`,
        `ALTER TABLE customers ADD COLUMN company_name TEXT`,
        `ALTER TABLE customers ADD COLUMN gstin TEXT`,
        `ALTER TABLE customers ADD COLUMN state TEXT DEFAULT 'Local'`,
        `ALTER TABLE customers ADD COLUMN preferred_print_type TEXT`,
        `ALTER TABLE customers ADD COLUMN preferred_paper_size TEXT`,
        `ALTER TABLE customers ADD COLUMN preferred_sides TEXT`,
        `ALTER TABLE customers ADD COLUMN notes TEXT`
    ];
    for (const sql of custMigrations) {
        try { db.exec(sql); } catch(e) {}
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS customer_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            note TEXT NOT NULL,
            author TEXT DEFAULT 'Operator',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS customer_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            order_id INTEGER,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER DEFAULT 0,
            category TEXT DEFAULT 'General',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
        )
    `);

    // Production Jobs Table (Smart Print Queue & Scheduling)
    db.exec(`
        CREATE TABLE IF NOT EXISTS production_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            order_item_id INTEGER,
            customer_id INTEGER,
            job_name TEXT NOT NULL,
            status TEXT DEFAULT 'Waiting',
            priority TEXT DEFAULT 'Normal',
            assigned_printer TEXT,
            assigned_operator TEXT DEFAULT 'Operator',
            paper_size TEXT DEFAULT 'A4',
            color_mode TEXT DEFAULT 'B&W',
            total_pages INTEGER DEFAULT 1,
            copies INTEGER DEFAULT 1,
            estimated_duration_minutes REAL DEFAULT 5,
            scheduled_start DATETIME,
            due_time DATETIME,
            estimated_start DATETIME,
            estimated_completion DATETIME,
            actual_start DATETIME,
            actual_completion DATETIME,
            sort_order INTEGER DEFAULT 0,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
            FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE SET NULL
        )
    `);

    // Orders Table (Unified Invoice Header)
    db.exec(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER,
            total_price REAL DEFAULT 0,
            status TEXT DEFAULT 'Pending',
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers (id)
        )
    `);

    // Order Items Table (Discrete files/print configurations)
    db.exec(`
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            file_name TEXT,
            file_path TEXT,
            print_type TEXT,
            paper_size TEXT,
            sides TEXT,
            pages INTEGER DEFAULT 1,
            copies INTEGER DEFAULT 1,
            price REAL DEFAULT 0,
            notes TEXT,
            paper_id INTEGER,
            extras_json TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
        )
    `);

    // Users Table (Role-based authentication)
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('Admin', 'Manager', 'Operator')),
            pin TEXT NOT NULL,
            pin_hash TEXT,
            pin_salt TEXT,
            pin_algo TEXT,
            reset_required INTEGER DEFAULT 0,
            failed_attempts INTEGER DEFAULT 0,
            locked_until DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Helper columns check for legacy DBs
    const userCols = [
        `ALTER TABLE users ADD COLUMN pin_hash TEXT`,
        `ALTER TABLE users ADD COLUMN pin_salt TEXT`,
        `ALTER TABLE users ADD COLUMN pin_algo TEXT`,
        `ALTER TABLE users ADD COLUMN reset_required INTEGER DEFAULT 0`,
        `ALTER TABLE users ADD COLUMN failed_attempts INTEGER DEFAULT 0`,
        `ALTER TABLE users ADD COLUMN locked_until DATETIME`
    ];
    for (const sql of userCols) {
        try { db.exec(sql); } catch(e) {}
    }

    // Settings Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1), -- Ensure only one row exists
            shop_name TEXT DEFAULT 'My Print Shop',
            default_printer TEXT,
            bw_price_per_page REAL DEFAULT 2.0,
            color_price_per_page REAL DEFAULT 10.0,
            cloud_url TEXT DEFAULT 'http://localhost:8080',
            shop_id TEXT,
            supabase_key TEXT,
            vercel_url TEXT,
            use_system_dialog INTEGER DEFAULT 0,
            bw_cost_per_page REAL DEFAULT 0.5,
            color_cost_per_page REAL DEFAULT 2.0,
            default_gst_rate REAL DEFAULT 18.0,
            enable_gst INTEGER DEFAULT 1,
            receipt_footer_message TEXT DEFAULT 'Thank you for visiting! Please check your prints before leaving.',
            currency_symbol TEXT DEFAULT '₹',
            business_address TEXT DEFAULT '123 Main Street, Sector 4, Printing Hub',
            business_contact TEXT DEFAULT '+91 98765 43210',
            business_email TEXT DEFAULT 'contact@myprintshop.com',
            business_gstin TEXT DEFAULT '',
            has_setup INTEGER DEFAULT 0
        )
    `);

    // Migrations for existing databases — safe to run repeatedly
    const settingsMigrations = [
        `ALTER TABLE settings ADD COLUMN cloud_url TEXT DEFAULT 'http://localhost:8080'`,
        `ALTER TABLE settings ADD COLUMN shop_id TEXT`,
        `ALTER TABLE settings ADD COLUMN supabase_key TEXT`,
        `ALTER TABLE settings ADD COLUMN vercel_url TEXT`,
        `ALTER TABLE settings ADD COLUMN use_system_dialog INTEGER DEFAULT 0`,
        `ALTER TABLE settings ADD COLUMN bw_cost_per_page REAL DEFAULT 0.5`,
        `ALTER TABLE settings ADD COLUMN color_cost_per_page REAL DEFAULT 2.0`,
        `ALTER TABLE settings ADD COLUMN default_gst_rate REAL DEFAULT 18.0`,
        `ALTER TABLE settings ADD COLUMN enable_gst INTEGER DEFAULT 1`,
        `ALTER TABLE settings ADD COLUMN receipt_footer_message TEXT DEFAULT 'Thank you for visiting! Please check your prints before leaving.'`,
        `ALTER TABLE settings ADD COLUMN currency_symbol TEXT DEFAULT '₹'`,
        `ALTER TABLE settings ADD COLUMN business_address TEXT DEFAULT '123 Main Street, Sector 4, Printing Hub'`,
        `ALTER TABLE settings ADD COLUMN business_contact TEXT DEFAULT '+91 98765 43210'`,
        `ALTER TABLE settings ADD COLUMN business_email TEXT DEFAULT 'contact@myprintshop.com'`,
        `ALTER TABLE settings ADD COLUMN business_gstin TEXT DEFAULT ''`,
        `ALTER TABLE settings ADD COLUMN has_setup INTEGER DEFAULT 0`
    ];
    for (const sql of settingsMigrations) {
        try { db.exec(sql); } catch (e) { /* column already exists */ }
    }


    // Insert default settings if empty
    const settingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get();
    if (settingsCount.count === 0) {
        db.prepare('INSERT INTO settings (id) VALUES (1)').run();
    }

    // License Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS license (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            license_key TEXT,
            status TEXT DEFAULT 'UNACTIVATED',
            expires_at DATETIME,
            license_type TEXT,
            meta_json TEXT,
            activated_on DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Helper columns check for legacy DBs
    const licenseCols = [
        `ALTER TABLE license ADD COLUMN status TEXT DEFAULT 'UNACTIVATED'`,
        `ALTER TABLE license ADD COLUMN expires_at DATETIME`,
        `ALTER TABLE license ADD COLUMN license_type TEXT`,
        `ALTER TABLE license ADD COLUMN meta_json TEXT`
    ];
    for (const sql of licenseCols) {
        try { db.exec(sql); } catch(e) {}
    }

    // Pricing Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS pricing (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('paper', 'extra')),
            color_type TEXT,
            paper_size TEXT,
            sides TEXT,
            price REAL NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Activities Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL,
            type TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Devices Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_name TEXT NOT NULL,
            windows_username TEXT NOT NULL,
            activated_on DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(device_name, windows_username)
        )
    `);
    // GST Invoices Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS gst_invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER,
            invoice_number TEXT UNIQUE NOT NULL,
            invoice_date DATE NOT NULL DEFAULT (date('now')),
            subtotal REAL NOT NULL DEFAULT 0,
            cgst_total REAL NOT NULL DEFAULT 0,
            sgst_total REAL NOT NULL DEFAULT 0,
            igst_total REAL NOT NULL DEFAULT 0,
            grand_total REAL NOT NULL DEFAULT 0,
            state_type TEXT DEFAULT 'Local',
            status TEXT DEFAULT 'Paid',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers (id)
        )
    `);

    // GST Invoice Items Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS gst_invoice_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            description TEXT NOT NULL,
            hsn_sac TEXT,
            qty INTEGER NOT NULL DEFAULT 1,
            rate REAL NOT NULL DEFAULT 0,
            gst_rate REAL NOT NULL DEFAULT 0,
            taxable_value REAL NOT NULL DEFAULT 0,
            cgst_amount REAL NOT NULL DEFAULT 0,
            sgst_amount REAL NOT NULL DEFAULT 0,
            igst_amount REAL NOT NULL DEFAULT 0,
            total REAL NOT NULL DEFAULT 0,
            FOREIGN KEY (invoice_id) REFERENCES gst_invoices (id) ON DELETE CASCADE
        )
    `);

    // Customer table migrations for GSTIN and State
    try {
        db.exec(`ALTER TABLE customers ADD COLUMN gstin TEXT`);
    } catch(e) {}
    try {
        db.exec(`ALTER TABLE customers ADD COLUMN state TEXT DEFAULT 'Local'`);
    } catch(e) {}

    // ==========================================
    // INVENTORY MANAGEMENT MODULE TABLES
    // ==========================================

    // 1. Inventory Categories Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            description TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 2. Suppliers Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            email TEXT,
            gstin TEXT,
            address TEXT,
            outstanding_balance REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 3. Inventory Locations Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            description TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 4. Inventory Items Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sku TEXT UNIQUE,
            barcode TEXT UNIQUE,
            name TEXT NOT NULL,
            category_id INTEGER NOT NULL,
            brand TEXT,
            supplier_id INTEGER,
            description TEXT,
            unit TEXT NOT NULL,
            opening_stock REAL NOT NULL DEFAULT 0,
            current_stock REAL NOT NULL DEFAULT 0,
            minimum_stock REAL NOT NULL DEFAULT 0,
            maximum_stock REAL NOT NULL DEFAULT 0,
            reorder_level REAL NOT NULL DEFAULT 0,
            purchase_price REAL NOT NULL DEFAULT 0,
            selling_price REAL NOT NULL DEFAULT 0,
            average_cost REAL NOT NULL DEFAULT 0,
            last_purchase_price REAL DEFAULT 0,
            last_purchase_date DATETIME,
            storage_location_id INTEGER,
            expiry_date DATE,
            image TEXT,
            notes TEXT,
            status TEXT DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
            size TEXT,
            gsm INTEGER,
            finish TEXT,
            color_type TEXT,
            sheets_per_ream INTEGER DEFAULT 500,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES inventory_categories (id),
            FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
            FOREIGN KEY (storage_location_id) REFERENCES inventory_locations (id)
        )
    `);

    // 5. Purchase Orders Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS purchase_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            po_number TEXT UNIQUE NOT NULL,
            supplier_id INTEGER NOT NULL,
            order_date DATE NOT NULL,
            received_date DATE,
            subtotal REAL NOT NULL DEFAULT 0,
            gst_amount REAL NOT NULL DEFAULT 0,
            transport_cost REAL NOT NULL DEFAULT 0,
            discount REAL NOT NULL DEFAULT 0,
            grand_total REAL NOT NULL DEFAULT 0,
            payment_status TEXT NOT NULL DEFAULT 'Unpaid' CHECK (payment_status IN ('Unpaid', 'Partially Paid', 'Paid')),
            status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Ordered', 'Received', 'Cancelled')),
            invoice_number TEXT,
            invoice_file_path TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
        )
    `);

    // 6. Purchase Order Items Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS purchase_order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            po_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            qty REAL NOT NULL,
            cost REAL NOT NULL,
            gst_rate REAL NOT NULL DEFAULT 18,
            total REAL NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (po_id) REFERENCES purchase_orders (id) ON DELETE CASCADE,
            FOREIGN KEY (item_id) REFERENCES inventory_items (id)
        )
    `);

    // 7. Stock Transactions Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS stock_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('purchase', 'return', 'manual_in', 'opening', 'donation', 'order', 'damage', 'waste', 'expired', 'sample', 'manual_out', 'internal')),
            qty REAL NOT NULL,
            cost REAL NOT NULL DEFAULT 0,
            reference_type TEXT,
            reference_id INTEGER,
            reason TEXT,
            operator TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (item_id) REFERENCES inventory_items (id)
        )
    `);

    // 8. Inventory History Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            field_changed TEXT,
            old_value TEXT,
            new_value TEXT,
            reason TEXT,
            operator TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (item_id) REFERENCES inventory_items (id)
        )
    `);

    // 9. Inventory Alerts Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('low_stock', 'out_of_stock')),
            message TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (item_id) REFERENCES inventory_items (id)
        )
    `);

    // 10. Inventory Settings Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            allow_negative_stock INTEGER NOT NULL DEFAULT 0,
            low_stock_threshold_percent REAL NOT NULL DEFAULT 15.0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Seed default settings row if empty
    const invSettingsCount = db.prepare('SELECT COUNT(*) as count FROM inventory_settings').get();
    if (invSettingsCount.count === 0) {
        db.prepare('INSERT INTO inventory_settings (id, allow_negative_stock, low_stock_threshold_percent) VALUES (1, 0, 15.0)').run();
    }

    // Seed default categories if empty
    const defaultCategories = ['Paper', 'Binding', 'Lamination', 'Ink/Toner', 'Packaging', 'Miscellaneous'];
    for (const catName of defaultCategories) {
        try {
            db.prepare('INSERT OR IGNORE INTO inventory_categories (name) VALUES (?)').run(catName);
        } catch (e) {}
    }

    // Seed default location if empty
    db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            description TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    const locCount = db.prepare('SELECT COUNT(*) as count FROM inventory_locations').get();
    if (locCount.count === 0) {
        db.prepare("INSERT INTO inventory_locations (name, description) VALUES ('Main Warehouse', 'Default main stock room')").run();
        db.prepare("INSERT INTO inventory_locations (name, description) VALUES ('Front Desk', 'Counter area supplies')").run();
    }

    // Migrate pricing table to include inventory_item_id
    try {
        db.exec(`ALTER TABLE pricing ADD COLUMN inventory_item_id INTEGER REFERENCES inventory_items(id)`);
    } catch(e) {}

    // Configurable Workflow Engine setup for fresh installations
    try {
        db.exec(`ALTER TABLE orders ADD COLUMN unified_pdf_path TEXT`);
    } catch(e) {}

    db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_steps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            label TEXT NOT NULL,
            sort_order INTEGER NOT NULL,
            is_active INTEGER DEFAULT 1 CHECK (is_active IN (0, 1)),
            action_type TEXT DEFAULT 'none' CHECK (action_type IN ('none', 'inventory_reserve', 'print', 'complete'))
        )
    `);

    // Seed default workflow steps if empty
    const stepCount = db.prepare("SELECT COUNT(*) as count FROM workflow_steps").get().count;
    if (stepCount === 0) {
        const defaultSteps = [
            { name: 'Order Created', label: 'Order Created', sort_order: 1, is_active: 1, action_type: 'none' },
            { name: 'Designer Approval', label: 'Designer Approval', sort_order: 2, is_active: 1, action_type: 'none' },
            { name: 'Customer Approval', label: 'Customer Approval', sort_order: 3, is_active: 1, action_type: 'none' },
            { name: 'Payment', label: 'Payment', sort_order: 4, is_active: 1, action_type: 'none' },
            { name: 'Inventory Reserve', label: 'Inventory Reserve', sort_order: 5, is_active: 1, action_type: 'inventory_reserve' },
            { name: 'Printing', label: 'Printing', sort_order: 6, is_active: 1, action_type: 'print' },
            { name: 'Quality Check', label: 'Quality Check', sort_order: 7, is_active: 1, action_type: 'none' },
            { name: 'Packing', label: 'Packing', sort_order: 8, is_active: 1, action_type: 'none' },
            { name: 'Delivered', label: 'Delivered', sort_order: 9, is_active: 1, action_type: 'none' },
            { name: 'Completed', label: 'Completed', sort_order: 10, is_active: 1, action_type: 'complete' }
        ];

        const stmt = db.prepare(`
            INSERT OR IGNORE INTO workflow_steps (name, label, sort_order, is_active, action_type)
            VALUES (?, ?, ?, ?, ?)
        `);

        for (const step of defaultSteps) {
            stmt.run(step.name, step.label, step.sort_order, step.is_active, step.action_type);
        }
    }

    // Enterprise Module Tables: Products, Print Profiles, Audit Logs, Print Jobs
    db.exec(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT,
            description TEXT,
            base_price REAL DEFAULT 0,
            unit TEXT DEFAULT 'each',
            sku TEXT,
            is_active INTEGER DEFAULT 1,
            config_json TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS print_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            paper_size TEXT DEFAULT 'A4',
            orientation TEXT DEFAULT 'portrait',
            color_mode TEXT DEFAULT 'bw',
            duplex INTEGER DEFAULT 0,
            copies INTEGER DEFAULT 1,
            quality TEXT DEFAULT 'normal',
            margins_json TEXT,
            scaling REAL DEFAULT 1.0,
            config_json TEXT,
            is_default INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS print_audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            file_path TEXT,
            file_name TEXT,
            printer_name TEXT,
            print_profile_id INTEGER,
            product_id INTEGER,
            copies INTEGER DEFAULT 1,
            pages INTEGER DEFAULT 0,
            color_mode TEXT,
            paper_size TEXT,
            status TEXT DEFAULT 'queued',
            print_profile_snapshot_json TEXT,
            error_message TEXT,
            operator TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (print_profile_id) REFERENCES print_profiles(id),
            FOREIGN KEY (product_id) REFERENCES products(id)
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS print_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            file_path TEXT,
            printer_name TEXT,
            status TEXT DEFAULT 'queued',
            copies INTEGER DEFAULT 1,
            pages INTEGER DEFAULT 0,
            error TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            item_id INTEGER,
            qty REAL DEFAULT 0,
            status TEXT DEFAULT 'Active' CHECK (status IN ('Active', 'Fulfilled', 'Released', 'Cancelled')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES orders(id),
            FOREIGN KEY (item_id) REFERENCES inventory_items(id)
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS recipes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            product_id INTEGER,
            is_active INTEGER DEFAULT 1,
            components_json TEXT,
            operator TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id)
        )
    `);

    // Create Performance Indexes for Foreign Keys and Search Columns
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
        CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
        CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
        CREATE INDEX IF NOT EXISTS idx_production_jobs_status ON production_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_production_jobs_scheduled ON production_jobs(scheduled_start);
        CREATE INDEX IF NOT EXISTS idx_gst_invoices_customer_id ON gst_invoices(customer_id);
        CREATE INDEX IF NOT EXISTS idx_stock_transactions_item_id ON stock_transactions(item_id);
        CREATE INDEX IF NOT EXISTS idx_inventory_items_category_id ON inventory_items(category_id);
    `);

    // Execute Enterprise Migration manager
    try {
        const { runMigrations } = require('./migrations');
        runMigrations();
    } catch (err) {
        console.error("Critical database migration failure:", err);
    }

    try {
        seedRichDataset();
    } catch (err) {
        console.error("Failed to seed rich print shop dataset:", err);
    }

    console.log("Database initialized successfully.");
}

function seedRichDataset() {
    // 1. Seed Suppliers
    const supplierCount = db.prepare("SELECT COUNT(*) as count FROM suppliers").get().count;
    if (supplierCount === 0) {
        const suppliers = [
            { name: 'Balaji Paper Distributors', phone: '9876543210', email: 'balaji@paper.com', gstin: '27AAAAA1111A1Z1', address: 'Mumbai, Maharashtra' },
            { name: 'Royal Printing Ink Co', phone: '9876543211', email: 'royal@ink.com', gstin: '27BBBBB2222B2Z2', address: 'Pune, Maharashtra' },
            { name: 'Solo Binding Solutions', phone: '9876543212', email: 'solo@binding.com', gstin: '27CCCCC3333C3Z3', address: 'Nagpur, Maharashtra' }
        ];
        const stmt = db.prepare(`
            INSERT INTO suppliers (name, phone, email, gstin, address, outstanding_balance)
            VALUES (?, ?, ?, ?, ?, 0)
        `);
        for (const s of suppliers) {
            stmt.run(s.name, s.phone, s.email, s.gstin, s.address);
        }
        console.log("Seeded default suppliers.");
    }

    // 2. Seed Inventory Items
    const itemCount = db.prepare("SELECT COUNT(*) as count FROM inventory_items").get().count;
    if (itemCount === 0) {
        const items = [
            { sku: 'JK-A4-75', name: 'JK Copier A4 Paper 75 GSM', category: 'Paper', brand: 'JK Copier', supplier: 'Balaji Paper Distributors', unit: 'Ream', current: 50, min: 5, max: 100, reorder: 10, buy: 250, sell: 350 },
            { sku: 'JK-A4-80', name: 'JK Copier A4 Paper 80 GSM', category: 'Paper', brand: 'JK Copier', supplier: 'Balaji Paper Distributors', unit: 'Ream', current: 30, min: 5, max: 80, reorder: 8, buy: 280, sell: 380 },
            { sku: 'JK-A3-80', name: 'JK Copier A3 Paper 80 GSM', category: 'Paper', brand: 'JK Copier', supplier: 'Balaji Paper Distributors', unit: 'Ream', current: 20, min: 2, max: 40, reorder: 5, buy: 550, sell: 700 },
            { sku: 'KD-A4-120G', name: 'Kodak Glossy Photo Paper A4 120 GSM', category: 'Paper', brand: 'Kodak', supplier: 'Balaji Paper Distributors', unit: 'Pack', current: 15, min: 2, max: 30, reorder: 4, buy: 150, sell: 250 },
            { sku: 'SOL-SP-10', name: 'Solo Spiral Binding Coils 10mm', category: 'Binding', brand: 'Solo', supplier: 'Solo Binding Solutions', unit: 'Pack', current: 10, min: 1, max: 20, reorder: 2, buy: 200, sell: 300 },
            { sku: 'GBC-LAM-A4', name: 'GBC Lamination Pouches A4', category: 'Lamination', brand: 'GBC', supplier: 'Solo Binding Solutions', unit: 'Pack', current: 12, min: 1, max: 25, reorder: 3, buy: 500, sell: 700 },
            { sku: 'HP-88A-BLK', name: 'HP LaserJet 88A Black Toner', category: 'Ink/Toner', brand: 'HP', supplier: 'Royal Printing Ink Co', unit: 'Piece', current: 5, min: 1, max: 10, reorder: 2, buy: 4500, sell: 5500 },
            { sku: 'CAN-GI790-C', name: 'Canon GI-790 Cyan Ink Bottle', category: 'Ink/Toner', brand: 'Canon', supplier: 'Royal Printing Ink Co', unit: 'Piece', current: 8, min: 1, max: 15, reorder: 2, buy: 650, sell: 800 },
            { sku: 'CAN-GI790-M', name: 'Canon GI-790 Magenta Ink Bottle', category: 'Ink/Toner', brand: 'Canon', supplier: 'Royal Printing Ink Co', unit: 'Piece', current: 8, min: 1, max: 15, reorder: 2, buy: 650, sell: 800 },
            { sku: 'CAN-GI790-Y', name: 'Canon GI-790 Yellow Ink Bottle', category: 'Ink/Toner', brand: 'Canon', supplier: 'Royal Printing Ink Co', unit: 'Piece', current: 8, min: 1, max: 15, reorder: 2, buy: 650, sell: 800 },
            { sku: 'CAN-GI790-K', name: 'Canon GI-790 Black Ink Bottle', category: 'Ink/Toner', brand: 'Canon', supplier: 'Royal Printing Ink Co', unit: 'Piece', current: 12, min: 2, max: 20, reorder: 4, buy: 700, sell: 900 }
        ];

        const getCatId = db.prepare("SELECT id FROM inventory_categories WHERE name = ?");
        const getSupId = db.prepare("SELECT id FROM suppliers WHERE name = ?");
        
        const stmtItem = db.prepare(`
            INSERT INTO inventory_items (sku, name, category_id, brand, supplier_id, unit, opening_stock, current_stock, minimum_stock, maximum_stock, reorder_level, purchase_price, selling_price, storage_location_id, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'Active')
        `);

        for (const item of items) {
            const catRow = getCatId.get(item.category);
            const supRow = getSupId.get(item.supplier);
            const catId = catRow ? catRow.id : 1;
            const supId = supRow ? supRow.id : null;
            
            stmtItem.run(item.sku, item.name, catId, item.brand, supId, item.unit, item.current, item.current, item.min, item.max, item.reorder, item.buy, item.sell);
        }

        // Initialize location stock (table may not exist in all schema versions)
        try {
            db.exec(`
                INSERT OR IGNORE INTO inventory_location_stock (item_id, location_id, current_stock, reserved_stock)
                SELECT id, 1, current_stock, 0 FROM inventory_items
            `);
        } catch (e) {
            // inventory_location_stock table not yet created — skip safely
        }

        console.log("Seeded default inventory items.");
    }

    // 3. Seed Pricing Items
    const pricingCount = db.prepare("SELECT COUNT(*) as count FROM pricing").get().count;
    if (pricingCount === 0) {
        const pricingList = [
            { name: 'Standard A4 B&W', category: 'paper', color_type: 'bw', paper_size: 'A4', sides: 'Single', price: 2.0 },
            { name: 'Standard A4 B&W Duplex', category: 'paper', color_type: 'bw', paper_size: 'A4', sides: 'Double', price: 3.5 },
            { name: 'Standard A4 Color', category: 'paper', color_type: 'color', paper_size: 'A4', sides: 'Single', price: 10.0 },
            { name: 'Standard A4 Color Duplex', category: 'paper', color_type: 'color', paper_size: 'A4', sides: 'Double', price: 18.0 },
            { name: 'Standard A3 B&W', category: 'paper', color_type: 'bw', paper_size: 'A3', sides: 'Single', price: 5.0 },
            { name: 'Standard A3 Color', category: 'paper', color_type: 'color', paper_size: 'A3', sides: 'Single', price: 20.0 },
            { name: 'Spiral Binding A4', category: 'extra', color_type: null, paper_size: 'A4', sides: 'Single', price: 30.0 },
            { name: 'Hard Binding A4', category: 'extra', color_type: null, paper_size: 'A4', sides: 'Single', price: 150.0 },
            { name: 'Lamination A4', category: 'extra', color_type: null, paper_size: 'A4', sides: 'Single', price: 20.0 }
        ];

        const stmtPricing = db.prepare(`
            INSERT INTO pricing (name, category, color_type, paper_size, sides, price)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        for (const p of pricingList) {
            stmtPricing.run(p.name, p.category, p.color_type, p.paper_size, p.sides, p.price);
        }

        // Link pricing to inventory items
        db.exec(`
            UPDATE pricing SET inventory_item_id = (SELECT id FROM inventory_items WHERE sku = 'JK-A4-75' LIMIT 1) WHERE name LIKE 'Standard A4 B&W%';
            UPDATE pricing SET inventory_item_id = (SELECT id FROM inventory_items WHERE sku = 'JK-A4-80' LIMIT 1) WHERE name LIKE 'Standard A4 Color%';
            UPDATE pricing SET inventory_item_id = (SELECT id FROM inventory_items WHERE sku = 'JK-A3-80' LIMIT 1) WHERE name LIKE 'Standard A3 B&W%';
            UPDATE pricing SET inventory_item_id = (SELECT id FROM inventory_items WHERE sku = 'SOL-SP-10' LIMIT 1) WHERE name LIKE 'Spiral Binding%';
            UPDATE pricing SET inventory_item_id = (SELECT id FROM inventory_items WHERE sku = 'GBC-LAM-A4' LIMIT 1) WHERE name LIKE 'Lamination%';
        `);

        console.log("Seeded default pricing list and linked to inventory items.");
    }
}

module.exports = { initDatabase };
