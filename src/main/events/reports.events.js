const EventBus = require('./EventBus');
const { EventTypes } = require('./EventTypes');

// Subscribe to events that affect reporting data
EventBus.subscribe(EventTypes.ORDER_COMPLETED, (event) => {
    const { orderId } = event.payload;
    console.log(`[ReportsEvents] Triggered reports refresh task for completed Order #${orderId}`);
});

EventBus.subscribe(EventTypes.INVENTORY_ADJUSTED, (event) => {
    console.log(`[ReportsEvents] Triggered stock valuation report refresh task.`);
});
