const EventTypes = {
    ORDER_CREATED: 'order.created',
    ORDER_UPDATED: 'order.updated',
    ORDER_COMPLETED: 'order.completed',
    INVENTORY_RESERVED: 'inventory.reserved',
    INVENTORY_FULFILLED: 'inventory.fulfilled',
    INVENTORY_RELEASED: 'inventory.released',
    INVENTORY_ADJUSTED: 'inventory.adjusted',
    INVENTORY_LOW_STOCK: 'inventory.low_stock',
    PRINTER_JOB_STARTED: 'printer.job.started',
    PRINTER_JOB_COMPLETED: 'printer.job.completed',
    PRINTER_JOB_FAILED: 'printer.job.failed',
    CUSTOMER_CREATED: 'customer.created',
    SETTINGS_CHANGED: 'settings.changed',
    DATABASE_BACKUP_STARTED: 'database.backup.started',
    DATABASE_BACKUP_COMPLETED: 'database.backup.completed',
    DATABASE_BACKUP_FAILED: 'database.backup.failed',
    DATABASE_RESTORE_STARTED: 'database.restore.started',
    DATABASE_RESTORE_COMPLETED: 'database.restore.completed',
    DATABASE_RESTORE_FAILED: 'database.restore.failed',
    DATABASE_CORRUPTION_DETECTED: 'database.corruption.detected',
    DATABASE_OPTIMIZED: 'database.optimized'
};

const CriticalEvents = new Set([
    EventTypes.INVENTORY_RESERVED,
    EventTypes.INVENTORY_FULFILLED,
    EventTypes.INVENTORY_RELEASED,
    EventTypes.ORDER_COMPLETED
]);

module.exports = { EventTypes, CriticalEvents };
