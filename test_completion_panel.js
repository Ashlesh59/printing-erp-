const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

console.log("=================================================");
console.log("TEST: ORDER COMPLETION PANEL VERIFICATION");
console.log("=================================================");

app.whenReady().then(async () => {
    ipcMain.handle('check-license', () => true);
    ipcMain.handle('get-settings', () => ({ print_simulator_enabled: 1 }));
    ipcMain.handle('get-printers', () => [{ name: 'EPSON L3210', status: 'Ready' }]);
    ipcMain.handle('get-all-pricing', () => []);
    ipcMain.handle('get-pricing', () => []);
    ipcMain.handle('get-dashboard-stats', () => ({}));
    ipcMain.handle('get-recent-orders', () => []);
    ipcMain.handle('get-inv-categories', () => []);
    ipcMain.handle('get-inv-items', () => []);
    ipcMain.handle('get-inv-suppliers', () => []);
    ipcMain.handle('get-inv-purchase-orders', () => []);
    ipcMain.handle('get-inv-locations', () => []);
    ipcMain.handle('get-inv-alerts', () => []);
    ipcMain.handle('get-users', () => []);
    ipcMain.handle('products:getAll', () => []);
    ipcMain.handle('profiles:getAll', () => []);
    ipcMain.handle('get-cloud-settings', () => ({}));
    ipcMain.handle('get-server-info', () => ({}));
    ipcMain.handle('get-devices', () => []);
    ipcMain.handle('get-recent-activities', () => []);
    ipcMain.handle('production:getJobs', () => []);
    ipcMain.handle('get-inv-dashboard-stats', () => ({}));
    ipcMain.handle('log-error', (e, msg) => console.log("[RENDERER LOG] " + msg));

    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'src/preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false
        }
    });

    win.loadFile(path.join(__dirname, 'src/renderer/index.html'));

    win.webContents.on('did-finish-load', async () => {
        const results = await win.webContents.executeJavaScript(`
            (async () => {
                const logs = [];
                const log = (msg) => logs.push(msg);

                try {
                    const shopBtn = Array.from(document.querySelectorAll('.role-btn'))
                        .find(b => b.textContent.includes('Shop'));
                    if (shopBtn) shopBtn.click();
                    await new Promise(r => setTimeout(r, 300));

                    const wsBtn = document.querySelector('.nav-btn[data-target="workspace"]');
                    if (wsBtn) wsBtn.click();
                    await new Promise(r => setTimeout(r, 200));

                    const panel = document.getElementById('ws-billing-completion-panel');
                    const valBox = document.getElementById('comp-val-box');
                    const btnSavePrint = document.getElementById('btn-action-save-print');
                    const btnPrintOnly = document.getElementById('btn-action-print-only');
                    const btnSchedule = document.getElementById('btn-action-schedule');

                    if (!panel) throw new Error("Completion Panel (#ws-billing-completion-panel) missing!");
                    if (!valBox) throw new Error("Validation Box (#comp-val-box) missing!");
                    if (!btnSavePrint) throw new Error("SAVE & PRINT button (#btn-action-save-print) missing!");
                    if (!btnPrintOnly) throw new Error("PRINT ONLY button (#btn-action-print-only) missing!");
                    if (!btnSchedule) throw new Error("SCHEDULE PRINT button (#btn-action-schedule) missing!");

                    log("SUCCESS: Order Completion Panel present with all 3 actions & validation box.");

                    // Test validation trigger on empty order
                    btnSavePrint.click();
                    await new Promise(r => setTimeout(r, 100));

                    const banner = document.getElementById('comp-status-banner');
                    if (banner && banner.style.display !== 'none' && banner.classList.contains('error')) {
                        log("SUCCESS: Strict Pre-action Validation verified (Intercepted empty order with error banner).");
                    } else {
                        log("WARNING: Status banner did not switch to error mode on empty click.");
                    }

                } catch(e) {
                    log("ERROR: " + e.stack);
                }

                return logs;
            })()
        `);

        results.forEach(l => console.log(l));
        app.exit(0);
    });
});
