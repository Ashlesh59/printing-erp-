const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 5000;
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Setup SQLite
const dbFile = path.join(__dirname, 'cloud_control.db');
const db = new Database(dbFile);

db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
        shopId TEXT PRIMARY KEY,
        name TEXT,
        registeredAt INTEGER,
        status TEXT DEFAULT 'active',
        token TEXT
    );
    CREATE TABLE IF NOT EXISTS heartbeats (
        shopId TEXT PRIMARY KEY,
        version TEXT,
        uptime REAL,
        lastSeen INTEGER,
        status TEXT
    );
    CREATE TABLE IF NOT EXISTS remote_commands (
        id TEXT PRIMARY KEY,
        shopId TEXT,
        command TEXT,
        status TEXT,
        timestamp INTEGER,
        result TEXT
    );
    CREATE TABLE IF NOT EXISTS pending_orders (
        id TEXT PRIMARY KEY,
        shopId TEXT,
        name TEXT,
        phone TEXT,
        printType TEXT,
        paperSize TEXT,
        fileName TEXT,
        originalName TEXT,
        filePath TEXT,
        timestamp INTEGER
    );
`);

// API Endpoints

app.post('/api/register', (req, res) => {
    const shopId = crypto.randomUUID().split('-')[0].toUpperCase();
    const name = req.body.name || 'Unknown Shop';
    const stmt = db.prepare('INSERT INTO shops (shopId, name, registeredAt) VALUES (?, ?, ?)');
    stmt.run(shopId, name, Date.now());
    res.json({ success: true, shopId });
});

app.get('/api/health', (req, res) => {
    const shopCount = db.prepare('SELECT count(*) as count FROM shops').get().count;
    res.json({ status: 'online', shops: shopCount });
});

app.post('/api/control/command', (req, res) => {
    try {
        console.log(`[API] Received command for shop ${req.body.shopId}`);
        const { shopId, command } = req.body;
        
        const shop = db.prepare('SELECT * FROM shops WHERE shopId = ?').get(shopId);
        if (!shop) {
            return res.status(404).json({ success: false, message: 'Shop not found' });
        }
        
        if (shop.status === 'revoked') {
            return res.status(403).json({ success: false, message: 'Shop access revoked' });
        }

        const commandId = crypto.randomUUID();
        const timestamp = Date.now();
        
        // Cryptographic Signature Generation
        const payload = `${command}:${commandId}:${timestamp}`;
        const signature = crypto.createHmac('sha256', shop.token || 'default-token')
                                .update(payload)
                                .digest('hex');

        db.prepare('INSERT INTO remote_commands (id, shopId, command, status, timestamp) VALUES (?, ?, ?, ?, ?)')
          .run(commandId, shopId, command, 'pending', timestamp);

        if (wsClients.has(shopId)) {
            console.log(`[API] Broadcasting command ${commandId} to shop ${shopId}`);
            wsClients.get(shopId).send(JSON.stringify({
                type: 'remote_command',
                id: commandId,
                command,
                timestamp,
                signature
            }));
        } else {
            console.log(`[API] Shop ${shopId} not connected via WS`);
        }

        res.json({ success: true, commandId });
    } catch(err) {
        console.error('[API] Error in /command:', err);
        res.status(500).json({ error: err.message });
    }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/control/shops', (req, res) => {
    const shops = db.prepare('SELECT * FROM shops').all();
    const heartbeats = db.prepare('SELECT * FROM heartbeats').all();
    
    const results = shops.map(shop => {
        const hb = heartbeats.find(h => h.shopId === shop.shopId);
        let isOnline = false;
        if (hb) {
            isOnline = (Date.now() - hb.lastSeen) < 600000;
        }
        return { ...shop, heartbeat: hb, isOnline };
    });
    
    res.json(results);
});

app.get('/api/control/shop/:shopId', (req, res) => {
    const shopId = req.params.shopId;
    const shop = db.prepare('SELECT * FROM shops WHERE shopId = ?').get(shopId);
    const heartbeat = db.prepare('SELECT * FROM heartbeats WHERE shopId = ?').get(shopId);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    
    let isOnline = false;
    if (heartbeat) {
        const diff = Date.now() - heartbeat.lastSeen;
        isOnline = diff < 600000; // 10 mins
    }
    
    res.json({ ...shop, heartbeat, isOnline });
});

app.post('/api/admin/revoke', (req, res) => {
    const { shopId } = req.body;
    const shop = db.prepare('SELECT * FROM shops WHERE shopId = ?').get(shopId);
    if (!shop) return res.status(404).json({ success: false, error: 'Shop not found' });
    
    db.prepare('UPDATE shops SET status = ? WHERE shopId = ?').run('revoked', shopId);
    
    // Disconnect active WS
    if (wsClients.has(shopId)) {
        wsClients.get(shopId).close();
        wsClients.delete(shopId);
    }
    
    res.json({ success: true, message: 'Shop access revoked' });
});

// Create HTTP and WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/v1/telemetry' });

const wsClients = new Map(); // shopId -> ws

wss.on('connection', (ws, req) => {
    // In production, we would parse req.headers.authorization and validate the token.
    let connectedShopId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const { type, shopId, token } = data;

            if (type === 'auth') {
                // Auto-enroll for test if not exists
                let shop = db.prepare('SELECT * FROM shops WHERE shopId = ?').get(shopId);
                if (!shop) {
                    db.prepare('INSERT INTO shops (shopId, name, registeredAt, status, token) VALUES (?, ?, ?, ?, ?)')
                      .run(shopId, 'Auto-enrolled Shop', Date.now(), 'active', token || 'default-token');
                    shop = db.prepare('SELECT * FROM shops WHERE shopId = ?').get(shopId);
                }

                // Check Revocation and Token
                if (shop.status === 'revoked' || (shop.token && shop.token !== token)) {
                    ws.send(JSON.stringify({ type: 'auth_failed', reason: 'Unauthorized or revoked' }));
                    ws.close();
                    return;
                }

                connectedShopId = shopId;
                wsClients.set(shopId, ws);
                ws.send(JSON.stringify({ type: 'auth_success' }));
            }

            // Only process further messages if authenticated
            if (!connectedShopId) return;

            if (type === 'heartbeat' || type === 'auth') {
                db.prepare(`
                    INSERT INTO heartbeats (shopId, version, uptime, lastSeen, status) 
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(shopId) DO UPDATE SET 
                    version=excluded.version, uptime=excluded.uptime, lastSeen=excluded.lastSeen, status=excluded.status
                `).run(connectedShopId, data.version || '1.0.0', data.uptime || 0, Date.now(), 'online');
            }

            if (type === 'command_ack') {
                const { commandId, status } = data;
                db.prepare('UPDATE remote_commands SET status = ?, result = ? WHERE id = ?')
                  .run(status, JSON.stringify(data), commandId);
            }

        } catch (e) {
            console.error('WS Error:', e);
        }
    });

    ws.on('close', () => {
        if (connectedShopId) {
            wsClients.delete(connectedShopId);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Cloud Relay Server running on port ${PORT}`);
});

module.exports = server;
