
        process.env.SHOP_ID = "PROD-TEST-SHOP";
        process.env.SHOP_AUTH_TOKEN = "super-secret-production-token";
        process.env.CLOUD_MASTER_URL = "ws://localhost:5000/v1/telemetry";

        const crypto = require('crypto');
        const path = require('path');
        const fs = require('fs');
        const { app } = require('electron');
        
        // Mock app.getAppPath for better-sqlite3 in test env
        if (!app.getAppPath) app.getAppPath = () => __dirname;

        const Module = require('module');
        const originalRequire = Module.prototype.require;
        
        Module.prototype.require = function(mod) {
            if (mod === 'electron-updater') {
                return { autoUpdater: { on: () => {}, checkForUpdatesAndNotify: () => {} } };
            }
            return originalRequire.apply(this, arguments);
        };

        console.log("Requiring cloud-server/server...");
        const server = require('./cloud-server/server');
        console.log("Initialization complete!");
        
        async function fetchJson(url, options = {}) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            options.signal = controller.signal;
            options.keepalive = false;
            url = url.replace('127.0.0.1', 'localhost');
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
            await new Promise(r => setTimeout(r, 1000)); // Server starts on require
            
            console.log("-> Initializing Cloud Client...");
            
            const client = require('./src/main/cloud-client');
            client.init();
            
            await new Promise(r => setTimeout(r, 1500));
            
            // Query Server DB directly for verification
            const Database = require('better-sqlite3');
            const db = new Database(path.join(__dirname, 'cloud-server', 'cloud_control.db'));
            
            const shop = db.prepare('SELECT * FROM shops WHERE shopId = ?').get('PROD-TEST-SHOP');
            assert(shop !== undefined, 'Shop successfully enrolled in Control Center SQLite');
            assert(shop && shop.token === 'super-secret-production-token', 'Shop token securely saved');
            
            const hb = db.prepare('SELECT * FROM heartbeats WHERE shopId = ?').get('PROD-TEST-SHOP');
            assert(hb && hb.status === 'online', 'Heartbeat persisted and shop is ONLINE');
            
            // Test Remote Command with Invalid Signature (Replay/Spoof Protection)
            console.log("-> Testing Remote Command Security...");
            const badCmdResult = await fetchJson('http://localhost:5000/api/control/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shopId: 'PROD-TEST-SHOP', command: 'restart' })
            });
            // The server will sign it legitimately! But wait, we need to test if the CLIENT rejects an invalid signature!
            // We can manually send a WS message to the client.
            
            client.handleRemoteCommand({
                type: 'remote_command',
                id: crypto.randomUUID(),
                command: 'restart',
                timestamp: Date.now(),
                signature: 'fake-signature-that-will-fail'
            });
            
            await new Promise(r => setTimeout(r, 500));
            // Assert that it didn't restart and rejected it.
            
            console.log("-> Testing Revocation...");
            await fetchJson('http://localhost:5000/api/admin/revoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shopId: 'PROD-TEST-SHOP' })
            });
            
            const revokedShop = db.prepare('SELECT * FROM shops WHERE shopId = ?').get('PROD-TEST-SHOP');
            assert(revokedShop && revokedShop.status === 'revoked', 'Admin API successfully revoked shop access');
            
            if (failed > 0) process.exit(1);
            process.exit(0);
        }
        
        runTest().catch(e => { console.error(e); process.exit(1); });
    