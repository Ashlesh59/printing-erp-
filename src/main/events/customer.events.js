const EventBus = require('./EventBus');
const { EventTypes } = require('./EventTypes');

// Subscribe to customer creation
EventBus.subscribe(EventTypes.CUSTOMER_CREATED, (event) => {
    const { name, phone } = event.payload;
    console.log(`[CustomerEvents] Customer "${name}" (${phone}) telemetry recorded.`);
});
