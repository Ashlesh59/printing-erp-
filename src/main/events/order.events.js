const EventBus = require('./EventBus');
const { EventTypes } = require('./EventTypes');

// Async subscription to order creation
EventBus.subscribe(EventTypes.ORDER_CREATED, (event) => {
    const { orderId } = event.payload;
    console.log(`[OrderEvents] Order #${orderId} creation event processed.`);
});

// Async subscription to order update
EventBus.subscribe(EventTypes.ORDER_UPDATED, (event) => {
    const { orderId, status } = event.payload;
    console.log(`[OrderEvents] Order #${orderId} status updated to: ${status}`);
});

// Sync subscription to order completion
EventBus.subscribe(EventTypes.ORDER_COMPLETED, (event) => {
    const { orderId } = event.payload;
    console.log(`[OrderEvents] Order #${orderId} marked as completed.`);
});
