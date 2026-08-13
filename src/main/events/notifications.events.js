const EventBus = require('./EventBus');
const { EventTypes } = require('./EventTypes');
const NotificationService = require('../database/services/notification-service');

// Subscribe to low stock alert
EventBus.subscribe(EventTypes.INVENTORY_LOW_STOCK, (event) => {
    const { itemId, type, message, priority } = event.payload;
    try {
        NotificationService.publish(type, message, itemId, priority);
        console.log(`[NotificationsEvents] Low-stock alert published for item #${itemId}`);
    } catch (err) {
        console.error(`[NotificationsEvents] Failed to publish low-stock alert for item #${itemId}:`, err);
    }
});

// Subscribe to print failures
EventBus.subscribe(EventTypes.PRINTER_JOB_FAILED, (event) => {
    const { jobId, printerName, orderId, error } = event.payload;
    try {
        NotificationService.publish(
            'system_warning',
            `PRINT FAILURE: Printer "${printerName}" failed to process Job #${jobId}. Error: ${error}`,
            orderId || null,
            'High'
        );
        console.log(`[NotificationsEvents] Print failure notification published for job #${jobId}`);
    } catch (err) {
        console.error(`[NotificationsEvents] Failed to publish print failure alert for job #${jobId}:`, err);
    }
});
