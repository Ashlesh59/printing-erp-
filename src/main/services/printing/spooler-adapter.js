/**
 * Authoritative OS Spooler Adapter for Print Queue Execution
 * 
 * Provides:
 * - ProductionSpoolerAdapter: Real headless webContents.print() pipeline with callback confirmation
 * - TestSpoolerAdapter: Deterministic mock adapter recording invocation telemetry for CI/automated tests
 */

const fs = require('fs');
const path = require('path');

class ProductionSpoolerAdapter {
    /**
     * Submits a print job to the operating system printer spooler via Electron webContents.print
     * @param {Object} job - Database print_jobs row
     * @param {Object} options - Print options snapshot
     * @returns {Promise<{ success: boolean, failureReason?: string, timeout?: boolean, crashed?: boolean, attemptDetails: Object }>}
     */
    async print(job, options = {}) {
        if (!job.file_path || !fs.existsSync(job.file_path)) {
            return {
                success: false,
                failureReason: `Source document file not found: ${job.file_path}`,
                attemptDetails: { timestamp: new Date().toISOString(), error: 'FILE_NOT_FOUND' }
            };
        }

        // Dynamically load BrowserWindow from Electron (fail-safe in test runners)
        let BrowserWindow;
        try {
            const electron = require('electron');
            BrowserWindow = electron.BrowserWindow;
        } catch (e) {
            BrowserWindow = null;
        }

        if (!BrowserWindow) {
            return {
                success: false,
                failureReason: 'Electron BrowserWindow is not available in current process',
                attemptDetails: { timestamp: new Date().toISOString(), error: 'NO_ELECTRON_WINDOW' }
            };
        }

        return new Promise((resolve) => {
            let workerWindow = null;
            let timeoutId = null;
            let finished = false;

            const cleanup = () => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                if (workerWindow && !workerWindow.isDestroyed()) {
                    try {
                        workerWindow.destroy();
                    } catch (e) {}
                    workerWindow = null;
                }
            };

            // 60-second timeout to transition stalled submissions to Uncertain
            timeoutId = setTimeout(() => {
                if (!finished) {
                    finished = true;
                    cleanup();
                    resolve({
                        success: false,
                        timeout: true,
                        failureReason: 'Print submission timed out waiting for OS printer spooler callback (60s)',
                        attemptDetails: { timestamp: new Date().toISOString(), error: 'TIMEOUT' }
                    });
                }
            }, 60000);

            try {
                workerWindow = new BrowserWindow({
                    show: false,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                        sandbox: true
                    }
                });

                workerWindow.webContents.on('crashed', (e, killed) => {
                    if (!finished) {
                        finished = true;
                        cleanup();
                        resolve({
                            success: false,
                            crashed: true,
                            failureReason: 'Print worker renderer process crashed during document rendering',
                            attemptDetails: { timestamp: new Date().toISOString(), error: 'RENDERER_CRASH' }
                        });
                    }
                });

                workerWindow.webContents.on('did-fail-load', (e, errorCode, errorDescription) => {
                    if (!finished) {
                        finished = true;
                        cleanup();
                        resolve({
                            success: false,
                            failureReason: `Failed to load document for printing: ${errorDescription} (code ${errorCode})`,
                            attemptDetails: { timestamp: new Date().toISOString(), error: errorDescription }
                        });
                    }
                });

                workerWindow.webContents.on('did-finish-load', () => {
                    const printOptions = {
                        silent: true,
                        printBackground: true,
                        deviceName: job.printer_device_name || job.printer_name,
                        color: options.color !== undefined ? options.color : (job.color_mode === 'color'),
                        copies: Math.max(1, parseInt(options.copies || job.copies, 10) || 1),
                        landscape: options.landscape !== undefined ? options.landscape : false,
                        margins: options.margins || { marginType: 'printableArea' }
                    };

                    // Duplex mode mapping
                    const duplex = options.duplex || options.duplexMode || job.duplex || 'Single';
                    if (duplex === 'Double' || duplex === 'longEdge') {
                        printOptions.duplexMode = 'longEdge';
                    } else if (duplex === 'shortEdge') {
                        printOptions.duplexMode = 'shortEdge';
                    } else {
                        printOptions.duplexMode = 'simplex';
                    }

                    // Paper size mapping
                    if (options.pageSize) {
                        printOptions.pageSize = options.pageSize;
                    } else if (job.paper_size) {
                        printOptions.pageSize = job.paper_size;
                    }

                    // Page ranges mapping
                    if (options.pageRanges && Array.isArray(options.pageRanges)) {
                        printOptions.pageRanges = options.pageRanges;
                    }

                    // Scaling mode
                    if (options.scaleFactor) {
                        printOptions.scaleFactor = options.scaleFactor;
                    }

                    try {
                        workerWindow.webContents.print(printOptions, (success, failureReason) => {
                            if (!finished) {
                                finished = true;
                                cleanup();
                                if (success) {
                                    resolve({
                                        success: true,
                                        attemptDetails: {
                                            timestamp: new Date().toISOString(),
                                            deviceName: printOptions.deviceName,
                                            status: 'Submitted'
                                        }
                                    });
                                } else {
                                    resolve({
                                        success: false,
                                        failureReason: failureReason || 'Operating system print spooler rejected the job',
                                        attemptDetails: {
                                            timestamp: new Date().toISOString(),
                                            deviceName: printOptions.deviceName,
                                            error: failureReason
                                        }
                                    });
                                }
                            }
                        });
                    } catch (printErr) {
                        if (!finished) {
                            finished = true;
                            cleanup();
                            resolve({
                                success: false,
                                failureReason: `Exception calling webContents.print: ${printErr.message}`,
                                attemptDetails: { timestamp: new Date().toISOString(), error: printErr.message }
                            });
                        }
                    }
                });

                const fileUrl = job.file_path.startsWith('http') ? job.file_path : `file://${path.resolve(job.file_path).replace(/\\/g, '/')}`;
                workerWindow.loadURL(fileUrl);
            } catch (err) {
                if (!finished) {
                    finished = true;
                    cleanup();
                    resolve({
                        success: false,
                        failureReason: `Failed to initialize print worker window: ${err.message}`,
                        attemptDetails: { timestamp: new Date().toISOString(), error: err.message }
                    });
                }
            }
        });
    }
}

class TestSpoolerAdapter {
    constructor() {
        this.invocations = [];
        this.delayMs = 0;
        this.shouldSucceed = true;
        this.failureReason = null;
        this.simulateTimeout = false;
        this.simulateCrash = false;
        this.concurrentExecutions = new Map();
        this.maxConcurrentPerPrinter = new Map();
        this.activeConcurrentPrinters = 0;
        this.maxActiveConcurrentPrinters = 0;
    }

    setDelay(ms) { this.delayMs = ms; }
    setSuccess(val, reason = null) { this.shouldSucceed = val; this.failureReason = reason; }
    setTimeoutMode(val) { this.simulateTimeout = val; }
    setCrashMode(val) { this.simulateCrash = val; }

    async print(job, options = {}) {
        const startTime = Date.now();
        const deviceName = (job.printer_device_name || job.printer_name || 'Default').toLowerCase();

        // Track per-printer active concurrency
        const currentOnDevice = (this.concurrentExecutions.get(deviceName) || 0) + 1;
        this.concurrentExecutions.set(deviceName, currentOnDevice);
        const maxOnDevice = Math.max(this.maxConcurrentPerPrinter.get(deviceName) || 0, currentOnDevice);
        this.maxConcurrentPerPrinter.set(deviceName, maxOnDevice);

        this.activeConcurrentPrinters++;
        this.maxActiveConcurrentPrinters = Math.max(this.maxActiveConcurrentPrinters, this.activeConcurrentPrinters);

        const record = {
            jobId: job.id,
            deviceName: job.printer_device_name || job.printer_name,
            filePath: job.file_path,
            settings: options,
            startTime,
            endTime: null,
            success: false,
            failureReason: null
        };
        this.invocations.push(record);

        if (this.delayMs > 0) {
            await new Promise(r => setTimeout(r, this.delayMs));
        }

        this.concurrentExecutions.set(deviceName, Math.max(0, (this.concurrentExecutions.get(deviceName) || 1) - 1));
        this.activeConcurrentPrinters = Math.max(0, this.activeConcurrentPrinters - 1);
        record.endTime = Date.now();

        if (this.simulateTimeout) {
            record.failureReason = 'Print submission timed out (simulated)';
            return {
                success: false,
                timeout: true,
                failureReason: record.failureReason,
                attemptDetails: { timestamp: new Date().toISOString(), error: 'TIMEOUT' }
            };
        }

        if (this.simulateCrash) {
            record.failureReason = 'Print worker renderer process crashed (simulated)';
            return {
                success: false,
                crashed: true,
                failureReason: record.failureReason,
                attemptDetails: { timestamp: new Date().toISOString(), error: 'RENDERER_CRASH' }
            };
        }

        if (this.shouldSucceed) {
            record.success = true;
            return {
                success: true,
                attemptDetails: {
                    timestamp: new Date().toISOString(),
                    deviceName: record.deviceName,
                    status: 'Submitted'
                }
            };
        } else {
            record.failureReason = this.failureReason || 'Physical printer out of paper / spooler rejected';
            return {
                success: false,
                failureReason: record.failureReason,
                attemptDetails: {
                    timestamp: new Date().toISOString(),
                    deviceName: record.deviceName,
                    error: record.failureReason
                }
            };
        }
    }

    clear() {
        this.invocations = [];
        this.concurrentExecutions.clear();
        this.maxConcurrentPerPrinter.clear();
        this.activeConcurrentPrinters = 0;
        this.maxActiveConcurrentPrinters = 0;
        this.delayMs = 0;
        this.shouldSucceed = true;
        this.failureReason = null;
        this.simulateTimeout = false;
        this.simulateCrash = false;
    }
}

module.exports = {
    ProductionSpoolerAdapter,
    TestSpoolerAdapter
};
