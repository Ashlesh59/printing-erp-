const EventBus = require('./EventBus');
const { EventTypes } = require('./EventTypes');
const ReservationService = require('../database/services/reservation-service');

// Sync subscription to stock reservation
EventBus.subscribe(EventTypes.INVENTORY_RESERVED, (event) => {
    const { orderId, orderData } = event.payload;
    const operator = event.userId || 'System';
    const role = event.payload.role || 'System';
    
    // Perform stock reservation
    const result = ReservationService.reserve(orderId, orderData, operator, role);
    if (!result || !result.success) {
        throw new Error(result ? result.error : 'Unknown stock reservation error');
    }
});

// Sync subscription to stock fulfillment (consuming reservation)
EventBus.subscribe(EventTypes.INVENTORY_FULFILLED, (event) => {
    const { orderId } = event.payload;
    const operator = event.userId || 'System';
    const role = event.payload.role || 'System';
    
    const result = ReservationService.fulfill(orderId, operator, role);
    if (!result || !result.success) {
        throw new Error(result ? result.error : 'Unknown stock fulfillment error');
    }
});

// Sync subscription to stock release (cancelling reservation)
EventBus.subscribe(EventTypes.INVENTORY_RELEASED, (event) => {
    const { orderId } = event.payload;
    const operator = event.userId || 'System';
    const role = event.payload.role || 'System';
    
    const result = ReservationService.release(orderId, operator, role);
    if (!result || !result.success) {
        throw new Error(result ? result.error : 'Unknown stock release error');
    }
});

// Sync subscription to stock restoration (undoing completed transaction)
EventBus.subscribe(EventTypes.INVENTORY_ADJUSTED, (event) => {
    const { orderId, isRestored } = event.payload;
    if (isRestored && orderId) {
        const operator = event.userId || 'System';
        const role = event.payload.role || 'System';
        
        const result = ReservationService.undoDeduction(orderId, operator, role);
        if (!result || !result.success) {
            throw new Error(result ? result.error : 'Unknown stock restoration error');
        }
    }
});
