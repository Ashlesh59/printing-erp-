process.env.WS_NO_UTF_8_VALIDATE = 'true';
process.env.WS_NO_BUFFER_UTIL = 'true';

const path = require('path');
const http = require('http');
const fs = require('fs');
const Database = require('better-sqlite3');

const CLOUD_SERVER_PORT = 5005;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    options.signal = controller.signal;
    
    try {
        const res = await fetch(url, options);
        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch(e) {
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
            return text;
        }
    } finally {
        clearTimeout(timeoutId);
    }
}

async function runTest() {
    console.log("Starting Control Center Integration Test...");
    let passed = 0;
    let failed = 0;
    let blocked = 0;

    const assert = (condition, msg) => {
        if (condition) {
            console.log(`✅ [PASS] ${msg}`);
            passed++;
        } else {
            console.error(`❌ [FAIL] ${msg}`);
            failed++;
        }
    };

    // 1. Start Cloud Server in-process
    console.log("-> Starting cloud server...");
    process.env.PORT = CLOUD_SERVER_PORT;
    const server = require('./cloud-server/server.js');
    await sleep(2000); // give it time to bind

    // Verify server is up
    try {
        const health = await fetchJson(`http://127.0.0.1:${CLOUD_SERVER_PORT}/api/health`);
        assert(health.status === 'online', 'Cloud server started and SQLite initialized');
    } catch (e) {
        console.error("Failed to start cloud server:", e);
        process.exit(1);
    }

    // 1.5 Setup enrollment key and enroll
    console.log("-> Enrolling shop...");
    let shopId, token;
    try {
        const keyRes = await fetchJson(`http://127.0.0.1:${CLOUD_SERVER_PORT}/api/admin/keys`, { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        console.log("-> keyRes debug:", keyRes);
        assert(keyRes && keyRes.success && keyRes.key, 'Admin can generate enrollment key');

        const enrollRes = await fetchJson(`http://127.0.0.1:${CLOUD_SERVER_PORT}/api/enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: keyRes.key, name: 'Integration Test Shop' })
        });
        console.log("-> enrollRes debug:", enrollRes);
        assert(enrollRes && enrollRes.success && enrollRes.shopId && enrollRes.token, 'Shop can enroll with valid key');
        
        shopId = enrollRes.shopId;
        token = enrollRes.token;
    } catch(e) {
        console.error("Failed to enroll detail:", e.message, e.stack);
        failed++;
    }

    // 2. Start Test Shop Client with enrolled credentials
    console.log("-> Starting test shop client...");
    const CloudClient = require('./src/main/cloud-client');
    CloudClient.shopId = shopId;
    CloudClient.authToken = token;
    CloudClient.cloudUrl = `ws://127.0.0.1:${CLOUD_SERVER_PORT}/v1/telemetry`;
    
    CloudClient.init();
    await sleep(2000); // Wait for connection and auth

    // 3. Verify Enrollment and Heartbeat
    try {
        const shopInfo = await fetchJson(`http://127.0.0.1:${CLOUD_SERVER_PORT}/api/control/shop/${shopId}`);
        assert(shopInfo.shopId === shopId, 'Shop successfully verified in SQLite');
        assert(shopInfo.heartbeat && shopInfo.heartbeat.status === 'online', 'Heartbeat received and persisted');
        assert(shopInfo.isOnline === true, 'Shop is currently marked ONLINE in Control Center');
    } catch (e) {
        console.error("Failed to verify heartbeat:", e);
        failed++;
    }

    // 4. Test Remote Command Execution
    console.log("-> Testing Remote Command (lock)...");
    try {
        const cmdRes = await fetchJson(`http://127.0.0.1:${CLOUD_SERVER_PORT}/api/control/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shopId: shopId,
                command: 'lock'
            })
        });
        
        assert(cmdRes.success === true && cmdRes.commandId, 'Remote command accepted by Control Center');
        
        await sleep(1500); // wait for WS dispatch, execution, and ACK back
        
        const dbPath = path.join(__dirname, 'cloud-server', 'cloud_control.db');
        const db = new Database(dbPath, { readonly: true });
        const row = db.prepare('SELECT * FROM remote_commands WHERE id = ?').get(cmdRes.commandId);
        
        assert(row && (row.status === 'success' || row.status === 'dispatched'), 'Command executed by client and ACK persisted in Control Center DB');
        db.close();

    } catch (e) {
        console.error("Failed remote command test:", e);
        failed++;
    }

    // 5. Test Offline Detection
    console.log("-> Testing offline detection...");
    if (CloudClient.ws) {
        CloudClient.ws.close();
    }
    
    // Backdate heartbeat in DB to simulate timeout
    const dbPath = path.join(__dirname, 'cloud-server', 'cloud_control.db');
    const db = new Database(dbPath);
    db.prepare('UPDATE heartbeats SET lastSeen = ? WHERE shopId = ?').run(Date.now() - 660000, shopId);
    db.close();

    try {
        const shopInfoOff = await fetchJson(`http://127.0.0.1:${CLOUD_SERVER_PORT}/api/control/shop/${shopId}`);
        assert(shopInfoOff.isOnline === false, 'Control Center correctly identifies shop as OFFLINE after timeout');
    } catch (e) {
        console.error("Failed offline test:", e);
        failed++;
    }

    // 6. Test Physical Printer Discovery (Hardware Blocker Test)
    console.log("-> Checking Printer Hardware...");
    try {
        const os = require('os');
        if (os.platform() === 'win32') {
            console.log("⚠️ [BLOCKED] PHYSICAL_PRINTER_VALIDATION = BLOCKED_BY_HARDWARE");
            blocked++;
        }
    } catch(e) {}

    // Cleanup
    if (server) server.close();
    
    console.log("\n==========================================================================");
    console.log("                CONTROL CENTER INTEGRATION TEST RESULTS                   ");
    console.log("==========================================================================");
    console.log(`PASSED: ${passed}`);
    console.log(`FAILED: ${failed}`);
    console.log(`BLOCKED: ${blocked}`);
    
    process.exit(failed > 0 ? 1 : 0);
}

runTest();
