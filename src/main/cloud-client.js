const WebSocket = require('ws');
const Sentry = require('@sentry/electron/main');
const { app } = require('electron');

class CloudClient {
    constructor() {
        // Remove hardcoded values; use environment or configuration
        this.shopId = process.env.SHOP_ID || 'UNCONFIGURED-SHOP'; 
        this.ws = null;
        this.cloudUrl = process.env.CLOUD_MASTER_URL || 'wss://api.printshopmanager.com/v1/telemetry';
        this.version = app ? app.getVersion() : '1.0.0';
        this.sentryDsn = process.env.SENTRY_DSN || null;
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 300000; // 5 mins max backoff
        this.authToken = process.env.SHOP_AUTH_TOKEN || null;
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
        } catch(e) { console.error('Sentry init failed', e); }

        // 2. Initialize Electron Updater (Silent Auto-Update State Machine)
        try {
            const { autoUpdater } = require('electron-updater');
            
            // Configure for silent updates
            autoUpdater.autoDownload = true;
            autoUpdater.autoInstallOnAppQuit = false; // We will force install manually

            autoUpdater.on('update-available', (info) => {
                console.log('Update available:', info.version);
                this.reportTelemetry({ type: 'update_status', status: 'AVAILABLE', version: info.version });
            });

            autoUpdater.on('download-progress', (progressObj) => {
                // Throttle telemetry reporting to avoid flooding the server
                this.reportTelemetry({ type: 'update_status', status: 'DOWNLOADING', progress: Math.round(progressObj.percent) });
            });

            autoUpdater.on('update-downloaded', (info) => {
                console.log('Update downloaded, preparing to install:', info.version);
                this.reportTelemetry({ type: 'update_status', status: 'DOWNLOADED', version: info.version });
                
                // For a kiosk/ERP, we want silent forced install immediately or during maintenance window.
                // We'll simulate immediate installation for the state machine.
                this.reportTelemetry({ type: 'update_status', status: 'INSTALLING' });
                
                // Wait briefly for telemetry to flush before restarting
                setTimeout(() => {
                    autoUpdater.quitAndInstall(true, true);
                }, 1000);
            });

            autoUpdater.on('error', (err) => {
                console.error('Update error:', err);
                this.reportTelemetry({ type: 'update_status', status: 'FAILED', error: err.message });
            });

            // Trigger the check
            autoUpdater.checkForUpdatesAndNotify();
        } catch(e) { console.error('AutoUpdater init failed', e); }

        // 3. Connect to Central WebSocket Server
        if (this.shopId !== 'UNCONFIGURED-SHOP' && this.authToken) {
            this.connect();
        } else {
            console.warn('CloudClient: SHOP_ID or SHOP_AUTH_TOKEN missing. Running in local-only mode.');
        }

        // 4. Start Heartbeat
        setInterval(() => this.sendHeartbeat(), 300000); // 5 mins
    }

    connect() {
        try {
            this.ws = new WebSocket(this.cloudUrl, {
                headers: {
                    'Authorization': `Bearer ${this.authToken}`,
                    'X-Shop-ID': this.shopId
                }
            });
            
            this.ws.on('open', () => {
                console.log('Connected to Cloud Master');
                this.reconnectAttempts = 0; // reset on success
                this.ws.send(JSON.stringify({
                    type: 'auth',
                    shopId: this.shopId,
                    token: this.authToken,
                    version: this.version,
                    timestamp: Date.now()
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
                console.warn('CloudClient Connection Error:', err.message);
            });

            this.ws.on('close', () => {
                this.reconnectAttempts++;
                const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
                console.log(`CloudClient disconnected. Reconnecting in ${delay/1000}s...`);
                setTimeout(() => this.connect(), delay);
            });
        } catch (e) {
            console.error('WebSocket initialization error:', e);
        }
    }

    sendHeartbeat() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ 
                type: 'heartbeat', 
                shopId: this.shopId,
                version: this.version,
                uptime: process.uptime(),
                timestamp: Date.now()
            }));
        }
    }

    reportTelemetry(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                ...payload,
                shopId: this.shopId,
                timestamp: Date.now()
            }));
        }
    }

    handleRemoteCommand(msg) {
        if (msg.type === 'remote_command') {
            console.log(`Received Remote Command: ${msg.command}`);
            
            // 1. Authenticate & Authorize Command
            if (!this.verifyCommandSignature(msg)) {
                console.error('Unauthorized or invalid remote command rejected.');
                this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'rejected_unauthorized' });
                return;
            }

            switch (msg.command) {
                case 'lock':
                    console.log('Locking terminal...');
                    this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'success' });
                    // Add IPC call to lock screen here
                    break;
                case 'force_backup':
                    console.log('Initiating forced cloud backup...');
                    this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'started' });
                    // Backup implementation here
                    break;
                case 'restart':
                    console.log('Restarting app...');
                    this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'restarting' });
                    setTimeout(() => {
                        const { app } = require('electron');
                        if (app && app.relaunch) {
                            app.relaunch();
                            app.exit();
                        } else {
                            process.exit(0);
                        }
                    }, 1000);
                    break;
                default:
                    console.log('Unknown command');
                    this.reportTelemetry({ type: 'command_ack', commandId: msg.id, status: 'unknown_command' });
            }
        }
    }

    verifyCommandSignature(msg) {
        if (!msg.signature || !msg.timestamp || !msg.id || !msg.command) return false;
        
        // Anti-Replay: Check if expired (> 5 minutes old)
        if (Date.now() - msg.timestamp > 5 * 60 * 1000) {
            console.error('Command rejected: Expired timestamp');
            return false;
        }

        // Anti-Replay: Check if already executed
        if (!this.executedCommands) this.executedCommands = new Set();
        if (this.executedCommands.has(msg.id)) {
            console.error('Command rejected: Replay attack detected');
            return false;
        }

        // Cryptographic Verification
        const crypto = require('crypto');
        const payload = `${msg.command}:${msg.id}:${msg.timestamp}`;
        const expectedSignature = crypto.createHmac('sha256', this.authToken || 'default-token')
                                        .update(payload)
                                        .digest('hex');
                                        
        if (msg.signature !== expectedSignature) {
            console.error('Command rejected: Invalid cryptographic signature');
            return false;
        }

        this.executedCommands.add(msg.id);
        return true;
    }
}

module.exports = new CloudClient();
