const EventBus = require('./EventBus');
const { EventTypes } = require('./EventTypes');
const { ActivityModel } = require('../database/models');
const EventRepository = require('../database/repositories/event-repository');

// Log customer creation to legacy activities table
EventBus.subscribe(EventTypes.CUSTOMER_CREATED, (event) => {
    const { name } = event.payload;
    try {
        ActivityModel.logActivity(`New customer added: ${name}`, 'customer_created');
    } catch (err) {
        console.error('[AnalyticsEvents] Failed to write customer activity to legacy table:', err);
    }
});

// Log order creation to legacy activities table
EventBus.subscribe(EventTypes.ORDER_CREATED, (event) => {
    const { orderId, logName } = event.payload;
    try {
        ActivityModel.logActivity(`Order #${orderId} created for ${logName}`, 'order_created');
    } catch (err) {
        console.error('[AnalyticsEvents] Failed to write order activity to legacy table:', err);
    }
});

// Log settings updates to legacy activities table
EventBus.subscribe(EventTypes.SETTINGS_CHANGED, (event) => {
    try {
        ActivityModel.logActivity('System settings updated', 'settings_updated');
    } catch (err) {
        console.error('[AnalyticsEvents] Failed to write settings activity to legacy table:', err);
    }
});

// Populate legacy inventory_events table to maintain backward compatibility with old logs
EventBus.subscribe(EventTypes.INVENTORY_RESERVED, (event) => {
    const { orderId, orderData, items } = event.payload;
    const operator = event.userId || 'System';
    const role = event.payload.role || 'System';
    try {
        EventRepository.logEvent('ReservationCreated', orderId, { orderData, items }, operator, role, 'Stock reserved');
    } catch (err) {
        console.error('[AnalyticsEvents] Failed to log legacy ReservationCreated event:', err);
    }
});

EventBus.subscribe(EventTypes.INVENTORY_FULFILLED, (event) => {
    const { orderId } = event.payload;
    const operator = event.userId || 'System';
    const role = event.payload.role || 'System';
    try {
        EventRepository.logEvent('ReservationFulfilled', orderId, {}, operator, role, 'Stock consumed successfully');
    } catch (err) {
        console.error('[AnalyticsEvents] Failed to log legacy ReservationFulfilled event:', err);
    }
});

EventBus.subscribe(EventTypes.INVENTORY_RELEASED, (event) => {
    const { orderId } = event.payload;
    const operator = event.userId || 'System';
    const role = event.payload.role || 'System';
    try {
        EventRepository.logEvent('ReservationReleased', orderId, {}, operator, role, 'Stock reservation cancelled');
    } catch (err) {
        console.error('[AnalyticsEvents] Failed to log legacy ReservationReleased event:', err);
    }
});

EventBus.subscribe(EventTypes.INVENTORY_ADJUSTED, (event) => {
    const { itemId, qty, type, locationId, reason, isRestored, orderId, isCreated, isUpdated, isDeleted, oldData, newData, name } = event.payload;
    const operator = event.userId || 'System';
    const role = event.payload.role || 'System';
    try {
        if (isRestored) {
            EventRepository.logEvent('StockRestored', orderId, {}, operator, role, 'Order cancelled, stock restored');
        } else if (isCreated) {
            EventRepository.logEvent('ItemCreated', itemId, newData, operator, role, 'Item created');
        } else if (isUpdated) {
            EventRepository.logEvent('ItemUpdated', itemId, { old: oldData, new: newData }, operator, role, 'Item modified');
        } else if (isDeleted) {
            EventRepository.logEvent('ItemDeleted', itemId, { name }, operator, role, 'Soft deleted item');
        } else {
            EventRepository.logEvent('StockAdjusted', itemId, { qty, type, locationId }, operator, role, reason);
        }
    } catch (err) {
        console.error('[AnalyticsEvents] Failed to log legacy StockAdjusted/Restored event:', err);
    }
});
