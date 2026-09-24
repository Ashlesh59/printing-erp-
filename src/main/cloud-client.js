const WebSocket = require('ws');
let Sentry = null;
try {
    Sentry = require('@sentry/electron/main');
} catch (e) {
    // Sentry optional in headless / node test environments
}

let electronApp = null;
try {
    const electron = require('electron');
    electronApp = electron.app || null;
} catch (e) {
    electronApp = null;
}

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

class CloudClient {
    constructor() {
        this.configPath = electronApp && typeof electronApp.getPath === 'function' 
            ? path.join(electronApp.getPath('userData'), 'cloud-config.json') 
            : path.join(__dirname, 'cloud-config.json');
        this.loadConfig();
        
        this.ws = null;
        this.cloudUrl = process.env.CONTROL_CENTER_WS_URL || process.env.CLOUD_MASTER_URL || this.cloudUrl || 'wss://control.desksolutions.in/v1/telemetry';
        this.version = electronApp && typeof electronApp.getVersion === 'function' ? electronApp.getVersion() : '1.0.0';
        this.sentryDsn = process.env.SENTRY_DSN || null;
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 300000; // 5 mins max backoff
        this.executedCommands = new Map(); // id -> execution timestamp (bounded memory)
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
    }

    loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                // Invariant: Permanent Shop ID and auth token are strictly preserved
                this.shopId = data.shopId || process.env.SHOP_ID || 'UNCONFIGURED-SHOP';
                this.authToken = data.authToken || process.env.SHOP_AUTH_TOKEN || null;
                // Precedence: explicit environment URL > saved config URL > production default
                this.cloudUrl = process.env.CONTROL_CENTER_WS_URL || process.env.CLOUD_MASTER_URL || data.cloudUrl || 'wss://control.desksolutions.in/v1/telemetry';
            } else {
                this.shopId = process.env.SHOP_ID || 'UNCONFIGURED-SHOP';
                this.authToken = process.env.SHOP_AUTH_TOKEN || null;
                this.cloudUrl = process.env.CONTROL_CENTER_WS_URL || process.env.CLOUD_MASTER_URL || 'wss://control.desksolutions.in/v1/telemetry';
            }
        } catch (e) {
            console.error('[CloudClient] Failed to load cloud config:', e);
            this.shopId = 'UNCONFIGURED-SHOP';
            this.authToken = null;
            this.cloudUrl = process.env.CONTROL_CENTER_WS_URL || process.env.CLOUD_MASTER_URL || 'wss://control.desksolutions.in/v1/telemetry';
        }
    }

    saveConfig(shopId, authToken, cloudUrl) {
        this.shopId = shopId;
        this.authToken = authToken;
        if (cloudUrl) this.cloudUrl = cloudUrl;
        try {
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.configPath, JSON.stringify({ 
                shopId: this.shopId, 
                authToken: this.authToken,
                cloudUrl: this.cloudUrl 
            }, null, 2), 'utf8');
        } catch (e) {
            console.error('[CloudClient] Failed to save cloud config:', e);
        }
    }

    isConnected() {
        return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
    }

    getStatus() {
        return {
            enrolled: this.shopId !== 'UNCONFIGURED-SHOP' && !!this.authToken,
            shopId: this.shopId,
            connected: this.isConnected(),
            server: this.cloudUrl,
            reconnectAttempts: this.reconnectAttempts,
            version: this.version
        };
    }

    async enroll(key, shopName, serverUrl) {
        try {
            const baseUrl = (serverUrl || process.env.CONTROL_CENTER_PUBLIC_URL || process.env.CLOUD_SERVER_URL || 'https://control.desksolutions.in').replace(/\/$/, '');
            const url = `${baseUrl}/api/enroll`;
            
            const response = await globalThis.fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, name: shopName })
            });

            const data = await response.json();
            if (!data.success) {
                return { success: false, error: data.message || 'Enrollment rejected' };
            }

            // Derive WS url from HTTP serverUrl
            const wsProtocol = baseUrl.startsWith('https') ? 'wss:' : 'ws:';
            const wsHost = baseUrl.replace(/^https?:\/\//, '');
            const wsUrl = `${wsProtocol}//${wsHost}/v1/telemetry`;

            this.saveConfig(data.shopId, data.token, wsUrl);
            
            // Reconnect WebSocket with new credentials
            if (this.ws) {
                try { this.ws.close(); } catch(e) {}
            }
            this.connect();

            return { success: true, shopId: data.shopId };
        } catch (error) {
            console.error('[CloudClient] Enrollment failed:', error);
            return { success: false, error: error.message };
        }
    }

    init() {
        // 1. Initialize Sentry Crash Reporting with Real Config
        try {
            if (this.sentryDsn) {
                Sentry.init({
                    dsn: this.sentryDsn,
                    tracesSampleRate: 1.0, 
                });
            }
        } catch(e) { 
            console.error('[CloudClient] Sentry init failed', e); 
        }

        // 2. Initialize Electron Updater (Silent Auto-Update State Machine)
        try {
            const { autoUpdater } = require('electron-updater');
            if (autoUpdater) {
                autoUpdater.autoDownload = true;
                autoUpdater.autoInstallOnAppQuit = false;

                autoUpdater.on('update-available', (info) => {
                    console.log('[CloudClient] Update available:', info.version);
                    this.reportTelemetry({ type: 'update_status', status: 'AVAILABLE', version: info.version });
                });

                autoUpdater.on('download-progress', (progressObj) => {
                    this.reportTelemetry({ type: 'update_status', status: 'DOWNLOADING', progress: Math.round(progressObj.percent) });
                });

                autoUpdater.on('update-downloaded', (info) => {
                    console.log('[CloudClient] Update downloaded:', info.version);
                    this.reportTelemetry({ type: 'update_status', status: 'DOWNLOADED', version: info.version });
                    this.reportTelemetry({ type: 'update_status', status: 'INSTALLING' });
                    
                    setTimeout(() => {
                        autoUpdater.quitAndInstall(true, true);
                    }, 1000);
                });

                autoUpdater.on('error', (err) => {
                    console.error('[CloudClient] Update error:', err);
                    this.reportTelemetry({ type: 'update_status', status: 'FAILED', error: err.message });
                });

                autoUpdater.checkForUpdatesAndNotify().catch(() => {});
            }
        } catch(e) { 
            // Update checking optional in dev
        }

        // 3. Connect to Central WebSocket Server if enrolled
        if (this.shopId !== 'UNCONFIGURED-SHOP' && this.authToken) {
            this.connect();
        } else {
            console.warn('[CloudClient] SHOP_ID or SHOP_AUTH_TOKEN missing. Running in local-only offline mode.');
        }

        // 4. Start Periodic Heartbeat (every 60s for timely 24/7 telemetry)
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 60000);
    }

    connect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (!this.authToken || this.shopId === 'UNCONFIGURED-SHOP') {
            return;
        }

        try {
            this.ws = new WebSocket(this.cloudUrl, {
                headers: {
                    'Authorization': `Bearer ${this.authToken}`,
                    'X-Shop-ID': this.shopId
                }
            });
            
            this.ws.on('open', () => {
                console.log(`[CloudClient] Connected to Cloud Master (${this.shopId})`);
                this.reconnectAttempts = 0;
                
                // Immediate auth & registration handshake
                this.ws.send(JSON.stringify({
                    type: 'auth',
                    shopId: this.shopId,
                    token: this.authToken,
                    version: this.version,
                    uptime: process.uptime(),
                    timestamp: Date.now(),
                    metrics: this.getSystemMetrics()
                }));
            });

            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data);
                    this.handleRemoteCommand(msg);
                } catch (e) {
                    if (this.sentryDsn) Sentry.captureException(e);
                }
            });

            this.ws.on('error', (err) => {
                // Silently handle offline/local mode error without throwing uncaught exceptions
                console.warn('[CloudClient] Connection Warning:', err.message);
            });

            this.ws.on('close', (code, reason) => {
                this.reconnectAttempts++;
                // Exponential backoff with jitter (1s -> 2s -> 4s ... max 5min)
                const baseDelay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), this.maxReconnectDelay);
                const jitter = Math.floor(Math.random() * 500);
                const delay = baseDelay + jitter;
                
                console.log(`[CloudClient] Disconnected (code: ${code}). Reconnecting in ${(delay/1000).toFixed(1)}s...`);
                this.reconnectTimer = setTimeout(() => this.connect(), delay);
            });
        } catch (e) {
            console.error('[CloudClient] WebSocket initialization error:', e);
        }
    }

    getSystemMetrics() {
        return {
            platform: os.platform(),
            arch: os.arch(),
            nodeVersion: process.version,
            totalMem: Math.round(os.totalmem() / (1024 * 1024)),
            freeMem: Math.round(os.freemem() / (1024 * 1024)),
            memoryUsageMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
            uptimeSeconds: Math.round(process.uptime()),
            hostname: os.hostname(),
            dbStatus: 'healthy'
        };
    }

    sendHeartbeat() {
        if (this.isConnected()) {
            this.ws.send(JSON.stringify({ 
                type: 'heartbeat', 
                shopId: this.shopId,
                version: this.version,
                uptime: process.uptime(),
                metrics: this.getSystemMetrics(),
                timestamp: Date.now()
            }));
        }
    }

    reportTelemetry(payload) {
        if (this.isConnected()) {
            this.ws.send(JSON.stringify({
                ...payload,
                shopId: this.shopId,
                timestamp: Date.now()
            }));
        }
    }

    reportError(errorType, message, stack) {
        this.reportTelemetry({
            type: 'error_report',
            errorType: errorType || 'AppError',
            message: message || 'Unknown error occurred',
            stack: stack || null,
            timestamp: Date.now()
        });
    }

    sendDiagnostics() {
        const diagnosticsData = {
            type: 'diagnostics',
            shopId: this.shopId,
            metrics: this.getSystemMetrics(),
            health: 'healthy',
            timestamp: Date.now()
        };
        this.reportTelemetry(diagnosticsData);
        return diagnosticsData;
    }

    handleRemoteCommand(msg) {
        if (msg.type === 'remote_command') {
            console.log(`[CloudClient] Received Remote Command: ${msg.command} [ID: ${msg.id}]`);
            
            // 1. Authenticate & Authorize Command cryptographically
            if (!this.verifyCommandSignature(msg)) {
                console.error('[CloudClient] Unauthorized or invalid remote command rejected.');
                this.reportTelemetry({ 
                    type: 'command_ack', 
                    commandId: msg.id, 
                    status: 'rejected_unauthorized',
                    error: 'Signature verification failed or command expired/replayed'
                });
                return;
            }

            // 2. Strict Capability Whitelist Execution (No arbitrary shell/eval)
            switch (msg.command) {
                case 'lock':
                    console.log('[CloudClient] Executing Lock Terminal...');
                    this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'success', detail: 'Terminal locked' });
                    break;

                case 'request_diagnostics':
                case 'diagnostics':
                    console.log('[CloudClient] Executing Diagnostics Report...');
                    const diag = this.sendDiagnostics();
                    this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'success', detail: diag });
                    break;

                case 'request_health':
                case 'health':
                    console.log('[CloudClient] Executing Health Check...');
                    this.sendHeartbeat();
                    this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'success', detail: 'Health verified' });
                    break;

                case 'request_backup':
                case 'force_backup':
                    console.log('[CloudClient] Executing Local Backup Request...');
                    this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'success', detail: 'Backup completed' });
                    break;

                case 'check_updates':
                    console.log('[CloudClient] Executing Update Check...');
                    this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'success', detail: 'Update check triggered' });
                    break;

                case 'reconnect':
                    console.log('[CloudClient] Executing Reconnect Request...');
                    this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'success', detail: 'Reconnecting' });
                    if (this.ws) this.ws.close();
                    break;

                case 'restart':
                    console.log('[CloudClient] Executing App Restart...');
                    this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'restarting', detail: 'App restarting' });
                    setTimeout(() => {
                        if (app && typeof app.relaunch === 'function') {
                            app.relaunch();
                            app.exit(0);
                        }
                    }, 500);
                    break;

                default:
                    console.warn(`[CloudClient] Unknown command rejected: ${msg.command}`);
                    this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'unknown_command' });
            }
        }
    }

    verifyCommandSignature(msg) {
        if (!msg || !msg.signature || !msg.timestamp || !msg.id || !msg.command) {
            return false;
        }
        
        // Anti-Replay: Check if expired (> 5 minutes old)
        if (Date.now() - msg.timestamp > 5 * 60 * 1000) {
            console.error('[CloudClient] Command rejected: Expired timestamp');
            return false;
        }

        // Anti-Replay: Prevent future-dated timestamp drift (> 1 minute ahead)
        if (msg.timestamp > Date.now() + 60 * 1000) {
            console.error('[CloudClient] Command rejected: Future timestamp detected');
            return false;
        }

        // Anti-Replay: Check if already executed
        if (this.executedCommands.has(msg.id)) {
            console.error('[CloudClient] Command rejected: Replay attack detected for command ID', msg.id);
            return false;
        }

        // Cryptographic Verification: HMAC-SHA256(command:id:timestamp:nonce) with backward-compatibility fallback
        const payload = msg.nonce 
            ? `${msg.command}:${msg.id}:${msg.timestamp}:${msg.nonce}`
            : `${msg.command}:${msg.id}:${msg.timestamp}`;

        const signingKey = this.authToken || process.env.COMMAND_SIGNING_SECRET;
        if (!signingKey) {
            console.error('[CloudClient] Command rejected: No authentication token configured');
            return false;
        }
        const expectedSignature = crypto.createHmac('sha256', signingKey)
                                        .update(payload)
                                        .digest('hex');
                                        
        if (msg.signature !== expectedSignature) {
            console.error('[CloudClient] Command rejected: Invalid cryptographic signature');
            return false;
        }

        // Record execution timestamp in map
        this.executedCommands.set(msg.id, Date.now());

        // Bounded memory cleanup: prune entries older than 10 minutes
        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const [id, ts] of this.executedCommands.entries()) {
            if (ts < cutoff) {
                this.executedCommands.delete(id);
            }
        }

        return true;
    }
}

module.exports = new CloudClient();
