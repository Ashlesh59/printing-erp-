const db = require('./db');

function runMigrations() {
    // Check if safety backup is needed before executing migrations
    let migrationsTableExists = false;
    try {
        const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='db_migrations'").get();
        if (row) migrationsTableExists = true;
    } catch (e) {}

    let pendingMigrations = false;
    if (!migrationsTableExists) {
        pendingMigrations = true;
    } else {
        try {
            const applied = db.prepare('SELECT version FROM db_migrations').all().map(r => r.version);
            const totalMigrations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
            pendingMigrations = totalMigrations.some(v => !applied.includes(v));
        } catch (e) {
            pendingMigrations = true;
        }
    }

    if (pendingMigrations) {
        console.log("[Migrations] Pending database migrations detected. Creating safety backup...");
        try {
            const backupService = require('./services/backup-service');
            backupService.performBackupSync('migration');
            console.log("[Migrations] Safety backup completed successfully.");
        } catch (err) {
            console.error("[Migrations] Safety backup failed before running migrations:", err);
        }
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS db_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            migrated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const runMigration = (version, name, sqlFunc) => {
        const row = db.prepare('SELECT version FROM db_migrations WHERE version = ?').get(version);
        if (row) return; // already run

        console.log(`Running database migration ${version}: ${name}...`);
        const transaction = db.transaction(() => {
            sqlFunc();
            db.prepare('INSERT INTO db_migrations (version, name) VALUES (?, ?)').run(version, name);
        });
        
        try {
            transaction();
            console.log(`Migration ${version} completed successfully!`);
        } catch (e) {
            console.error(`Migration ${version} failed! Rolling back. Error:`, e);
            throw e;
        }
    };

    // Migration 1: Base systems (Placeholder to align version counter if needed)
    runMigration(1, 'Initial Schema setup', () => {
        // base table setups are handled by legacy schema.js
    });

    // Migration 2: Existing low stock alerts setup
    runMigration(2, 'Initialize default categories and settings', () => {
        // legacy setup
    });

    // Migration 3: Enterprise Inventory Module Upgrade
    runMigration(3, 'Enterprise ERP Inventory Engine Schema Upgrade', () => {
        // 1. Alter tables to add new columns
        try {
            db.exec(`ALTER TABLE inventory_items ADD COLUMN reserved_stock REAL DEFAULT 0`);
        } catch(e) { /* Column might exist */ }

        try {
            db.exec(`ALTER TABLE inventory_locations ADD COLUMN parent_id INTEGER REFERENCES inventory_locations(id) ON DELETE CASCADE`);
            db.exec(`ALTER TABLE inventory_locations ADD COLUMN type TEXT DEFAULT 'Warehouse' CHECK (type IN ('Warehouse', 'Section', 'Shelf', 'Bin'))`);
        } catch(e) { /* Column might exist */ }

        // 2. Re-create inventory_items to relax the CHECK constraint for Soft Delete (Active, Archived, Deleted)
        // Check if we need to migrate inventory_items check constraint
        try {
            db.exec(`
                CREATE TABLE IF NOT EXISTS temp_inventory_items AS SELECT * FROM inventory_items;
                DROP TABLE inventory_items;
                CREATE TABLE inventory_items (
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
                    reserved_stock REAL NOT NULL DEFAULT 0,
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
                    status TEXT DEFAULT 'Active' CHECK (status IN ('Active', 'Archived', 'Deleted', 'Inactive')),
                    size TEXT,
                    gsm INTEGER,
                    finish TEXT,
                    color_type TEXT,
                    sheets_per_ream INTEGER DEFAULT 500,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (category_id) REFERENCES inventory_categories (id),
                    FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
                    FOREIGN KEY (storage_location_id) REFERENCES inventory_locations (id)
                );
                
                -- Restore data
                INSERT OR IGNORE INTO inventory_items (
                    id, sku, barcode, name, category_id, brand, supplier_id, description, unit,
                    opening_stock, current_stock, minimum_stock, maximum_stock, reorder_level,
                    purchase_price, selling_price, average_cost, last_purchase_price, storage_location_id,
                    expiry_date, notes, status, size, gsm, finish, color_type, sheets_per_ream, created_at
                ) SELECT 
                    id, sku, barcode, name, category_id, brand, supplier_id, description, unit,
                    opening_stock, current_stock, minimum_stock, maximum_stock, reorder_level,
                    purchase_price, selling_price, average_cost, last_purchase_price, storage_location_id,
                    expiry_date, notes, status, size, gsm, finish, color_type, sheets_per_ream, created_at 
                FROM temp_inventory_items;

                DROP TABLE temp_inventory_items;
            `);
        } catch (e) {
            console.error("Warning: inventory_items table check constraint migration error:", e);
        }

        // 3. Recipes Engine Tables
        db.exec(`
            CREATE TABLE IF NOT EXISTS recipes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                pricing_id INTEGER NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Archived', 'Deleted')),
                description TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (pricing_id) REFERENCES pricing (id) ON DELETE CASCADE
            )
        `);

        db.exec(`
            CREATE TABLE IF NOT EXISTS recipe_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recipe_id INTEGER NOT NULL,
                inventory_item_id INTEGER NOT NULL,
                formula TEXT NOT NULL DEFAULT 'copies',
                quantity REAL NOT NULL DEFAULT 1.0,
                optional INTEGER DEFAULT 0 CHECK (optional IN (0, 1)),
                sort_order INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (recipe_id) REFERENCES recipes (id) ON DELETE CASCADE,
                FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id) ON DELETE CASCADE,
                UNIQUE(recipe_id, inventory_item_id)
            )
        `);

        // 4. Multi-location stock levels
        db.exec(`
            CREATE TABLE IF NOT EXISTS inventory_location_stock (
                item_id INTEGER NOT NULL,
                location_id INTEGER NOT NULL,
                current_stock REAL NOT NULL DEFAULT 0,
                reserved_stock REAL NOT NULL DEFAULT 0,
                PRIMARY KEY (item_id, location_id),
                FOREIGN KEY (item_id) REFERENCES inventory_items (id) ON DELETE CASCADE,
                FOREIGN KEY (location_id) REFERENCES inventory_locations (id) ON DELETE CASCADE
            )
        `);

        // Sync existing items to main location stock
        try {
            db.exec(`
                INSERT OR IGNORE INTO inventory_location_stock (item_id, location_id, current_stock, reserved_stock)
                SELECT id, IFNULL(storage_location_id, 1), current_stock, reserved_stock
                FROM inventory_items
            `);
        } catch(e) {
            console.error("Stock location synchronization warning:", e);
        }

        // 5. Inventory Reservations
        db.exec(`
            CREATE TABLE IF NOT EXISTS inventory_reservations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                location_id INTEGER NOT NULL,
                qty_reserved REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Fulfilled', 'Released')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES inventory_items (id) ON DELETE CASCADE,
                FOREIGN KEY (location_id) REFERENCES inventory_locations (id) ON DELETE CASCADE
            )
        `);

        // 6. Warehouse Transfers
        db.exec(`
            CREATE TABLE IF NOT EXISTS warehouse_transfers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL,
                from_location_id INTEGER NOT NULL,
                to_location_id INTEGER NOT NULL,
                qty REAL NOT NULL,
                operator TEXT,
                reason TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (item_id) REFERENCES inventory_items (id) ON DELETE CASCADE,
                FOREIGN KEY (from_location_id) REFERENCES inventory_locations (id) ON DELETE CASCADE,
                FOREIGN KEY (to_location_id) REFERENCES inventory_locations (id) ON DELETE CASCADE
            )
        `);

        // 7. Physical Stock Count (Stocktakes)
        db.exec(`
            CREATE TABLE IF NOT EXISTS physical_stock_counts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL,
                location_id INTEGER NOT NULL,
                system_stock REAL NOT NULL,
                actual_count REAL NOT NULL,
                difference REAL NOT NULL,
                operator TEXT,
                reason TEXT,
                status TEXT DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (item_id) REFERENCES inventory_items (id) ON DELETE CASCADE,
                FOREIGN KEY (location_id) REFERENCES inventory_locations (id) ON DELETE CASCADE
            )
        `);

        // 8. Batch Tracking
        db.exec(`
            CREATE TABLE IF NOT EXISTS inventory_batches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL,
                batch_number TEXT NOT NULL,
                supplier_batch TEXT,
                qty_received REAL NOT NULL,
                qty_remaining REAL NOT NULL,
                manufacturing_date DATE,
                expiry_date DATE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (item_id) REFERENCES inventory_items (id) ON DELETE CASCADE
            )
        `);

        // 9. Unit Conversions
        db.exec(`
            CREATE TABLE IF NOT EXISTS unit_conversions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL,
                from_unit TEXT NOT NULL,
                to_unit TEXT NOT NULL,
                factor REAL NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (item_id) REFERENCES inventory_items (id) ON DELETE CASCADE,
                UNIQUE(item_id, from_unit, to_unit)
            )
        `);

        // 10. Purchase Returns
        db.exec(`
            CREATE TABLE IF NOT EXISTS purchase_returns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                po_id INTEGER,
                supplier_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                qty_returned REAL NOT NULL,
                refund_amount REAL NOT NULL DEFAULT 0,
                operator TEXT,
                reason TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (po_id) REFERENCES purchase_orders (id) ON DELETE SET NULL,
                FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES inventory_items (id) ON DELETE CASCADE
            )
        `);

        // 11. Central Notification Center
        db.exec(`
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL CHECK (type IN ('low_stock', 'critical_stock', 'po_pending', 'supplier_due', 'system_warning', 'inventory_error')),
                message TEXT NOT NULL,
                reference_id INTEGER,
                status TEXT DEFAULT 'Unread' CHECK (status IN ('Unread', 'Read', 'Dismissed')),
                priority TEXT DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High', 'Critical')),
                expiry_date DATE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 12. Printer Material Metrics
        db.exec(`
            CREATE TABLE IF NOT EXISTS printer_material_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                printer_name TEXT NOT NULL UNIQUE,
                paper_consumed INTEGER DEFAULT 0,
                toner_est_usage_percent REAL DEFAULT 0.0,
                maintenance_counter INTEGER DEFAULT 0,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 13. Immutable Event Sourcing Logs
        db.exec(`
            CREATE TABLE IF NOT EXISTS inventory_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                aggregate_id TEXT NOT NULL,
                event_data TEXT NOT NULL,
                operator TEXT,
                operator_role TEXT,
                device TEXT,
                reason TEXT,
                ip TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 14. Performance Indexes & Composite Indexes
        try {
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_stock_location ON inventory_location_stock(item_id, location_id);
                CREATE INDEX IF NOT EXISTS idx_reservations_order ON inventory_reservations(order_id);
                CREATE INDEX IF NOT EXISTS idx_events_type ON inventory_events(event_type);
                CREATE INDEX IF NOT EXISTS idx_batches_item ON inventory_batches(item_id);
            `);
            try { db.exec(`CREATE INDEX IF NOT EXISTS idx_recipes_pricing ON recipes(pricing_id);`); } catch(e) {}
            try { db.exec(`CREATE INDEX IF NOT EXISTS idx_recipe_items_recipe ON recipe_items(recipe_id);`); } catch(e) {}
        } catch(e) {
            console.warn('[Migration 3] Index warning:', e.message);
        }
    });

    // Migration 4: Enterprise Print Engine Schema Upgrade
    runMigration(4, 'Enterprise Print Engine Upgrade', () => {
        // 1. Add printer assignments to settings table
        const settingsColumns = [
            'photo_printer TEXT',
            'receipt_printer TEXT',
            'label_printer TEXT',
            'barcode_printer TEXT',
            'silent_print_enabled INTEGER DEFAULT 0'
        ];
        
        for (const col of settingsColumns) {
            try {
                db.exec(`ALTER TABLE settings ADD COLUMN ${col}`);
            } catch(e) {
                // Column already exists
            }
        }

        // 2. Create print_jobs table
        db.exec(`
            CREATE TABLE IF NOT EXISTS print_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER,
                printer_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                pages INTEGER DEFAULT 1,
                copies INTEGER DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued', 'Preparing', 'Rendering', 'Submitting', 'Submitted', 'Confirmed Printed', 'Failed', 'Cancelled', 'Uncertain')),
                retry_count INTEGER DEFAULT 0,
                error_message TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                finished_at DATETIME
            )
        `);
    });

    // Migration 5: Enterprise Print Engine V2 Capabilities
    runMigration(5, 'Enterprise Print Engine V2 Capabilities', () => {
        // 1. Add print_simulator_enabled to settings table
        try {
            db.exec("ALTER TABLE settings ADD COLUMN print_simulator_enabled INTEGER DEFAULT 0");
        } catch(e) {}

        // 2. Add default printer configurations to pricing table
        const pricingColumns = [
            'default_printer TEXT',
            'print_paper_size TEXT',
            'print_orientation TEXT',
            'print_color_mode TEXT',
            'print_duplex TEXT',
            'print_quality TEXT'
        ];
        for (const col of pricingColumns) {
            try {
                db.exec(`ALTER TABLE pricing ADD COLUMN ${col}`);
            } catch(e) {}
        }

        // 3. Add telemetry columns to print_jobs table
        const jobColumns = [
            'customer_id INTEGER',
            'paper_size TEXT',
            'color_mode TEXT',
            'duplex TEXT',
            'duration_ms INTEGER',
            'is_simulated INTEGER DEFAULT 0',
            'started_at DATETIME'
        ];
        for (const col of jobColumns) {
            try {
                db.exec(`ALTER TABLE print_jobs ADD COLUMN ${col}`);
            } catch(e) {}
        }
    });

    // Migration 6: Document Production Engine — Phase 2A
    runMigration(6, 'Document Production Engine Schema', () => {
        // 1. Document Projects
        db.exec(`
            CREATE TABLE IF NOT EXISTS doc_projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL DEFAULT 'Untitled Project',
                status TEXT DEFAULT 'Active' CHECK (status IN ('Active', 'Archived', 'Deleted')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. Per-project source files (non-destructive — original_path never modified)
        db.exec(`
            CREATE TABLE IF NOT EXISTS doc_project_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                original_path TEXT NOT NULL,
                file_name TEXT NOT NULL,
                file_type TEXT NOT NULL CHECK (file_type IN ('pdf', 'image')),
                sort_order INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES doc_projects(id) ON DELETE CASCADE
            )
        `);

        // 3. Non-destructive edit transforms (JSON-encoded, layered)
        db.exec(`
            CREATE TABLE IF NOT EXISTS doc_file_edits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL,
                edit_type TEXT NOT NULL,
                params_json TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (file_id) REFERENCES doc_project_files(id) ON DELETE CASCADE
            )
        `);

        // 4. Named presets (layout, print profiles, watermarks, stamps)
        db.exec(`
            CREATE TABLE IF NOT EXISTS doc_presets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                preset_type TEXT NOT NULL CHECK (preset_type IN ('layout', 'print_profile', 'photo', 'watermark', 'stamp')),
                config_json TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 5. Session crash recovery state (overwritten on each autosave)
        db.exec(`
            CREATE TABLE IF NOT EXISTS doc_session_state (
                project_id INTEGER PRIMARY KEY,
                state_json TEXT NOT NULL,
                saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES doc_projects(id) ON DELETE CASCADE
            )
        `);

        // 6. Plugin registry (for future OCR, AI, batch plugins)
        db.exec(`
            CREATE TABLE IF NOT EXISTS doc_plugins (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                version TEXT NOT NULL DEFAULT '1.0.0',
                enabled INTEGER DEFAULT 1,
                config_json TEXT,
                installed_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 7. Performance indexes
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_doc_project_files_project ON doc_project_files(project_id);
            CREATE INDEX IF NOT EXISTS idx_doc_file_edits_file ON doc_file_edits(file_id);
            CREATE INDEX IF NOT EXISTS idx_doc_presets_type ON doc_presets(preset_type);
        `);

        // 8. New settings columns for Document Studio
        const docSettingsCols = [
            "doc_studio_output_dir TEXT DEFAULT 'C:\\\\PrintShopManager\\\\DocumentStudio'",
            'doc_autosave_enabled INTEGER DEFAULT 1',
            'doc_autosave_interval_sec INTEGER DEFAULT 30'
        ];
        for (const col of docSettingsCols) {
            try { db.exec(`ALTER TABLE settings ADD COLUMN ${col}`); } catch(e) {}
        }
    });

    // Migration 7: Multi-item Orders and Users PIN security
    runMigration(7, 'Multi-item Orders and PIN Access Security', () => {
        // 1. Create users table
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('Admin', 'Manager', 'Operator')),
                pin TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Users are provisioned securely through the Setup Wizard with validated scrypt hashes

        // 2. Create order_items table
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

        // 3. Migrate data from orders to order_items & recreate orders table
        let tableInfo;
        try {
            tableInfo = db.prepare("PRAGMA table_info(orders)").all();
        } catch (e) {
            tableInfo = [];
        }

        const hasFileName = tableInfo.some(col => col.name === 'file_name');
        if (hasFileName) {
            console.log("[Migration 7] Legacy orders table structure detected. Migrating to multi-item structure...");

            // Fetch old orders data
            const oldOrders = db.prepare(`
                SELECT id, customer_id, file_name, file_path, print_type, paper_size, sides, pages, copies, price, notes, status, created_at 
                FROM orders
            `).all();

            // Drop old orders table
            db.exec("DROP TABLE orders");

            // Create new orders table
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

            // Migrate data
            const stmtOrder = db.prepare(`
                INSERT INTO orders (id, customer_id, total_price, status, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `);

            const stmtOrderItem = db.prepare(`
                INSERT INTO order_items (order_id, file_name, file_path, print_type, paper_size, sides, pages, copies, price, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const old of oldOrders) {
                stmtOrder.run(old.id, old.customer_id, old.price, old.status || 'Completed', old.notes || null, old.created_at);
                stmtOrderItem.run(old.id, old.file_name, old.file_path, old.print_type, old.paper_size, old.sides, old.pages, old.copies, old.price, old.notes, old.created_at);
            }

            console.log(`[Migration 7] Successfully migrated ${oldOrders.length} orders to multi-item schema.`);
        } else {
            const hasTotalPrice = tableInfo.some(col => col.name === 'total_price');
            if (!hasTotalPrice && tableInfo.length > 0) {
                db.exec("ALTER TABLE orders ADD COLUMN total_price REAL DEFAULT 0");
            }
        }
    });

    // Migration 8: Event History Sourcing Logs
    runMigration(8, 'Event History table setup', () => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS event_history (
                id TEXT PRIMARY KEY,
                event_name TEXT NOT NULL,
                timestamp DATETIME NOT NULL,
                source_module TEXT NOT NULL,
                user_id TEXT,
                device_id TEXT,
                version TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_event_history_name ON event_history(event_name);
        `);
    });

    // Migration 9: Configurable Workflow Engine
    runMigration(9, 'Workflow Engine Configurable Steps', () => {
        // 1. Alter orders table to add unified_pdf_path
        try {
            db.exec(`ALTER TABLE orders ADD COLUMN unified_pdf_path TEXT`);
        } catch(e) {
            // Column might exist
        }

        // 2. Create workflow_steps table
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

        // 3. Seed default workflow steps
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
    });

    // Migration 10: Enterprise Print Profile Engine
    runMigration(10, 'Enterprise Print Profile Engine', () => {
        // 1. Create print_profiles table
        db.exec(`
            CREATE TABLE IF NOT EXISTS print_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                is_archived INTEGER NOT NULL DEFAULT 0,
                is_favorite INTEGER NOT NULL DEFAULT 0,
                group_name TEXT DEFAULT 'General',
                printer_name TEXT,
                printer_driver TEXT,
                paper_size TEXT NOT NULL,
                paper_type TEXT,
                paper_weight INTEGER,
                paper_source TEXT,
                orientation TEXT DEFAULT 'portrait',
                auto_rotate INTEGER DEFAULT 1,
                scaling TEXT DEFAULT 'fit',
                custom_scale REAL DEFAULT 100.0,
                margins_type TEXT DEFAULT 'default',
                margin_top REAL DEFAULT 0.0,
                margin_bottom REAL DEFAULT 0.0,
                margin_left REAL DEFAULT 0.0,
                margin_right REAL DEFAULT 0.0,
                printable_area TEXT,
                bleed REAL DEFAULT 0.0,
                crop_marks INTEGER DEFAULT 0,
                color_mode TEXT DEFAULT 'color',
                icc_profile TEXT,
                resolution_dpi INTEGER DEFAULT 600,
                print_quality TEXT DEFAULT 'Normal',
                duplex_mode TEXT DEFAULT 'simplex',
                mirror INTEGER DEFAULT 0,
                reverse_order INTEGER DEFAULT 0,
                n_up INTEGER DEFAULT 1,
                poster INTEGER DEFAULT 0,
                borderless INTEGER DEFAULT 0,
                copies INTEGER DEFAULT 1,
                "collate" INTEGER DEFAULT 1,
                binding_margin REAL DEFAULT 0.0,
                stapling TEXT DEFAULT 'None',
                punch TEXT DEFAULT 'None',
                folding TEXT DEFAULT 'None',
                cut_marks INTEGER DEFAULT 0,
                lamination TEXT DEFAULT 'None',
                pricing_id INTEGER,
                recipe_id INTEGER,
                quality_rules_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (pricing_id) REFERENCES pricing(id) ON DELETE SET NULL,
                FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL
            )
        `);

        // 2. Create products table
        db.exec(`
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                category TEXT,
                description TEXT,
                print_profile_id INTEGER,
                is_active INTEGER NOT NULL DEFAULT 1,
                is_favorite INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (print_profile_id) REFERENCES print_profiles(id) ON DELETE SET NULL
            )
        `);

        // 3. Create device_capabilities table
        db.exec(`
            CREATE TABLE IF NOT EXISTS device_capabilities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_name TEXT UNIQUE NOT NULL,
                display_name TEXT NOT NULL,
                driver_name TEXT,
                port_name TEXT,
                is_default INTEGER DEFAULT 0,
                can_duplex INTEGER DEFAULT 0,
                can_color INTEGER DEFAULT 0,
                paper_sizes_json TEXT,
                paper_sources_json TEXT,
                resolutions_json TEXT,
                status TEXT DEFAULT 'Online',
                last_scanned DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 4. Create printer_groups and printer_group_members tables
        db.exec(`
            CREATE TABLE IF NOT EXISTS printer_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                description TEXT
            )
        `);
        db.exec(`
            CREATE TABLE IF NOT EXISTS printer_group_members (
                group_id INTEGER,
                printer_name TEXT,
                PRIMARY KEY (group_id, printer_name),
                FOREIGN KEY (group_id) REFERENCES printer_groups(id) ON DELETE CASCADE,
                FOREIGN KEY (printer_name) REFERENCES device_capabilities(device_name) ON DELETE CASCADE
            )
        `);

        // 5. Create calibration_profiles table
        db.exec(`
            CREATE TABLE IF NOT EXISTS calibration_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                printer_name TEXT UNIQUE NOT NULL,
                offset_x REAL DEFAULT 0.0,
                offset_y REAL DEFAULT 0.0,
                scale_x REAL DEFAULT 1.0,
                scale_y REAL DEFAULT 1.0,
                margin_compensation REAL DEFAULT 0.0,
                paper_feed_offset REAL DEFAULT 0.0,
                calibration_test_results TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (printer_name) REFERENCES device_capabilities(device_name) ON DELETE CASCADE
            )
        `);

        // 6. Create print_audit_logs table
        db.exec(`
            CREATE TABLE IF NOT EXISTS print_audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER,
                customer_id INTEGER,
                operator_name TEXT,
                product_id INTEGER,
                product_name TEXT,
                print_profile_id INTEGER,
                print_profile_name TEXT,
                print_profile_snapshot_json TEXT NOT NULL,
                printer_name TEXT NOT NULL,
                driver_name TEXT,
                paper_size TEXT,
                paper_source TEXT,
                pages INTEGER DEFAULT 1,
                copies INTEGER DEFAULT 1,
                inventory_used_json TEXT,
                duration_ms INTEGER,
                status TEXT NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued', 'Preparing', 'Printing', 'Submitted', 'Confirmed Printed', 'Completed', 'Cancelled', 'Failed', 'Uncertain')),
                error_message TEXT,
                is_simulated INTEGER DEFAULT 0,
                started_at DATETIME,
                finished_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
                FOREIGN KEY (print_profile_id) REFERENCES print_profiles(id) ON DELETE SET NULL
            )
        `);

        // 7. Add product_id and print_profile_id columns to order_items table
        try {
            db.exec("ALTER TABLE order_items ADD COLUMN product_id INTEGER REFERENCES products(id) ON DELETE SET NULL");
        } catch(e) {}
        try {
            db.exec("ALTER TABLE order_items ADD COLUMN print_profile_id INTEGER REFERENCES print_profiles(id) ON DELETE SET NULL");
        } catch(e) {}

        // 8. Seed default profiles and products matching the existing base pricing data
        try {
            const paperPricing = db.prepare("SELECT * FROM pricing WHERE category = 'paper'").all();
            for (const pricing of paperPricing) {
                const profileName = pricing.name + " Profile";
                const profileResult = db.prepare(`
                    INSERT INTO print_profiles (
                        name, paper_size, color_mode, duplex_mode, pricing_id, printer_name, print_quality
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(
                    profileName,
                    pricing.paper_size || 'A4',
                    pricing.color_type === 'color' ? 'color' : 'bw',
                    pricing.sides === 'Double' ? 'longEdge' : 'simplex',
                    pricing.id,
                    pricing.default_printer || 'Default',
                    pricing.print_quality || 'Normal'
                );
                const profileId = profileResult.lastInsertRowid;

                db.prepare(`
                    INSERT INTO products (name, category, description, print_profile_id)
                    VALUES (?, ?, ?, ?)
                `).run(
                    pricing.name,
                    'Standard Print',
                    'Automatically mapped legacy pricing option',
                    profileId
                );
            }

            db.prepare("INSERT OR IGNORE INTO printer_groups (name, description) VALUES ('Color Printers', 'High quality color printing devices')").run();
            db.prepare("INSERT OR IGNORE INTO printer_groups (name, description) VALUES ('B&W Printers', 'Fast monochrome printing devices')").run();

            try {
                db.exec(`
                    UPDATE print_profiles 
                    SET recipe_id = (SELECT id FROM recipes WHERE product_id = print_profiles.product_id LIMIT 1)
                    WHERE product_id IS NOT NULL
                `);
            } catch(e) {}
        } catch(seedErr) {
            console.warn("Notice: Product and Print Profile seeding notice:", seedErr.message);
        }
    });

    // Migration 11: Customer Workspace 2.0 Schema Enhancements
    runMigration(11, 'Customer Workspace 2.0 Schema Enhancements', () => {
        const customerCols = [
            `ALTER TABLE customers ADD COLUMN email TEXT`,
            `ALTER TABLE customers ADD COLUMN tag TEXT DEFAULT 'Regular'`,
            `ALTER TABLE customers ADD COLUMN address TEXT`,
            `ALTER TABLE customers ADD COLUMN company_name TEXT`,
            `ALTER TABLE customers ADD COLUMN preferred_print_type TEXT`,
            `ALTER TABLE customers ADD COLUMN preferred_paper_size TEXT`,
            `ALTER TABLE customers ADD COLUMN preferred_sides TEXT`,
            `ALTER TABLE customers ADD COLUMN notes TEXT`
        ];
        for (const sql of customerCols) {
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
    });

    // Migration 12: Production Scheduling & Smart Print Queue Schema
    runMigration(12, 'Production Scheduling Engine Schema', () => {
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
    });

    // Migration 13: Dynamic Job Configuration Architecture
    runMigration(13, 'Dynamic Job Configuration Schema', () => {
        try {
            db.exec("ALTER TABLE print_profiles ADD COLUMN config_json TEXT");
        } catch(e) {}
        
        db.exec(`
            CREATE TABLE IF NOT EXISTS order_item_specifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
                spec_key TEXT NOT NULL,
                spec_value TEXT NOT NULL,
                UNIQUE(order_item_id, spec_key)
            )
        `);

        // Helper schemas
        const getBusinessCardSchema = () => ({
            type: "business-card",
            fields: [
                { key: "Paper Type", label: "Paper Type", type: "select", options: ["Art Card", "Ivory Card", "Textured Card"], default: "Art Card", section: "Material" },
                { key: "GSM", label: "GSM", type: "select", options: ["250 GSM", "300 GSM", "350 GSM"], default: "300 GSM", section: "Material" },
                { key: "Finish", label: "Finish", type: "select", options: ["Matte", "Gloss", "Velvet"], default: "Matte", section: "Finishing" },
                { key: "Lamination", label: "Lamination", type: "select", options: ["None", "Single Matte", "Double Matte", "Single Gloss", "Double Gloss"], default: "Double Matte", section: "Finishing" },
                { key: "Corner Type", label: "Corner Type", type: "select", options: ["Square", "Rounded"], default: "Square", section: "Finishing" }
            ],
            validation: [],
            pricing: {
                pricing_model: "unit",
                surcharges: {
                    "Corner Type": { "Rounded": 0.50 },
                    "Lamination": { "Single Matte": 0.30, "Double Matte": 0.50, "Single Gloss": 0.20, "Double Gloss": 0.40 }
                }
            }
        });

        const getFlyerSchema = () => ({
            type: "flyer-brochure",
            fields: [
                { key: "Paper Type", label: "Paper Type", type: "select", options: ["Art Paper", "Maplitho", "Bond Paper"], default: "Art Paper", section: "Material" },
                { key: "GSM", label: "GSM", type: "select", options: ["80 GSM", "130 GSM", "170 GSM", "220 GSM"], default: "130 GSM", section: "Material" },
                { key: "Folding Type", label: "Folding Type", type: "select", options: ["No Fold", "Half Fold", "Z-Fold", "Tri-Fold"], default: "No Fold", section: "Finishing" }
            ],
            validation: [],
            pricing: {
                pricing_model: "unit",
                surcharges: {
                    "Folding Type": { "Half Fold": 0.10, "Z-Fold": 0.20, "Tri-Fold": 0.20 }
                }
            }
        });

        const getPosterSchema = () => ({
            type: "poster",
            fields: [
                { key: "Material", label: "Material", type: "select", options: ["Gloss Photo Paper", "Matte Poster Paper", "Synthetic Non-Tearable"], default: "Gloss Photo Paper", section: "Material" },
                { key: "Lamination", label: "Lamination", type: "select", options: ["None", "Gloss Lamination", "Matte Lamination"], default: "None", section: "Finishing" }
            ],
            validation: [],
            pricing: {
                pricing_model: "unit",
                surcharges: {
                    "Lamination": { "Gloss Lamination": 10.00, "Matte Lamination": 12.00 }
                }
            }
        });

        const getBannerSchema = () => ({
            type: "banner",
            fields: [
                { key: "Material", label: "Material", type: "select", options: ["Normal Flex", "Star Flex", "Backlit Flex", "Canvas"], default: "Normal Flex", section: "Material" },
                { key: "Width", label: "Width (feet)", type: "number", default: 3.0, section: "Dimensions" },
                { key: "Height", label: "Height (feet)", type: "number", default: 2.0, section: "Dimensions" },
                { key: "Eyelets", label: "Eyelets", type: "select", options: ["None", "4 Corners", "Every 2 feet"], default: "None", section: "Finishing" },
                { key: "Finishing", label: "Finishing", type: "select", options: ["Clean Cut", "Hemming", "Pocket Fold"], default: "Clean Cut", section: "Finishing" }
            ],
            validation: [
                { field: "Width", min: 0.1, message: "Width must be greater than zero." },
                { field: "Height", min: 0.1, message: "Height must be greater than zero." }
            ],
            pricing: {
                pricing_model: "area",
                surcharges: {
                    "Material": { "Star Flex": 5.00, "Backlit Flex": 15.00, "Canvas": 25.00 },
                    "Eyelets": { "4 Corners": 10.00, "Every 2 feet": 20.00 }
                }
            }
        });

        const getStickerSchema = () => ({
            type: "sticker",
            fields: [
                { key: "Material", label: "Material", type: "select", options: ["Vinyl Gloss", "Vinyl Matte", "Paper Sticker", "Transparent Sticker"], default: "Vinyl Gloss", section: "Material" },
                { key: "Shape", label: "Shape", type: "select", options: ["Circle", "Square", "Rectangle", "Custom Die Cut"], default: "Circle", section: "Product Specifications" },
                { key: "Cut Type", label: "Cut Type", type: "select", options: ["Half Cut / Kiss Cut", "Die Cut / Full Cut", "Sheet Form"], default: "Half Cut / Kiss Cut", section: "Finishing" },
                { key: "Lamination", label: "Lamination", type: "select", options: ["None", "Gloss", "Matte"], default: "None", section: "Finishing" }
            ],
            validation: [],
            pricing: {
                pricing_model: "unit",
                surcharges: {
                    "Cut Type": { "Die Cut / Full Cut": 0.50 },
                    "Lamination": { "Gloss": 0.20, "Matte": 0.25 }
                }
            }
        });

        const getBookSchema = () => ({
            type: "book",
            fields: [
                { key: "Page Count", label: "Page Count", type: "number", default: 16, section: "Product Specifications" },
                { key: "Cover Paper", label: "Cover Paper", type: "select", options: ["Art Card 250gsm", "Art Card 300gsm", "Self Cover"], default: "Art Card 250gsm", section: "Material" },
                { key: "Paper Type", label: "Paper Type", type: "select", options: ["Maplitho 80gsm", "Art Paper 130gsm", "Art Paper 170gsm"], default: "Maplitho 80gsm", section: "Material" },
                { key: "Binding Type", label: "Binding Type", type: "select", options: ["Saddle Stitch / Stapled", "Perfect Binding", "Spiral Binding", "Wire-O Binding"], default: "Saddle Stitch / Stapled", section: "Finishing" },
                { key: "Spiral Size", label: "Spiral Size", type: "select", options: ["6mm", "8mm", "10mm", "12mm"], default: "6mm", section: "Finishing", dependentOn: { key: "Binding Type", value: "Spiral Binding" } }
            ],
            validation: [
                { field: "Page Count", min: 2, message: "Page count must be at least 2." }
            ],
            pricing: {
                pricing_model: "page",
                surcharges: {
                    "Binding Type": { "Perfect Binding": 15.00, "Spiral Binding": 20.00, "Wire-O Binding": 25.00 },
                    "Cover Paper": { "Art Card 300gsm": 5.00 }
                }
            }
        });

        const getGenericSchema = () => ({
            type: "generic",
            fields: [],
            validation: [],
            pricing: {
                pricing_model: "page",
                surcharges: {}
            }
        });

        // Upgrade existing print profiles with default schemas
        try {
            const profiles = db.prepare("SELECT id, name FROM print_profiles").all();
            const stmtUpdate = db.prepare("UPDATE print_profiles SET config_json = ? WHERE id = ?");
            for (const p of profiles) {
                let schema = null;
                const name = p.name.toLowerCase();
                if (name.includes('visiting') || name.includes('business')) {
                    schema = getBusinessCardSchema();
                } else if (name.includes('flyer') || name.includes('brochure')) {
                    schema = getFlyerSchema();
                } else if (name.includes('poster')) {
                    schema = getPosterSchema();
                } else if (name.includes('flex') || name.includes('banner')) {
                    schema = getBannerSchema();
                } else if (name.includes('sticker')) {
                    schema = getStickerSchema();
                } else if (name.includes('book') || name.includes('magazine')) {
                    schema = getBookSchema();
                } else {
                    schema = getGenericSchema();
                }
                stmtUpdate.run(JSON.stringify(schema), p.id);
            }
        } catch (err) {
            console.error("Migration 13 Seeding Error:", err);
        }
    });

    // Migration 14: Phase 1 Security (Salted scrypt PINs, default reset, and license schema upgrade)
    runMigration(14, 'Phase 1 Security & Authentication Hardening', () => {
        const crypto = require('crypto');
        
        // 1. Safety Backup before migration
        try {
            const backupService = require('./services/backup-service');
            if (backupService && typeof backupService.createSafetyBackup === 'function') {
                backupService.createSafetyBackup('migration_14_security_hardening');
            }
        } catch(e) {
            console.warn('[Migration 14] Safety backup notice:', e.message);
        }

        // 2. Add security columns to users table
        const userCols = [
            `ALTER TABLE users ADD COLUMN pin_hash TEXT`,
            `ALTER TABLE users ADD COLUMN pin_salt TEXT`,
            `ALTER TABLE users ADD COLUMN pin_algo TEXT`,
            `ALTER TABLE users ADD COLUMN reset_required INTEGER DEFAULT 0`,
            `ALTER TABLE users ADD COLUMN failed_attempts INTEGER DEFAULT 0`,
            `ALTER TABLE users ADD COLUMN locked_until DATETIME`
        ];
        for (const colSql of userCols) {
            try { db.exec(colSql); } catch(e) {}
        }

        // 3. Add license status and validation columns
        const licenseCols = [
            `ALTER TABLE license ADD COLUMN status TEXT DEFAULT 'UNACTIVATED'`,
            `ALTER TABLE license ADD COLUMN expires_at DATETIME`,
            `ALTER TABLE license ADD COLUMN license_type TEXT`,
            `ALTER TABLE license ADD COLUMN meta_json TEXT`
        ];
        for (const colSql of licenseCols) {
            try { db.exec(colSql); } catch(e) {}
        }

        // 4. Invalidate all default credentials & force reset
        const defaultPins = ['1234', '5678', '0000', '1111', '123456', '654321', '000000', '111111'];
        const defaultHashes = defaultPins.map(p => crypto.createHash('sha256').update(p).digest('hex').toLowerCase());

        try {
            const users = db.prepare('SELECT id, name, role, pin FROM users').all();
            for (const user of users) {
                const stored = String(user.pin || '').trim();
                const isDefaultPlain = defaultPins.includes(stored);
                const isDefaultSha256 = defaultHashes.includes(stored.toLowerCase());

                if (isDefaultPlain || isDefaultSha256 || !stored) {
                    // Force reset and nullify pin so default credentials can NEVER grant access
                    db.prepare("UPDATE users SET pin = '', reset_required = 1 WHERE id = ?").run(user.id);
                    console.log(`[Migration 14] User '${user.name}' (${user.role}) had default/blank credentials. Forced reset applied.`);
                }
            }
        } catch (err) {
            console.error('[Migration 14] Error checking default credentials:', err);
        }
    });

    // Migration 15: Local Order Lifecycle & State Machine Reconciliation
    runMigration(15, "Phase 2 Local Order Lifecycle, Payments & Reconciliation Hardening", () => {
        // 1. Add order tracking and payment columns
        const orderCols = [
            `ALTER TABLE orders ADD COLUMN submission_id TEXT`,
            `ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'Unpaid'`,
            `ALTER TABLE orders ADD COLUMN customer_name_snapshot TEXT`,
            `ALTER TABLE orders ADD COLUMN customer_phone_snapshot TEXT`,
            `ALTER TABLE orders ADD COLUMN customer_gstin_snapshot TEXT`,
            `ALTER TABLE orders ADD COLUMN subtotal REAL DEFAULT 0`,
            `ALTER TABLE orders ADD COLUMN taxable_amount REAL DEFAULT 0`,
            `ALTER TABLE orders ADD COLUMN gst_amount REAL DEFAULT 0`,
            `ALTER TABLE orders ADD COLUMN discount_amount REAL DEFAULT 0`,
            `ALTER TABLE orders ADD COLUMN paid_amount REAL DEFAULT 0`,
            `ALTER TABLE orders ADD COLUMN unified_pdf_path TEXT`
        ];
        for (const colSql of orderCols) {
            try { db.exec(colSql); } catch(e) {}
        }

        // 2. Add order items quantity and pricing snapshot columns
        const orderItemCols = [
            `ALTER TABLE order_items ADD COLUMN source_pages INTEGER DEFAULT 1`,
            `ALTER TABLE order_items ADD COLUMN n_up INTEGER DEFAULT 1`,
            `ALTER TABLE order_items ADD COLUMN physical_sheets INTEGER DEFAULT 1`,
            `ALTER TABLE order_items ADD COLUMN logical_pages INTEGER DEFAULT 1`,
            `ALTER TABLE order_items ADD COLUMN unit_price REAL DEFAULT 0`,
            `ALTER TABLE order_items ADD COLUMN total_price REAL DEFAULT 0`,
            `ALTER TABLE order_items ADD COLUMN checksum TEXT`
        ];
        for (const colSql of orderItemCols) {
            try { db.exec(colSql); } catch(e) {}
        }

        // 3. Add GST invoice linking and payment status
        const gstCols = [
            `ALTER TABLE gst_invoices ADD COLUMN order_id INTEGER`,
            `ALTER TABLE gst_invoices ADD COLUMN payment_status TEXT DEFAULT 'Unpaid'`,
            `ALTER TABLE gst_invoices ADD COLUMN paid_amount REAL DEFAULT 0`
        ];
        for (const colSql of gstCols) {
            try { db.exec(colSql); } catch(e) {}
        }

        // 4. Create dedicated Payments table for immutable payment records
        db.exec(`
            CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL,
                invoice_id INTEGER,
                amount REAL NOT NULL,
                payment_method TEXT NOT NULL DEFAULT 'Cash',
                reference_number TEXT,
                status TEXT NOT NULL DEFAULT 'Completed' CHECK (status IN ('Completed', 'Refunded', 'Voided')),
                notes TEXT,
                recorded_by TEXT DEFAULT 'Operator',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
                FOREIGN KEY (invoice_id) REFERENCES gst_invoices (id) ON DELETE SET NULL
            )
        `);

        // 5. Add print jobs retry and error tracking columns
        const printJobCols = [
            `ALTER TABLE print_jobs ADD COLUMN attempt_count INTEGER DEFAULT 1`,
            `ALTER TABLE print_jobs ADD COLUMN retry_history_json TEXT`,
            `ALTER TABLE print_jobs ADD COLUMN error_message TEXT`
        ];
        for (const colSql of printJobCols) {
            try { db.exec(colSql); } catch(e) {}
        }

        // 6. Create indexes for performance and uniqueness
        db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_submission_id ON orders(submission_id) WHERE submission_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_gst_invoices_order_id ON gst_invoices(order_id) WHERE order_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
            CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id);
            CREATE INDEX IF NOT EXISTS idx_print_jobs_order_id ON print_jobs(order_id);
        `);

        // 7. Normalize legacy historical order & invoice states safely
        try {
            // Populate snapshots for existing orders with customers
            db.exec(`
                UPDATE orders 
                SET customer_name_snapshot = (SELECT name FROM customers WHERE customers.id = orders.customer_id),
                    customer_phone_snapshot = (SELECT phone FROM customers WHERE customers.id = orders.customer_id),
                    customer_gstin_snapshot = (SELECT gstin FROM customers WHERE customers.id = orders.customer_id)
                WHERE customer_id IS NOT NULL AND customer_name_snapshot IS NULL;
            `);

            // Normalize payment statuses based on order status
            db.exec(`
                UPDATE orders
                SET payment_status = 'Paid', paid_amount = total_price
                WHERE status = 'Completed' AND (payment_status IS NULL OR payment_status = 'Unpaid');
            `);

            db.exec(`
                UPDATE orders
                SET payment_status = 'Unpaid', paid_amount = 0
                WHERE status IN ('Pending', 'Scheduled', 'Waiting', 'In Production', 'Ready') AND payment_status IS NULL;
            `);

            db.exec(`
                UPDATE gst_invoices
                SET payment_status = 'Paid', paid_amount = grand_total
                WHERE status = 'Paid' AND (payment_status IS NULL OR payment_status = 'Unpaid');
            `);
        } catch (err) {
            console.error('[Migration 15] Error normalizing legacy records:', err);
        }
    });

    // Migration 16: Phase 3 Physical Printing Engine Hardening & Truthful State Machine
    runMigration(16, "Phase 3 Physical Printing Engine Hardening & Concurrency", () => {
        try {
            const tableInfo = db.prepare("PRAGMA table_info(print_jobs)").all();
            const cols = new Set(tableInfo.map(c => c.name));

            db.exec(`
                CREATE TABLE IF NOT EXISTS print_jobs_v16 (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER,
                    customer_id INTEGER,
                    printer_name TEXT,
                    printer_device_name TEXT,
                    file_path TEXT,
                    status TEXT DEFAULT 'Queued' CHECK (status IN ('Queued', 'Preparing', 'Rendering', 'Submitting', 'Submitted', 'Confirmed Printed', 'Failed', 'Cancelled', 'Uncertain')),
                    copies INTEGER DEFAULT 1,
                    pages INTEGER DEFAULT 0,
                    paper_size TEXT,
                    color_mode TEXT,
                    duplex TEXT,
                    scaling_mode TEXT DEFAULT 'fit',
                    attempt_count INTEGER DEFAULT 1,
                    settings_snapshot_json TEXT,
                    preflight_checksum TEXT,
                    retry_history_json TEXT,
                    attempt_history_json TEXT,
                    locked_by TEXT,
                    locked_at DATETIME,
                    submitted_at DATETIME,
                    completed_at DATETIME,
                    finished_at DATETIME,
                    started_at DATETIME,
                    error TEXT,
                    error_message TEXT,
                    duration_ms INTEGER,
                    is_simulated INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
                    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE SET NULL
                );
            `);

            const customerIdCol = cols.has('customer_id') ? 'customer_id' : 'NULL';
            const paperSizeCol = cols.has('paper_size') ? 'paper_size' : 'NULL';
            const colorModeCol = cols.has('color_mode') ? 'color_mode' : 'NULL';
            const duplexCol = cols.has('duplex') ? 'duplex' : 'NULL';
            const attemptCountCol = cols.has('attempt_count') ? 'attempt_count' : '1';
            const retryHistoryCol = cols.has('retry_history_json') ? 'retry_history_json' : 'NULL';
            const errorCol = cols.has('error') ? 'error' : 'NULL';
            const durationMsCol = cols.has('duration_ms') ? 'duration_ms' : 'NULL';
            const isSimulatedCol = cols.has('is_simulated') ? 'is_simulated' : '0';
            const startedAtCol = cols.has('started_at') ? 'started_at' : 'NULL';

            db.exec(`
                INSERT INTO print_jobs_v16 (
                    id, order_id, customer_id, printer_name, printer_device_name, file_path,
                    status, copies, pages, paper_size, color_mode, duplex, attempt_count,
                    retry_history_json, error, error_message, duration_ms, is_simulated,
                    finished_at, started_at, created_at
                )
                SELECT 
                    id, order_id, ${customerIdCol}, printer_name, COALESCE(printer_name, 'Default'), file_path,
                    CASE 
                        WHEN status IN ('Completed', 'Printed') THEN 'Submitted'
                        WHEN status IN ('Preparing', 'Printing', 'Rendering', 'Submitting') THEN 'Uncertain'
                        WHEN status = 'queued' THEN 'Queued'
                        WHEN status IN ('Queued', 'Preparing', 'Rendering', 'Submitting', 'Submitted', 'Confirmed Printed', 'Failed', 'Cancelled', 'Uncertain') THEN status
                        ELSE 'Queued'
                    END,
                    COALESCE(copies, 1), COALESCE(pages, 0), ${paperSizeCol}, ${colorModeCol}, ${duplexCol}, COALESCE(${attemptCountCol}, 1),
                    ${retryHistoryCol}, ${errorCol}, error_message, ${durationMsCol}, ${isSimulatedCol},
                    finished_at, ${startedAtCol}, created_at
                FROM print_jobs;

                DROP TABLE print_jobs;
                ALTER TABLE print_jobs_v16 RENAME TO print_jobs;

                CREATE INDEX IF NOT EXISTS idx_print_jobs_order_id ON print_jobs(order_id);
                CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
                CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_device_name ON print_jobs(printer_device_name);
                CREATE INDEX IF NOT EXISTS idx_print_jobs_locked_by ON print_jobs(locked_by);
            `);
        } catch (err) {
            console.error('[Migration 16] Error applying print_jobs table migration:', err);
            throw err;
        }
    });
}

module.exports = { runMigrations };
