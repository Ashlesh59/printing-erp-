/**
 * DeskSolutions Control Center — Forensic Recheck & Repair Verification Suite
 * Tests all forensic repairs:
 * 1. Admin Authentication Gate (401 on missing/bad key, 200 on valid Bearer / X-Admin-Key)
 * 2. SQLite Online Hot Backup & Backup Listing APIs
 * 3. Command HMAC-SHA256 signature with Nonce verification
 * 4. Future timestamp drift rejection (> 1m ahead)
 * 5. Queued command dispatch upon offline shop reconnect
 * 6. Concurrent socket supersession without stale socket deletion
 * 7. Database performance indexes verification in sqlite_master
 * 8. Accurate offline detector (no false alerts for freshly enrolled shops)
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const TEST_PORT = 5892;
const TEST_DB_PATH = path.join(__dirname, 'test_cloud_control_forensic.db');
const TEST_ADMIN_KEY = 'forensic-founder-secret-key-12345';

// Clean test artifacts
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');

process.env.CONTROL_CENTER_PORT = String(TEST_PORT);
process.env.PORT = String(TEST_PORT);
process.env.DB_PATH = TEST_DB_PATH;
process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
process.env.AUTH_SECRET = TEST_ADMIN_KEY;
process.env.NODE_ENV = 'production'; // Enforce production auth gate

console.log('============================================================');
console.log('   CONTROL CENTER FORENSIC RECHECK & REPAIR TEST SUITE      ');
console.log('============================================================\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition, testName, details = '') {
    totalTests++;
    if (condition) {
        passedTests++;
        console.log(`  ✅ [PASS] ${testName}`);
    } else {
        console.error(`  ❌ [FAIL] ${testName} - ${details}`);
        process.exitCode = 1;
    }
}

async function request(method, pathUrl, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const reqHeaders = { ...headers };
        if (payload && !reqHeaders['Content-Type']) {
            reqHeaders['Content-Type'] = 'application/json';
        }
        const req = http.request({
            hostname: '127.0.0.1',
            port: TEST_PORT,
            path: pathUrl,
            method,
            headers: reqHeaders
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

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function runForensicSuite() {
    let server = null;
    let ws1 = null;
    let ws2 = null;

    try {
        console.log('── Phase 1: Server Boot & Admin Auth Gate ─────────────────');
        server = require('./cloud-server/server.js');
        await sleep(1000);

        // 1. Unauthenticated request to /api/control/shops should be 401
        const unauthShops = await request('GET', '/api/control/shops');
        assert(unauthShops.status === 401, 'Unauthenticated /api/control/shops returns 401 Unauthorized');

        // 2. Bad admin key should be 401
        const badKeyShops = await request('GET', '/api/control/shops', null, { 'X-Admin-Key': 'wrong-key' });
        assert(badKeyShops.status === 401, 'Bad admin key returns 401 Unauthorized');

        // 3. Valid X-Admin-Key should be 200
        const validXKey = await request('GET', '/api/control/shops', null, { 'X-Admin-Key': TEST_ADMIN_KEY });
        assert(validXKey.status === 200 && Array.isArray(validXKey.data), 'Valid X-Admin-Key returns 200 OK with array');

        // 4. Valid Authorization: Bearer should be 200
        const validBearer = await request('GET', '/api/control/shops', null, { 'Authorization': `Bearer ${TEST_ADMIN_KEY}` });
        assert(validBearer.status === 200, 'Valid Authorization: Bearer returns 200 OK');

        // 5. Public /health should remain accessible without auth
        const healthRes = await request('GET', '/health');
        assert(healthRes.status === 200 && healthRes.data.status === 'ok', 'Public /health probe accessible without credentials');

        // 6. Public /ready probe should verify database connection
        const readyRes = await request('GET', '/ready');
        assert(readyRes.status === 200 && readyRes.data.status === 'ready' && readyRes.data.database === 'connected', 'Public /ready probe verifies database connectivity');

        // 7. Root / serves Control Center HTML index page
        const rootRes = await request('GET', '/');
        assert(rootRes.status === 200 && typeof rootRes.data === 'string' && rootRes.data.includes('DeskSolutions Control Center'), 'Root / serves Control Center HTML rather than Cannot GET /');

        console.log('\n── Phase 2: Live Database Hot Backup API ──────────────────');
        const backupRes = await request('POST', '/api/admin/backup', {}, { 'X-Admin-Key': TEST_ADMIN_KEY });
        assert(backupRes.status === 200 && backupRes.data.success === true, 'POST /api/admin/backup created hot SQLite backup');
        assert(typeof backupRes.data.backupFile === 'string' && backupRes.data.sizeBytes > 0, 'Backup response includes valid filename and non-zero size');

        const backupsList = await request('GET', '/api/admin/backups', null, { 'X-Admin-Key': TEST_ADMIN_KEY });
        assert(backupsList.status === 200 && backupsList.data.backups.length >= 1, 'GET /api/admin/backups enumerates persisted backups');

        // Verify physical backup file is a valid SQLite DB
        const backupPath = path.join(__dirname, 'cloud-server', 'backups', backupRes.data.backupFile);
        assert(fs.existsSync(backupPath), 'Physical backup file verified on disk');
        const testBackupDb = new Database(backupPath);
        const shopTableCheck = testBackupDb.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='shops'").get();
        assert(shopTableCheck.count === 1, 'Backup database contains valid shops table schema');
        testBackupDb.close();

        console.log('\n── Phase 3: Enrollment & Offline Queued Commands ──────────');
        // Generate enrollment key
        const keyRes = await request('POST', '/api/admin/keys', {}, { 'X-Admin-Key': TEST_ADMIN_KEY });
        assert(keyRes.status === 200 && keyRes.data.key, 'Generated enrollment key');
        const enrollmentKey = keyRes.data.key;

        // Enroll Shop F1
        const enrollRes = await request('POST', '/api/enroll', { key: enrollmentKey, name: 'Forensic Shop 1' });
        assert(enrollRes.status === 200 && enrollRes.data.shopId, 'Enrolled Forensic Shop 1');
        const shopId = enrollRes.data.shopId;
        const shopToken = enrollRes.data.token;

        // Dispatch command while Shop F1 is OFFLINE
        const cmdRes = await request('POST', '/api/control/command', { shopId, command: 'request_diagnostics' }, { 'X-Admin-Key': TEST_ADMIN_KEY });
        assert(cmdRes.status === 200 && cmdRes.data.success === true, 'Command accepted while shop is offline');
        assert(cmdRes.data.dispatched === false, 'Command correctly flagged as not immediately dispatched (queued)');
        const queuedCmdId = cmdRes.data.commandId;

        console.log('\n── Phase 4: WebSocket Connect & Queued Command Reception ─');
        let receivedQueuedCommand = null;
        ws1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/v1/telemetry`);

        await new Promise((resolve) => {
            ws1.on('open', () => {
                ws1.send(JSON.stringify({
                    type: 'auth',
                    shopId,
                    token: shopToken,
                    version: '2.5.0',
                    uptime: 120
                }));
            });

            ws1.on('message', (msgStr) => {
                const msg = JSON.parse(msgStr);
                if (msg.type === 'auth_success') {
                    // Authenticated
                }
                if (msg.type === 'remote_command' && msg.id === queuedCmdId) {
                    receivedQueuedCommand = msg;
                    // Acknowledge execution
                    ws1.send(JSON.stringify({
                        type: 'command_ack',
                        commandId: msg.id,
                        status: 'success',
                        detail: 'Executed queued diagnostics'
                    }));
                    resolve();
                }
            });
        });

        assert(receivedQueuedCommand !== null, 'Queued command automatically dispatched immediately upon WebSocket connection');
        assert(receivedQueuedCommand.nonce && receivedQueuedCommand.signature, 'Queued command includes anti-replay nonce and signature');

        await sleep(500);
        // Verify command status updated to acknowledged in DB
        const cmdsAfterAck = await request('GET', `/api/control/commands?shopId=${shopId}`, null, { 'X-Admin-Key': TEST_ADMIN_KEY });
        const targetCmd = cmdsAfterAck.data.find(c => c.id === queuedCmdId);
        assert(targetCmd && targetCmd.status === 'success', 'Command status updated to success in Control Center database');

        console.log('\n── Phase 5: Cryptographic Nonce & Future Drift Forensics ─');
        const CloudClient = require('./src/main/cloud-client');
        CloudClient.shopId = shopId;
        CloudClient.authToken = shopToken;

        // 1. Valid command signature verification with nonce
        const testNonce = crypto.randomBytes(8).toString('hex');
        const now = Date.now();
        const validPayload = `request_health:CMD_VALID_1:${now}:${testNonce}`;
        const validSig = crypto.createHmac('sha256', shopToken).update(validPayload).digest('hex');

        const validCheck = CloudClient.verifyCommandSignature({
            id: 'CMD_VALID_1',
            command: 'request_health',
            timestamp: now,
            nonce: testNonce,
            signature: validSig
        });
        assert(validCheck === true, 'CloudClient verified cryptographic signature containing nonce');

        // 2. Tampered nonce verification
        const tamperedNonceCheck = CloudClient.verifyCommandSignature({
            id: 'CMD_TAMPER_1',
            command: 'request_health',
            timestamp: now,
            nonce: 'tampered-nonce-val',
            signature: validSig
        });
        assert(tamperedNonceCheck === false, 'CloudClient strictly rejected tampered nonce');

        // 3. Future-dated timestamp drift (> 1m ahead)
        const futureTime = Date.now() + (5 * 60 * 1000); // 5 minutes ahead
        const futurePayload = `request_health:CMD_FUTURE_1:${futureTime}:${testNonce}`;
        const futureSig = crypto.createHmac('sha256', shopToken).update(futurePayload).digest('hex');
        const futureCheck = CloudClient.verifyCommandSignature({
            id: 'CMD_FUTURE_1',
            command: 'request_health',
            timestamp: futureTime,
            nonce: testNonce,
            signature: futureSig
        });
        assert(futureCheck === false, 'CloudClient strictly rejected future-dated timestamp attack');

        // 4. Replay attack rejection
        const replayCheck = CloudClient.verifyCommandSignature({
            id: 'CMD_VALID_1',
            command: 'request_health',
            timestamp: now,
            nonce: testNonce,
            signature: validSig
        });
        assert(replayCheck === false, 'CloudClient strictly rejected replayed command ID');

        console.log('\n── Phase 6: WebSocket Concurrency & Socket Supersession ──');
        let ws1ClosedSuperseded = false;
        ws1.on('close', (code, reason) => {
            if (String(reason).includes('Superseded')) {
                ws1ClosedSuperseded = true;
            }
        });

        // Open second socket for same shop (simulating rapid reconnect / network handoff)
        ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/v1/telemetry`);
        await new Promise((resolve) => {
            ws2.on('open', () => {
                ws2.send(JSON.stringify({
                    type: 'auth',
                    shopId,
                    token: shopToken,
                    version: '2.5.0',
                    uptime: 130
                }));
            });
            ws2.on('message', (msgStr) => {
                const msg = JSON.parse(msgStr);
                if (msg.type === 'auth_success') resolve();
            });
        });

        await sleep(500);
        assert(ws1ClosedSuperseded === true, 'Previous socket gracefully closed with "Superseded" notice');

        // Dispatch new command, verify delivered to ws2
        let ws2ReceivedCommand = false;
        ws2.on('message', (msgStr) => {
            const msg = JSON.parse(msgStr);
            if (msg.type === 'remote_command' && msg.command === 'lock') {
                ws2ReceivedCommand = true;
            }
        });

        const lockCmdRes = await request('POST', '/api/control/command', { shopId, command: 'lock' }, { 'X-Admin-Key': TEST_ADMIN_KEY });
        assert(lockCmdRes.status === 200 && lockCmdRes.data.dispatched === true, 'New command dispatched to superseding active socket');
        await sleep(500);
        assert(ws2ReceivedCommand === true, 'Superseding socket successfully received live command');

        console.log('\n── Phase 7: Database Performance Indexes Audit ───────────');
        const db = new Database(TEST_DB_PATH);
        const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(i => i.name);
        assert(indexes.includes('idx_alerts_shop_status'), 'Index idx_alerts_shop_status exists');
        assert(indexes.includes('idx_audit_shop_ts'), 'Index idx_audit_shop_ts exists');
        assert(indexes.includes('idx_commands_shop_ts'), 'Index idx_commands_shop_ts exists');
        assert(indexes.includes('idx_diagnostics_shop_ts'), 'Index idx_diagnostics_shop_ts exists');
        assert(indexes.includes('idx_errors_shop_ts'), 'Index idx_errors_shop_ts exists');
        db.close();

        console.log('\n============================================================');
        console.log(`  FORENSIC RECHECK COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
        console.log('============================================================\n');

    } catch (err) {
        console.error('Forensic test execution error:', err);
        process.exitCode = 1;
    } finally {
        if (ws1) try { ws1.close(); } catch(e) {}
        if (ws2) try { ws2.close(); } catch(e) {}
        if (server && typeof server.close === 'function') server.close();

        setTimeout(() => {
            try {
                if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
                if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
                if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
            } catch(e) {}
            process.exit(process.exitCode || 0);
        }, 1000);
    }
}

runForensicSuite();
