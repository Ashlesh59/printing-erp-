const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Initialize Cloud Client (Sentry, Updates, WebSockets)
require('./cloud-client').init();

process.on('uncaughtException', (err) => {
    console.error('[Main] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[Main] Unhandled Rejection:', reason);
});

// Register privileged custom file protocol before app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'app-file', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } }
]);
const { initDatabase } = require('./database/schema');
const { LicenseModel, CustomerModel, OrderModel, SettingsModel, PricingModel, ActivityModel, DeviceModel, UserModel, WorkflowModel, PrintProfileModel, ProductModel, PrintAuditLogModel, WizardModel } = require('./database/models');
const GstModel = require('./database/gst-model');
const { startWatcher } = require('./watcher');
const { printFile, createUnifiedPdf } = require('./printer');
const DeviceManager = require('./device-manager');
const DocumentValidator = require('./document-validator');

// Initialize Database on startup
initDatabase();

// Initialize Event-Driven Architecture (EDA) Bus and register middlewares
const eventBus = require('./events/EventBus');
const { ValidationMiddleware, LoggingMiddleware, PerformanceMiddleware, DebugMiddleware, PermissionHooksMiddleware } = require('./events/EventMiddleware');

eventBus.use(ValidationMiddleware);
eventBus.use(LoggingMiddleware);
eventBus.use(PerformanceMiddleware);
eventBus.use(DebugMiddleware(false)); // Disabled verbose payload logging in production
eventBus.use(PermissionHooksMiddleware);

// Load and register domain subscribers
require('./events/order.events.js');
require('./events/inventory.events.js');
require('./events/printer.events.js');
require('./events/customer.events.js');
require('./events/reports.events.js');
require('./events/dashboard.events.js');
require('./events/notifications.events.js');
require('./events/analytics.events.js');

function createWindow() {
  const userDataPath = app.getPath('userData');
  const windowStatePath = path.join(userDataPath, 'window-state.json');
  
  let windowState = {
    width: 1280,
    height: 800,
    x: undefined,
    y: undefined,
    isMaximized: false
  };

  try {
    if (fs.existsSync(windowStatePath)) {
      windowState = JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
    }
  } catch (err) {
    console.error("Failed to load window state:", err);
  }

  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  // Validate bounds to prevent window opening offscreen
  let posX = windowState.x;
  let posY = windowState.y;
  if (typeof posX === 'number' && (posX < 0 || posX >= primaryDisplay.bounds.width)) {
    posX = undefined;
  }
  if (typeof posY === 'number' && (posY < 0 || posY >= primaryDisplay.bounds.height)) {
    posY = undefined;
  }

  const mainWindow = new BrowserWindow({
    width: windowState.width || 1280,
    height: windowState.height || 800,
    x: posX,
    y: posY,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] [Line ${line}] [${sourceId}]: ${message}`);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  let saveStateTimeout = null;
  const saveState = () => {
    if (saveStateTimeout) clearTimeout(saveStateTimeout);
    saveStateTimeout = setTimeout(() => {
      try {
        if (mainWindow.isDestroyed()) return;
        const bounds = mainWindow.getBounds();
        windowState.isMaximized = mainWindow.isMaximized();
        windowState.isFullScreen = mainWindow.isFullScreen();
        if (!windowState.isMaximized && !windowState.isFullScreen) {
          windowState.width = bounds.width;
          windowState.height = bounds.height;
          windowState.x = bounds.x;
          windowState.y = bounds.y;
        }
        fs.writeFileSync(windowStatePath, JSON.stringify(windowState), 'utf8');
      } catch (err) {
        console.error("Failed to save window state:", err);
      }
    }, 500);
  };

  mainWindow.on('resize', saveState);
  mainWindow.on('move', saveState);
  mainWindow.on('close', saveState);

  const htmlPath = path.resolve(__dirname, '../renderer/index.html');
  if (global.isDatabaseCorrupted) {
    mainWindow.loadURL(`file://${htmlPath}?recovery=true`);
  } else {
    mainWindow.loadFile(htmlPath);
  }
  
  mainWindow.webContents.on('did-finish-load', () => {
    startWatcher(mainWindow.webContents);
  });
  
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[Renderer] ${message}`);
  });

  // Guard IPC handlers registration so re-creating windows does not throw duplicate channel errors
  if (!global.ipcHandlersRegistered) {
    global.ipcHandlersRegistered = true;

    // IPC Handlers for License
    ipcMain.handle('check-license', () => {
    const license = LicenseModel.getLicense();
    return !!(license && license.license_key);
  });

  ipcMain.handle('activate-license', (event, key) => {
    return LicenseModel.activateLicense(key);
  });

  ipcMain.handle('get-license-info', () => {
    return LicenseModel.getLicense();
  });

  // IPC Handlers for Customers
  ipcMain.handle('search-customers', (event, phone) => {
    return CustomerModel.searchByPhone(phone);
  });

  ipcMain.handle('create-customer', (event, data) => {
    return CustomerModel.createCustomer(data);
  });

  ipcMain.handle('update-customer-profile', (event, id, data) => {
    return CustomerModel.updateCustomer(id, data);
  });

  ipcMain.handle('get-all-customers', (event, limit, offset) => {
    return CustomerModel.getAllCustomers(limit, offset);
  });

  ipcMain.handle('search-customers-advanced', (event, opts = {}) => {
    const { query = '', tag = 'All', sortBy = 'last_visit', limit = 50, offset = 0 } = opts;
    return CustomerModel.searchCustomersAdvanced(query, tag, sortBy, limit, offset);
  });

  ipcMain.handle('get-customer-profile', (event, customerId) => {
    return CustomerModel.getCustomerProfile(customerId);
  });

  ipcMain.handle('add-customer-note', (event, customerId, note, author) => {
    return CustomerModel.addNote(customerId, note, author);
  });

  ipcMain.handle('delete-customer-note', (event, noteId) => {
    return CustomerModel.deleteNote(noteId);
  });

  ipcMain.handle('add-customer-document', (event, customerId, orderId, fileName, filePath, fileSize, category) => {
    return CustomerModel.addDocument(customerId, orderId, fileName, filePath, fileSize, category);
  });

  ipcMain.handle('duplicate-order-for-customer', (event, orderId) => {
    return CustomerModel.duplicateOrder(orderId);
  });

  // Production Scheduling & Smart Print Queue IPC Handlers
  const ProductionModel = require('./database/production-model');
  const SmartScheduler = require('./smart-scheduler');

  ipcMain.handle('production:getJobs', (event, filters, searchQuery) => {
    return ProductionModel.getJobs(filters, searchQuery);
  });

  ipcMain.handle('production:getDashboardStats', () => {
    return ProductionModel.getDashboardStats();
  });

  ipcMain.handle('production:createJob', (event, data) => {
    return ProductionModel.createJob(data);
  });

  ipcMain.handle('production:updateStatus', (event, jobId, status) => {
    return ProductionModel.updateStatus(jobId, status);
  });

  ipcMain.handle('production:updatePriority', (event, jobId, priority) => {
    return ProductionModel.updatePriority(jobId, priority);
  });

  ipcMain.handle('production:assignPrinter', (event, jobId, printerName) => {
    return ProductionModel.assignPrinter(jobId, printerName);
  });

  ipcMain.handle('production:reorderQueue', (event, orderedJobIds) => {
    return ProductionModel.reorderQueue(orderedJobIds);
  });

  ipcMain.handle('production:moveUp', (event, jobId) => {
    return ProductionModel.moveJobUp(jobId);
  });

  ipcMain.handle('production:moveDown', (event, jobId) => {
    return ProductionModel.moveJobDown(jobId);
  });

  ipcMain.handle('production:recommendPrinter', (event, jobSpecs) => {
    return SmartScheduler.recommendPrinter(jobSpecs);
  });

  ipcMain.handle('production:duplicateJob', (event, jobId) => {
    return ProductionModel.duplicateJob(jobId);
  });

  ipcMain.handle('production:deleteJob', (event, jobId) => {
    return ProductionModel.deleteJob(jobId);
  });

  ipcMain.handle('production:scheduleJob', (event, jobId, scheduleData) => {
    return ProductionModel.scheduleJob(jobId, scheduleData);
  });

  // IPC Handlers for Orders
  ipcMain.handle('create-order', (event, data) => {
    return OrderModel.createOrder(data);
  });

  ipcMain.handle('get-order-item-specifications', (event, orderItemId) => {
    return OrderModel.getOrderItemSpecifications(orderItemId);
  });

  ipcMain.handle('get-recent-orders', (event, limit, offset) => {
    return OrderModel.getRecentOrders(limit, offset);
  });

  ipcMain.handle('get-dashboard-stats', () => {
    return OrderModel.getDashboardStats();
  });

  ipcMain.handle('get-customer-orders', (event, customerId) => {
    return OrderModel.getOrdersByCustomer(customerId);
  });

  ipcMain.handle('update-order-status', (event, id, status) => {
    return OrderModel.updateOrderStatus(id, status);
  });

  // IPC Handlers for Activities
  ipcMain.handle('get-recent-activities', () => {
    return ActivityModel.getRecentActivities();
  });

  ipcMain.handle('log-activity', (event, desc, type) => {
    return ActivityModel.logActivity(desc, type);
  });

  // IPC Handlers for Users / PIN security
  ipcMain.handle('verify-pin', (event, pin) => {
    return UserModel.verifyPin(pin);
  });
  ipcMain.handle('get-users', () => {
    return UserModel.getUsers();
  });
  ipcMain.handle('create-user', (event, data) => {
    return UserModel.createUser(data.name, data.role, data.pin);
  });
  ipcMain.handle('delete-user', (event, id) => {
    return UserModel.deleteUser(id);
  });

  // IPC Handlers for Workflow Engine
  ipcMain.handle('get-workflow-steps', () => {
    return WorkflowModel.getSteps();
  });
  ipcMain.handle('update-workflow-steps', (event, steps) => {
    return WorkflowModel.updateSteps(steps);
  });
  ipcMain.handle('reset-workflow-steps', () => {
    return WorkflowModel.resetSteps();
  });

  // IPC Handlers for Pricing
  ipcMain.handle('get-all-pricing', () => PricingModel.getAll());
  ipcMain.handle('get-pricing', () => PricingModel.getAll()); // alias for renderer convenience
  ipcMain.handle('get-pricing-by-category', (event, category) => PricingModel.getByCategory(category));
  ipcMain.handle('create-pricing', (event, data) => PricingModel.create(data));
  ipcMain.handle('update-pricing', (event, id, data) => PricingModel.update(id, data));
  ipcMain.handle('delete-pricing', (event, id) => PricingModel.delete(id));

  // IPC Handlers for File Selection
  ipcMain.handle('select-files', async () => {
    const { dialog } = require('electron');
    const fs = require('fs');
    const mainWindow = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Supported Files', extensions: ['pdf', 'jpg', 'jpeg', 'png'] }]
    });
    
    // Restore focus to window to prevent Windows focus loss bug
    if (mainWindow) {
        mainWindow.focus();
        mainWindow.webContents.focus();
    }
    
    if (result.canceled) return [];
    
    return result.filePaths.map(p => {
        const stats = fs.statSync(p);
        return {
            name: path.basename(p),
            path: p,
            size: stats.size,
            ext: path.extname(p).toLowerCase(),
            addedAt: new Date().toISOString()
        };
    });
  });

  ipcMain.handle('open-incoming-folder', async () => {
    const { shell } = require('electron');
    const os = require('os');
    const incomingPath = path.join(os.homedir(), 'Documents', 'PrintShop', 'IncomingFiles');
    // Ensure it exists before opening
    const fs = require('fs');
    if (!fs.existsSync(incomingPath)) {
        fs.mkdirSync(incomingPath, { recursive: true });
    }
    await shell.openPath(incomingPath);
  });

  // IPC Handlers for Devices
  ipcMain.handle('get-devices', () => {
    return DeviceModel.getAllDevices();
  });

  ipcMain.handle('save-customer-order-file', async (event, fileData) => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    try {
        const incomingPath = path.join(os.homedir(), 'Documents', 'PrintShop', 'IncomingFiles');
        if (!fs.existsSync(incomingPath)) {
            fs.mkdirSync(incomingPath, { recursive: true });
        }
        
        // Handle array buffer from renderer
        const buffer = Buffer.from(fileData.bytes);
        
        // Prevent collisions
        const timestamp = Date.now();
        const ext = path.extname(fileData.name);
        const basename = path.basename(fileData.name, ext);
        const safeName = `${basename}_${timestamp}${ext}`;
        const filePath = path.join(incomingPath, safeName);
        
        fs.writeFileSync(filePath, buffer);
        
        return { success: true, path: filePath, name: safeName };
    } catch(e) {
        return { success: false, error: e.message };
    }
  });

  // IPC Handlers for Settings & Printers
  ipcMain.handle('get-settings', () => {
    return SettingsModel.getSettings();
  });

  ipcMain.handle('update-settings', (event, data) => {
    return SettingsModel.updateSettings(data);
  });

  ipcMain.handle('complete-wizard-setup', (event, data) => {
    return WizardModel.executeWizardSetup(data);
  });

  ipcMain.handle('get-printers', async () => {
    try {
      const targetWin = BrowserWindow.getAllWindows()[0];
      return targetWin ? await targetWin.webContents.getPrintersAsync() : [];
    } catch (err) {
      console.error("[Main] Error fetching system printers:", err);
      return [];
    }
  });

  // IPC Handlers for Backup
  ipcMain.handle('select-backup-folder', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], {
        properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('backup-database', async (event, destPath) => {
    const backupService = require('./database/services/backup-service');
    return await backupService.performBackup('manual');
  });

  ipcMain.handle('get-db-health', () => {
    const backupService = require('./database/services/backup-service');
    return backupService.getDatabaseHealth();
  });

  ipcMain.handle('get-backup-history', () => {
    const backupService = require('./database/services/backup-service');
    return backupService.getBackupHistory();
  });

  ipcMain.handle('trigger-manual-backup', async () => {
    const backupService = require('./database/services/backup-service');
    return await backupService.performBackup('manual');
  });

  ipcMain.handle('verify-backup', (event, filePath) => {
    const backupService = require('./database/services/backup-service');
    return backupService.verifyBackupFile(filePath);
  });

  ipcMain.handle('delete-backup', (event, filePath) => {
    const backupService = require('./database/services/backup-service');
    return backupService.deleteBackupFile(filePath);
  });

  ipcMain.handle('restore-backup', async (event, filePath) => {
    const backupService = require('./database/services/backup-service');
    return await backupService.restoreBackup(filePath);
  });

  ipcMain.handle('is-db-corrupted', () => {
    return !!global.isDatabaseCorrupted;
  });

  ipcMain.handle('recovery-restore', async (event, filePath) => {
    const backupService = require('./database/services/backup-service');
    return await backupService.restoreBackup(filePath);
  });

  ipcMain.handle('recovery-fresh-db', async () => {
    const fs = require('fs');
    const dbService = require('./database/db');
    const schema = require('./database/schema');
    try {
        dbService.close();
        const dbPath = dbService.dbPath;
        const corruptedPath = dbPath + `.corrupted_${Date.now()}`;
        if (fs.existsSync(dbPath)) {
            fs.renameSync(dbPath, corruptedPath);
        }
        dbService.reopen();

        global.isDatabaseCorrupted = false;
        schema.initDatabase();
        return { success: true };
    } catch(err) {
        console.error("Fresh DB creation failed:", err);
        return { success: false, error: err.message };
    }
  });

  ipcMain.handle('create-safety-backup', async (event, op) => {
    const backupService = require('./database/services/backup-service');
    return await backupService.createSafetyBackup(op);
  });

  ipcMain.handle('commit-safety-backup', (event, op) => {
    const backupService = require('./database/services/backup-service');
    return backupService.commitSafetyBackup(op);
  });

  ipcMain.handle('rollback-safety-backup', async (event, op) => {
    const backupService = require('./database/services/backup-service');
    return await backupService.rollbackSafetyBackup(op);
  });

  ipcMain.handle('print-file', async (event, payload, options) => {
    const settings = SettingsModel.getSettings();
    let printerName = settings ? settings.default_printer : null;
    
    // Auto printer selection depending on target roles
    if (options && options.role) {
        if (options.role === 'receipt') {
            printerName = settings.receipt_printer || printerName;
        } else if (options.role === 'photo') {
            printerName = settings.photo_printer || printerName;
        } else if (options.role === 'label' || options.role === 'barcode') {
            printerName = settings.label_printer || settings.barcode_printer || printerName;
        }
    }

    if (options && options.printerName) {
        printerName = options.printerName;
    }

    const useSystemDialog = settings ? (settings.use_system_dialog === 1) : false;
    const silent = settings ? (settings.silent_print_enabled === 1) : !useSystemDialog;
    
    if (!printerName && !useSystemDialog) {
        return { success: false, error: "No default printer set. Please go to Settings to choose one." };
    }
    
    try {
        const printOptions = {
            ...options,
            useSystemDialog: useSystemDialog,
            silent: silent
        };
        const { printFile } = require('./printer');
        return await printFile(payload, printerName, printOptions);
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('print-test-page', async (event, printerName) => {
      try {
          const { printTestPage } = require('./printer');
          return await printTestPage(printerName);
      } catch (e) {
          return { success: false, error: e.message || String(e) };
      }
  });

  ipcMain.handle('get-print-jobs', async () => {
      try {
          const db = require('./database/db');
          return db.prepare('SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT 100').all();
      } catch(e) {
          return [];
      }
  });

  ipcMain.handle('log-error', (event, msg) => {
      const fs = require('fs');
      const path = require('path');
      try {
          const logPath = path.join(app.getPath('userData'), 'renderer_error.log');
          fs.appendFileSync(logPath, new Date().toISOString() + ': ' + msg + '\n');
      } catch (e) {
          console.error("Failed to write to renderer_error.log:", e);
      }
  });

  ipcMain.handle('generate-unified-pdf', async (event, payload, options) => {
      try {
          const pdfBytes = await createUnifiedPdf(payload, options);
          return { success: true, pdfBytes: pdfBytes }; // Returns a Uint8Array
      } catch (e) {
          return { success: false, error: e.message };
      }
  });

  ipcMain.handle('save-order-files', async (event, customerName, customerPhone, orderId, pdfBytes, originalFilePaths) => {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      try {
          // Clean up name
          const cleanName = customerName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
          const folderName = cleanName;
          
          const dateStr = new Date().toISOString().split('T')[0];
          const orderFolderName = `Order_${dateStr}_${String(orderId).padStart(3, '0')}`;
          
          const baseDocsDir = app ? path.join(app.getPath('documents'), 'PrintShopManager') : path.join(os.homedir(), 'Documents', 'PrintShopManager');
          const docsPath = path.join(baseDocsDir, 'Customers', folderName, orderFolderName);
          fs.mkdirSync(docsPath, { recursive: true });
          
          const filePath = path.join(docsPath, `Unified_Order_${orderId}.pdf`);
          fs.writeFileSync(filePath, Buffer.from(pdfBytes));

          // Save path to DB
          const db = require('./database/db');
          db.prepare('UPDATE orders SET unified_pdf_path = ? WHERE id = ?').run(filePath, orderId);
          
          // Copy original files
          if (originalFilePaths && Array.isArray(originalFilePaths)) {
              originalFilePaths.forEach((origPath, index) => {
                  try {
                      if (fs.existsSync(origPath)) {
                          const ext = path.extname(origPath);
                          const destPath = path.join(docsPath, `Original_${index + 1}${ext}`);
                          fs.copyFileSync(origPath, destPath);
                      }
                  } catch (err) {
                      console.error(`Failed to copy original file ${origPath}:`, err);
                  }
              });
          }
          
          return { success: true, path: filePath };
      } catch (e) {
          return { success: false, error: e.message };
      }
  });

  // GST Tracker IPC Handlers
  ipcMain.handle('create-gst-invoice', (event, data) => {
    return GstModel.createInvoice(data.invoice, data.items);
  });

  ipcMain.handle('get-gst-invoices', (event, limit, offset) => {
    return GstModel.getInvoices(limit, offset);
  });

  ipcMain.handle('get-gst-invoice-items', (event, invoiceId) => {
    return GstModel.getInvoiceItems(invoiceId);
  });

  ipcMain.handle('get-gst-summary', () => {
    return GstModel.getGstSummary();
  });

  ipcMain.handle('update-customer-gst', (event, data) => {
    return GstModel.updateCustomerGst(data.customerId, data.gstin, data.state);
  });

  // ==========================================
  // INVENTORY IPC HANDLERS
  // ==========================================
  const InventoryModel = require('./database/inventory-model');
  
  ipcMain.handle('get-inv-categories', () => InventoryModel.getCategories());
  ipcMain.handle('create-inv-category', (event, data) => InventoryModel.createCategory(data));
  ipcMain.handle('update-inv-category', (event, { id, data }) => InventoryModel.updateCategory(id, data));
  ipcMain.handle('delete-inv-category', (event, id) => InventoryModel.deleteCategory(id));
  
  ipcMain.handle('get-inv-suppliers', () => InventoryModel.getSuppliers());
  ipcMain.handle('create-inv-supplier', (event, data) => InventoryModel.createSupplier(data));
  ipcMain.handle('update-inv-supplier', (event, { id, data }) => InventoryModel.updateSupplier(id, data));
  ipcMain.handle('delete-inv-supplier', (event, id) => InventoryModel.deleteSupplier(id));
  
  ipcMain.handle('get-inv-locations', () => InventoryModel.getLocations());
  ipcMain.handle('create-inv-location', (event, data) => InventoryModel.createLocation(data));
  ipcMain.handle('update-inv-location', (event, { id, data }) => InventoryModel.updateLocation(id, data));
  ipcMain.handle('delete-inv-location', (event, id) => InventoryModel.deleteLocation(id));
  
  ipcMain.handle('get-inv-items', () => InventoryModel.getItems());
  ipcMain.handle('get-inv-item-by-id', (event, id) => InventoryModel.getItemById(id));
  ipcMain.handle('create-inv-item', (event, data) => InventoryModel.createItem(data));
  ipcMain.handle('update-inv-item', (event, { id, data }) => InventoryModel.updateItem(id, data));
  ipcMain.handle('delete-inv-item', (event, id) => InventoryModel.deleteItem(id));
  
  ipcMain.handle('adjust-inv-stock', (event, data) => InventoryModel.adjustStock(data));
  ipcMain.handle('get-inv-transactions', (event, itemId) => InventoryModel.getStockTransactions(itemId));
  
  ipcMain.handle('get-inv-purchase-orders', () => InventoryModel.getPurchaseOrders());
  ipcMain.handle('get-inv-purchase-order-by-id', (event, id) => InventoryModel.getPurchaseOrderById(id));
  ipcMain.handle('create-inv-purchase-order', (event, data) => InventoryModel.createPurchaseOrder(data));
  ipcMain.handle('receive-inv-purchase-order', (event, { poId, data }) => InventoryModel.receivePurchaseOrder(poId, data));
  ipcMain.handle('cancel-inv-purchase-order', (event, { poId, data }) => InventoryModel.cancelPurchaseOrder(poId, data));
  
  ipcMain.handle('get-inv-alerts', () => InventoryModel.getAlerts());
  ipcMain.handle('get-inv-settings', () => InventoryModel.getSettings());
  ipcMain.handle('update-inv-settings', (event, data) => InventoryModel.updateSettings(data));
  
  ipcMain.handle('get-inv-dashboard-stats', () => InventoryModel.getDashboardStats());
  ipcMain.handle('get-inv-reports', (event, { start, end }) => InventoryModel.getInventoryReports(start, end));

  // ==========================================
  // ENTERPRISE MODULES IPC HANDLERS
  // ==========================================
  const RecipeService = require('./database/services/recipe-service');
  const TransferService = require('./database/services/transfer-service');
  const CountService = require('./database/services/count-service');
  const ForecastService = require('./database/services/forecast-service');
  const POService = require('./database/services/po-service');
  const NotificationService = require('./database/services/notification-service');
  const db = require('./database/db');

  ipcMain.handle('get-inv-recipes', () => RecipeService.getRecipes());
  ipcMain.handle('get-inv-recipe-by-id', (event, id) => RecipeService.getRecipeById(id));
  ipcMain.handle('save-inv-recipe', (event, data) => RecipeService.saveRecipe(data, data.operator, data.role));
  ipcMain.handle('delete-inv-recipe', (event, id) => RecipeService.softDeleteRecipe(id));

  ipcMain.handle('transfer-inv-stock', (event, data) => TransferService.transferStock(data, data.operator, data.role));
  ipcMain.handle('get-inv-transfers', () => TransferService.getTransfers());

  ipcMain.handle('create-inv-stock-count', (event, data) => CountService.createCount(data, data.operator, data.role));
  ipcMain.handle('approve-inv-stock-count', (event, id) => CountService.approveCount(id));
  ipcMain.handle('get-inv-stock-counts', () => CountService.getStockCounts());

  ipcMain.handle('get-inv-forecasting', (event, method) => ForecastService.getAllForecasts(method));
  ipcMain.handle('create-inv-return', (event, data) => POService.createPurchaseReturn(data, data.operator, data.role));

  ipcMain.handle('get-inv-notifications', (event, unreadOnly) => NotificationService.getNotifications(unreadOnly));
  ipcMain.handle('mark-inv-notification-read', (event, id) => NotificationService.markAsRead(id));
  ipcMain.handle('dismiss-all-inv-notifications', () => NotificationService.dismissAll());

  ipcMain.handle('get-printer-material-metrics', () => {
    return db.prepare('SELECT * FROM printer_material_metrics ORDER BY last_updated DESC').all();
  });

  // ==========================================
  // DOCUMENT STUDIO IPC HANDLERS — Phase 2A
  // ==========================================
  const DocEngine = require('./document-engine');

  // PDF Tools
  ipcMain.handle('doc-rotate-pages',     (e, filePath, indices, deg)        => DocEngine.rotatePdfPages(filePath, indices, deg));
  ipcMain.handle('doc-delete-pages',     (e, filePath, indices)             => DocEngine.deletePages(filePath, indices));
  ipcMain.handle('doc-reorder-pages',    (e, filePath, order)               => DocEngine.reorderPages(filePath, order));
  ipcMain.handle('doc-duplicate-pages',  (e, filePath, indices)             => DocEngine.duplicatePages(filePath, indices));
  ipcMain.handle('doc-extract-pages',    (e, filePath, indices)             => DocEngine.extractPages(filePath, indices));
  ipcMain.handle('doc-split-pdf',        (e, filePath, points)              => DocEngine.splitPdf(filePath, points));
  ipcMain.handle('doc-merge-pdfs',       (e, paths)                         => DocEngine.mergePdfs(paths));
  ipcMain.handle('doc-insert-blank',     (e, filePath, positions, paper)    => DocEngine.insertBlankPages(filePath, positions, paper));
  ipcMain.handle('doc-add-page-numbers', (e, filePath, opts)                => DocEngine.addPageNumbers(filePath, opts));
  ipcMain.handle('doc-add-watermark',    (e, filePath, text, opts)          => DocEngine.addWatermark(filePath, text, opts));
  ipcMain.handle('doc-add-stamp',        (e, filePath, text, indices, opts) => DocEngine.addStamp(filePath, text, indices, opts));
  ipcMain.handle('doc-scale-pages',      (e, filePath, sx, sy)              => DocEngine.scalePages(filePath, sx, sy));
  ipcMain.handle('doc-fit-to-area',      (e, filePath, w, h, mode)          => DocEngine.fitToArea(filePath, w, h, mode));
  ipcMain.handle('doc-crop-pages',       (e, filePath, box, indices)        => DocEngine.cropPages(filePath, box, indices));
  ipcMain.handle('doc-auto-rotate',      (e, filePath)                      => DocEngine.autoRotateDetect(filePath));

  // Output & Integration
  ipcMain.handle('doc-save-output',      (e, pdfBytes, name, dir)           => DocEngine.saveOutput(pdfBytes, name, dir));
  ipcMain.handle('doc-save-to-order',    (e, pdfBytes, name)                => DocEngine.saveToOrderIncoming(pdfBytes, name));

  // System Janitor & Maintenance
  ipcMain.handle('system-cleanup-temp',  ()                                 => require('./janitor').cleanupTempFiles());
  ipcMain.handle('system-optimize-db',   ()                                 => require('./janitor').optimizeDatabase());

  // Project Management
  ipcMain.handle('doc-get-projects',     ()                                 => { try { return { success: true, data: DocEngine.getProjects() }; } catch(e) { return { success: false, error: e.message }; } });
  ipcMain.handle('doc-create-project',   (e, data)                          => { try { return { success: true, data: DocEngine.createProject(data) }; } catch(e) { return { success: false, error: e.message }; } });
  ipcMain.handle('doc-save-project',     (e, projectId, stateJson)          => { try { return DocEngine.saveProject(projectId, stateJson); } catch(e) { return { success: false, error: e.message }; } });
  ipcMain.handle('doc-delete-project',   (e, projectId)                     => { try { return DocEngine.deleteProject(projectId); } catch(e) { return { success: false, error: e.message }; } });

  // Presets
  ipcMain.handle('doc-get-presets',      (e, type)                          => { try { return { success: true, data: DocEngine.getPresets(type) }; } catch(e) { return { success: false, error: e.message }; } });
  ipcMain.handle('doc-save-preset',      (e, data)                          => { try { return { success: true, data: DocEngine.savePreset(data) }; } catch(e) { return { success: false, error: e.message }; } });
  ipcMain.handle('doc-delete-preset',    (e, id)                            => { try { return DocEngine.deletePreset(id); } catch(e) { return { success: false, error: e.message }; } });

  // Session / Crash Recovery
  ipcMain.handle('doc-save-session',     (e, projectId, stateJson)          => { try { return DocEngine.saveSessionState(projectId, stateJson); } catch(e) { return { success: false, error: e.message }; } });
  ipcMain.handle('doc-get-session',      (e, projectId)                     => { try { return { success: true, data: DocEngine.getSessionState(projectId) }; } catch(e) { return { success: false, error: e.message }; } });
  ipcMain.handle('doc-clear-session',    (e, projectId)                     => { try { return DocEngine.clearSessionState(projectId); } catch(e) { return { success: false, error: e.message }; } });

  // Plugin extensibility
  ipcMain.handle('doc-process-plugin',   (e, filePath, pluginId, params)    => DocEngine.processWithPlugin(filePath, pluginId, params));
  ipcMain.handle('doc-batch-process',    (e, filePaths, operation, params)  => DocEngine.batchProcess(filePaths, operation, params));

  ipcMain.handle('doc-convert-office', async (e, filePath) => {
      const { convertOfficeToPdf } = require('./doc-converter');
      try {
          const outputDir = path.join(app.getPath('userData'), 'DocumentStudio', 'Converted');
          const pdfPath = await convertOfficeToPdf(filePath, outputDir);
          return { success: true, pdfPath };
      } catch (err) {
          return { success: false, error: err.message };
      }
  });

  ipcMain.handle('doc-compile-print-pdf', async (e, recipe) => {
      try {
          const res = await DocEngine.compilePrintReadyPdf(recipe);
          if (!res.success) throw new Error(res.error);
          
          const outputDir = path.join(app.getPath('userData'), 'DocumentStudio', 'Compiled');
          const timestamp = Date.now();
          const targetPath = path.join(outputDir, `Compiled_${timestamp}.pdf`);
          
          fs.mkdirSync(outputDir, { recursive: true });
          fs.writeFileSync(targetPath, res.data);
          
          return { success: true, filePath: targetPath };
      } catch (err) {
          return { success: false, error: err.message };
      }
  });

  // Enterprise Products, Print Profiles, and Device Manager IPC Handlers
  ipcMain.handle('products:getAll', () => ProductModel.getAll());
  ipcMain.handle('products:save', (e, data) => data.id ? ProductModel.update(data.id, data) : ProductModel.create(data));
  ipcMain.handle('products:delete', (e, id) => ProductModel.delete(id));

  ipcMain.handle('profiles:getAll', () => PrintProfileModel.getAll());
  ipcMain.handle('profiles:save', (e, data) => data.id ? PrintProfileModel.update(data.id, data) : PrintProfileModel.create(data));
  ipcMain.handle('profiles:duplicate', (e, id) => PrintProfileModel.duplicate(id));
  ipcMain.handle('profiles:delete', (e, id) => PrintProfileModel.delete(id));

  ipcMain.handle('devices:getPrinters', () => DeviceManager.getPrinters());
  ipcMain.handle('devices:discoverPrinters', () => DeviceManager.discoverPrinters());
  ipcMain.handle('devices:getGroups', () => DeviceManager.getGroups());
  ipcMain.handle('devices:saveGroup', (e, data) => DeviceManager.saveGroup(data));
  ipcMain.handle('devices:deleteGroup', (e, id) => DeviceManager.deleteGroup(id));
  ipcMain.handle('devices:getCalibrations', () => DeviceManager.getCalibrations());
  ipcMain.handle('devices:getCalibration', (e, name) => DeviceManager.getCalibration(name));
  ipcMain.handle('devices:saveCalibration', (e, name, data) => DeviceManager.saveCalibration(name, data));

  ipcMain.handle('print:validateDocument', (e, filePath) => DocumentValidator.validate(filePath));
  ipcMain.handle('print:getAuditLogs', (e, limit) => PrintAuditLogModel.getLogs(limit));
  ipcMain.handle('print:getLogById', (e, id) => PrintAuditLogModel.getLogById(id));
  
  ipcMain.handle('print:reprintJob', async (e, auditLogId) => {
      try {
          const log = PrintAuditLogModel.getLogById(auditLogId);
          if (!log) throw new Error("Print audit log not found");
          
          const snapshot = JSON.parse(log.print_profile_snapshot_json || '{}');
          // For reprint, payload is the original compiled/unified file path
          const payload = [{ path: log.file_path, ext: '.pdf', rotate: 0, fit: 'contain' }];
          
          const printOptions = {
              ...snapshot,
              copies: log.copies,
              printProfileId: log.print_profile_id,
              productId: log.product_id
          };
          
          const { printFile } = require('./printer');
          return await printFile(payload, log.printer_name, printOptions);
      } catch (err) {
          return { success: false, error: err.message };
      }
  });

  ipcMain.handle('toggle-fullscreen', () => {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      if (win) {
          const isFS = win.isFullScreen();
          win.setFullScreen(!isFS);
          return !isFS;
      }
      return false;
  });

  ipcMain.handle('set-fullscreen', (event, flag) => {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      if (win) {
          win.setFullScreen(!!flag);
          return win.isFullScreen();
      }
      return false;
  });

  ipcMain.handle('is-fullscreen', () => {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      return win ? win.isFullScreen() : false;
  });
  } // End of if (!global.ipcHandlersRegistered)

  // Open DevTools during development
  // mainWindow.webContents.openDevTools();
  return mainWindow;
}

const { startServer, getServerInfo } = require('./server');
const { initCloudSync, setupCloudIPC } = require('./cloud-sync');

app.whenReady().then(() => {
  // Register custom protocol handler for loading local files securely
  protocol.handle('app-file', (request) => {
    try {
      let rawPath = request.url.replace(/^app-file:\/\/\/?/, '');
      rawPath = decodeURIComponent(rawPath);
      const normalizedPath = path.normalize(rawPath);
      if (!fs.existsSync(normalizedPath)) {
        return new Response('File not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(normalizedPath).toString());
    } catch (err) {
      console.error("[Custom Protocol] Error loading file:", err);
      return new Response('Error loading file: ' + err.message, { status: 500 });
    }
  });

  DeviceModel.upsertDevice(os.hostname(), os.userInfo().username);
  const win = createWindow();

  setupCloudIPC();
  initCloudSync(win);

  // Discover and cache printers on startup
  DeviceManager.discoverPrinters().catch(err => {
      console.error("[Startup] Failed to run initial printer discovery:", err);
  });

  // Startup Printer Check
  setTimeout(async () => {
      try {
          const settings = SettingsModel.getSettings();
          if (settings) {
              const defaultPrinter = settings.default_printer;
              const NotificationService = require('./database/services/notification-service');
              
              if (!defaultPrinter) {
                  NotificationService.publish(
                      'system_warning',
                      'WARNING: Default print driver is unconfigured. Please select a printer in Settings.',
                      null,
                      'Medium'
                  );
              } else {
                  const printers = await win.webContents.getPrintersAsync();
                  const printerMatch = printers.find(p => p.name === defaultPrinter || p.displayName === defaultPrinter);
                  if (!printerMatch) {
                      NotificationService.publish(
                          'system_warning',
                          `WARNING: The configured default printer "${defaultPrinter}" was not detected on this system.`,
                          null,
                          'High'
                      );
                  } else {
                      const descLower = (printerMatch.description || '').toLowerCase();
                      const isOffline = printerMatch.status === 6 || printerMatch.status === 7 || printerMatch.status === 128 || descLower.includes('offline');
                      if (isOffline) {
                          NotificationService.publish(
                              'system_warning',
                              `WARNING: The configured printer "${defaultPrinter}" is currently OFFLINE.`,
                              null,
                              'Medium'
                          );
                      }
                  }
              }
          }
      } catch(err) {
          console.error("Failed to execute startup printer validation check:", err);
      }
  }, 2000);

  startServer(win).catch(err => {
      console.error("Failed to start local mobile order server:", err);
  });

  // Database Scheduler: Startup automatic backup check
  setTimeout(async () => {
      if (global.isDatabaseCorrupted) return;
      try {
          const backupService = require('./database/services/backup-service');
          const health = backupService.getDatabaseHealth();
          let runBackup = false;
          if (health.lastBackup === 'Never') {
              runBackup = true;
          } else {
              const lastBackupDate = new Date(health.lastBackup.replace(' ', 'T') + 'Z');
              const diffTime = Date.now() - lastBackupDate.getTime();
              const diffHours = diffTime / (1000 * 60 * 60);
              if (diffHours >= 24) {
                  runBackup = true;
              }
          }
          if (runBackup) {
              console.log("[BackupScheduler] Running daily automatic database backup...");
              await backupService.performBackup('automatic');
          }
      } catch (err) {
          console.error("[BackupScheduler] Startup automatic backup check failed:", err);
      }
  }, 5000);

  // Periodic checks: run integrity check and check auto-backup every 24 hours
  setInterval(async () => {
      if (global.isDatabaseCorrupted) return;
      console.log("[BackupScheduler] Running periodic 24h database integrity check and backup check...");
      try {
          const backupService = require('./database/services/backup-service');
          const healthy = backupService.runIntegrityChecks();
          if (healthy) {
              await backupService.performBackup('automatic');
          }
      } catch (err) {
          console.error("[BackupScheduler] Periodic database check failed:", err);
      }
  }, 24 * 60 * 60 * 1000);

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('get-server-info', async () => {
    return getServerInfo();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
