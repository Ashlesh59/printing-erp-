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
        console.log("DOM loaded. Simulating Doc Studio click...");
        
        const logs = await mainWindow.webContents.executeJavaScript(`
            (async () => {
                const logs = [];
                const log = (msg) => logs.push(msg);

                try {
                    // Click Shop Mode button
                    const shopBtn = Array.from(document.querySelectorAll('.role-btn'))
                        .find(b => b.textContent.includes('Shop'));
                    
                    shopBtn.click();
                    await new Promise(r => setTimeout(r, 500));
                    
                    // Find Doc Studio button
                    const docBtn = document.getElementById('nav-btn-doc-studio');
                    if (!docBtn) {
                        log("ERROR: Doc Studio button not found!");
                        return logs;
                    }
                    
                    log("Clicking Doc Studio nav button...");
                    docBtn.click();
                    await new Promise(r => setTimeout(r, 500));
                    
                    // Check if doc-studio view is active
                    const docView = document.getElementById('doc-studio');
                    const isDocViewActive = docView && docView.classList.contains('active');
                    log("Is doc-studio view active: " + isDocViewActive);
                    log("doc-studio display style: " + (docView ? window.getComputedStyle(docView).display : 'none'));
                    
                    // Check if empty state title is displayed
                    const emptyTitle = document.querySelector('.doc-empty-title');
                    log("Empty state title text: " + (emptyTitle ? emptyTitle.textContent : 'none'));
                    
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
