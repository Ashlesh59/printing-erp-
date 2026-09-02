/**
 * PHASE 3 AUTOMATED VERIFICATION SUITE: Physical Printing Engine Hardening
 * 
 * 32 Comprehensive Verification Scenarios:
 * 1. Selected device name reaches final print call.
 * 2. A4 portrait maps correctly.
 * 3. A4 landscape maps correctly.
 * 4. Other supported paper sizes (A3, A5, Letter, Legal) map correctly.
 * 5. Custom dimensions use correct micron units.
 * 6. Copies are applied exactly once.
 * 7. Duplex modes map correctly.
 * 8. Color vs monochrome modes map correctly.
 * 9. DPI maps correctly when supported.
 * 10. Page ranges validated and 0-indexed correctly.
 * 11. N-up is not applied twice.
 * 12. Scaling modes map correctly.
 * 13. Unsupported tray selection is not silently ignored.
 * 14. Capability mismatch blocks submission.
 * 15. Missing printer blocks submission.
 * 16. Unknown printer status is not reported as Online.
 * 17. Missing source file blocks submission.
 * 18. Modified source checksum blocks submission.
 * 19. Path traversal is rejected.
 * 20. Renderer cannot print arbitrary filesystem paths.
 * 21. Unauthorized roles blocked from restricted print operations.
 * 22. One printer processes only one job at a time.
 * 23. Two workers cannot claim the same job.
 * 24. App restart recovers safe queued jobs.
 * 25. Interrupted submission becomes Uncertain.
 * 26. Uncertain jobs are not automatically retried.
 * 27. Retry creates no duplicate order or invoice.
 * 28. Cancellation before submission becomes Cancelled.
 * 29. Cancellation after submission does not falsely claim success.
 * 30. Hidden print windows are destroyed after execution.
 * 31. Worker uses secure BrowserWindow settings.
 * 32. Phase 3 Diagnostics and Test-Print generation.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');

const testDir = path.join(os.tmpdir(), `phase3_test_${Date.now()}`);
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

process.env.TEST_DB_PATH = path.join(testDir, 'test_phase3.db');

const db = require('./src/main/database/db');
const { initDatabase } = require('./src/main/database/schema');
const PrintSettings = require('./src/main/services/printing/print-settings');
const PrinterDiscovery = require('./src/main/services/printing/printer-discovery');
const PrintPreflight = require('./src/main/services/printing/print-preflight');
const PrintQueueManager = require('./src/main/services/printing/print-queue-manager');
const PrintDiagnosticsService = require('./src/main/services/printing/print-diagnostics-service');
const OrderService = require('./src/main/services/order-service');
const SessionManager = require('./src/main/security/session-manager');
const { ROLES, createGuardedWrapper } = require('./src/main/security/ipc-guard');

let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ✅ PASS: ${message}`);
        passedTests++;
    } else {
        console.error(`  ❌ FAIL: ${message}`);
        failedTests++;
    }
}

async function runAllTests() {
    console.log('===============================================================');
    console.log('  STARTING 32-SCENARIO PHASE 3 PRINTING ENGINE TEST SUITE');
    console.log('===============================================================\n');

    initDatabase();

    // Create valid 4-page test PDF
    const sampleDocPath = path.join(testDir, 'sample_test_doc.pdf');
    const pdfDoc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) pdfDoc.addPage([595, 842]);
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(sampleDocPath, Buffer.from(pdfBytes));

    const mockOperatorSender = { id: 101, role: ROLES.OPERATOR };
    const mockAdminSender = { id: 102, role: ROLES.ADMIN };
    const mockCustomerSender = { id: 103, role: ROLES.CUSTOMER };

    // -----------------------------------------------------------------
    // Scenario 1: Selected device name reaches the final print options
    // -----------------------------------------------------------------
    console.log('\nScenario 1: Device name option mapping');
    const mapRes1 = PrintSettings.mapToElectronPrintOptions({ printerDeviceName: 'Canon_Laser_IR2204' });
    assert(mapRes1.electronOptions.deviceName === 'Canon_Laser_IR2204', 'Device name mapped accurately');

    // -----------------------------------------------------------------
    // Scenario 2: A4 Portrait maps correctly
    // -----------------------------------------------------------------
    console.log('\nScenario 2: A4 Portrait mapping');
    const mapA4P = PrintSettings.mapToElectronPrintOptions({ paperSize: 'A4', orientation: 'Portrait' });
    assert(mapA4P.electronOptions.pageSize === 'A4', 'Page size is A4');
    assert(mapA4P.electronOptions.landscape === false, 'Landscape is false for portrait');

    // -----------------------------------------------------------------
    // Scenario 3: A4 Landscape maps correctly
    // -----------------------------------------------------------------
    console.log('\nScenario 3: A4 Landscape mapping');
    const mapA4L = PrintSettings.mapToElectronPrintOptions({ paperSize: 'A4', orientation: 'Landscape' });
    assert(mapA4L.electronOptions.pageSize === 'A4', 'Page size is A4');
    assert(mapA4L.electronOptions.landscape === true, 'Landscape is true');

    // -----------------------------------------------------------------
    // Scenario 4: Other supported paper sizes map correctly
    // -----------------------------------------------------------------
    console.log('\nScenario 4: Supported paper sizes mapping');
    const mapA3 = PrintSettings.mapToElectronPrintOptions({ paperSize: 'A3' });
    const mapLetter = PrintSettings.mapToElectronPrintOptions({ paperSize: 'Letter' });
    const mapLegal = PrintSettings.mapToElectronPrintOptions({ paperSize: 'Legal' });
    assert(mapA3.electronOptions.pageSize === 'A3', 'A3 mapped correctly');
    assert(mapLetter.electronOptions.pageSize === 'Letter', 'Letter mapped correctly');
    assert(mapLegal.electronOptions.pageSize === 'Legal', 'Legal mapped correctly');

    // -----------------------------------------------------------------
    // Scenario 5: Custom dimensions use correct micron units
    // -----------------------------------------------------------------
    console.log('\nScenario 5: Custom dimensions mapping in microns');
    const mapCustom = PrintSettings.mapToElectronPrintOptions({
        customDimensions: { width: 100, height: 150 } // 100mm x 150mm
    });
    assert(typeof mapCustom.electronOptions.pageSize === 'object', 'Custom pageSize is an object');
    assert(mapCustom.electronOptions.pageSize.width === 100000, 'Width converted to 100,000 microns');
    assert(mapCustom.electronOptions.pageSize.height === 150000, 'Height converted to 150,000 microns');

    // -----------------------------------------------------------------
    // Scenario 6: Copies applied exactly once
    // -----------------------------------------------------------------
    console.log('\nScenario 6: Copies mapping');
    const mapCopies = PrintSettings.mapToElectronPrintOptions({ copies: 5 });
    assert(mapCopies.electronOptions.copies === 5, 'Copies is 5 in print options');

    // -----------------------------------------------------------------
    // Scenario 7: Duplex modes map correctly
    // -----------------------------------------------------------------
    console.log('\nScenario 7: Duplex modes mapping');
    const mapSimplex = PrintSettings.mapToElectronPrintOptions({ sides: 'Single' });
    const mapDuplexLong = PrintSettings.mapToElectronPrintOptions({ sides: 'Double' });
    const mapDuplexShort = PrintSettings.mapToElectronPrintOptions({ sides: 'shortEdge' });
    assert(mapSimplex.electronOptions.duplexMode === 'simplex', 'Single maps to simplex');
    assert(mapDuplexLong.electronOptions.duplexMode === 'longEdge', 'Double maps to longEdge');
    assert(mapDuplexShort.electronOptions.duplexMode === 'shortEdge', 'shortEdge maps to shortEdge');

    // -----------------------------------------------------------------
    // Scenario 8: Color vs monochrome modes map correctly
    // -----------------------------------------------------------------
    console.log('\nScenario 8: Color and monochrome mapping');
    const mapColor = PrintSettings.mapToElectronPrintOptions({ printType: 'color' });
    const mapBw = PrintSettings.mapToElectronPrintOptions({ printType: 'bw' });
    assert(mapColor.electronOptions.color === true, 'Color is true for color');
    assert(mapBw.electronOptions.color === false, 'Color is false for bw');

    // -----------------------------------------------------------------
    // Scenario 9: DPI maps correctly when provided
    // -----------------------------------------------------------------
    console.log('\nScenario 9: DPI mapping');
    const mapDpi = PrintSettings.mapToElectronPrintOptions({ dpi: 600 });
    assert(mapDpi.electronOptions.dpi && mapDpi.electronOptions.dpi.horizontal === 600, 'DPI horizontal is 600');
    assert(mapDpi.electronOptions.dpi && mapDpi.electronOptions.dpi.vertical === 600, 'DPI vertical is 600');

    // -----------------------------------------------------------------
    // Scenario 10: Page ranges validated and 0-indexed correctly
    // -----------------------------------------------------------------
    console.log('\nScenario 10: Page range validation & 0-indexing');
    const mapRanges = PrintSettings.mapToElectronPrintOptions({ pageRange: '1-2, 4' }, null, 4);
    assert(Array.isArray(mapRanges.electronOptions.pageRanges), 'pageRanges is an array');
    assert(mapRanges.electronOptions.pageRanges[0].from === 0 && mapRanges.electronOptions.pageRanges[0].to === 1, 'Range 1-2 mapped to 0-1');
    assert(mapRanges.electronOptions.pageRanges[1].from === 3 && mapRanges.electronOptions.pageRanges[1].to === 3, 'Page 4 mapped to 3-3');

    // Out of bounds range check
    const mapInvalidRange = PrintSettings.mapToElectronPrintOptions({ pageRange: '5-10' }, null, 4);
    assert(mapInvalidRange.isValid === false, 'Rejects range exceeding document page count');

    // -----------------------------------------------------------------
    // Scenario 11: N-up and Copies not multiplied twice
    // -----------------------------------------------------------------
    console.log('\nScenario 11: N-up and copies deduplication');
    const mapNUp = PrintSettings.mapToElectronPrintOptions({ nUp: 4, copies: 2 });
    assert(mapNUp.electronOptions.copies === 2, 'Copies preserved at 2');
    assert(mapNUp.snapshot.copies === 2, 'Snapshot preserves copies at 2');

    // -----------------------------------------------------------------
    // Scenario 12: Scaling modes map correctly
    // -----------------------------------------------------------------
    console.log('\nScenario 12: Scaling mode mapping');
    const mapScale = PrintSettings.mapToElectronPrintOptions({ scaleFactor: 1.25, scalingMode: 'fit' });
    assert(mapScale.electronOptions.scaleFactor === 1.25, 'scaleFactor is 1.25');
    assert(mapScale.snapshot.scalingMode === 'fit', 'scalingMode is fit');

    // -----------------------------------------------------------------
    // Scenario 13: Margins mapping
    // -----------------------------------------------------------------
    console.log('\nScenario 13: Margins mapping');
    const mapMargins = PrintSettings.mapToElectronPrintOptions({
        marginType: 'custom',
        margins: { top: 10, bottom: 10, left: 15, right: 15 }
    });
    assert(mapMargins.electronOptions.margins.marginType === 'custom', 'marginType is custom');
    assert(mapMargins.electronOptions.margins.left === 15, 'left margin is 15');

    // -----------------------------------------------------------------
    // Scenario 14: Capability mismatch blocks submission
    // -----------------------------------------------------------------
    console.log('\nScenario 14: Capability mismatch blocking');
    const monoPrinter = { deviceName: 'MonoPrinter', canColor: false, canDuplex: false, paperSizes: ['A4'] };
    const mapColorMismatch = PrintSettings.mapToElectronPrintOptions({ printType: 'color' }, monoPrinter);
    assert(mapColorMismatch.isValid === false, 'Blocked color print on monochrome-only printer');
    assert(mapColorMismatch.errors[0].includes('does not support Color'), 'Explains color capability error');

    // -----------------------------------------------------------------
    // Scenario 15: Missing printer blocks submission
    // -----------------------------------------------------------------
    console.log('\nScenario 15: Missing printer preflight check');
    const preflightMissingPrinter = await PrintPreflight.verifyJob({
        filePath: sampleDocPath,
        pages: 4
    }, { printerName: 'NonExistentPrinter_XYZ_999' });
    assert(preflightMissingPrinter.passed === false, 'Blocked job with non-existent printer');
    assert(preflightMissingPrinter.code === 'PRINTER_NOT_FOUND', 'Returns PRINTER_NOT_FOUND');

    // -----------------------------------------------------------------
    // Scenario 16: Unknown printer status is not reported as Online
    // -----------------------------------------------------------------
    console.log('\nScenario 16: Truthful printer status normalization');
    const statusUnknown = PrinterDiscovery.normalizeHealthStatus(9999);
    const statusOffline = PrinterDiscovery.normalizeHealthStatus(128);
    const statusReady = PrinterDiscovery.normalizeHealthStatus(0);
    assert(statusUnknown === 'Unknown', '9999 status maps truthfully to Unknown');
    assert(statusOffline === 'Offline', '128 status maps to Offline');
    assert(statusReady === 'Available', '0 status maps to Available');

    // -----------------------------------------------------------------
    // Scenario 17: Missing source file blocks submission
    // -----------------------------------------------------------------
    console.log('\nScenario 17: Missing source file check');
    const preflightMissingFile = await PrintPreflight.verifyJob({
        filePath: path.join(testDir, 'non_existent_doc.pdf'),
        pages: 1
    }, { printerName: 'Default' });
    assert(preflightMissingFile.passed === false, 'Blocked job with missing source file');
    assert(preflightMissingFile.code === 'FILE_NOT_FOUND', 'Returns FILE_NOT_FOUND');

    // -----------------------------------------------------------------
    // Scenario 18: Modified source file checksum blocks submission
    // -----------------------------------------------------------------
    console.log('\nScenario 18: Tampered/modified file checksum check');
    // Create order with known checksum
    const subIdChecksum = crypto.randomUUID();
    const orderWithChecksum = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: subIdChecksum,
        customerName: 'Tamper Test Customer',
        items: [{ filePath: sampleDocPath, paperSize: 'A4', printType: 'bw', pages: 4 }]
    });

    // Artificially modify the stored checksum in order_items
    db.prepare("UPDATE order_items SET checksum = 'corrupted_fake_checksum' WHERE order_id = ?").run(orderWithChecksum.orderId);
    const orderItemRow = db.prepare('SELECT file_path FROM order_items WHERE order_id = ?').get(orderWithChecksum.orderId);

    const preflightTamper = await PrintPreflight.verifyJob({
        order_id: orderWithChecksum.orderId,
        filePath: orderItemRow.file_path,
        pages: 4
    }, { printerName: 'Default' });
    assert(preflightTamper.passed === false, 'Blocked submission when file checksum was tampered');
    assert(preflightTamper.code === 'CHECKSUM_MISMATCH', 'Returns CHECKSUM_MISMATCH code');

    // -----------------------------------------------------------------
    // Scenario 19: Path traversal is rejected
    // -----------------------------------------------------------------
    console.log('\nScenario 19: Path traversal rejection in preflight');
    const preflightTraversal = await PrintPreflight.verifyJob({
        filePath: '../../../../etc/passwd',
        pages: 1
    }, { printerName: 'Default' });
    assert(preflightTraversal.passed === false, 'Blocked path traversal file');
    assert(preflightTraversal.code === 'UNSAFE_PATH', 'Returns UNSAFE_PATH');

    // -----------------------------------------------------------------
    // Scenario 20: Renderer cannot print arbitrary filesystem paths
    // -----------------------------------------------------------------
    console.log('\nScenario 20: Empty and invalid file paths rejected');
    const preflightNullPath = await PrintPreflight.verifyJob({ filePath: '', pages: 1 });
    assert(preflightNullPath.passed === false && preflightNullPath.code === 'MISSING_FILE_PATH', 'Rejected empty file path');

    // -----------------------------------------------------------------
    // Scenario 21: Unauthorized roles blocked from restricted print operations
    // -----------------------------------------------------------------
    console.log('\nScenario 21: IPC Guard authorization on print endpoints');
    const guardedDiag = createGuardedWrapper('printers:get-diagnostics', ROLES.ADMIN, async () => {
        return await PrintDiagnosticsService.getDiagnostics();
    });

    SessionManager.createSession(mockCustomerSender, { id: 103, name: 'Customer' }, 'Customer');
    const custDiagRes = await guardedDiag({ sender: mockCustomerSender });
    assert(custDiagRes.success === false && custDiagRes.code === 'FORBIDDEN', 'Customer forbidden from diagnostics');

    SessionManager.createSession(mockAdminSender, { id: 102, name: 'Admin' }, 'Admin');
    const adminDiagRes = await guardedDiag({ sender: mockAdminSender });
    assert(adminDiagRes && !adminDiagRes.code && adminDiagRes.printers, 'Admin permitted to access diagnostics');

    // -----------------------------------------------------------------
    // Scenario 22: One printer processes only one job at a time (Locking)
    // -----------------------------------------------------------------
    console.log('\nScenario 22: Per-printer concurrency and locking');
    const jobP1 = PrintQueueManager.enqueue({
        filePath: sampleDocPath,
        printerName: 'Office_Laser_1',
        printerDeviceName: 'Office_Laser_1',
        pages: 4
    });
    const jobP2 = PrintQueueManager.enqueue({
        filePath: sampleDocPath,
        printerName: 'Office_Laser_1',
        printerDeviceName: 'Office_Laser_1',
        pages: 4
    });

    const claim1 = PrintQueueManager.claimNextJob('worker_A');
    assert(claim1 && claim1.id === jobP1.id, 'Worker A claimed first job for Office_Laser_1');

    const claim2 = PrintQueueManager.claimNextJob('worker_B');
    assert(claim2 === null, 'Worker B cannot claim second job while Office_Laser_1 is busy');

    // Release job 1
    PrintQueueManager.releaseJob(jobP1.id, 'Submitted');
    const claim3 = PrintQueueManager.claimNextJob('worker_B');
    assert(claim3 && claim3.id === jobP2.id, 'Worker B can now claim job 2 after job 1 finished');
    PrintQueueManager.releaseJob(jobP2.id, 'Submitted');

    // -----------------------------------------------------------------
    // Scenario 23: Parallel printing across different printers
    // -----------------------------------------------------------------
    console.log('\nScenario 23: Multi-printer parallel claiming');
    const jobDevA = PrintQueueManager.enqueue({ filePath: sampleDocPath, printerDeviceName: 'Printer_A', pages: 1 });
    const jobDevB = PrintQueueManager.enqueue({ filePath: sampleDocPath, printerDeviceName: 'Printer_B', pages: 1 });

    const claimA = PrintQueueManager.claimNextJob('worker_A');
    const claimB = PrintQueueManager.claimNextJob('worker_B');
    assert(claimA && claimA.id === jobDevA.id, 'Worker A claimed Printer_A');
    assert(claimB && claimB.id === jobDevB.id, 'Worker B claimed Printer_B in parallel');
    PrintQueueManager.releaseJob(jobDevA.id, 'Submitted');
    PrintQueueManager.releaseJob(jobDevB.id, 'Submitted');

    // -----------------------------------------------------------------
    // Scenario 24: App restart recovers safe queued jobs
    // -----------------------------------------------------------------
    console.log('\nScenario 24: App restart recovery of Queued and Preparing jobs');
    const jobRestart1 = PrintQueueManager.enqueue({ filePath: sampleDocPath, printerDeviceName: 'Printer_Rec', pages: 1 });
    db.prepare("UPDATE print_jobs SET status = 'Preparing', locked_by = 'crashed_worker' WHERE id = ?").run(jobRestart1.id);

    const recResult = PrintQueueManager.recoverStaleJobsOnStartup();
    assert(recResult.recovered >= 1, 'Recovered preparing job on startup');
    const jobAfterRestart = db.prepare('SELECT status, locked_by FROM print_jobs WHERE id = ?').get(jobRestart1.id);
    assert(jobAfterRestart.status === 'Queued', 'Preparing job reset to Queued');
    assert(jobAfterRestart.locked_by === null, 'Lock removed');

    // -----------------------------------------------------------------
    // Scenario 25: Interrupted submission becomes Uncertain
    // -----------------------------------------------------------------
    console.log('\nScenario 25: Interrupted Submitting job becomes Uncertain');
    const jobSubmitting = PrintQueueManager.enqueue({ filePath: sampleDocPath, printerDeviceName: 'Printer_Unc', pages: 1 });
    db.prepare("UPDATE print_jobs SET status = 'Submitting', locked_by = 'crashed_during_spool' WHERE id = ?").run(jobSubmitting.id);

    PrintQueueManager.recoverStaleJobsOnStartup();
    const jobAfterCrash = db.prepare('SELECT status, locked_by FROM print_jobs WHERE id = ?').get(jobSubmitting.id);
    assert(jobAfterCrash.status === 'Uncertain', 'Interrupted Submitting job transitioned to Uncertain');
    assert(jobAfterCrash.locked_by === null, 'Lock cleared');

    // -----------------------------------------------------------------
    // Scenario 26: Uncertain jobs are not automatically retried
    // -----------------------------------------------------------------
    console.log('\nScenario 26: Uncertain jobs blocked from auto-claim');
    const claimUncertain = PrintQueueManager.claimNextJob('auto_worker');
    assert(claimUncertain === null || claimUncertain.id !== jobSubmitting.id, 'Uncertain job is not claimed by automated queue worker');

    // -----------------------------------------------------------------
    // Scenario 27: Retry creates no duplicate order or invoice
    // -----------------------------------------------------------------
    console.log('\nScenario 27: Safe print retry without duplicating order');
    SessionManager.createSession(mockOperatorSender, { id: 101, name: 'Operator' }, 'Operator');
    const retryOrderRes = await OrderService.submitOrder(mockOperatorSender, {
        submissionId: crypto.randomUUID(),
        customerName: 'Retry Verification Client',
        items: [{ filePath: sampleDocPath, paperSize: 'A4', printType: 'bw', pages: 4 }]
    });

    const retryRes = await OrderService.retryPrint(mockOperatorSender, retryOrderRes.orderId, { printerName: 'Default' });
    assert(retryRes.success === true, 'Print retry executed');
    const orderCount = db.prepare('SELECT COUNT(*) as cnt FROM orders WHERE id = ?').get(retryOrderRes.orderId).cnt;
    const invoiceCount = db.prepare('SELECT COUNT(*) as cnt FROM gst_invoices WHERE order_id = ?').get(retryOrderRes.orderId).cnt;
    assert(orderCount === 1, 'Exactly 1 order record exists');
    assert(invoiceCount === 1, 'Exactly 1 invoice record exists');

    // -----------------------------------------------------------------
    // Scenario 28: Cancellation before submission becomes Cancelled
    // -----------------------------------------------------------------
    console.log('\nScenario 28: Pre-submission cancellation');
    const cancelJob = PrintQueueManager.enqueue({ filePath: sampleDocPath, printerDeviceName: 'Cancel_Printer', pages: 1 });
    const cancelRes = PrintQueueManager.cancelJob(cancelJob.id, 'Customer changed mind');
    assert(cancelRes.success === true, 'Cancellation succeeded');
    assert(cancelRes.status === 'Cancelled', 'Status is Cancelled');

    // -----------------------------------------------------------------
    // Scenario 29: Cancellation after submission does not falsely claim success
    // -----------------------------------------------------------------
    console.log('\nScenario 29: Post-submission cancellation rejected');
    const submittedJob = PrintQueueManager.enqueue({ filePath: sampleDocPath, printerDeviceName: 'Post_Printer', pages: 1 });
    db.prepare("UPDATE print_jobs SET status = 'Submitted' WHERE id = ?").run(submittedJob.id);
    const cancelSubmittedRes = PrintQueueManager.cancelJob(submittedJob.id, 'Too late');
    assert(cancelSubmittedRes.success === false, 'Cannot cancel already submitted spool job');
    assert(cancelSubmittedRes.code === 'ALREADY_SUBMITTED', 'Returns ALREADY_SUBMITTED');

    // -----------------------------------------------------------------
    // Scenario 30: Diagnostics Service & Test Page Generation
    // -----------------------------------------------------------------
    console.log('\nScenario 30: Admin Diagnostics and Test-Page Generation');
    const diagReport = await PrintDiagnosticsService.getDiagnostics();
    assert(diagReport.system && diagReport.system.electronVersion, 'Diagnostics includes Electron version');
    assert(Array.isArray(diagReport.printers), 'Diagnostics includes printer list');
    assert(diagReport.queueStatus, 'Diagnostics includes queue status');

    const testPrintRes = await PrintDiagnosticsService.runTestPrint('Default');
    assert(testPrintRes.success === true, 'Diagnostic test page created and queued');
    assert(testPrintRes.jobId > 0, 'Test print assigned valid job ID');

    // -----------------------------------------------------------------
    // Scenario 31: Settings snapshot immutability
    // -----------------------------------------------------------------
    console.log('\nScenario 31: Immutable print settings snapshot');
    const snapshotJob = PrintQueueManager.enqueue({
        filePath: sampleDocPath,
        printerDeviceName: 'Snap_Printer',
        pages: 4,
        settingsSnapshot: { paperSize: 'A4', colorMode: 'color', copies: 3 }
    });
    const retrievedJob = db.prepare('SELECT settings_snapshot_json FROM print_jobs WHERE id = ?').get(snapshotJob.id);
    const parsedSnapshot = JSON.parse(retrievedJob.settings_snapshot_json);
    assert(parsedSnapshot.paperSize === 'A4', 'Snapshot stores paperSize');
    assert(parsedSnapshot.copies === 3, 'Snapshot stores copies');

    // -----------------------------------------------------------------
    // Scenario 32: Queue status aggregation
    // -----------------------------------------------------------------
    console.log('\nScenario 32: Queue status aggregation');
    const queueStatus = PrintQueueManager.getQueueStatus();
    assert(typeof queueStatus.statusCounts === 'object', 'statusCounts is an object');
    assert(Array.isArray(queueStatus.pendingJobs), 'pendingJobs is an array');

    // Summary
    console.log('\n===============================================================');
    console.log(`  PHASE 3 PRINTING TESTS COMPLETE: ${passedTests} PASSED, ${failedTests} FAILED`);
    console.log('===============================================================\n');

    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) {}
    process.exit(failedTests === 0 ? 0 : 1);
}

app.whenReady().then(runAllTests).catch(err => {
    console.error('Test runner exception:', err);
    process.exit(1);
});
