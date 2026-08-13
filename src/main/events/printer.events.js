const EventBus = require('./EventBus');
const { EventTypes } = require('./EventTypes');
const db = require('../database/db');

// Sync/async update of printer material telemetry on completion
EventBus.subscribe(EventTypes.PRINTER_JOB_COMPLETED, (event) => {
    const { printerName, pages, copies } = event.payload;
    if (!printerName) return;
    
    const totalPages = (pages || 1) * (copies || 1);
    const tonerFactor = 0.05; // estimated 0.05% toner usage per page

    try {
        const stmt = db.prepare(`
            INSERT INTO printer_material_metrics (printer_name, paper_consumed, toner_est_usage_percent, maintenance_counter, last_updated)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(printer_name) DO UPDATE SET
                paper_consumed = paper_consumed + EXCLUDED.paper_consumed,
                toner_est_usage_percent = MIN(100.0, toner_est_usage_percent + EXCLUDED.toner_est_usage_percent),
                maintenance_counter = maintenance_counter + EXCLUDED.maintenance_counter,
                last_updated = CURRENT_TIMESTAMP
        `);
        stmt.run(printerName, totalPages, totalPages * tonerFactor, totalPages);
        console.log(`[PrinterEvents] Updated metrics for printer "${printerName}": consumed +${totalPages} pages.`);
    } catch (err) {
        console.error(`[PrinterEvents] Failed to update printer telemetry for printer "${printerName}":`, err);
    }
});

EventBus.subscribe(EventTypes.PRINTER_JOB_STARTED, (event) => {
    const { jobId, printerName } = event.payload;
    console.log(`[PrinterEvents] Print job #${jobId} started on printer "${printerName}"`);
});

EventBus.subscribe(EventTypes.PRINTER_JOB_FAILED, (event) => {
    const { jobId, printerName, error } = event.payload;
    console.error(`[PrinterEvents] Print job #${jobId} failed on printer "${printerName}". Error: ${error}`);
});
