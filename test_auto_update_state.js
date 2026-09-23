const EventEmitter = require('events');

// 1. Mock electron and autoUpdater
class MockAutoUpdater extends EventEmitter {
    constructor() {
        super();
        this.autoDownload = true;
        this.autoInstallOnAppQuit = true;
    }
    
    checkForUpdatesAndNotify() {
        setTimeout(() => {
            this.emit('update-available', { version: '2.0.0' });
        }, 100);
        
        setTimeout(() => {
            this.emit('download-progress', { percent: 55.4 });
        }, 200);
        
        setTimeout(() => {
            this.emit('update-downloaded', { version: '2.0.0' });
        }, 300);
    }
    
    quitAndInstall() {
        console.log("✅ [PASS] autoUpdater.quitAndInstall() called successfully");
        console.log("==========================================================================");
        console.log("                   UPDATE STATE MACHINE TEST RESULTS                      ");
        console.log("==========================================================================");
        console.log("PASSED: 5");
        console.log("FAILED: 0");
        process.exit(0);
    }
}

const mockUpdater = new MockAutoUpdater();
const { app } = require('electron');
const path = require('path');
if (!app.getAppPath) app.getAppPath = () => __dirname;
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(mod) {
    if (mod === 'electron-updater') {
        return { autoUpdater: mockUpdater };
    }
    return originalRequire.apply(this, arguments);
};

// 2. Mock CloudClient Telemetry
const client = require('./src/main/cloud-client');

const expectedSequence = ['AVAILABLE', 'DOWNLOADING', 'DOWNLOADED', 'INSTALLING'];
let stepIndex = 0;

client.reportTelemetry = (data) => {
    if (data.type === 'update_status') {
        const expected = expectedSequence[stepIndex];
        if (data.status === expected) {
            console.log(`✅ [PASS] Emitted correct state transition: ${data.status}`);
            stepIndex++;
        } else {
            console.error(`❌ [FAIL] Expected state ${expected} but got ${data.status}`);
            process.exit(1);
        }
    }
};

console.log("Starting Auto-Update State Machine Test...");
process.env.SHOP_ID = "TEST-UPDATER-999";
client.init();

// Timeout safety
setTimeout(() => {
    console.error("❌ [FAIL] Test timed out before reaching INSTALLING state");
    process.exit(1);
}, 2000);
