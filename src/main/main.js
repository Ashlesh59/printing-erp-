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

    const sessionManager = require('./security/session-manager');
    const { ROLES, registerGuardedHandler } = require('./security/ipc-guard');
    const { LicenseService, LicenseState } = require('./security/license-service');
    const pinSecurity = require('./security/pin-security');
    const authThrottle = require('./security/auth-throttle');

    // ==========================================
    // AUTHENTICATION & SESSION IPC HANDLERS
    // ==========================================
    registerGuardedHandler('auth:login', ROLES.PUBLIC, async (event, { pin, role = 'Any' }) => {
      const senderId = event.sender ? event.sender.id : null;
      const result = await UserModel.verifyPin(pin, senderId, role);
      if (!result.success) {
        return result;
      }
      const sessionRole = role === 'Shop' ? (result.user.role || 'Operator') : (role === 'Admin' ? 'Admin' : result.user.role);
      const session = sessionManager.createSession(event.sender, result.user, sessionRole);
      return {
        success: true,
        session: {
          role: session.role,
          user: session.user,
          authenticatedAt: session.authenticatedAt
        }
      };
    });

    registerGuardedHandler('auth:kiosk-login', ROLES.PUBLIC, async (event) => {
      const session = sessionManager.createKioskSession(event.sender);
      return {
        success: true,
        session: {
          role: session.role,
          user: session.user,
          authenticatedAt: session.authenticatedAt
        }
      };
    });

    registerGuardedHandler('auth:get-session', ROLES.PUBLIC, async (event) => {
      const session = sessionManager.getSession(event.sender);
      if (!session) {
        return { authenticated: false, role: null, user: null };
      }
      return {
        authenticated: true,
        role: session.role,
        user: session.user,
        authenticatedAt: session.authenticatedAt
      };
    });

    registerGuardedHandler('auth:logout', ROLES.PUBLIC, async (event) => {
      sessionManager.destroySession(event.sender);
      return { success: true };
    });

    // Backwards-compatible PIN verify wrapper
    registerGuardedHandler('verify-pin', ROLES.PUBLIC, async (event, pin) => {
      const senderId = event.sender ? event.sender.id : null;
      return await UserModel.verifyPin(pin, senderId);
    });

    // ==========================================
    // LICENSE IPC HANDLERS (Fail-Closed)
    // ==========================================
    registerGuardedHandler('check-license', ROLES.PUBLIC, () => {
      const status = LicenseService.checkLicenseStatus();
      return status.valid === true;
    });

    registerGuardedHandler('activate-license', ROLES.PUBLIC, (event, key) => {
      return LicenseService.activateLicense(key);
    });

    registerGuardedHandler('get-license-info', ROLES.PUBLIC, () => {
      return LicenseService.getPublicLicenseInfo();
    });

    // ==========================================
    // CUSTOMER MANAGEMENT (OPERATOR+)
    // ==========================================
    registerGuardedHandler('search-customers', ROLES.OPERATOR, (event, phone) => {
      return CustomerModel.searchByPhone(phone);
    });

    registerGuardedHandler('create-customer', ROLES.OPERATOR, (event, data) => {
      return CustomerModel.createCustomer(data);
    });

    registerGuardedHandler('update-customer-profile', ROLES.OPERATOR, (event, id, data) => {
      return CustomerModel.updateCustomer(id, data);
    });

    registerGuardedHandler('get-all-customers', ROLES.OPERATOR, (event, limit, offset) => {
      return CustomerModel.getAllCustomers(limit, offset);
    });

    registerGuardedHandler('search-customers-advanced', ROLES.OPERATOR, (event, opts = {}) => {
      const { query = '', tag = 'All', sortBy = 'last_visit', limit = 50, offset = 0 } = opts;
      return CustomerModel.searchCustomersAdvanced(query, tag, sortBy, limit, offset);
    });

    registerGuardedHandler('get-customer-profile', ROLES.OPERATOR, (event, customerId) => {
      return CustomerModel.getCustomerProfile(customerId);
    });

    registerGuardedHandler('add-customer-note', ROLES.OPERATOR, (event, customerId, note, author) => {
      return CustomerModel.addNote(customerId, note, author);
    });

    registerGuardedHandler('delete-customer-note', ROLES.ADMIN, (event, noteId) => {
      return CustomerModel.deleteNote(noteId);
    });

    registerGuardedHandler('add-customer-document', ROLES.OPERATOR, (event, customerId, orderId, fileName, filePath, fileSize, category) => {
      return CustomerModel.addDocument(customerId, orderId, fileName, filePath, fileSize, category);
    });

    registerGuardedHandler('duplicate-order-for-customer', ROLES.OPERATOR, (event, orderId) => {
      return CustomerModel.duplicateOrder(orderId);
    });

    // ==========================================
    // PRODUCTION QUEUE & SCHEDULING (OPERATOR+)
    // ==========================================
    const ProductionModel = require('./database/production-model');
    const SmartScheduler = require('./smart-scheduler');

    registerGuardedHandler('production:getJobs', ROLES.OPERATOR, (event, filters, searchQuery) => {
      return ProductionModel.getJobs(filters, searchQuery);
    });

    registerGuardedHandler('production:getDashboardStats', ROLES.OPERATOR, (event, filters) => {
      return ProductionModel.getDashboardStats(filters || {});
    });

    registerGuardedHandler('production:createJob', ROLES.OPERATOR, (event, data) => {
      return ProductionModel.createJob(data);
    });

    registerGuardedHandler('production:updateStatus', ROLES.OPERATOR, (event, jobId, status) => {
      return ProductionModel.updateStatus(jobId, status);
    });

    registerGuardedHandler('production:updatePriority', ROLES.OPERATOR, (event, jobId, priority) => {
      return ProductionModel.updatePriority(jobId, priority);
    });

    registerGuardedHandler('production:assignPrinter', ROLES.OPERATOR, (event, jobId, printerName) => {
      return ProductionModel.assignPrinter(jobId, printerName);
    });

    registerGuardedHandler('production:reorderQueue', ROLES.OPERATOR, (event, orderedJobIds) => {
      return ProductionModel.reorderQueue(orderedJobIds);
    });

    registerGuardedHandler('production:moveUp', ROLES.OPERATOR, (event, jobId) => {
      return ProductionModel.moveJobUp(jobId);
    });

    registerGuardedHandler('production:moveDown', ROLES.OPERATOR, (event, jobId) => {
      return ProductionModel.moveJobDown(jobId);
    });

    registerGuardedHandler('production:recommendPrinter', ROLES.OPERATOR, (event, jobSpecs) => {
      return SmartScheduler.recommendPrinter(jobSpecs);
    });

    registerGuardedHandler('production:duplicateJob', ROLES.OPERATOR, (event, jobId) => {
      return ProductionModel.duplicateJob(jobId);
    });

    registerGuardedHandler('production:deleteJob', ROLES.ADMIN, (event, jobId) => {
      return ProductionModel.deleteJob(jobId);
    });

    registerGuardedHandler('production:scheduleJob', ROLES.OPERATOR, (event, jobId, scheduleData) => {
      return ProductionModel.scheduleJob(jobId, scheduleData);
    });

    // ==========================================
    // ORDER MANAGEMENT (OPERATOR+)
    // ==========================================
    const OrderService = require('./services/order-service');
    const PricingEngine = require('./services/pricing-engine');
    const ReconciliationService = require('./services/reconciliation-service');

    // Run Startup Reconciliation
    ReconciliationService.runStartupReconciliation();

    registerGuardedHandler('orders:submit', ROLES.CUSTOMER, (event, data) => {
      return OrderService.submitOrder(event.sender, data);
    });

    registerGuardedHandler('orders:cancel', ROLES.OPERATOR, (event, { orderId, reason }) => {
      return OrderService.cancelOrder(event.sender, orderId, reason);
    });

    registerGuardedHandler('orders:retry-print', ROLES.OPERATOR, (event, { orderId, options }) => {
      return OrderService.retryPrint(event.sender, orderId, options);
    });

    registerGuardedHandler('orders:record-payment', ROLES.OPERATOR, (event, data) => {
      return OrderService.recordPayment(event.sender, data);
    });

    registerGuardedHandler('orders:calculate-pricing', ROLES.OPERATOR, (event, { items, options }) => {
      return PricingEngine.calculateOrderPricing(items, options);
    });

    // Backwards-compatible create-order handler
    registerGuardedHandler('create-order', ROLES.OPERATOR, (event, data) => {
      return OrderService.submitOrder(event.sender, data);
    });

    registerGuardedHandler('get-order-item-specifications', ROLES.OPERATOR, (event, orderItemId) => {
      return OrderModel.getOrderItemSpecifications(orderItemId);
    });

    registerGuardedHandler('get-recent-orders', ROLES.OPERATOR, (event, limit, offset) => {
      return OrderModel.getRecentOrders(limit, offset);
    });

    registerGuardedHandler('get-dashboard-stats', ROLES.OPERATOR, () => {
      return OrderModel.getDashboardStats();
    });

    registerGuardedHandler('get-customer-orders', ROLES.OPERATOR, (event, customerId) => {
      return OrderModel.getOrdersByCustomer(customerId);
    });

    registerGuardedHandler('update-order-status', ROLES.OPERATOR, (event, id, status) => {
      return OrderModel.updateOrderStatus(id, status);
    });

    // ==========================================
    // ACTIVITIES & AUDIT (OPERATOR+)
    // ==========================================
    registerGuardedHandler('get-recent-activities', ROLES.OPERATOR, () => {
      return ActivityModel.getRecentActivities();
    });

    registerGuardedHandler('log-activity', ROLES.OPERATOR, (event, desc, type) => {
      return ActivityModel.logActivity(desc, type);
    });

    // ==========================================
    // USER & CREDENTIAL MANAGEMENT (ADMIN ONLY)
    // ==========================================
    registerGuardedHandler('get-users', ROLES.ADMIN, () => {
      return UserModel.getUsers();
    });

    registerGuardedHandler('create-user', ROLES.ADMIN, async (event, data) => {
      return await UserModel.createUser(data.name, data.role, data.pin);
    });

    registerGuardedHandler('change-pin', ROLES.ADMIN, async (event, data) => {
      return await UserModel.changePin(data.userId, data.oldPin, data.newPin);
    });

    registerGuardedHandler('delete-user', ROLES.ADMIN, (event, id) => {
      return UserModel.deleteUser(id);
    });

    // ==========================================
    // WORKFLOW ENGINE
    // ==========================================
    registerGuardedHandler('get-workflow-steps', ROLES.OPERATOR, () => {
      return WorkflowModel.getSteps();
    });

    registerGuardedHandler('update-workflow-steps', ROLES.ADMIN, (event, steps) => {
      return WorkflowModel.updateSteps(steps);
    });

    registerGuardedHandler('reset-workflow-steps', ROLES.ADMIN, () => {
      return WorkflowModel.resetSteps();
    });

    // ==========================================
    // PRICING MANAGEMENT
    // ==========================================
    registerGuardedHandler('get-all-pricing', ROLES.OPERATOR, () => PricingModel.getAll());
    registerGuardedHandler('get-pricing', ROLES.OPERATOR, () => PricingModel.getAll());
    registerGuardedHandler('get-pricing-by-category', ROLES.OPERATOR, (event, category) => PricingModel.getByCategory(category));
    registerGuardedHandler('create-pricing', ROLES.ADMIN, (event, data) => PricingModel.create(data));
    registerGuardedHandler('update-pricing', ROLES.ADMIN, (event, id, data) => PricingModel.update(id, data));
    registerGuardedHandler('delete-pricing', ROLES.ADMIN, (event, id) => PricingModel.delete(id));

    // ==========================================
    // FILE SELECTION & CUSTOMER SUBMISSION
    // ==========================================
    registerGuardedHandler('select-files', ROLES.OPERATOR, async () => {
      const { dialog } = require('electron');
      const mainWindow = BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Supported Files', extensions: ['pdf', 'jpg', 'jpeg', 'png'] }]
      });
      
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

    registerGuardedHandler('open-incoming-folder', ROLES.OPERATOR, async () => {
      const { shell } = require('electron');
      const incomingPath = path.join(os.homedir(), 'Documents', 'PrintShop', 'IncomingFiles');
      if (!fs.existsSync(incomingPath)) {
        fs.mkdirSync(incomingPath, { recursive: true });
      }
      await shell.openPath(incomingPath);
    });

    registerGuardedHandler('get-devices', ROLES.OPERATOR, () => {
      return DeviceModel.getAllDevices();
    });

    // Customer safe upload (CUSTOMER+)
    registerGuardedHandler('save-customer-order-file', ROLES.CUSTOMER, async (event, fileData) => {
      try {
        const incomingPath = path.join(os.homedir(), 'Documents', 'PrintShop', 'IncomingFiles');
        if (!fs.existsSync(incomingPath)) {
          fs.mkdirSync(incomingPath, { recursive: true });
        }
        
        const buffer = Buffer.from(fileData.bytes);
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

    // ==========================================
    // SETTINGS & SETUP WIZARD
    // ==========================================
    registerGuardedHandler('get-settings', ROLES.PUBLIC, () => {
      return SettingsModel.getSettings();
    });

    registerGuardedHandler('update-settings', ROLES.ADMIN, (event, data) => {
      return SettingsModel.updateSettings(data);
    });

    registerGuardedHandler('complete-wizard-setup', ROLES.PUBLIC, (event, data) => {
      return WizardModel.executeWizardSetup(data);
    });

    registerGuardedHandler('get-printers', ROLES.OPERATOR, async () => {
      try {
        const targetWin = BrowserWindow.getAllWindows()[0];
        return targetWin ? await targetWin.webContents.getPrintersAsync() : [];
      } catch (err) {
        console.error("[Main] Error fetching system printers:", err);
        return [];
      }
    });

    // ==========================================
    // BACKUP & RECOVERY (ADMIN ONLY)
    // ==========================================
    registerGuardedHandler('select-backup-folder', ROLES.ADMIN, async () => {
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], {
        properties: ['openDirectory']
      });
      return result.canceled ? null : result.filePaths[0];
    });

    registerGuardedHandler('backup-database', ROLES.ADMIN, async (event, destPath) => {
      const backupService = require('./database/services/backup-service');
      return await backupService.performBackup('manual');
    });

    registerGuardedHandler('get-db-health', ROLES.ADMIN, () => {
      const backupService = require('./database/services/backup-service');
      return backupService.getDatabaseHealth();
    });

    registerGuardedHandler('get-backup-history', ROLES.ADMIN, () => {
      const backupService = require('./database/services/backup-service');
      return backupService.getBackupHistory();
    });

    registerGuardedHandler('trigger-manual-backup', ROLES.ADMIN, async () => {
      const backupService = require('./database/services/backup-service');
      return await backupService.performBackup('manual');
    });

    registerGuardedHandler('verify-backup', ROLES.ADMIN, (event, filePath) => {
      const backupService = require('./database/services/backup-service');
      return backupService.verifyBackupFile(filePath);
    });

    registerGuardedHandler('delete-backup', ROLES.ADMIN, (event, filePath) => {
      const backupService = require('./database/services/backup-service');
      return backupService.deleteBackupFile(filePath);
    });

    registerGuardedHandler('restore-backup', ROLES.ADMIN, async (event, filePath) => {
      const backupService = require('./database/services/backup-service');
      return await backupService.restoreBackup(filePath);
    });

    registerGuardedHandler('is-db-corrupted', ROLES.PUBLIC, () => {
      return !!global.isDatabaseCorrupted;
    });

    registerGuardedHandler('recovery-restore', ROLES.ADMIN, async (event, filePath) => {
      const backupService = require('./database/services/backup-service');
      return await backupService.restoreBackup(filePath);
    });

    registerGuardedHandler('recovery-fresh-db', ROLES.ADMIN, async () => {
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

    registerGuardedHandler('create-safety-backup', ROLES.ADMIN, async (event, op) => {
      const backupService = require('./database/services/backup-service');
      return await backupService.createSafetyBackup(op);
    });

    registerGuardedHandler('commit-safety-backup', ROLES.ADMIN, (event, op) => {
      const backupService = require('./database/services/backup-service');
      return backupService.commitSafetyBackup(op);
    });

    registerGuardedHandler('rollback-safety-backup', ROLES.ADMIN, async (event, op) => {
      const backupService = require('./database/services/backup-service');
      return await backupService.rollbackSafetyBackup(op);
    });

    // ==========================================
    // PRINTING SERVICES (OPERATOR+)
    // ==========================================
    registerGuardedHandler('print-file', ROLES.OPERATOR, async (event, payload, options) => {
      const settings = SettingsModel.getSettings();
      let printerName = settings ? settings.default_printer : null;
      
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

    registerGuardedHandler('print-test-page', ROLES.OPERATOR, async (event, printerName) => {
      try {
        const { printTestPage } = require('./printer');
        return await printTestPage(printerName);
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    });

    registerGuardedHandler('get-print-jobs', ROLES.OPERATOR, async () => {
      try {
        const db = require('./database/db');
        return db.prepare('SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT 100').all();
      } catch(e) {
        return [];
      }
    });

    registerGuardedHandler('log-error', ROLES.PUBLIC, (event, msg) => {
      try {
        const logPath = path.join(app.getPath('userData'), 'renderer_error.log');
        fs.appendFileSync(logPath, new Date().toISOString() + ': ' + msg + '\n');
      } catch (e) {
        console.error("Failed to write to renderer_error.log:", e);
      }
    });

    registerGuardedHandler('generate-unified-pdf', ROLES.OPERATOR, async (event, payload, options) => {
      try {
        const pdfBytes = await createUnifiedPdf(payload, options);
        return { success: true, pdfBytes: pdfBytes };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    registerGuardedHandler('save-order-files', ROLES.OPERATOR, async (event, customerName, customerPhone, orderId, pdfBytes, originalFilePaths) => {
      try {
        const cleanName = customerName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const dateStr = new Date().toISOString().split('T')[0];
        const orderFolderName = `Order_${dateStr}_${String(orderId).padStart(3, '0')}`;
        
        const baseDocsDir = app ? path.join(app.getPath('documents'), 'PrintShopManager') : path.join(os.homedir(), 'Documents', 'PrintShopManager');
        const docsPath = path.join(baseDocsDir, 'Customers', cleanName, orderFolderName);
        fs.mkdirSync(docsPath, { recursive: true });
        
        const filePath = path.join(docsPath, `Unified_Order_${orderId}.pdf`);
        fs.writeFileSync(filePath, Buffer.from(pdfBytes));

        const db = require('./database/db');
        db.prepare('UPDATE orders SET unified_pdf_path = ? WHERE id = ?').run(filePath, orderId);
        
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

    // ==========================================
    // GST TRACKER (OPERATOR+)
    // ==========================================
    registerGuardedHandler('create-gst-invoice', ROLES.OPERATOR, (event, data) => {
      return GstModel.createInvoice(data.invoice, data.items);
    });

    registerGuardedHandler('get-gst-invoices', ROLES.OPERATOR, (event, limit, offset) => {
      return GstModel.getInvoices(limit, offset);
    });

    registerGuardedHandler('get-gst-invoice-items', ROLES.OPERATOR, (event, invoiceId) => {
      return GstModel.getInvoiceItems(invoiceId);
    });

    registerGuardedHandler('get-gst-summary', ROLES.OPERATOR, () => {
      return GstModel.getGstSummary();
    });

    registerGuardedHandler('update-customer-gst', ROLES.OPERATOR, (event, data) => {
      return GstModel.updateCustomerGst(data.customerId, data.gstin, data.state);
    });

    // ==========================================
    // INVENTORY IPC HANDLERS
    // ==========================================
    const InventoryModel = require('./database/inventory-model');
    
    registerGuardedHandler('get-inv-categories', ROLES.OPERATOR, () => InventoryModel.getCategories());
    registerGuardedHandler('create-inv-category', ROLES.ADMIN, (event, data) => InventoryModel.createCategory(data));
    registerGuardedHandler('update-inv-category', ROLES.ADMIN, (event, { id, data }) => InventoryModel.updateCategory(id, data));
    registerGuardedHandler('delete-inv-category', ROLES.ADMIN, (event, id) => InventoryModel.deleteCategory(id));
    
    registerGuardedHandler('get-inv-suppliers', ROLES.OPERATOR, () => InventoryModel.getSuppliers());
    registerGuardedHandler('create-inv-supplier', ROLES.ADMIN, (event, data) => InventoryModel.createSupplier(data));
    registerGuardedHandler('update-inv-supplier', ROLES.ADMIN, (event, { id, data }) => InventoryModel.updateSupplier(id, data));
    registerGuardedHandler('delete-inv-supplier', ROLES.ADMIN, (event, id) => InventoryModel.deleteSupplier(id));
    
    registerGuardedHandler('get-inv-locations', ROLES.OPERATOR, () => InventoryModel.getLocations());
    registerGuardedHandler('create-inv-location', ROLES.ADMIN, (event, data) => InventoryModel.createLocation(data));
    registerGuardedHandler('update-inv-location', ROLES.ADMIN, (event, { id, data }) => InventoryModel.updateLocation(id, data));
    registerGuardedHandler('delete-inv-location', ROLES.ADMIN, (event, id) => InventoryModel.deleteLocation(id));
    
    registerGuardedHandler('get-inv-items', ROLES.OPERATOR, () => InventoryModel.getItems());
    registerGuardedHandler('get-inv-item-by-id', ROLES.OPERATOR, (event, id) => InventoryModel.getItemById(id));
    registerGuardedHandler('create-inv-item', ROLES.ADMIN, (event, data) => InventoryModel.createItem(data));
    registerGuardedHandler('update-inv-item', ROLES.ADMIN, (event, { id, data }) => InventoryModel.updateItem(id, data));
    registerGuardedHandler('delete-inv-item', ROLES.ADMIN, (event, id) => InventoryModel.deleteItem(id));
    
    registerGuardedHandler('adjust-inv-stock', ROLES.ADMIN, (event, data) => InventoryModel.adjustStock(data));
    registerGuardedHandler('get-inv-transactions', ROLES.OPERATOR, (event, itemId) => InventoryModel.getStockTransactions(itemId));
    
    registerGuardedHandler('get-inv-purchase-orders', ROLES.OPERATOR, () => InventoryModel.getPurchaseOrders());
    registerGuardedHandler('get-inv-purchase-order-by-id', ROLES.OPERATOR, (event, id) => InventoryModel.getPurchaseOrderById(id));
    registerGuardedHandler('create-inv-purchase-order', ROLES.ADMIN, (event, data) => InventoryModel.createPurchaseOrder(data));
    registerGuardedHandler('receive-inv-purchase-order', ROLES.ADMIN, (event, { poId, data }) => InventoryModel.receivePurchaseOrder(poId, data));
    registerGuardedHandler('cancel-inv-purchase-order', ROLES.ADMIN, (event, { poId, data }) => InventoryModel.cancelPurchaseOrder(poId, data));
    
    registerGuardedHandler('get-inv-alerts', ROLES.OPERATOR, () => InventoryModel.getAlerts());
    registerGuardedHandler('get-inv-settings', ROLES.OPERATOR, () => InventoryModel.getSettings());
    registerGuardedHandler('update-inv-settings', ROLES.ADMIN, (event, data) => InventoryModel.updateSettings(data));
    
    registerGuardedHandler('get-inv-dashboard-stats', ROLES.OPERATOR, () => InventoryModel.getDashboardStats());
    registerGuardedHandler('get-inv-reports', ROLES.OPERATOR, (event, { start, end }) => InventoryModel.getInventoryReports(start, end));

    // ==========================================
    // ENTERPRISE RECIPES & FORECASTING
    // ==========================================
    const RecipeService = require('./database/services/recipe-service');
    const TransferService = require('./database/services/transfer-service');
    const CountService = require('./database/services/count-service');
    const ForecastService = require('./database/services/forecast-service');
    const POService = require('./database/services/po-service');
    const NotificationService = require('./database/services/notification-service');
    const db = require('./database/db');

    registerGuardedHandler('get-inv-recipes', ROLES.OPERATOR, () => RecipeService.getRecipes());
    registerGuardedHandler('get-inv-recipe-by-id', ROLES.OPERATOR, (event, id) => RecipeService.getRecipeById(id));
    registerGuardedHandler('save-inv-recipe', ROLES.ADMIN, (event, data) => RecipeService.saveRecipe(data, data.operator, data.role));
    registerGuardedHandler('delete-inv-recipe', ROLES.ADMIN, (event, id) => RecipeService.softDeleteRecipe(id));

    registerGuardedHandler('transfer-inv-stock', ROLES.OPERATOR, (event, data) => TransferService.transferStock(data, data.operator, data.role));
    registerGuardedHandler('get-inv-transfers', ROLES.OPERATOR, () => TransferService.getTransfers());

    registerGuardedHandler('create-inv-stock-count', ROLES.ADMIN, (event, data) => CountService.createCount(data, data.operator, data.role));
    registerGuardedHandler('approve-inv-stock-count', ROLES.ADMIN, (event, id) => CountService.approveCount(id));
    registerGuardedHandler('get-inv-stock-counts', ROLES.OPERATOR, () => CountService.getStockCounts());

    registerGuardedHandler('get-inv-forecasting', ROLES.OPERATOR, (event, method) => ForecastService.getAllForecasts(method));
    registerGuardedHandler('create-inv-return', ROLES.ADMIN, (event, data) => POService.createPurchaseReturn(data, data.operator, data.role));

    registerGuardedHandler('get-inv-notifications', ROLES.OPERATOR, (event, unreadOnly) => NotificationService.getNotifications(unreadOnly));
    registerGuardedHandler('mark-inv-notification-read', ROLES.OPERATOR, (event, id) => NotificationService.markAsRead(id));
    registerGuardedHandler('dismiss-all-inv-notifications', ROLES.OPERATOR, () => NotificationService.dismissAll());

    registerGuardedHandler('get-printer-material-metrics', ROLES.OPERATOR, () => {
      return db.prepare('SELECT * FROM printer_material_metrics ORDER BY last_updated DESC').all();
    });

    // ==========================================
    // DOCUMENT STUDIO IPC HANDLERS
    // ==========================================
    const DocEngine = require('./document-engine');

    registerGuardedHandler('doc-rotate-pages', ROLES.OPERATOR, (e, filePath, indices, deg) => DocEngine.rotatePdfPages(filePath, indices, deg));
    registerGuardedHandler('doc-delete-pages', ROLES.OPERATOR, (e, filePath, indices) => DocEngine.deletePages(filePath, indices));
    registerGuardedHandler('doc-reorder-pages', ROLES.OPERATOR, (e, filePath, order) => DocEngine.reorderPages(filePath, order));
    registerGuardedHandler('doc-duplicate-pages', ROLES.OPERATOR, (e, filePath, indices) => DocEngine.duplicatePages(filePath, indices));
    registerGuardedHandler('doc-extract-pages', ROLES.OPERATOR, (e, filePath, indices) => DocEngine.extractPages(filePath, indices));
    registerGuardedHandler('doc-split-pdf', ROLES.OPERATOR, (e, filePath, points) => DocEngine.splitPdf(filePath, points));
    registerGuardedHandler('doc-merge-pdfs', ROLES.OPERATOR, (e, paths) => DocEngine.mergePdfs(paths));
    registerGuardedHandler('doc-insert-blank', ROLES.OPERATOR, (e, filePath, positions, paper) => DocEngine.insertBlankPages(filePath, positions, paper));
    registerGuardedHandler('doc-add-page-numbers', ROLES.OPERATOR, (e, filePath, opts) => DocEngine.addPageNumbers(filePath, opts));
    registerGuardedHandler('doc-add-watermark', ROLES.OPERATOR, (e, filePath, text, opts) => DocEngine.addWatermark(filePath, text, opts));
    registerGuardedHandler('doc-add-stamp', ROLES.OPERATOR, (e, filePath, text, indices, opts) => DocEngine.addStamp(filePath, text, indices, opts));
    registerGuardedHandler('doc-scale-pages', ROLES.OPERATOR, (e, filePath, sx, sy) => DocEngine.scalePages(filePath, sx, sy));
    registerGuardedHandler('doc-fit-to-area', ROLES.OPERATOR, (e, filePath, w, h, mode) => DocEngine.fitToArea(filePath, w, h, mode));
    registerGuardedHandler('doc-crop-pages', ROLES.OPERATOR, (e, filePath, box, indices) => DocEngine.cropPages(filePath, box, indices));
    registerGuardedHandler('doc-auto-rotate', ROLES.OPERATOR, (e, filePath) => DocEngine.autoRotateDetect(filePath));

    registerGuardedHandler('doc-save-output', ROLES.OPERATOR, (e, pdfBytes, name, dir) => DocEngine.saveOutput(pdfBytes, name, dir));
    registerGuardedHandler('doc-save-to-order', ROLES.OPERATOR, (e, pdfBytes, name) => DocEngine.saveToOrderIncoming(pdfBytes, name));

    registerGuardedHandler('system-cleanup-temp', ROLES.ADMIN, () => require('./janitor').cleanupTempFiles());
    registerGuardedHandler('system-optimize-db', ROLES.ADMIN, () => require('./janitor').optimizeDatabase());

    registerGuardedHandler('doc-get-projects', ROLES.OPERATOR, () => { try { return { success: true, data: DocEngine.getProjects() }; } catch(e) { return { success: false, error: e.message }; } });
    registerGuardedHandler('doc-create-project', ROLES.OPERATOR, (e, data) => { try { return { success: true, data: DocEngine.createProject(data) }; } catch(e) { return { success: false, error: e.message }; } });
    registerGuardedHandler('doc-save-project', ROLES.OPERATOR, (e, projectId, stateJson) => { try { return DocEngine.saveProject(projectId, stateJson); } catch(e) { return { success: false, error: e.message }; } });
    registerGuardedHandler('doc-delete-project', ROLES.OPERATOR, (e, projectId) => { try { return DocEngine.deleteProject(projectId); } catch(e) { return { success: false, error: e.message }; } });

    registerGuardedHandler('doc-get-presets', ROLES.OPERATOR, (e, type) => { try { return { success: true, data: DocEngine.getPresets(type) }; } catch(e) { return { success: false, error: e.message }; } });
    registerGuardedHandler('doc-save-preset', ROLES.OPERATOR, (e, data) => { try { return { success: true, data: DocEngine.savePreset(data) }; } catch(e) { return { success: false, error: e.message }; } });
    registerGuardedHandler('doc-delete-preset', ROLES.OPERATOR, (e, id) => { try { return DocEngine.deletePreset(id); } catch(e) { return { success: false, error: e.message }; } });

    registerGuardedHandler('doc-save-session', ROLES.OPERATOR, (e, projectId, stateJson) => { try { return DocEngine.saveSessionState(projectId, stateJson); } catch(e) { return { success: false, error: e.message }; } });
    registerGuardedHandler('doc-get-session', ROLES.OPERATOR, (e, projectId) => { try { return { success: true, data: DocEngine.getSessionState(projectId) }; } catch(e) { return { success: false, error: e.message }; } });
    registerGuardedHandler('doc-clear-session', ROLES.OPERATOR, (e, projectId) => { try { return DocEngine.clearSessionState(projectId); } catch(e) { return { success: false, error: e.message }; } });

    registerGuardedHandler('doc-process-plugin', ROLES.OPERATOR, (e, filePath, pluginId, params) => DocEngine.processWithPlugin(filePath, pluginId, params));
    registerGuardedHandler('doc-batch-process', ROLES.OPERATOR, (e, filePaths, operation, params) => DocEngine.batchProcess(filePaths, operation, params));

    registerGuardedHandler('doc-convert-office', ROLES.OPERATOR, async (e, filePath) => {
      const { convertOfficeToPdf } = require('./doc-converter');
      try {
        const outputDir = path.join(app.getPath('userData'), 'DocumentStudio', 'Converted');
        const pdfPath = await convertOfficeToPdf(filePath, outputDir);
        return { success: true, pdfPath };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    registerGuardedHandler('doc-compile-print-pdf', ROLES.OPERATOR, async (e, recipe) => {
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

    // ==========================================
    // ENTERPRISE PRODUCTS, PROFILES & DEVICES
    // ==========================================
    registerGuardedHandler('products:getAll', ROLES.OPERATOR, () => ProductModel.getAll());
    registerGuardedHandler('products:save', ROLES.ADMIN, (e, data) => data.id ? ProductModel.update(data.id, data) : ProductModel.create(data));
    registerGuardedHandler('products:delete', ROLES.ADMIN, (e, id) => ProductModel.delete(id));

    registerGuardedHandler('profiles:getAll', ROLES.OPERATOR, () => PrintProfileModel.getAll());
    registerGuardedHandler('profiles:save', ROLES.ADMIN, (e, data) => data.id ? PrintProfileModel.update(data.id, data) : PrintProfileModel.create(data));
    registerGuardedHandler('profiles:duplicate', ROLES.ADMIN, (e, id) => PrintProfileModel.duplicate(id));
    registerGuardedHandler('profiles:delete', ROLES.ADMIN, (e, id) => PrintProfileModel.delete(id));

    registerGuardedHandler('devices:getPrinters', ROLES.OPERATOR, () => DeviceManager.getPrinters());
    registerGuardedHandler('devices:discoverPrinters', ROLES.OPERATOR, () => DeviceManager.discoverPrinters());
    registerGuardedHandler('devices:getGroups', ROLES.OPERATOR, () => DeviceManager.getGroups());
    registerGuardedHandler('devices:saveGroup', ROLES.ADMIN, (e, data) => DeviceManager.saveGroup(data));
    registerGuardedHandler('devices:deleteGroup', ROLES.ADMIN, (e, id) => DeviceManager.deleteGroup(id));
    registerGuardedHandler('devices:getCalibrations', ROLES.OPERATOR, () => DeviceManager.getCalibrations());
    registerGuardedHandler('devices:getCalibration', ROLES.OPERATOR, (e, name) => DeviceManager.getCalibration(name));
    registerGuardedHandler('devices:saveCalibration', ROLES.ADMIN, (e, name, data) => DeviceManager.saveCalibration(name, data));

    registerGuardedHandler('print:validateDocument', ROLES.OPERATOR, (e, filePath) => DocumentValidator.validate(filePath));
    registerGuardedHandler('print:getAuditLogs', ROLES.OPERATOR, (e, limit) => PrintAuditLogModel.getLogs(limit));
    registerGuardedHandler('print:getLogById', ROLES.OPERATOR, (e, id) => PrintAuditLogModel.getLogById(id));
    
    registerGuardedHandler('print:reprintJob', ROLES.OPERATOR, async (e, auditLogId) => {
      try {
        const log = PrintAuditLogModel.getLogById(auditLogId);
        if (!log) throw new Error("Print audit log not found");
        
        const snapshot = JSON.parse(log.print_profile_snapshot_json || '{}');
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

    registerGuardedHandler('toggle-fullscreen', ROLES.PUBLIC, () => {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      if (win) {
        const isFS = win.isFullScreen();
        win.setFullScreen(!isFS);
        return !isFS;
      }
      return false;
    });

    registerGuardedHandler('set-fullscreen', ROLES.PUBLIC, (event, flag) => {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      if (win) {
        win.setFullScreen(!!flag);
        return win.isFullScreen();
      }
      return false;
    });

    registerGuardedHandler('is-fullscreen', ROLES.PUBLIC, () => {
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
