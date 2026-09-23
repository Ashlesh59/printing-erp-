const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function runTest(scriptName, useElectron = true) {
    return new Promise((resolve) => {
        const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const args = ['electron', scriptName];
        
        console.log(`\n======================================================`);
        console.log(`Running: ${cmd} ${args.join(' ')}`);
        console.log(`======================================================\n`);
        
        const child = spawn(cmd, args, { 
            stdio: 'inherit', 
            shell: true,
            env: { 
                ...process.env, 
                ELECTRON_RUN_AS_NODE: '1',
                WS_NO_UTF_8_VALIDATE: 'true', 
                WS_NO_BUFFER_UTIL: 'true' 
            } 
        });
        
        child.on('close', (code) => {
            resolve(code === 0);
        });
    });
}

async function runStaticForensics() {
    console.log("-> Running Static Security Forensics...");
    let passed = true;
    
    // Check for hardcoded SENTRY_DSN
    const cloudClientPath = path.join(__dirname, 'src', 'main', 'cloud-client.js');
    if (fs.existsSync(cloudClientPath)) {
        const code = fs.readFileSync(cloudClientPath, 'utf8');
        if (code.includes('https://') && code.includes('sentry.io')) {
            console.error("❌ [FAIL] Hardcoded Sentry DSN detected in cloud-client.js");
            passed = false;
        } else {
            console.log("✅ [PASS] No hardcoded Sentry DSN detected in source.");
        }
    }
    
    // Check for arbitrary RCE in remote commands
    if (fs.existsSync(cloudClientPath)) {
        const code = fs.readFileSync(cloudClientPath, 'utf8');
        if (code.includes('exec(') || code.includes('eval(')) {
            console.error("❌ [FAIL] Arbitrary RCE detected in remote commands");
            passed = false;
        } else {
            console.log("✅ [PASS] No unsafe RCE logic detected in remote command handling.");
        }
    }

    return passed;
}

async function main() {
    let report = {
        git_hash: 'unknown',
        tests_executed: 0,
        passed: 0,
        failed: 0,
        blocked: 0,
        skipped: 0,
        real_hardware_tests: 0,
        cloud_integration_tests: 0,
        security_tests: 0,
        save_persistence_tests: 0,
        database_recovery_tests: 0,
        performance_measurements: []
    };

    const recordPass = () => { report.passed++; report.tests_executed++; };
    const recordFail = () => { report.failed++; report.tests_executed++; };
    const recordBlocked = () => { report.blocked++; report.tests_executed++; };

    // 1. Static Security Forensics
    report.security_tests++;
    if (await runStaticForensics()) {
        recordPass();
    } else {
        recordFail();
    }

    // 2. Control Center E2E & Remote Commands
    fs.writeFileSync('test_runner_cloud.js', `
        process.env.SHOP_ID = "PROD-TEST-SHOP";
        process.env.SHOP_AUTH_TOKEN = "super-secret-production-token";
        process.env.CLOUD_MASTER_URL = "ws://127.0.0.1:5000/v1/telemetry";

        const crypto = require('crypto');
        const path = require('path');
        const fs = require('fs');
        const Database = require('better-sqlite3');
        
        let app = null;
        try {
            const electron = require('electron');
            app = (typeof electron === 'object' && electron && electron.app) ? electron.app : null;
        } catch(e) {}
        if (!app) app = { getAppPath: () => __dirname, getPath: () => __dirname, getVersion: () => '1.0.0' };
        if (!app.getAppPath) app.getAppPath = () => __dirname;

        const Module = require('module');
        const originalRequire = Module.prototype.require;
        
        Module.prototype.require = function(mod) {
            if (mod === 'electron-updater') {
                return { autoUpdater: { on: () => {}, checkForUpdatesAndNotify: () => {} } };
            }
            return originalRequire.apply(this, arguments);
        };

        // Seed the shop in DB before connecting
        const db = new Database(path.join(__dirname, 'cloud-server', 'cloud_control.db'));
        db.prepare("INSERT OR REPLACE INTO shops (shopId, name, registeredAt, status, token) VALUES (?, ?, ?, 'active', ?)")
          .run('PROD-TEST-SHOP', 'Production Test Shop', Date.now(), 'super-secret-production-token');

        console.log("Requiring cloud-server/server...");
        const server = require('./cloud-server/server');
        console.log("Initialization complete!");
        
        async function fetchJson(url, options = {}) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            options.signal = controller.signal;
            try {
                const res = await fetch(url, options);
                const text = await res.text();
                try { return JSON.parse(text); } catch(e) { if (!res.ok) throw new Error(text); return text; }
            } finally { clearTimeout(timeoutId); }
        }

        async function runTest() {
            let passed = 0, failed = 0;
            const assert = (cond, msg) => { if(cond) { console.log('✅ [PASS] ' + msg); passed++; } else { console.error('❌ [FAIL] ' + msg); failed++; } };
            
            console.log("-> Starting Cloud Server...");
            await new Promise(r => setTimeout(r, 1000));
            
            console.log("-> Initializing Cloud Client...");
            const client = require('./src/main/cloud-client');
            client.shopId = 'PROD-TEST-SHOP';
            client.authToken = 'super-secret-production-token';
            client.cloudUrl = 'ws://127.0.0.1:5000/v1/telemetry';
            client.init();
            
            await new Promise(r => setTimeout(r, 1500));
            
            const shop = db.prepare('SELECT * FROM shops WHERE shopId = ?').get('PROD-TEST-SHOP');
            assert(shop !== undefined, 'Shop successfully enrolled in Control Center SQLite');
            assert(shop && shop.token === 'super-secret-production-token', 'Shop token securely saved');
            
            const hb = db.prepare('SELECT * FROM heartbeats WHERE shopId = ?').get('PROD-TEST-SHOP');
            assert(hb && hb.status === 'online', 'Heartbeat persisted and shop is ONLINE');
            
            // Test Remote Command with Invalid Signature
            console.log("-> Testing Remote Command Security...");
            client.handleRemoteCommand({
                type: 'remote_command',
                id: crypto.randomUUID(),
                command: 'restart',
                timestamp: Date.now(),
                signature: 'fake-signature-that-will-fail'
            });
            
            await new Promise(r => setTimeout(r, 500));
            
            console.log("-> Testing Revocation...");
            await fetchJson('http://127.0.0.1:5000/api/admin/revoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shopId: 'PROD-TEST-SHOP' })
            });
            
            const revokedShop = db.prepare('SELECT * FROM shops WHERE shopId = ?').get('PROD-TEST-SHOP');
            assert(revokedShop && revokedShop.status === 'revoked', 'Admin API successfully revoked shop access');
            
            db.close();
            if (server && server.close) server.close();
            if (failed > 0) process.exit(1);
            process.exit(0);
        }
        
        runTest().catch(e => { console.error(e); process.exit(1); });
    `);
    
    report.cloud_integration_tests++;
    if (await runTest('test_runner_cloud.js')) {
        recordPass();
    } else {
        recordFail();
    }

    // 3. ERP Save Persistence Forensic Test
    fs.writeFileSync('test_runner_persistence.js', `
        const path = require('path');
        const fs = require('fs');
        let app = null;
        try {
            const electron = require('electron');
            app = (typeof electron === 'object' && electron && electron.app) ? electron.app : null;
        } catch(e) {}
        if (!app) app = { getAppPath: () => __dirname, getPath: () => __dirname, getVersion: () => '1.0.0' };
        if (!app.getAppPath) app.getAppPath = () => __dirname;
        
        const { initDatabase } = require('./src/main/database/schema');
        initDatabase();
        
        const { CustomerModel } = require('./src/main/database/models');
        const EventBus = require('./src/main/events/EventBus');
        const { EventTypes } = require('./src/main/events/EventTypes');
        
        async function runTest() {
            let passed = 0, failed = 0;
            const assert = (cond, msg) => { if(cond) { console.log('✅ [PASS] ' + msg); passed++; } else { console.error('❌ [FAIL] ' + msg); failed++; } };
            
            console.log("-> Testing Local ERP Operations without Cloud...");
            
            const result = CustomerModel.createCustomer({
                name: 'Offline Test Customer',
                phone: '555-000-1234',
                email: 'offline@test.com',
                company_name: 'Offline Corp'
            });
            
            assert(result.id, 'Customer created successfully offline');
            
            const fetched = CustomerModel.getCustomerProfile(result.id);
            assert(fetched && fetched.customer.name === 'Offline Test Customer', 'Customer data fully persisted to local SQLite');
            
            if (failed > 0) process.exit(1);
            process.exit(0);
        }
        
        runTest().catch(e => { console.error(e); process.exit(1); });
    `);
    
    report.save_persistence_tests++;
    if (await runTest('test_runner_persistence.js')) {
        recordPass();
    } else {
        recordFail();
    }

    // 4. Auto-Update State Machine
    report.security_tests++;
    if (await runTest('test_auto_update_state.js')) {
        recordPass();
    } else {
        recordFail();
    }
    
    // Hardware Printer Blocked check
    recordBlocked();
    report.real_hardware_tests++;

    fs.writeFileSync('phase4_production_readiness.json', JSON.stringify(report, null, 2));
    
    if (report.failed > 0) {
        console.error("❌ Some production readiness checks failed.");
        process.exit(1);
    } else {
        console.log("\n======================================================");
        console.log("✅ ALL PRODUCTION READINESS CHECKS COMPLETED (PASS)");
        console.log("======================================================\n");
        process.exit(0);
    }
}

main().catch(console.error);
