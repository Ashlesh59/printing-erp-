const WebSocket = require('ws');
const Sentry = require('@sentry/electron/main');

class CloudClient {
    constructor() {
        this.shopId = 'DEMO-SHOP-123'; // Hardcoded for this demo so it matches the dashboard
        this.ws = null;
        this.cloudUrl = 'ws://localhost:5000';
    }

    init() {
        // 1. Initialize Sentry Crash Reporting
        try {
            Sentry.init({
                dsn: 'https://placeholder-dsn@o0.ingest.sentry.io/0',
                tracesSampleRate: 1.0, 
            });
        } catch(e) { console.error('Sentry init failed', e); }

        // 2. Initialize Electron Updater
        try {
            const { autoUpdater } = require('electron-updater');
            autoUpdater.checkForUpdatesAndNotify();
            autoUpdater.on('update-available', () => {
                console.log('Update is available, downloading...');
            });
            autoUpdater.on('update-downloaded', () => {
                console.log('Update downloaded, ready to install');
            });
        } catch(e) { console.error('AutoUpdater init failed', e); }

        // 3. Connect to Central WebSocket Server
        this.connect();

        // 4. Start Heartbeat
        setInterval(() => this.sendHeartbeat(), 300000); // 5 mins
    }

    connect() {
        try {
            this.ws = new WebSocket(this.cloudUrl);
            
            this.ws.on('open', () => {
                console.log('Connected to Cloud Master');
                this.ws.send(JSON.stringify({
                    type: 'auth',
                    shopId: this.shopId,
                    version: '1.0.0'
                }));
            });

            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data);
                    this.handleRemoteCommand(msg);
                } catch (e) {
                    Sentry.captureException(e);
                }
            });

            this.ws.on('error', (err) => {
                // Silently handle offline/local mode error without throwing uncaught exceptions
            });

            this.ws.on('close', () => {
                setTimeout(() => this.connect(), 30000);
            });
        } catch (e) {
            // Silently handle WebSocket initialization error
        }
    }

    sendHeartbeat() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'heartbeat', shopId: this.shopId }));
        }
    }

    handleRemoteCommand(msg) {
        if (msg.type === 'remote_command') {
            console.log(`Received Remote Command from Admin: ${msg.command}`);
            const { app } = require('electron');
            
            switch (msg.command) {
                case 'lock':
                    console.log('Locking terminal...');
                    // Add IPC call to lock screen here
                    break;
                case 'force_backup':
                    console.log('Initiating forced cloud backup...');
                    break;
                case 'restart':
                    console.log('Restarting app...');
                    app.relaunch();
                    app.exit();
                    break;
                default:
                    console.log('Unknown command');
            }
        }
    }
}

module.exports = new CloudClient();
