const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const SERVER_PORT = 5006;
const CLOUD_URL = `http://127.0.0.1:${SERVER_PORT}`;
const DB_PATH = path.join(__dirname, 'cloud_control.db');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startServer() {
    process.env.PORT = SERVER_PORT;
    process.env.DB_PATH = 'cloud_control.db';
    
    // We can require the server directly in the same Electron process.
    // The server listens on the configured PORT.
    return require('./cloud-server/server');
}

async function runTest() {
    console.log("Starting Burn-In Multi-Shop Verification...");
    
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    const server = await startServer();
    console.log("✅ Control Center Server started.");

    try {
        const db = new Database(DB_PATH);
        
        console.log("-> Testing Enrollment & Security...");
        
        let keys = [];
        for (let i = 0; i < 3; i++) {
            const res = await fetch(`${CLOUD_URL}/api/admin/keys`, { method: 'POST' });
            const data = await res.json();
            keys.push(data.key);
        }
        
        const enroll = async (key, name) => {
            const res = await fetch(`${CLOUD_URL}/api/enroll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, name })
            });
            return res.json();
        };

        const shopA = await enroll(keys[0], 'Shop A');
        const shopB = await enroll(keys[1], 'Shop B');
        const shopC = await enroll(keys[2], 'Shop C');
        
        if (shopA.success && shopB.success && shopC.success) {
            console.log("✅ Shop A, B, C successfully enrolled.");
        } else {
            throw new Error("Failed to enroll shops");
        }

        if (shopA.shopId !== shopB.shopId && shopB.shopId !== shopC.shopId && shopA.shopId !== shopC.shopId) {
            console.log("✅ Unique Shop IDs verified.");
        } else {
            throw new Error("Shop IDs are not unique!");
        }
        
        const rejectEnroll = await enroll(keys[0], 'Shop Hacker');
        if (!rejectEnroll.success) {
            console.log("✅ Second redemption of key rejected.");
        } else {
            throw new Error("Reused key was accepted!");
        }
        
        console.log("-> Testing Isolation & Remote Commands...");
        
        const WebSocket = require('ws');
        const connectWs = (shopId, token) => {
            return new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/v1/telemetry`, {
                    headers: { 'x-shop-id': shopId, 'x-auth-token': token }
                });
                ws.on('open', () => {
                    ws.send(JSON.stringify({
                        type: 'auth',
                        shopId: shopId,
                        token: token,
                        version: '1.0.0',
                        timestamp: Date.now()
                    }));
                    resolve(ws);
                });
                ws.on('error', reject);
            });
        };

        const wsA = await connectWs(shopA.shopId, shopA.token);
        const wsB = await connectWs(shopB.shopId, shopB.token);
        console.log("✅ Shop A and B connected via WebSocket.");

        let aCommandReceived = false;
        let bCommandReceived = false;

        wsA.on('message', msg => {
            const payload = JSON.parse(msg);
            if (payload.type === 'remote_command') aCommandReceived = true;
        });
        
        wsB.on('message', msg => {
            const payload = JSON.parse(msg);
            if (payload.type === 'remote_command') bCommandReceived = true;
        });

        await fetch(`${CLOUD_URL}/api/control/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shopId: shopA.shopId, command: 'lock' })
        });

        await sleep(1000);
        
        if (aCommandReceived && !bCommandReceived) {
            console.log("✅ Command isolation verified (Command only reached Shop A).");
        } else {
            throw new Error("Command isolation failed!");
        }

        wsA.close();
        wsB.close();

        console.log("✅ ALL BURN-IN API TESTS PASSED.");
    } catch (err) {
        console.error("❌ TEST FAILED:", err);
        process.exitCode = 1;
    } finally {
        // Exit process
        setTimeout(() => process.exit(), 1000);
    }
}

runTest();
