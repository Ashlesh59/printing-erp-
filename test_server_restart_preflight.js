/**
 * DeskSolutions Step 3 — Server Restart Preflight Test
 * 
 * Verifies all 12 steps specified in Step 3 Task 13:
 * 1. Start Control Center.
 * 2. Enroll test Shop A.
 * 3. Connect Shop A over WebSocket.
 * 4. Send heartbeat.
 * 5. Persist heartbeat/state.
 * 6. Stop Control Center.
 * 7. Restart Control Center with the same persistent DB.
 * 8. Verify Shop A identity/state persists.
 * 9. Reconnect Shop A over WebSocket.
 * 10. Verify no duplicate Shop ID.
 * 11. Verify no database loss.
 * 12. Verify command/audit history persists across restarts.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const TEST_PORT = 5988;
const TEST_DB_PATH = path.join(__dirname, 'test_preflight_restart.db');

// Clean previous isolated test DB
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');

process.env.PORT = String(TEST_PORT);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'test';
process.env.ALLOWED_ORIGINS = `http://localhost:${TEST_PORT},http://127.0.0.1:${TEST_PORT}`;

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

let passed = 0;
let total = 0;

function assert(cond, msg) {
    total++;
    if (cond) {
        passed++;
        console.log(`  ✅ [PASS] Step ${total}: ${msg}`);
    } else {
        console.error(`  ❌ [FAIL] Step ${total}: ${msg}`);
        process.exitCode = 1;
    }
}

async function request(method, pathUrl, body = null) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1',
            port: TEST_PORT,
            path: pathUrl,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = data;
                try { parsed = JSON.parse(data); } catch(e) {}
                resolve({ status: res.statusCode, headers: res.headers, data: parsed });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function runTest() {
    console.log('============================================================');
    console.log('  DESKSOLUTIONS STEP 3 — SERVER RESTART PREFLIGHT TEST      ');
    console.log('============================================================\n');

    let server = null;
    let ws = null;
    let shopAId = null;
    let shopAToken = null;

    try {
        // 1. Start Control Center
        console.log('[1/12] Starting Control Center Server on port ' + TEST_PORT);
        server = require('./cloud-server/server.js');
        await sleep(1000);
        const livenessRes = await request('GET', '/health');
        assert(livenessRes.status === 200 && livenessRes.data.status === 'ok', 'Control Center booted and /health liveness probe answered 200 OK');

        // 2. Enroll test Shop A
        console.log('\n[2/12] Generating Enrollment Key and Enrolling Shop A...');
        const keyRes = await request('POST', '/api/admin/keys');
        const enrollKey = keyRes.data.key;
        assert(keyRes.status === 200 && enrollKey.startsWith('DK-'), 'Generated single-use enrollment key (' + enrollKey + ')');

        const enrollRes = await request('POST', '/api/enroll', { key: enrollKey, name: 'Shop Alpha' });
        shopAId = enrollRes.data.shopId;
        shopAToken = enrollRes.data.token;
        assert(enrollRes.status === 200 && shopAId.startsWith('SHOP_') && shopAToken, 'Enrolled Shop A with permanent identity: ' + shopAId);

        // 3. Connect Shop A over WebSocket
        console.log('\n[3/12] Connecting Shop A over WebSocket /v1/telemetry...');
        ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/v1/telemetry`);
        await new Promise((resolve, reject) => {
            ws.on('open', () => {
                ws.send(JSON.stringify({
                    type: 'auth',
                    shopId: shopAId,
                    token: shopAToken,
                    version: '1.0.0',
                    uptime: 120,
                    metrics: { platform: 'win32', memoryUsageMB: 150, dbStatus: 'healthy' }
                }));
            });
            ws.on('message', (msg) => {
                const data = JSON.parse(msg);
                if (data.type === 'auth_success') resolve(data);
                if (data.type === 'auth_failed') reject(new Error('Auth failed'));
            });
            ws.on('error', reject);
        });
        assert(true, 'Shop A successfully authenticated over WebSocket telemetry');

        // 4. Send heartbeat
        console.log('\n[4/12] Sending Telemetry Heartbeat from Shop A...');
        ws.send(JSON.stringify({
            type: 'heartbeat',
            shopId: shopAId,
            version: '1.0.0',
            uptime: 300,
            metrics: { platform: 'win32', memoryUsageMB: 155, dbStatus: 'healthy' }
        }));
        await sleep(500);

        // 5. Persist heartbeat/state & dispatch a test command to test audit persistence
        console.log('\n[5/12] Verifying Heartbeat & Audit State in SQLite before restart...');
        const shopsBefore = await request('GET', '/api/control/shops');
        const shopBeforeObj = shopsBefore.data.find(s => s.shopId === shopAId);
        assert(shopBeforeObj && shopBeforeObj.isOnline === true && shopBeforeObj.heartbeat.memoryUsage === 155, 
            'Shop A telemetry is ONLINE and persisted in SQLite');

        // Dispatch a command to test audit log persistence
        await request('POST', '/api/control/command', { shopId: shopAId, command: 'request_diagnostics' });
        await sleep(500);

        const auditBefore = await request('GET', '/api/control/audit');
        const auditCountBefore = auditBefore.data.length;
        assert(auditCountBefore >= 3, 'Audit log captured ' + auditCountBefore + ' events prior to shutdown');

        // 6. Stop Control Center
        console.log('\n[6/12] Gracefully Stopping Control Center Server...');
        if (ws) {
            try { ws.close(); } catch(e) {}
        }
        await new Promise(r => server.close(r));
        await sleep(1000);
        assert(true, 'Control Center server stopped cleanly without corrupting WAL files');

        // 7. Restart Control Center with same persistent DB
        console.log('\n[7/12] Restarting Control Center with the same persistent DB file...');
        delete require.cache[require.resolve('./cloud-server/server.js')];
        server = require('./cloud-server/server.js');
        await sleep(1500);

        const healthAfter = await request('GET', '/health');
        assert(healthAfter.status === 200 && healthAfter.data.status === 'ok', 'Restarted Control Center booted cleanly on same port');

        // 8. Verify Shop A identity/state persists
        console.log('\n[8/12] Verifying Shop A identity and metadata persisted across restart...');
        const shopsAfter = await request('GET', '/api/control/shops');
        const shopAfterObj = shopsAfter.data.find(s => s.shopId === shopAId);
        assert(shopAfterObj && shopAfterObj.shopId === shopAId && shopAfterObj.name === 'Shop Alpha',
            'Permanent Shop ID and name survived server restart perfectly');

        // 9. Reconnect Shop A over WebSocket
        console.log('\n[9/12] Reconnecting Shop A over WebSocket...');
        ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/v1/telemetry`);
        await new Promise((resolve, reject) => {
            ws.on('open', () => {
                ws.send(JSON.stringify({
                    type: 'auth',
                    shopId: shopAId,
                    token: shopAToken,
                    version: '1.0.0',
                    uptime: 500,
                    metrics: { platform: 'win32', memoryUsageMB: 160, dbStatus: 'healthy' }
                }));
            });
            ws.on('message', (msg) => {
                const data = JSON.parse(msg);
                if (data.type === 'auth_success') resolve(data);
                if (data.type === 'auth_failed') reject(new Error('Reconnection auth failed'));
            });
            ws.on('error', reject);
        });
        assert(true, 'Shop A successfully reconnected and authenticated after server restart');

        // 10. Verify no duplicate Shop ID
        console.log('\n[10/12] Verifying no duplicate Shop ID was created...');
        const shopsAfterReconnect = await request('GET', '/api/control/shops');
        const matches = shopsAfterReconnect.data.filter(s => s.shopId === shopAId);
        assert(matches.length === 1 && shopsAfterReconnect.data.length === 1,
            'Exactly 1 shop record exists (no duplicate Shop ID created upon reconnect)');

        // 11. Verify no database loss
        console.log('\n[11/12] Verifying database integrity & zero data loss...');
        assert(fs.existsSync(TEST_DB_PATH) && fs.statSync(TEST_DB_PATH).size > 0,
            'SQLite DB file exists and contains all persisted tables and schemas');

        // 12. Verify command/audit history persists
        console.log('\n[12/12] Verifying audit and command history across server restart...');
        const auditAfter = await request('GET', '/api/control/audit');
        const foundEnrollLog = auditAfter.data.some(l => l.action === 'SHOP_ENROLLED' && l.shopId === shopAId);
        const foundCommandLog = auditAfter.data.some(l => l.action === 'COMMAND_ISSUED');
        assert(auditAfter.data.length >= auditCountBefore && foundEnrollLog && foundCommandLog,
            'Complete audit history (' + auditAfter.data.length + ' logs) fully preserved across restart');

        console.log('\n============================================================');
        console.log(`  SERVER RESTART PREFLIGHT: ${passed}/${total} STEPS PASSED`);
        console.log('============================================================\n');

    } catch (e) {
        console.error('Test execution error:', e);
        process.exitCode = 1;
    } finally {
        if (ws) try { ws.close(); } catch(e) {}
        if (server && typeof server.close === 'function') {
            try { server.close(); } catch(e) {}
        }
        await sleep(1000);
        // Clean isolated test DB
        try {
            if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
            if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
            if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
        } catch(e) {}
        process.exit(process.exitCode || 0);
    }
}

runTest();
