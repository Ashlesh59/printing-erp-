const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  checkLicense: () => ipcRenderer.invoke('check-license'),
  activateLicense: (key) => ipcRenderer.invoke('activate-license', key),
  onNewFile: (callback) => ipcRenderer.on('new-file-detected', (event, file) => callback(file)),
  searchCustomers: (phone) => ipcRenderer.invoke('search-customers', phone),
  getAllCustomers: (limit, offset) => ipcRenderer.invoke('get-all-customers', limit, offset),
  createCustomer: (data) => ipcRenderer.invoke('create-customer', data),
  updateCustomerProfile: (id, data) => ipcRenderer.invoke('update-customer-profile', id, data),
  searchCustomersAdvanced: (opts) => ipcRenderer.invoke('search-customers-advanced', opts),
  getCustomerProfile: (customerId) => ipcRenderer.invoke('get-customer-profile', customerId),
  addCustomerNote: (customerId, note, author) => ipcRenderer.invoke('add-customer-note', customerId, note, author),
  deleteCustomerNote: (noteId) => ipcRenderer.invoke('delete-customer-note', noteId),
  addCustomerDocument: (customerId, orderId, fileName, filePath, fileSize, category) => ipcRenderer.invoke('add-customer-document', customerId, orderId, fileName, filePath, fileSize, category),
  duplicateOrderForCustomer: (orderId) => ipcRenderer.invoke('duplicate-order-for-customer', orderId),

  // Production Scheduling & Smart Print Queue API
  productionGetJobs: (filters, searchQuery) => ipcRenderer.invoke('production:getJobs', filters, searchQuery),
  productionGetDashboardStats: () => ipcRenderer.invoke('production:getDashboardStats'),
  productionCreateJob: (data) => ipcRenderer.invoke('production:createJob', data),
  productionUpdateStatus: (jobId, status) => ipcRenderer.invoke('production:updateStatus', jobId, status),
  productionUpdatePriority: (jobId, priority) => ipcRenderer.invoke('production:updatePriority', jobId, priority),
  productionAssignPrinter: (jobId, printerName) => ipcRenderer.invoke('production:assignPrinter', jobId, printerName),
  productionReorderQueue: (orderedJobIds) => ipcRenderer.invoke('production:reorderQueue', orderedJobIds),
  productionMoveUp: (jobId) => ipcRenderer.invoke('production:moveUp', jobId),
  productionMoveDown: (jobId) => ipcRenderer.invoke('production:moveDown', jobId),
  productionRecommendPrinter: (jobSpecs) => ipcRenderer.invoke('production:recommendPrinter', jobSpecs),
  productionDuplicateJob: (jobId) => ipcRenderer.invoke('production:duplicateJob', jobId),
  productionDeleteJob: (jobId) => ipcRenderer.invoke('production:deleteJob', jobId),
  productionScheduleJob: (jobId, scheduleData) => ipcRenderer.invoke('production:scheduleJob', jobId, scheduleData),
  createOrder: (data) => ipcRenderer.invoke('create-order', data),
  getRecentOrders: (limit, offset) => ipcRenderer.invoke('get-recent-orders', limit, offset),
  getDashboardStats: () => ipcRenderer.invoke('get-dashboard-stats'),
  updateOrderStatus: (id, status) => ipcRenderer.invoke('update-order-status', id, status),
  getRecentActivities: () => ipcRenderer.invoke('get-recent-activities'),
  logActivity: (desc, type) => ipcRenderer.invoke('log-activity', desc, type),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (data) => ipcRenderer.invoke('update-settings', data),
  completeWizardSetup: (data) => ipcRenderer.invoke('complete-wizard-setup', data),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  printFile: (payload, options) => ipcRenderer.invoke('print-file', payload, options),
  selectBackupFolder: () => ipcRenderer.invoke('select-backup-folder'),
  backupDatabase: (dest) => ipcRenderer.invoke('backup-database', dest),
  systemCleanupTemp: () => ipcRenderer.invoke('system-cleanup-temp'),
  systemOptimizeDb: () => ipcRenderer.invoke('system-optimize-db'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  openIncomingFolder: () => ipcRenderer.invoke('open-incoming-folder'),
  getCustomerOrders: (customerId) => ipcRenderer.invoke('get-customer-orders', customerId),
  logError: (msg) => ipcRenderer.invoke('log-error', msg),
  generateUnifiedPdf: (payload, options) => ipcRenderer.invoke('generate-unified-pdf', payload, options),
  saveOrderFiles: (name, phone, orderId, pdfBytes, originalFilePaths) => ipcRenderer.invoke('save-order-files', name, phone, orderId, pdfBytes, originalFilePaths),
  getAllPricing: () => ipcRenderer.invoke('get-all-pricing'),
  getPricing: () => ipcRenderer.invoke('get-pricing'),
  getPricingByCategory: (cat) => ipcRenderer.invoke('get-pricing-by-category', cat),
  createPricing: (data) => ipcRenderer.invoke('create-pricing', data),
  updatePricing: (id, data) => ipcRenderer.invoke('update-pricing', id, data),
  deletePricing: (id) => ipcRenderer.invoke('delete-pricing', id),
  ping: () => 'pong',
  getDevices: () => ipcRenderer.invoke('get-devices'),
  getLicenseInfo: () => ipcRenderer.invoke('get-license-info'),
  saveCustomerOrderFile: (fileData) => ipcRenderer.invoke('save-customer-order-file', fileData),
  getServerInfo: () => ipcRenderer.invoke('get-server-info'),
  onNewMobileOrder: (callback) => ipcRenderer.on('new-mobile-order', (event, data) => callback(data)),
  getCloudSettings: () => ipcRenderer.invoke('get-cloud-settings'),
  updateCloudSettings: (url, key, id, vercel) => ipcRenderer.invoke('update-cloud-settings', { url, key, id, vercel }),
  createGstInvoice: (invoice, items) => ipcRenderer.invoke('create-gst-invoice', { invoice, items }),
  getGstInvoices: (limit, offset) => ipcRenderer.invoke('get-gst-invoices', limit, offset),
  getGstInvoiceItems: (invoiceId) => ipcRenderer.invoke('get-gst-invoice-items', invoiceId),
  getGstSummary: () => ipcRenderer.invoke('get-gst-summary'),
  updateCustomerGst: (customerId, gstin, state) => ipcRenderer.invoke('update-customer-gst', { customerId, gstin, state }),
  getOrderItemSpecifications: (orderItemId) => ipcRenderer.invoke('get-order-item-specifications', orderItemId),

  // Inventory Management IPC Methods
  getInvCategories: () => ipcRenderer.invoke('get-inv-categories'),
  createInvCategory: (data) => ipcRenderer.invoke('create-inv-category', data),
  updateInvCategory: (id, data) => ipcRenderer.invoke('update-inv-category', { id, data }),
  deleteInvCategory: (id) => ipcRenderer.invoke('delete-inv-category', id),

  getInvSuppliers: () => ipcRenderer.invoke('get-inv-suppliers'),
  createInvSupplier: (data) => ipcRenderer.invoke('create-inv-supplier', data),
  updateInvSupplier: (id, data) => ipcRenderer.invoke('update-inv-supplier', { id, data }),
  deleteInvSupplier: (id) => ipcRenderer.invoke('delete-inv-supplier', id),

  getInvLocations: () => ipcRenderer.invoke('get-inv-locations'),
  createInvLocation: (data) => ipcRenderer.invoke('create-inv-location', data),
  updateInvLocation: (id, data) => ipcRenderer.invoke('update-inv-location', { id, data }),
  deleteInvLocation: (id) => ipcRenderer.invoke('delete-inv-location', id),

  getInvItems: () => ipcRenderer.invoke('get-inv-items'),
  getInvItemById: (id) => ipcRenderer.invoke('get-inv-item-by-id', id),
  createInvItem: (data) => ipcRenderer.invoke('create-inv-item', data),
  updateInvItem: (id, data) => ipcRenderer.invoke('update-inv-item', { id, data }),
  deleteInvItem: (id) => ipcRenderer.invoke('delete-inv-item', id),

  adjustInvStock: (data) => ipcRenderer.invoke('adjust-inv-stock', data),
  getInvTransactions: (itemId) => ipcRenderer.invoke('get-inv-transactions', itemId),

  getInvPurchaseOrders: () => ipcRenderer.invoke('get-inv-purchase-orders'),
  getInvPurchaseOrderById: (id) => ipcRenderer.invoke('get-inv-purchase-order-by-id', id),
  createInvPurchaseOrder: (data) => ipcRenderer.invoke('create-inv-purchase-order', data),
  receiveInvPurchaseOrder: (poId, data) => ipcRenderer.invoke('receive-inv-purchase-order', { poId, data }),
  cancelInvPurchaseOrder: (poId, data) => ipcRenderer.invoke('cancel-inv-purchase-order', { poId, data }),

  getInvAlerts: () => ipcRenderer.invoke('get-inv-alerts'),
  getInvSettings: () => ipcRenderer.invoke('get-inv-settings'),
  updateInvSettings: (data) => ipcRenderer.invoke('update-inv-settings', data),

  getInvDashboardStats: () => ipcRenderer.invoke('get-inv-dashboard-stats'),
  getInvReports: (start, end) => ipcRenderer.invoke('get-inv-reports', { start, end }),

  // Enterprise APIs
  getInvRecipes: () => ipcRenderer.invoke('get-inv-recipes'),
  getInvRecipeById: (id) => ipcRenderer.invoke('get-inv-recipe-by-id', id),
  saveInvRecipe: (data) => ipcRenderer.invoke('save-inv-recipe', data),
  deleteInvRecipe: (id) => ipcRenderer.invoke('delete-inv-recipe', id),

  transferInvStock: (data) => ipcRenderer.invoke('transfer-inv-stock', data),
  getInvTransfers: () => ipcRenderer.invoke('get-inv-transfers'),

  createInvStockCount: (data) => ipcRenderer.invoke('create-inv-stock-count', data),
  approveInvStockCount: (id) => ipcRenderer.invoke('approve-inv-stock-count', id),
  getInvStockCounts: () => ipcRenderer.invoke('get-inv-stock-counts'),

  getInvForecasting: (method) => ipcRenderer.invoke('get-inv-forecasting', method),
  createInvReturn: (data) => ipcRenderer.invoke('create-inv-return', data),

  getInvNotifications: (unreadOnly) => ipcRenderer.invoke('get-inv-notifications', unreadOnly),
  markInvNotificationRead: (id) => ipcRenderer.invoke('mark-inv-notification-read', id),
  dismissAllInvNotifications: () => ipcRenderer.invoke('dismiss-all-inv-notifications'),

  getPrinterMaterialMetrics: () => ipcRenderer.invoke('get-printer-material-metrics'),
  printTestPage: (printerName) => ipcRenderer.invoke('print-test-page', printerName),
  getPrintJobs: () => ipcRenderer.invoke('get-print-jobs'),

  // ==========================================
  // DOCUMENT STUDIO BRIDGE — Phase 2A
  // ==========================================
  // PDF Tools
  docRotatePages:    (filePath, indices, deg)        => ipcRenderer.invoke('doc-rotate-pages', filePath, indices, deg),
  docDeletePages:    (filePath, indices)             => ipcRenderer.invoke('doc-delete-pages', filePath, indices),
  docReorderPages:   (filePath, order)               => ipcRenderer.invoke('doc-reorder-pages', filePath, order),
  docDuplicatePages: (filePath, indices)             => ipcRenderer.invoke('doc-duplicate-pages', filePath, indices),
  docExtractPages:   (filePath, indices)             => ipcRenderer.invoke('doc-extract-pages', filePath, indices),
  docSplitPdf:       (filePath, points)              => ipcRenderer.invoke('doc-split-pdf', filePath, points),
  docMergePdfs:      (paths)                         => ipcRenderer.invoke('doc-merge-pdfs', paths),
  docInsertBlank:    (filePath, positions, paper)    => ipcRenderer.invoke('doc-insert-blank', filePath, positions, paper),
  docAddPageNumbers: (filePath, opts)                => ipcRenderer.invoke('doc-add-page-numbers', filePath, opts),
  docAddWatermark:   (filePath, text, opts)          => ipcRenderer.invoke('doc-add-watermark', filePath, text, opts),
  docAddStamp:       (filePath, text, indices, opts) => ipcRenderer.invoke('doc-add-stamp', filePath, text, indices, opts),
  docScalePages:     (filePath, sx, sy)              => ipcRenderer.invoke('doc-scale-pages', filePath, sx, sy),
  docFitToArea:      (filePath, w, h, mode)          => ipcRenderer.invoke('doc-fit-to-area', filePath, w, h, mode),
  docCropPages:      (filePath, box, indices)        => ipcRenderer.invoke('doc-crop-pages', filePath, box, indices),
  docAutoRotate:     (filePath)                      => ipcRenderer.invoke('doc-auto-rotate', filePath),

  // Output & Create Order integration
  docSaveOutput:     (pdfBytes, name, dir)           => ipcRenderer.invoke('doc-save-output', pdfBytes, name, dir),
  docSaveToOrder:    (pdfBytes, name)                => ipcRenderer.invoke('doc-save-to-order', pdfBytes, name),
  docConvertOffice:  (filePath)                      => ipcRenderer.invoke('doc-convert-office', filePath),
  docCompilePrintPdf: (recipe)                       => ipcRenderer.invoke('doc-compile-print-pdf', recipe),

  // Project Management
  docGetProjects:    ()                              => ipcRenderer.invoke('doc-get-projects'),
  docCreateProject:  (data)                          => ipcRenderer.invoke('doc-create-project', data),
  docSaveProject:    (projectId, stateJson)          => ipcRenderer.invoke('doc-save-project', projectId, stateJson),
  docDeleteProject:  (projectId)                     => ipcRenderer.invoke('doc-delete-project', projectId),

  // Presets
  docGetPresets:     (type)                          => ipcRenderer.invoke('doc-get-presets', type),
  docSavePreset:     (data)                          => ipcRenderer.invoke('doc-save-preset', data),
  docDeletePreset:   (id)                            => ipcRenderer.invoke('doc-delete-preset', id),

  // Session / Crash Recovery
  docSaveSession:    (projectId, stateJson)          => ipcRenderer.invoke('doc-save-session', projectId, stateJson),
  docGetSession:     (projectId)                     => ipcRenderer.invoke('doc-get-session', projectId),
  docClearSession:   (projectId)                     => ipcRenderer.invoke('doc-clear-session', projectId),

  // Plugin extensibility
  docProcessPlugin:  (filePath, pluginId, params)    => ipcRenderer.invoke('doc-process-plugin', filePath, pluginId, params),
  docBatchProcess:   (filePaths, operation, params)  => ipcRenderer.invoke('doc-batch-process', filePaths, operation, params),

  // Security & User administration
  verifyPin:         (pin)                           => ipcRenderer.invoke('verify-pin', pin),
  getUsers:          ()                              => ipcRenderer.invoke('get-users'),
  createUser:        (name, role, pin)               => ipcRenderer.invoke('create-user', { name, role, pin }),
  deleteUser:        (id)                            => ipcRenderer.invoke('delete-user', id),

  // Database Security & Recovery
  getDatabaseHealth: () => ipcRenderer.invoke('get-db-health'),
  getBackupHistory: () => ipcRenderer.invoke('get-backup-history'),
  triggerManualBackup: () => ipcRenderer.invoke('trigger-manual-backup'),
  verifyBackup: (filePath) => ipcRenderer.invoke('verify-backup', filePath),
  deleteBackup: (filePath) => ipcRenderer.invoke('delete-backup', filePath),
  restoreBackup: (filePath) => ipcRenderer.invoke('restore-backup', filePath),
  isDatabaseCorrupted: () => ipcRenderer.invoke('is-db-corrupted'),
  recoveryRestore: (filePath) => ipcRenderer.invoke('recovery-restore', filePath),
  recoveryCreateFreshDb: () => ipcRenderer.invoke('recovery-fresh-db'),
  createSafetyBackup: (op) => ipcRenderer.invoke('create-safety-backup', op),
  commitSafetyBackup: (op) => ipcRenderer.invoke('commit-safety-backup', op),
  rollbackSafetyBackup: (op) => ipcRenderer.invoke('rollback-safety-backup', op),

  // Enterprise Products & Print Profiles APIs
  getProducts: () => ipcRenderer.invoke('products:getAll'),
  saveProduct: (data) => ipcRenderer.invoke('products:save', data),
  deleteProduct: (id) => ipcRenderer.invoke('products:delete', id),
  
  getPrintProfiles: () => ipcRenderer.invoke('profiles:getAll'),
  savePrintProfile: (data) => ipcRenderer.invoke('profiles:save', data),
  duplicatePrintProfile: (id) => ipcRenderer.invoke('profiles:duplicate', id),
  deletePrintProfile: (id) => ipcRenderer.invoke('profiles:delete', id),

  getDevicePrinters: () => ipcRenderer.invoke('devices:getPrinters'),
  discoverPrinters: () => ipcRenderer.invoke('devices:discoverPrinters'),
  getPrinterGroups: () => ipcRenderer.invoke('devices:getGroups'),
  savePrinterGroup: (data) => ipcRenderer.invoke('devices:saveGroup', data),
  deletePrinterGroup: (id) => ipcRenderer.invoke('devices:deleteGroup', id),
  getPrinterCalibrations: () => ipcRenderer.invoke('devices:getCalibrations'),
  getPrinterCalibration: (name) => ipcRenderer.invoke('devices:getCalibration', name),
  savePrinterCalibration: (name, data) => ipcRenderer.invoke('devices:saveCalibration', name, data),

  validateDocument: (filePath) => ipcRenderer.invoke('print:validateDocument', filePath),
  getPrintAuditLogs: (limit) => ipcRenderer.invoke('print:getAuditLogs', limit),
  reprintJob: (auditLogId) => ipcRenderer.invoke('print:reprintJob', auditLogId),
  getPrintLogById: (id) => ipcRenderer.invoke('print:getLogById', id),

  // Workflow Engine
  getWorkflowSteps: () => ipcRenderer.invoke('get-workflow-steps'),
  updateWorkflowSteps: (steps) => ipcRenderer.invoke('update-workflow-steps', steps),
  resetWorkflowSteps: () => ipcRenderer.invoke('reset-workflow-steps'),

  // Window Fullscreen Controls
  toggleFullScreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  setFullScreen: (flag) => ipcRenderer.invoke('set-fullscreen', flag),
  isFullScreen: () => ipcRenderer.invoke('is-fullscreen')
});
