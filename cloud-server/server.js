const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const app = express();

// Trust reverse proxy (Nginx, Caddy, Cloudflare, AWS ALB) for accurate client IP in req.ip
app.enable('trust proxy');

// Security Response Headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Environment Configuration with Sensible Defaults
const NODE_ENV = process.env.NODE_ENV || 'development';
const HOST = process.env.CONTROL_CENTER_HOST || '0.0.0.0';
const PORT = parseInt(process.env.CONTROL_CENTER_PORT || process.env.PORT || '5000', 10);
const ENROLLMENT_KEY_TTL = parseInt(process.env.ENROLLMENT_KEY_TTL, 10) || (24 * 60 * 60 * 1000); // Default: 24h
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.CONTROL_CENTER_SECRET || null;
const COMMAND_SIGNING_SECRET = process.env.COMMAND_SIGNING_SECRET || null;

// Dynamic CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) 
    : (NODE_ENV === 'production' ? ['https://control.desksolutions.in', 'https://desksolutions.in'] : ['*']);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else if (NODE_ENV === 'production') {
            callback(new Error(`Origin ${origin} not allowed by CORS`));
        } else {
            callback(null, true); // Permissive for local development & API access
        }
    },
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const dbFile = process.env.DB_PATH 
    ? (path.isAbsolute(process.env.DB_PATH) ? process.env.DB_PATH : path.resolve(process.cwd(), process.env.DB_PATH))
    : path.join(__dirname, 'cloud_control.db');

const dbDir = path.dirname(dbFile);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const uploadsDir = process.env.UPLOADS_DIR 
    ? (path.isAbsolute(process.env.UPLOADS_DIR) ? process.env.UPLOADS_DIR : path.resolve(process.cwd(), process.env.UPLOADS_DIR))
    : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Setup SQLite with Full Persistence Schema
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
        shopId TEXT PRIMARY KEY,
        name TEXT,
        registeredAt INTEGER,
        status TEXT DEFAULT 'active',
        token TEXT,
        metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS heartbeats (
        shopId TEXT PRIMARY KEY,
        version TEXT,
        uptime REAL,
        lastSeen INTEGER,
        status TEXT,
        ip TEXT,
        hostname TEXT,
        memoryUsage REAL,
        cpuUsage REAL,
        dbStatus TEXT,
        metrics TEXT
    );
    CREATE TABLE IF NOT EXISTS remote_commands (
        id TEXT PRIMARY KEY,
        shopId TEXT,
        command TEXT,
        status TEXT,
        timestamp INTEGER,
        expiresAt INTEGER,
        nonce TEXT,
        signature TEXT,
        result TEXT,
        executedAt INTEGER,
        ackedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS enrollment_keys (
        key TEXT PRIMARY KEY,
        used INTEGER DEFAULT 0,
        shopId TEXT,
        createdAt INTEGER,
        expiresAt INTEGER,
        revoked INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        shopId TEXT,
        type TEXT,
        severity TEXT,
        message TEXT,
        details TEXT,
        timestamp INTEGER,
        status TEXT DEFAULT 'active',
        resolvedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        shopId TEXT,
        action TEXT,
        actor TEXT,
        details TEXT,
        timestamp INTEGER,
        ip TEXT
    );
    CREATE TABLE IF NOT EXISTS diagnostics (
        id TEXT PRIMARY KEY,
        shopId TEXT,
        metrics TEXT,
        health TEXT,
        timestamp INTEGER
    );
    CREATE TABLE IF NOT EXISTS errors (
        id TEXT PRIMARY KEY,
        shopId TEXT,
        errorType TEXT,
        message TEXT,
        stack TEXT,
        timestamp INTEGER,
        resolved INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS updates (
        shopId TEXT PRIMARY KEY,
        installedVersion TEXT,
        availableVersion TEXT,
        status TEXT,
        progress INTEGER DEFAULT 0,
        lastChecked INTEGER,
        error TEXT
    );
`);

// Automatic schema migrations for existing databases
try { db.exec('ALTER TABLE enrollment_keys ADD COLUMN revoked INTEGER DEFAULT 0;'); } catch(e) {}
try { db.exec('ALTER TABLE shops ADD COLUMN metadata TEXT;'); } catch(e) {}
try { db.exec('ALTER TABLE heartbeats ADD COLUMN ip TEXT;'); } catch(e) {}
try { db.exec('ALTER TABLE heartbeats ADD COLUMN hostname TEXT;'); } catch(e) {}
try { db.exec('ALTER TABLE heartbeats ADD COLUMN memoryUsage REAL;'); } catch(e) {}
try { db.exec('ALTER TABLE heartbeats ADD COLUMN cpuUsage REAL;'); } catch(e) {}
try { db.exec('ALTER TABLE heartbeats ADD COLUMN dbStatus TEXT;'); } catch(e) {}
try { db.exec('ALTER TABLE heartbeats ADD COLUMN metrics TEXT;'); } catch(e) {}
try { db.exec('ALTER TABLE remote_commands ADD COLUMN expiresAt INTEGER;'); } catch(e) {}
try { db.exec('ALTER TABLE remote_commands ADD COLUMN nonce TEXT;'); } catch(e) {}
try { db.exec('ALTER TABLE remote_commands ADD COLUMN signature TEXT;'); } catch(e) {}
try { db.exec('ALTER TABLE remote_commands ADD COLUMN ackedAt INTEGER;'); } catch(e) {}
try { db.exec('ALTER TABLE remote_commands ADD COLUMN executedAt INTEGER;'); } catch(e) {}

// Database Performance Indexes (optimizes 24/7 lookups and prevents full-table scans)
try {
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_alerts_shop_status ON alerts(shopId, status);
        CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_shop_ts ON audit_logs(shopId, timestamp);
        CREATE INDEX IF NOT EXISTS idx_commands_shop_ts ON remote_commands(shopId, timestamp);
        CREATE INDEX IF NOT EXISTS idx_commands_status ON remote_commands(status);
        CREATE INDEX IF NOT EXISTS idx_diagnostics_shop_ts ON diagnostics(shopId, timestamp);
        CREATE INDEX IF NOT EXISTS idx_errors_shop_ts ON errors(shopId, timestamp);
    `);
} catch(e) {
    console.warn('[DB] Index creation notice:', e.message);
}

// Database Backups Directory
const backupsDir = process.env.BACKUPS_DIR || process.env.BACKUP_PATH
    ? (path.isAbsolute(process.env.BACKUPS_DIR || process.env.BACKUP_PATH)
        ? (process.env.BACKUPS_DIR || process.env.BACKUP_PATH)
        : path.resolve(process.cwd(), process.env.BACKUPS_DIR || process.env.BACKUP_PATH))
    : path.join(__dirname, 'backups');
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

// Helpers
function logAudit(shopId, action, actor, details, ip = '127.0.0.1') {
    try {
        const id = crypto.randomUUID();
        const timestamp = Date.now();
        const detailsStr = typeof details === 'object' ? JSON.stringify(details) : String(details || '');
        db.prepare('INSERT INTO audit_logs (id, shopId, action, actor, details, timestamp, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, shopId || 'GLOBAL', action, actor || 'SYSTEM', detailsStr, timestamp, ip);
    } catch (e) {
        console.error('[Audit] Failed to record audit log:', e.message);
    }
}

function createAlert(shopId, type, severity, message, details = '') {
    try {
        // Throttling / Deduplication: check if active alert of same type and shop exists within last 5 minutes
        const recent = db.prepare(`
            SELECT id FROM alerts 
            WHERE shopId = ? AND type = ? AND status = 'active' AND timestamp > ?
            LIMIT 1
        `).get(shopId, type, Date.now() - 300000);

        if (recent) {
            // Update timestamp & message instead of spamming duplicates
            db.prepare('UPDATE alerts SET timestamp = ?, message = ?, details = ? WHERE id = ?')
              .run(Date.now(), message, typeof details === 'object' ? JSON.stringify(details) : details, recent.id);
            return recent.id;
        }

        const id = crypto.randomUUID();
        const timestamp = Date.now();
        const detailsStr = typeof details === 'object' ? JSON.stringify(details) : String(details || '');
        db.prepare(`
            INSERT INTO alerts (id, shopId, type, severity, message, details, timestamp, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        `).run(id, shopId, type, severity, message, detailsStr, timestamp);

        logAudit(shopId, 'ALERT_TRIGGERED', 'MONITOR', `[${severity.toUpperCase()}] ${type}: ${message}`);
        return id;
    } catch (e) {
        console.error('[Alert] Failed to create alert:', e.message);
    }
}

// Admin Authentication Middleware (guards administrative and control endpoints)
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || AUTH_SECRET || null;

function requireAdminAuth(req, res, next) {
    if (!ADMIN_API_KEY) {
        if (NODE_ENV === 'production') {
            console.error('[Security] Blocked unauthenticated admin request in production: No ADMIN_API_KEY or AUTH_SECRET configured.');
            return res.status(500).json({ success: false, error: 'Server misconfiguration: Admin authentication secret required in production' });
        }
        // In local development or test mode without configured secret, allow access
        return next();
    }

    const authHeader = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : null;
    const customHeader = req.headers['x-admin-key'] || req.headers['x-admin-secret'] || null;
    const queryKey = req.query ? req.query.admin_key : null;

    const providedKey = bearerToken || customHeader || queryKey;
    if (!providedKey) {
        logAudit('GLOBAL', 'ADMIN_AUTH_FAILED', 'ANONYMOUS', `Missing credentials on ${req.method} ${req.path}`, req.ip);
        return res.status(401).json({ success: false, error: 'Authentication required: Missing admin key' });
    }

    const keyBuf = Buffer.from(String(providedKey));
    const expectedBuf = Buffer.from(String(ADMIN_API_KEY));
    if (keyBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(keyBuf, expectedBuf)) {
        logAudit('GLOBAL', 'ADMIN_AUTH_FAILED', 'ANONYMOUS', `Invalid admin key on ${req.method} ${req.path}`, req.ip);
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid admin credentials' });
    }

    next();
}

// ──────────────────────────────────────────────────────────────
//  Admin & Enrollment APIs
// ──────────────────────────────────────────────────────────────

app.post('/api/admin/keys', requireAdminAuth, (req, res) => {
    try {
        const key = 'DK-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const createdAt = Date.now();
        const expiresAt = createdAt + ENROLLMENT_KEY_TTL;
        
        db.prepare('INSERT INTO enrollment_keys (key, createdAt, expiresAt, used, revoked) VALUES (?, ?, ?, 0, 0)')
          .run(key, createdAt, expiresAt);
          
        logAudit('GLOBAL', 'ENROLLMENT_KEY_GENERATED', 'ADMIN', `Key: ${key}`, req.ip);
        res.json({ success: true, key, expiresAt });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/keys', requireAdminAuth, (req, res) => {
    try {
        const keys = db.prepare('SELECT * FROM enrollment_keys ORDER BY createdAt DESC LIMIT 50').all();
        const now = Date.now();
        const mapped = keys.map(k => ({
            ...k,
            isExpired: now > k.expiresAt,
            status: k.revoked ? 'REVOKED' : (k.used ? 'USED' : (now > k.expiresAt ? 'EXPIRED' : 'ACTIVE'))
        }));
        res.json({ success: true, keys: mapped });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/keys/revoke', requireAdminAuth, (req, res) => {
    try {
        const { key } = req.body || {};
        if (!key || typeof key !== 'string') return res.status(400).json({ success: false, message: 'Valid key is required' });
        
        const row = db.prepare('SELECT * FROM enrollment_keys WHERE key = ?').get(key);
        if (!row) return res.status(404).json({ success: false, message: 'Key not found' });
        
        db.prepare('UPDATE enrollment_keys SET revoked = 1 WHERE key = ?').run(key);
        logAudit('GLOBAL', 'ENROLLMENT_KEY_REVOKED', 'ADMIN', `Key: ${key}`, req.ip);
        res.json({ success: true, message: 'Key revoked successfully' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Database Online Backup APIs (WAL-safe backup without server interruption)
app.post('/api/admin/backup', requireAdminAuth, async (req, res) => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFileName = `cloud_control_backup_${timestamp}.db`;
        const backupPath = path.join(backupsDir, backupFileName);

        await db.backup(backupPath);
        const stats = fs.statSync(backupPath);
        
        logAudit('GLOBAL', 'DATABASE_BACKUP_CREATED', 'ADMIN', `Backup created: ${backupFileName} (${stats.size} bytes)`, req.ip);
        res.json({
            success: true,
            backupFile: backupFileName,
            sizeBytes: stats.size,
            timestamp: Date.now()
        });
    } catch (e) {
        console.error('[Backup] Failed to create database backup:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/backups', requireAdminAuth, (req, res) => {
    try {
        if (!fs.existsSync(backupsDir)) {
            return res.json({ success: true, backups: [] });
        }
        const files = fs.readdirSync(backupsDir)
            .filter(f => f.endsWith('.db'))
            .map(f => {
                const stat = fs.statSync(path.join(backupsDir, f));
                return {
                    name: f,
                    sizeBytes: stat.size,
                    createdAt: stat.mtimeMs
                };
            })
            .sort((a, b) => b.createdAt - a.createdAt);

        res.json({ success: true, backups: files });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/enroll', (req, res) => {
    const { key, name } = req.body;
    const ip = req.ip || '127.0.0.1';

    if (!key) {
        logAudit('UNKNOWN', 'ENROLLMENT_REJECTED', 'SYSTEM', 'Missing key in enrollment attempt', ip);
        return res.status(400).json({ success: false, message: 'Enrollment key required' });
    }

    try {
        const result = db.transaction(() => {
            const row = db.prepare('SELECT * FROM enrollment_keys WHERE key = ?').get(key);
            if (!row) {
                logAudit('UNKNOWN', 'ENROLLMENT_REJECTED', 'SYSTEM', `Invalid key: ${key}`, ip);
                return { status: 404, data: { success: false, message: 'Invalid enrollment key' } };
            }
            if (row.revoked) {
                logAudit(row.shopId || 'UNKNOWN', 'ENROLLMENT_REJECTED', 'SYSTEM', `Revoked key used: ${key}`, ip);
                return { status: 403, data: { success: false, message: 'Key has been revoked' } };
            }
            if (row.used) {
                logAudit(row.shopId || 'UNKNOWN', 'ENROLLMENT_REJECTED', 'SYSTEM', `Reused key attempt: ${key}`, ip);
                return { status: 403, data: { success: false, message: 'Key already used' } };
            }
            if (Date.now() > row.expiresAt) {
                logAudit('UNKNOWN', 'ENROLLMENT_REJECTED', 'SYSTEM', `Expired key attempt: ${key}`, ip);
                return { status: 403, data: { success: false, message: 'Key expired' } };
            }

            const shopId = 'SHOP_' + crypto.randomBytes(6).toString('hex').toUpperCase();
            const token = crypto.randomBytes(32).toString('hex');
            const shopName = name || `PrintShop ${shopId.substring(5, 9)}`;

            // Mark key as used
            db.prepare('UPDATE enrollment_keys SET used = 1, shopId = ? WHERE key = ?').run(shopId, key);

            // Register permanent shop identity
            db.prepare('INSERT INTO shops (shopId, name, registeredAt, status, token, metadata) VALUES (?, ?, ?, ?, ?, ?)')
              .run(shopId, shopName, Date.now(), 'active', token, JSON.stringify({ enrolledIp: ip, enrolledWithKey: key }));

            logAudit(shopId, 'SHOP_ENROLLED', 'SYSTEM', `Enrolled as "${shopName}" with key ${key}`, ip);
            return { status: 200, data: { success: true, shopId, token, name: shopName } };
        })();

        res.status(result.status).json(result.data);
    } catch (e) {
        console.error('[Enroll] Transaction error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ──────────────────────────────────────────────────────────────
//  Health & Overview API
// ──────────────────────────────────────────────────────────────

// Standard container / load balancer liveness probe
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()), timestamp: Date.now() });
});

// Container / orchestrator readiness probe (verifies database query execution)
app.get('/ready', (req, res) => {
    try {
        db.prepare('SELECT 1').get();
        res.json({ status: 'ready', database: 'connected', timestamp: Date.now() });
    } catch (e) {
        res.status(503).json({ status: 'not_ready', database: 'error', error: e.message });
    }
});

app.get('/api/health', (req, res) => {
    try {
        const totalShops = db.prepare('SELECT count(*) as count FROM shops').get().count;
        const heartbeats = db.prepare('SELECT * FROM heartbeats').all();
        const activeAlerts = db.prepare("SELECT count(*) as count FROM alerts WHERE status = 'active'").get().count;
        const now = Date.now();
        const onlineShops = heartbeats.filter(h => (now - h.lastSeen) < 600000).length;

        res.json({
            status: 'online',
            shops: totalShops,
            onlineShops,
            offlineShops: Math.max(0, totalShops - onlineShops),
            activeAlerts,
            timestamp: now
        });
    } catch (e) {
        res.status(500).json({ status: 'error', error: e.message });
    }
});

// ──────────────────────────────────────────────────────────────
//  Control Center Fleet Monitoring & Shop Inspection APIs
// ──────────────────────────────────────────────────────────────

app.get('/api/control/shops', requireAdminAuth, (req, res) => {
    try {
        const shops = db.prepare('SELECT * FROM shops ORDER BY registeredAt DESC').all();
        const heartbeats = db.prepare('SELECT * FROM heartbeats').all();
        const alerts = db.prepare("SELECT shopId, count(*) as alertCount FROM alerts WHERE status = 'active' GROUP BY shopId").all();
        const updates = db.prepare('SELECT * FROM updates').all();
        const now = Date.now();

        const results = shops.map(shop => {
            const hb = heartbeats.find(h => h.shopId === shop.shopId);
            const alertInfo = alerts.find(a => a.shopId === shop.shopId);
            const updateInfo = updates.find(u => u.shopId === shop.shopId);
            
            const isOnline = !!(hb && (now - hb.lastSeen) < 600000 && shop.status !== 'revoked');
            let metricsObj = {};
            try { if (hb && hb.metrics) metricsObj = JSON.parse(hb.metrics); } catch(e) {}

            return {
                shopId: shop.shopId,
                name: shop.name,
                registeredAt: shop.registeredAt,
                status: shop.status,
                isOnline,
                heartbeat: hb ? {
                    version: hb.version,
                    uptime: hb.uptime,
                    lastSeen: hb.lastSeen,
                    status: hb.status,
                    memoryUsage: hb.memoryUsage || metricsObj.memoryUsageMB,
                    dbStatus: hb.dbStatus || metricsObj.dbStatus || 'healthy'
                } : null,
                activeAlerts: alertInfo ? alertInfo.alertCount : 0,
                updateStatus: updateInfo ? updateInfo.status : 'UP_TO_DATE'
            };
        });

        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/control/shop/:shopId', requireAdminAuth, (req, res) => {
    try {
        const { shopId } = req.params;
        const shop = db.prepare('SELECT shopId, name, registeredAt, status, metadata FROM shops WHERE shopId = ?').get(shopId);
        if (!shop) return res.status(404).json({ error: 'Shop not found' });

        const heartbeat = db.prepare('SELECT * FROM heartbeats WHERE shopId = ?').get(shopId);
        const activeAlerts = db.prepare("SELECT * FROM alerts WHERE shopId = ? AND status = 'active' ORDER BY timestamp DESC").all(shopId);
        const recentCommands = db.prepare('SELECT * FROM remote_commands WHERE shopId = ? ORDER BY timestamp DESC LIMIT 10').all(shopId);
        const recentErrors = db.prepare('SELECT * FROM errors WHERE shopId = ? ORDER BY timestamp DESC LIMIT 10').all(shopId);
        const recentDiagnostics = db.prepare('SELECT * FROM diagnostics WHERE shopId = ? ORDER BY timestamp DESC LIMIT 5').all(shopId);
        const updateInfo = db.prepare('SELECT * FROM updates WHERE shopId = ?').get(shopId);

        const now = Date.now();
        const isOnline = !!(heartbeat && (now - heartbeat.lastSeen) < 600000 && shop.status !== 'revoked');

        res.json({
            ...shop,
            isOnline,
            heartbeat: heartbeat || null,
            activeAlerts,
            recentCommands,
            recentErrors,
            recentDiagnostics,
            updateInfo: updateInfo || null
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/revoke', requireAdminAuth, (req, res) => {
    try {
        const { shopId } = req.body || {};
        if (!shopId || typeof shopId !== 'string') return res.status(400).json({ success: false, error: 'Valid shopId is required' });
        
        const shop = db.prepare('SELECT * FROM shops WHERE shopId = ?').get(shopId);
        if (!shop) return res.status(404).json({ success: false, error: 'Shop not found' });
        
        db.prepare("UPDATE shops SET status = 'revoked' WHERE shopId = ?").run(shopId);
        
        // Disconnect active WS
        if (wsClients.has(shopId)) {
            try {
                wsClients.get(shopId).send(JSON.stringify({ type: 'auth_failed', reason: 'Shop access revoked' }));
                wsClients.get(shopId).close();
            } catch(e) {}
            wsClients.delete(shopId);
        }
        
        logAudit(shopId, 'SHOP_REVOKED', 'ADMIN', `Revoked access for shop ${shopId}`, req.ip);
        createAlert(shopId, 'SHOP_REVOKED', 'warning', `Shop access has been administratively revoked`);
        
        res.json({ success: true, message: 'Shop access revoked' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ──────────────────────────────────────────────────────────────
//  Safe Remote Command Control APIs
// ──────────────────────────────────────────────────────────────

const ALLOWED_COMMANDS = new Set([
    'lock',
    'restart',
    'request_diagnostics',
    'diagnostics',
    'request_health',
    'health',
    'request_backup',
    'force_backup',
    'check_updates',
    'reconnect',
    'clear_cache'
]);

app.post('/api/control/command', requireAdminAuth, (req, res) => {
    try {
        const { shopId, command } = req.body || {};
        if (!shopId || typeof shopId !== 'string' || !command || typeof command !== 'string') {
            return res.status(400).json({ success: false, message: 'shopId and command must be strings' });
        }

        // Strict capability whitelist validation
        if (!ALLOWED_COMMANDS.has(command)) {
            logAudit(shopId, 'COMMAND_REJECTED', 'ADMIN', `Disallowed command attempt: ${command}`, req.ip);
            return res.status(400).json({ success: false, message: `Disallowed command capability: ${command}` });
        }

        const shop = db.prepare('SELECT * FROM shops WHERE shopId = ?').get(shopId);
        if (!shop) {
            return res.status(404).json({ success: false, message: 'Shop not found' });
        }
        
        if (shop.status === 'revoked') {
            return res.status(403).json({ success: false, message: 'Shop access revoked' });
        }

        const commandId = crypto.randomUUID();
        const timestamp = Date.now();
        const expiresAt = timestamp + 5 * 60 * 1000; // 5 min TTL
        const nonce = crypto.randomBytes(8).toString('hex');
        
        // Cryptographic Signature Generation: HMAC-SHA256(command:commandId:timestamp:nonce)
        const payload = `${command}:${commandId}:${timestamp}:${nonce}`;
        const signingKey = shop.token || COMMAND_SIGNING_SECRET;
        if (!signingKey) {
            logAudit(shopId, 'COMMAND_REJECTED', 'ADMIN', 'No signing key available for shop', req.ip);
            return res.status(500).json({ success: false, message: 'No cryptographic signing key configured for shop' });
        }
        const signature = crypto.createHmac('sha256', signingKey)
                                .update(payload)
                                .digest('hex');

        db.prepare(`
            INSERT INTO remote_commands (id, shopId, command, status, timestamp, expiresAt, nonce, signature)
            VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
        `).run(commandId, shopId, command, timestamp, expiresAt, nonce, signature);

        logAudit(shopId, 'COMMAND_ISSUED', 'ADMIN', `Dispatched command "${command}" [ID: ${commandId}]`, req.ip);

        // Dispatch over WebSocket if currently connected
        let dispatched = false;
        if (wsClients.has(shopId)) {
            const clientWs = wsClients.get(shopId);
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                    type: 'remote_command',
                    id: commandId,
                    command,
                    timestamp,
                    expiresAt,
                    nonce,
                    signature
                }));
                dispatched = true;
                db.prepare("UPDATE remote_commands SET status = 'dispatched' WHERE id = ?").run(commandId);
            }
        }

        res.json({ success: true, commandId, dispatched });
    } catch(err) {
        console.error('[API] Error in /control/command:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/control/commands', requireAdminAuth, (req, res) => {
    try {
        const { shopId } = req.query;
        let commands;
        if (shopId) {
            commands = db.prepare('SELECT * FROM remote_commands WHERE shopId = ? ORDER BY timestamp DESC LIMIT 50').all(shopId);
        } else {
            commands = db.prepare('SELECT * FROM remote_commands ORDER BY timestamp DESC LIMIT 50').all();
        }
        res.json(commands);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ──────────────────────────────────────────────────────────────
//  Alerts & Notifications APIs
// ──────────────────────────────────────────────────────────────

app.get('/api/control/alerts', requireAdminAuth, (req, res) => {
    try {
        const { shopId, status, severity } = req.query;
        let query = 'SELECT * FROM alerts WHERE 1=1';
        const params = [];

        if (shopId) { query += ' AND shopId = ?'; params.push(shopId); }
        if (status) { query += ' AND status = ?'; params.push(status); }
        if (severity) { query += ' AND severity = ?'; params.push(severity); }

        query += ' ORDER BY timestamp DESC LIMIT 100';
        const alerts = db.prepare(query).all(...params);
        res.json(alerts);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/control/alerts/:id/ack', requireAdminAuth, (req, res) => {
    try {
        const { id } = req.params;
        db.prepare("UPDATE alerts SET status = 'acknowledged' WHERE id = ?").run(id);
        logAudit('GLOBAL', 'ALERT_ACKNOWLEDGED', 'ADMIN', `Alert ID: ${id}`, req.ip);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/control/alerts/:id/resolve', requireAdminAuth, (req, res) => {
    try {
        const { id } = req.params;
        db.prepare("UPDATE alerts SET status = 'resolved', resolvedAt = ? WHERE id = ?").run(Date.now(), id);
        logAudit('GLOBAL', 'ALERT_RESOLVED', 'ADMIN', `Alert ID: ${id}`, req.ip);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ──────────────────────────────────────────────────────────────
//  Diagnostics, Audit & Update APIs
// ──────────────────────────────────────────────────────────────

app.get('/api/control/audit', requireAdminAuth, (req, res) => {
    try {
        const { shopId } = req.query;
        let logs;
        if (shopId) {
            logs = db.prepare('SELECT * FROM audit_logs WHERE shopId = ? ORDER BY timestamp DESC LIMIT 100').all(shopId);
        } else {
            logs = db.prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100').all();
        }
        res.json(logs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/control/diagnostics/:shopId', requireAdminAuth, (req, res) => {
    try {
        const { shopId } = req.params;
        const diags = db.prepare('SELECT * FROM diagnostics WHERE shopId = ? ORDER BY timestamp DESC LIMIT 20').all(shopId);
        res.json(diags);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/control/errors', requireAdminAuth, (req, res) => {
    try {
        const { shopId } = req.query;
        let errors;
        if (shopId) {
            errors = db.prepare('SELECT * FROM errors WHERE shopId = ? ORDER BY timestamp DESC LIMIT 50').all(shopId);
        } else {
            errors = db.prepare('SELECT * FROM errors ORDER BY timestamp DESC LIMIT 50').all();
        }
        res.json(errors);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/control/updates', requireAdminAuth, (req, res) => {
    try {
        const updates = db.prepare('SELECT * FROM updates').all();
        res.json(updates);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ──────────────────────────────────────────────────────────────
//  Co-Pilot Operational Intelligence API (Real DB Queries)
// ──────────────────────────────────────────────────────────────

app.post('/api/copilot/query', requireAdminAuth, (req, res) => {
    try {
        const queryText = (req.body.query || '').trim().toLowerCase();
        const now = Date.now();

        if (!queryText) {
            return res.json({ answer: 'Please enter an operational question regarding shops, alerts, updates, or errors.' });
        }

        // 1. Offline Shops
        if (queryText.includes('offline') || queryText.includes('disconnected')) {
            const allShops = db.prepare("SELECT * FROM shops WHERE status != 'revoked'").all();
            const heartbeats = db.prepare('SELECT * FROM heartbeats').all();
            const offline = allShops.filter(s => {
                const hb = heartbeats.find(h => h.shopId === s.shopId);
                return !hb || (now - hb.lastSeen) >= 600000;
            });

            if (offline.length === 0) {
                return res.json({
                    answer: 'All registered shops are currently ONLINE and connected.',
                    data: { count: 0, shops: [] }
                });
            }

            const shopSummaries = offline.map(s => {
                const hb = heartbeats.find(h => h.shopId === s.shopId);
                const lastSeenStr = hb ? `${Math.round((now - hb.lastSeen) / 60000)}m ago` : 'Never';
                return `${s.name} (${s.shopId}) - Last seen: ${lastSeenStr}`;
            });

            return res.json({
                answer: `Found ${offline.length} offline shop(s):\n- ${shopSummaries.join('\n- ')}`,
                data: { count: offline.length, shops: offline }
            });
        }

        // 2. Critical & Active Alerts
        if (queryText.includes('alert') || queryText.includes('critical') || queryText.includes('warning')) {
            const alerts = db.prepare("SELECT * FROM alerts WHERE status = 'active' ORDER BY timestamp DESC LIMIT 10").all();
            if (alerts.length === 0) {
                return res.json({
                    answer: 'There are currently NO unresolved active alerts across the fleet.',
                    data: { count: 0, alerts: [] }
                });
            }

            const list = alerts.map(a => `[${a.severity.toUpperCase()}] ${a.shopId}: ${a.message} (${new Date(a.timestamp).toLocaleTimeString()})`);
            return res.json({
                answer: `There are ${alerts.length} active alert(s):\n- ${list.join('\n- ')}`,
                data: { count: alerts.length, alerts }
            });
        }

        // 3. Application Errors
        if (queryText.includes('error') || queryText.includes('failure') || queryText.includes('crash')) {
            const errors = db.prepare('SELECT * FROM errors ORDER BY timestamp DESC LIMIT 10').all();
            if (errors.length === 0) {
                return res.json({
                    answer: 'No recent errors reported by any shop.',
                    data: { count: 0, errors: [] }
                });
            }

            const errList = errors.map(e => `${e.shopId} [${e.errorType}]: ${e.message} (${new Date(e.timestamp).toLocaleTimeString()})`);
            return res.json({
                answer: `Recent error reports (${errors.length}):\n- ${errList.join('\n- ')}`,
                data: { count: errors.length, errors }
            });
        }

        // 4. Update Status
        if (queryText.includes('update') || queryText.includes('version') || queryText.includes('rollout')) {
            const updates = db.prepare('SELECT * FROM updates').all();
            const failed = updates.filter(u => u.status === 'FAILED');
            if (failed.length > 0) {
                return res.json({
                    answer: `Attention: ${failed.length} shop(s) experienced update failures:\n- ` + 
                            failed.map(f => `${f.shopId}: ${f.error || 'Failed'}`).join('\n- '),
                    data: updates
                });
            }
            return res.json({
                answer: `All update deployments are healthy. Tracked installations: ${updates.length}.`,
                data: updates
            });
        }

        // 5. Specific Shop Query: e.g. "Shop A", "SHOP_123"
        const shopMatch = db.prepare('SELECT * FROM shops').all().find(s => 
            queryText.includes(s.shopId.toLowerCase()) || queryText.includes(s.name.toLowerCase())
        );

        if (shopMatch) {
            const hb = db.prepare('SELECT * FROM heartbeats WHERE shopId = ?').get(shopMatch.shopId);
            const isOnline = hb && (now - hb.lastSeen) < 600000;
            const alerts = db.prepare("SELECT * FROM alerts WHERE shopId = ? AND status = 'active'").all(shopMatch.shopId);
            const errors = db.prepare('SELECT * FROM errors WHERE shopId = ?').all(shopMatch.shopId);
            
            return res.json({
                answer: `Operational Status for ${shopMatch.name} (${shopMatch.shopId}):\n` +
                        `- Status: ${shopMatch.status.toUpperCase()} (${isOnline ? 'ONLINE' : 'OFFLINE'})\n` +
                        `- Version: ${hb ? hb.version : 'Unknown'}\n` +
                        `- Last Check-in: ${hb ? new Date(hb.lastSeen).toLocaleString() : 'Never'}\n` +
                        `- Active Alerts: ${alerts.length}\n` +
                        `- Logged Errors: ${errors.length}`,
                data: { shop: shopMatch, heartbeat: hb, isOnline, alerts, errors }
            });
        }

        // 6. Fleet Overview / Health Summary
        const totalShops = db.prepare('SELECT count(*) as count FROM shops').get().count;
        const onlineCount = db.prepare('SELECT * FROM heartbeats').all().filter(h => (now - h.lastSeen) < 600000).length;
        const activeAlerts = db.prepare("SELECT count(*) as count FROM alerts WHERE status = 'active'").get().count;

        return res.json({
            answer: `DeskSolutions Fleet Overview:\n` +
                    `- Total Registered Shops: ${totalShops}\n` +
                    `- Currently Online: ${onlineCount}\n` +
                    `- Currently Offline: ${Math.max(0, totalShops - onlineCount)}\n` +
                    `- Active Unresolved Alerts: ${activeAlerts}\n` +
                    `You can ask me specifically about offline shops, critical alerts, errors, or specific shop IDs.`,
            data: { totalShops, onlineCount, activeAlerts }
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Static Assets
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────────────────────
//  WebSocket Server & Real-time Telemetry
// ──────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocket.Server({ 
    server, 
    path: '/v1/telemetry',
    maxPayload: 1024 * 1024 // 1 MB limit prevents memory exhaustion attacks
});
const wsClients = new Map(); // shopId -> WebSocket

wss.on('connection', (ws, req) => {
    let connectedShopId = null;

    // Attach immediate socket error listener to prevent uncaught exceptions crashing Node.js
    ws.on('error', (err) => {
        console.warn(`[WS] Socket error (${connectedShopId || 'unauthenticated'}):`, err.message);
    });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const { type, shopId, token } = data;

            if (type === 'auth') {
                const shop = db.prepare('SELECT * FROM shops WHERE shopId = ?').get(shopId);
                
                if (!shop) {
                    logAudit(shopId || 'UNKNOWN', 'AUTH_REJECTED', 'SYSTEM', 'Shop not registered in database', req.socket.remoteAddress);
                    ws.send(JSON.stringify({ type: 'auth_failed', reason: 'Shop not enrolled' }));
                    ws.close();
                    return;
                }

                if (shop.status === 'revoked' || shop.token !== token) {
                    logAudit(shopId, 'AUTH_REJECTED', 'SYSTEM', 'Token mismatch or revoked status', req.socket.remoteAddress);
                    ws.send(JSON.stringify({ type: 'auth_failed', reason: 'Unauthorized or revoked' }));
                    ws.close();
                    return;
                }

                // If an existing socket is registered for this shop, close it cleanly to avoid stale socket conflicts
                if (wsClients.has(shopId)) {
                    const oldWs = wsClients.get(shopId);
                    if (oldWs !== ws) {
                        try {
                            oldWs.close(1000, 'Superseded by new connection');
                        } catch(e) {}
                    }
                }

                connectedShopId = shopId;
                wsClients.set(shopId, ws);
                
                // Record connection in audit log
                logAudit(shopId, 'SHOP_CONNECTED', 'CLIENT', `WebSocket connection established (Version: ${data.version || '1.0.0'})`, req.socket.remoteAddress);
                
                // Upsert heartbeat immediately
                const metricsStr = data.metrics ? JSON.stringify(data.metrics) : null;
                db.prepare(`
                    INSERT INTO heartbeats (shopId, version, uptime, lastSeen, status, ip, metrics) 
                    VALUES (?, ?, ?, ?, 'online', ?, ?)
                    ON CONFLICT(shopId) DO UPDATE SET 
                    version=excluded.version, uptime=excluded.uptime, lastSeen=excluded.lastSeen, 
                    status='online', ip=excluded.ip, metrics=excluded.metrics
                `).run(shopId, data.version || '1.0.0', data.uptime || 0, Date.now(), req.socket.remoteAddress, metricsStr);

                // Auto-resolve any active OFFLINE alert for this shop
                db.prepare("UPDATE alerts SET status = 'resolved', resolvedAt = ? WHERE shopId = ? AND type = 'SHOP_OFFLINE' AND status = 'active'")
                  .run(Date.now(), shopId);

                ws.send(JSON.stringify({ type: 'auth_success', shopId }));

                // Dispatch any pending unexpired commands queued while shop was offline
                try {
                    const pendingCmds = db.prepare(`
                        SELECT * FROM remote_commands 
                        WHERE shopId = ? AND status = 'pending' AND expiresAt > ? 
                        ORDER BY timestamp ASC
                    `).all(shopId, Date.now());

                    for (const cmd of pendingCmds) {
                        ws.send(JSON.stringify({
                            type: 'remote_command',
                            id: cmd.id,
                            command: cmd.command,
                            timestamp: cmd.timestamp,
                            expiresAt: cmd.expiresAt,
                            nonce: cmd.nonce,
                            signature: cmd.signature
                        }));
                        db.prepare("UPDATE remote_commands SET status = 'dispatched' WHERE id = ?").run(cmd.id);
                        logAudit(shopId, 'COMMAND_DISPATCHED_QUEUED', 'SYSTEM', `Queued command "${cmd.command}" [ID: ${cmd.id}] dispatched on connection`, req.socket.remoteAddress);
                    }
                    
                    // Mark expired pending commands
                    db.prepare("UPDATE remote_commands SET status = 'expired' WHERE shopId = ? AND status = 'pending' AND expiresAt <= ?")
                      .run(shopId, Date.now());
                } catch (e) {
                    console.error('[WS] Queued command dispatch error:', e);
                }

                return;
            }

            // Reject any unauthenticated packets
            if (!connectedShopId) {
                ws.send(JSON.stringify({ type: 'auth_failed', reason: 'Authentication required' }));
                ws.close();
                return;
            }

            if (type === 'heartbeat') {
                const metricsStr = data.metrics ? JSON.stringify(data.metrics) : null;
                db.prepare(`
                    INSERT INTO heartbeats (shopId, version, uptime, lastSeen, status, ip, metrics) 
                    VALUES (?, ?, ?, ?, 'online', ?, ?)
                    ON CONFLICT(shopId) DO UPDATE SET 
                    version=excluded.version, uptime=excluded.uptime, lastSeen=excluded.lastSeen, 
                    status='online', metrics=COALESCE(excluded.metrics, heartbeats.metrics)
                `).run(connectedShopId, data.version || '1.0.0', data.uptime || 0, Date.now(), req.socket.remoteAddress, metricsStr);
            }

            if (type === 'diagnostics') {
                const diagId = crypto.randomUUID();
                const metricsStr = typeof data.metrics === 'object' ? JSON.stringify(data.metrics) : String(data.metrics || '');
                db.prepare('INSERT INTO diagnostics (id, shopId, metrics, health, timestamp) VALUES (?, ?, ?, ?, ?)')
                  .run(diagId, connectedShopId, metricsStr, data.health || 'healthy', Date.now());
            }

            if (type === 'error_report') {
                const errorId = crypto.randomUUID();
                db.prepare('INSERT INTO errors (id, shopId, errorType, message, stack, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
                  .run(errorId, connectedShopId, data.errorType || 'RuntimeError', data.message, data.stack || '', Date.now());
                createAlert(connectedShopId, 'APP_ERROR', 'warning', `Error: ${data.message}`, data.stack);
            }

            if (type === 'update_status') {
                db.prepare(`
                    INSERT INTO updates (shopId, installedVersion, availableVersion, status, progress, lastChecked, error)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(shopId) DO UPDATE SET
                    installedVersion=COALESCE(excluded.installedVersion, updates.installedVersion),
                    availableVersion=COALESCE(excluded.availableVersion, updates.availableVersion),
                    status=excluded.status,
                    progress=excluded.progress,
                    lastChecked=excluded.lastChecked,
                    error=excluded.error
                `).run(connectedShopId, data.installedVersion || null, data.version || null, data.status, data.progress || 0, Date.now(), data.error || null);

                if (data.status === 'FAILED') {
                    createAlert(connectedShopId, 'UPDATE_FAILED', 'critical', `Auto-update failed: ${data.error || 'Unknown error'}`);
                }
            }

            if (type === 'command_ack') {
                const { commandId, status, detail, error } = data;
                const resultStr = JSON.stringify({ status, detail, error, timestamp: Date.now() });
                db.prepare("UPDATE remote_commands SET status = ?, result = ?, ackedAt = ? WHERE id = ?")
                  .run(status, resultStr, Date.now(), commandId);
                logAudit(connectedShopId, 'COMMAND_ACKNOWLEDGED', 'CLIENT', `Command ${commandId} result: ${status}`, req.socket.remoteAddress);
            }

        } catch (e) {
            console.error('[WS] Message Processing Error:', e);
        }
    });

    ws.on('close', () => {
        if (connectedShopId) {
            logAudit(connectedShopId, 'SHOP_DISCONNECTED', 'SYSTEM', 'WebSocket connection closed', req.socket.remoteAddress);
            // Only delete from wsClients if this socket instance is still the active registered socket
            if (wsClients.get(connectedShopId) === ws) {
                wsClients.delete(connectedShopId);
            }
        }
    });
});

// Periodic Offline Detector (Every 30s) — Accurately ignores brand new shops that enrolled < 10m ago
setInterval(() => {
    try {
        const threshold = Date.now() - 600000; // 10 minutes
        const activeShops = db.prepare("SELECT shopId, name, registeredAt FROM shops WHERE status = 'active'").all();
        const heartbeats = db.prepare("SELECT * FROM heartbeats").all();

        for (const shop of activeShops) {
            const hb = heartbeats.find(h => h.shopId === shop.shopId);
            if (hb) {
                if (hb.lastSeen < threshold) {
                    createAlert(shop.shopId, 'SHOP_OFFLINE', 'warning', `Shop "${shop.name}" is OFFLINE (No heartbeat for > 10m)`);
                }
            } else if (shop.registeredAt && (Date.now() - shop.registeredAt > threshold)) {
                // Only alert for un-checked-in shops if enrolled more than 10m ago
                createAlert(shop.shopId, 'SHOP_OFFLINE', 'warning', `Shop "${shop.name}" has never connected since enrollment (> 10m ago)`);
            }
        }
    } catch (e) {
        // Silently catch background interval errors
    }
}, 30000);

// 24/7 Database Maintenance & Table Bounding (Prunes logs older than retention windows and runs optimize)
function runDatabaseMaintenance() {
    try {
        const now = Date.now();
        const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000);
        const sixtyDaysAgo = now - (60 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

        const auditPrune = db.prepare('DELETE FROM audit_logs WHERE timestamp < ?').run(ninetyDaysAgo);
        const alertPrune = db.prepare("DELETE FROM alerts WHERE status = 'resolved' AND timestamp < ?").run(sixtyDaysAgo);
        const diagPrune = db.prepare('DELETE FROM diagnostics WHERE timestamp < ?').run(thirtyDaysAgo);
        const errPrune = db.prepare('DELETE FROM errors WHERE timestamp < ?').run(thirtyDaysAgo);
        const cmdExpire = db.prepare("UPDATE remote_commands SET status = 'expired' WHERE status = 'pending' AND expiresAt <= ?").run(now);

        db.pragma('optimize');

        // Automated backup retention pruning (Default: 30 days retention, keeps at least 5 backups)
        const BACKUP_RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);
        if (fs.existsSync(backupsDir)) {
            const backupCutoff = now - (BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
            const backupFiles = fs.readdirSync(backupsDir).filter(f => f.endsWith('.db'));
            if (backupFiles.length > 5) {
                let prunedCount = 0;
                backupFiles.forEach(file => {
                    const filePath = path.join(backupsDir, file);
                    try {
                        const stat = fs.statSync(filePath);
                        if (stat.mtimeMs < backupCutoff) {
                            fs.unlinkSync(filePath);
                            prunedCount++;
                        }
                    } catch (e) {}
                });
                if (prunedCount > 0) {
                    console.log(`[Maintenance] Pruned ${prunedCount} database backup(s) older than ${BACKUP_RETENTION_DAYS} days.`);
                }
            }
        }

        if (auditPrune.changes || alertPrune.changes || diagPrune.changes || errPrune.changes || cmdExpire.changes) {
            console.log(`[Maintenance] Pruned ${auditPrune.changes} audit logs, ${alertPrune.changes} alerts, ${diagPrune.changes} diags, ${errPrune.changes} errors, expired ${cmdExpire.changes} commands.`);
        }
    } catch (e) {
        console.error('[Maintenance] Database maintenance error:', e.message);
    }
}
setTimeout(runDatabaseMaintenance, 5000);
setInterval(runDatabaseMaintenance, 24 * 60 * 60 * 1000);

server.listen(PORT, HOST, () => {
    console.log(`DeskSolutions Control Center Server running on ${HOST}:${PORT}`);
});

// Graceful shutdown handling for container environments (Docker/Kubernetes/Railway)
function gracefulShutdown(signal) {
    console.log(`[Server] Received ${signal}. Starting graceful shutdown...`);
    for (const [shopId, ws] of wsClients.entries()) {
        try {
            ws.send(JSON.stringify({ type: 'server_shutdown', reason: 'Control Center restarting' }));
            ws.close();
        } catch (e) {}
    }
    wsClients.clear();

    server.close(() => {
        console.log('[Server] HTTP and WebSocket listeners closed.');
        try {
            db.close();
            console.log('[Server] SQLite database connection closed cleanly.');
        } catch (e) {
            console.error('[Server] Error closing database:', e.message);
        }
        process.exit(0);
    });

    setTimeout(() => {
        console.error('[Server] Graceful shutdown timed out. Forcing exit.');
        process.exit(1);
    }, 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = server;
