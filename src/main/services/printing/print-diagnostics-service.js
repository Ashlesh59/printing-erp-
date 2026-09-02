/**
 * Admin Print Diagnostics & Test Page Generator Service
 * 
 * Provides transparent hardware diagnostics, queue telemetry, and safe alignment test pages.
 */

const { PDFDocument, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('../../database/db');
const PrinterDiscovery = require('./printer-discovery');
const PrintQueueManager = require('./print-queue-manager');

class PrintDiagnosticsService {
    /**
     * Generates a comprehensive hardware and queue diagnostic report
     */
    static async getDiagnostics() {
        const printers = await PrinterDiscovery.getPrinters(true);
        const queueStatus = PrintQueueManager.getQueueStatus();

        const recentJobs = db.prepare(`
            SELECT id, order_id, printer_name, printer_device_name, status, copies, pages,
                   error_message, duration_ms, started_at, finished_at, created_at
            FROM print_jobs 
            ORDER BY id DESC LIMIT 20
        `).all();

        const uncertainJobs = db.prepare(`
            SELECT id, order_id, printer_name, status, error_message, created_at
            FROM print_jobs 
            WHERE status = 'Uncertain'
            ORDER BY id DESC
        `).all();

        return {
            system: {
                platform: os.platform(),
                release: os.release(),
                arch: os.arch(),
                electronVersion: process.versions.electron,
                nodeVersion: process.versions.node
            },
            printers,
            queueStatus,
            recentJobs,
            uncertainJobs,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Generates a safe alignment and color test PDF and enqueues it for printing
     * @param {string} printerName 
     * @returns {Promise<Object>}
     */
    static async runTestPrint(printerName = 'Default') {
        const targetPrinter = await PrinterDiscovery.getPrinterByName(printerName);
        if (!targetPrinter) {
            return { success: false, error: `Printer "${printerName}" not found.` };
        }

        try {
            const pdfDoc = await PDFDocument.create();
            const page = pdfDoc.addPage([595.28, 841.89]); // Exact A4 in points (72 DPI)

            // Outer border
            page.drawRectangle({
                x: 20,
                y: 20,
                width: 555.28,
                height: 801.89,
                borderColor: rgb(0.1, 0.1, 0.1),
                borderWidth: 2
            });

            // Alignment crosshairs
            page.drawLine({ start: { x: 20, y: 420.95 }, end: { x: 50, y: 420.95 }, color: rgb(0.1, 0.1, 0.1), thickness: 1 });
            page.drawLine({ start: { x: 545.28, y: 420.95 }, end: { x: 575.28, y: 420.95 }, color: rgb(0.1, 0.1, 0.1), thickness: 1 });
            page.drawLine({ start: { x: 297.64, y: 20 }, end: { x: 297.64, y: 50 }, color: rgb(0.1, 0.1, 0.1), thickness: 1 });
            page.drawLine({ start: { x: 297.64, y: 791.89 }, end: { x: 297.64, y: 821.89 }, color: rgb(0.1, 0.1, 0.1), thickness: 1 });

            // Color calibration patches
            page.drawRectangle({ x: 50, y: 700, width: 70, height: 35, color: rgb(0.9, 0.1, 0.1) });
            page.drawRectangle({ x: 130, y: 700, width: 70, height: 35, color: rgb(0.1, 0.8, 0.1) });
            page.drawRectangle({ x: 210, y: 700, width: 70, height: 35, color: rgb(0.1, 0.1, 0.9) });
            page.drawRectangle({ x: 290, y: 700, width: 70, height: 35, color: rgb(0.9, 0.9, 0.1) });
            page.drawRectangle({ x: 370, y: 700, width: 70, height: 35, color: rgb(0.1, 0.9, 0.9) });

            // 5-step grayscale band
            for (let g = 0; g < 5; g++) {
                const tone = 0.2 * g;
                page.drawRectangle({ x: 50 + g * 80, y: 640, width: 70, height: 30, color: rgb(tone, tone, tone) });
            }

            const fontBold = await pdfDoc.embedFont('Helvetica-Bold');
            const fontRegular = await pdfDoc.embedFont('Helvetica');

            page.drawText('PrintShop Manager - Diagnostic Test Page', {
                x: 50,
                y: 570,
                size: 16,
                font: fontBold,
                color: rgb(0.1, 0.1, 0.1)
            });

            const timeStr = new Date().toLocaleString();
            page.drawText(`Printer: ${targetPrinter.displayName} (${targetPrinter.deviceName})`, { x: 50, y: 535, size: 11, font: fontRegular });
            page.drawText(`Driver: ${targetPrinter.driverName} | Port: ${targetPrinter.portName}`, { x: 50, y: 515, size: 10, font: fontRegular });
            page.drawText(`Generated: ${timeStr} | Scale: 100% Exact A4`, { x: 50, y: 495, size: 10, font: fontRegular });
            page.drawText('Status: Verification Passed - Spooler Pipeline Functional', { x: 50, y: 475, size: 10, font: fontRegular });

            const pdfBytes = await pdfDoc.save();
            const tempTestPath = path.join(PrintQueueManager.getAppTempDir(), `diagnostic_test_page_${Date.now()}.pdf`);
            fs.writeFileSync(tempTestPath, Buffer.from(pdfBytes));

            // Enqueue test print
            const job = PrintQueueManager.enqueue({
                filePath: tempTestPath,
                printerName: targetPrinter.displayName,
                printerDeviceName: targetPrinter.deviceName,
                copies: 1,
                pages: 1,
                paperSize: 'A4',
                colorMode: 'color',
                duplex: 'Single',
                isTempFile: true
            });

            return {
                success: true,
                message: `Diagnostic test page created and queued for "${targetPrinter.displayName}".`,
                jobId: job.id
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
}

module.exports = PrintDiagnosticsService;
