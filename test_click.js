const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.whenReady().then(() => {
    // Mock handlers to allow shop mode dashboard to run
    ipcMain.handle('check-license', () => true);
    ipcMain.handle('get-gst-summary', () => ({}));
    ipcMain.handle('get-inv-categories', () => []);
    ipcMain.handle('get-inv-dashboard-stats', () => ({
        paperUsageDays: [],
        purchaseTrends: []
    }));
    ipcMain.handle('get-inv-items', () => []);
    ipcMain.handle('get-settings', () => ({}));
    ipcMain.handle('get-recent-orders', () => []);
    ipcMain.handle('get-pricing', () => []);
    ipcMain.handle('get-inv-suppliers', () => []);
    ipcMain.handle('get-inv-purchase-orders', () => []);
    ipcMain.handle('get-gst-invoices', () => []);
    ipcMain.handle('get-printers', () => []);
    ipcMain.handle('log-error', (event, msg) => {
        console.log(`[RENDERER ERROR] ${msg}`);
    });

    const mainWindow = new BrowserWindow({
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

    mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));

    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[CONSOLE] ${message}`);
    });

    mainWindow.webContents.on('did-finish-load', async () => {
        console.log("DOM loaded. Simulating Shop Mode entry...");
        
        const logs = await mainWindow.webContents.executeJavaScript(`
            (async () => {
                const logs = [];
                const log = (msg) => logs.push(msg);

                try {
                    // 1. Check startup state
                    const roleScreen = document.getElementById('role-selection-screen');
                    log("Is role selection visible on start: " + (roleScreen && window.getComputedStyle(roleScreen).display !== 'none'));
                    
                    // 2. Click Shop Mode button
                    const shopBtn = Array.from(document.querySelectorAll('.role-btn'))
                        .find(b => b.textContent.includes('Shop'));
                    
                    if (!shopBtn) {
                        log("ERROR: Shop Mode button not found!");
                        return logs;
                    }
                    
                    log("Clicking Shop Mode button...");
                    shopBtn.click();
                    
                    // Wait for transition
                    await new Promise(r => setTimeout(r, 500));
                    
                    // Check if main app visible
                    const mainApp = document.getElementById('main-app');
                    log("Is main-app visible: " + (mainApp && window.getComputedStyle(mainApp).display !== 'none'));
                    
                    // 3. Find Settings button
                    const settingsBtn = Array.from(document.querySelectorAll('.nav-btn'))
                        .find(b => b.getAttribute('data-target') === 'settings');
                    
                    if (!settingsBtn) {
                        log("ERROR: Settings nav button not found!");
                        return logs;
                    }
                    
                    log("Clicking Settings nav button...");
                    settingsBtn.click();
                    
                    // Wait for modal transition
                    await new Promise(r => setTimeout(r, 500));
                    
                    // Check if PIN lock modal is active
                    const pinModal = document.getElementById('pin-lock-modal');
                    const isPinActive = pinModal && pinModal.classList.contains('active');
                    log("Is PIN modal active: " + isPinActive);
                    
                    // Check active tab in local storage
                    log("Saved shop tab in localStorage: " + localStorage.getItem('psm_shop_tab'));
                    
                } catch(e) {
                    log("CRASH: " + e.stack);
                }
                
                return logs;
            })()
        `);
        
        console.log("Validation logs:");
        logs.forEach(l => console.log("  " + l));
        app.exit(0);
    });
});
