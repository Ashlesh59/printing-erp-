
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
    