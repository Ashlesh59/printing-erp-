const EventBus = require('./EventBus');
const { EventTypes } = require('./EventTypes');

// Subscribe to events that impact the dashboard UI
EventBus.subscribe(EventTypes.ORDER_CREATED, (event) => {
    const { orderId } = event.payload;
    console.log(`[DashboardEvents] Dashboard statistics queue flag set for new Order #${orderId}`);
});

EventBus.subscribe(EventTypes.ORDER_COMPLETED, (event) => {
    const { orderId } = event.payload;
    console.log(`[DashboardEvents] Dashboard statistics queue flag set for completed Order #${orderId}`);
});
