/**
 * Single Authoritative Persistent Print Queue Manager
 * 
 * Guarantees:
 * - SQLite-backed persistent queue state machine (Queued -> Preparing -> Rendering -> Submitting -> Submitted)
 * - True multi-printer concurrent execution across distinct physical devices
 * - Per-printer single-flight mutex serialization
 * - Crash/timeout resilience (Submitting -> Uncertain)
 * - Dependency injection of SpoolerAdapter for deterministic testability
 * - Safe temporary file cleanup strictly bounded to dedicated app temp directory
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('../../database/db');
const { ProductionSpoolerAdapter } = require('./spooler-adapter');

let defaultSpoolerAdapter = new ProductionSpoolerAdapter();
let activeSpoolerAdapter = defaultSpoolerAdapter;

class PrintQueueManager {
    static activePrinters = new Set(); // Normalized deviceName strings currently in-flight
    static activeWorkers = new Map();  // deviceName -> Promise<void>

    /**
     * Dependency Injection for Spooler Adapter (Testing)
     */
    static setSpoolerAdapter(adapter) {
        activeSpoolerAdapter = adapter;
    }

    static resetSpoolerAdapter() {
        activeSpoolerAdapter = defaultSpoolerAdapter;
    }

    static getSpoolerAdapter() {
        return activeSpoolerAdapter;
    }

    /**
     * Helper to get dedicated application temp directory
     */
    static getAppTempDir() {
        let appTemp;
        try {
            const { app } = require('electron');
            if (app && app.getPath) {
                appTemp = path.join(app.getPath('userData'), 'Temp');
            }
        } catch (e) {}

        if (!appTemp) {
            appTemp = path.join(os.tmpdir(), 'PrintShopManager_Temp');
        }

        if (!fs.existsSync(appTemp)) {
            try { fs.mkdirSync(appTemp, { recursive: true }); } catch (e) {}
        }
        return appTemp;
    }

    /**
     * Enqueues a new print job into the SQLite persistent queue
     * @param {Object} jobParams
     * @returns {Object} Newly inserted print_jobs row
     */
    static enqueue(jobParams = {}) {
        const orderId = jobParams.orderId || jobParams.order_id || null;
        const customerId = jobParams.customerId || jobParams.customer_id || null;
        const filePath = jobParams.filePath || jobParams.file_path || null;
        const printerName = jobParams.printerName || jobParams.printer_name || 'Default';
        const printerDeviceName = jobParams.printerDeviceName || jobParams.printer_device_name || printerName;
        const copies = Math.max(1, parseInt(jobParams.copies, 10) || 1);
        const pages = Math.max(0, parseInt(jobParams.pages, 10) || 0);
        const paperSize = jobParams.paperSize || jobParams.paper_size || 'A4';
        const colorMode = jobParams.colorMode || jobParams.printType || 'bw';
        const duplex = jobParams.duplex || jobParams.sides || 'Single';
        const scalingMode = jobParams.scalingMode || 'fit';
        const settingsSnapshot = jobParams.settingsSnapshot ? JSON.stringify(jobParams.settingsSnapshot) : null;
        const preflightChecksum = jobParams.preflightChecksum || null;
        const isTempFile = jobParams.isTempFile ? 1 : 0;

        const stmt = db.prepare(`
            INSERT INTO print_jobs (
                order_id, customer_id, printer_name, printer_device_name, file_path,
                copies, pages, paper_size, color_mode, duplex, scaling_mode,
                settings_snapshot_json, preflight_checksum, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Queued', CURRENT_TIMESTAMP)
        `);

        const res = stmt.run(
            orderId, customerId, printerName, printerDeviceName, filePath,
            copies, pages, paperSize, colorMode, duplex, scalingMode,
            settingsSnapshot, preflightChecksum
        );

        const newJob = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(res.lastInsertRowid);
        newJob.is_temp_file = isTempFile;
        return newJob;
    }

    /**
     * Atomically claims the next Queued job for a specific printer or any available free printer
     * @param {string} workerId 
     * @param {string|null} targetPrinterDevice 
     * @returns {Object|null} Claimed print_jobs row
     */
    static claimNextJob(workerId = `worker_${crypto.randomUUID().substring(0, 8)}`, targetPrinterDevice = null) {
        let claimedJob = null;

        const tx = db.transaction(() => {
            let candidateJobs;
            if (targetPrinterDevice) {
                candidateJobs = db.prepare(`
                    SELECT * FROM print_jobs 
                    WHERE status = 'Queued' AND locked_by IS NULL 
                      AND (LOWER(printer_device_name) = ? OR LOWER(printer_name) = ?)
                    ORDER BY id ASC
                    LIMIT 5
                `).all(targetPrinterDevice.toLowerCase(), targetPrinterDevice.toLowerCase());
            } else {
                candidateJobs = db.prepare(`
                    SELECT * FROM print_jobs 
                    WHERE status = 'Queued' AND locked_by IS NULL
                    ORDER BY id ASC
                    LIMIT 20
                `).all();
            }

            for (const candidate of candidateJobs) {
                const targetDevice = (candidate.printer_device_name || candidate.printer_name || 'Default').toLowerCase();
                
                // Ensure this physical printer is not already busy
                if (!this.activePrinters.has(targetDevice)) {
                    const claimRes = db.prepare(`
                        UPDATE print_jobs 
                        SET status = 'Preparing', locked_by = ?, locked_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND status = 'Queued' AND locked_by IS NULL
                    `).run(workerId, candidate.id);

                    if (claimRes.changes > 0) {
                        this.activePrinters.add(targetDevice);
                        claimedJob = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(candidate.id);
                        break;
                    }
                }
            }
        });

        try {
            tx();
        } catch (e) {
            console.error('[PrintQueueManager] Atomic claim error:', e.message);
        }

        return claimedJob;
    }

    /**
     * Updates intermediate job status in database (Preparing -> Rendering -> Submitting)
     */
    static updateJobStatus(jobId, newStatus) {
        try {
            db.prepare(`
                UPDATE print_jobs
                SET status = ?
                WHERE id = ?
            `).run(newStatus, jobId);
        } catch (e) {
            console.error(`[PrintQueueManager] Failed to update job #${jobId} status to ${newStatus}:`, e.message);
        }
    }

    /**
     * Releases printer lock and transitions print job to its final terminal state
     */
    static releaseJob(jobId, finalStatus, errorMessage = null, attemptHistory = null) {
        const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
        if (!job) return;

        const targetDevice = (job.printer_device_name || job.printer_name || 'Default').toLowerCase();
        this.activePrinters.delete(targetDevice);

        const isSuccess = finalStatus === 'Submitted' || finalStatus === 'Confirmed Printed';

        try {
            db.prepare(`
                UPDATE print_jobs 
                SET status = ?, 
                    locked_by = NULL, 
                    locked_at = NULL,
                    error_message = ?,
                    attempt_history_json = COALESCE(?, attempt_history_json),
                    submitted_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE submitted_at END,
                    finished_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(
                finalStatus,
                errorMessage || null,
                attemptHistory ? JSON.stringify(attemptHistory) : null,
                isSuccess ? 1 : 0,
                jobId
            );
        } catch (e) {
            console.error(`[PrintQueueManager] Error releasing job #${jobId}:`, e.message);
        }
    }

    /**
     * Cancels a queued or preparing job safely before submission
     */
    static cancelJob(jobId, reason = 'Operator cancelled job') {
        const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
        if (!job) return { success: false, error: 'Job not found', code: 'NOT_FOUND' };

        if (job.status === 'Submitted' || job.status === 'Confirmed Printed') {
            return {
                success: false,
                error: 'Cannot cancel a job that has already been submitted to the printer spooler.',
                code: 'ALREADY_SUBMITTED'
            };
        }

        if (job.status === 'Cancelled') {
            return { success: true, message: 'Job is already cancelled', alreadyCancelled: true };
        }

        const targetDevice = (job.printer_device_name || job.printer_name || 'Default').toLowerCase();
        this.activePrinters.delete(targetDevice);

        try {
            db.prepare(`
                UPDATE print_jobs 
                SET status = 'Cancelled', locked_by = NULL, locked_at = NULL,
                    error_message = ?, finished_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(`Cancelled: ${reason}`, jobId);

            return { success: true, jobId, status: 'Cancelled' };
        } catch (e) {
            return { success: false, error: e.message, code: 'DB_ERROR' };
        }
    }

    /**
     * Operator Resolution Workflow: Confirms an Uncertain/Stalled job was printed
     */
    static confirmPrinted(jobId) {
        const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
        if (!job) return { success: false, error: 'Job not found', code: 'NOT_FOUND' };

        const targetDevice = (job.printer_device_name || job.printer_name || 'Default').toLowerCase();
        this.activePrinters.delete(targetDevice);

        db.prepare(`
            UPDATE print_jobs 
            SET status = 'Confirmed Printed', locked_by = NULL, locked_at = NULL,
                error_message = NULL, finished_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(jobId);

        this.cleanupJobTempFile(job.file_path);
        return { success: true, jobId, status: 'Confirmed Printed' };
    }

    /**
     * Operator Resolution Workflow: Marks an Uncertain/Stalled job as Failed
     */
    static markFailed(jobId, reason = 'Operator marked as failed') {
        const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
        if (!job) return { success: false, error: 'Job not found', code: 'NOT_FOUND' };

        const targetDevice = (job.printer_device_name || job.printer_name || 'Default').toLowerCase();
        this.activePrinters.delete(targetDevice);

        db.prepare(`
            UPDATE print_jobs 
            SET status = 'Failed', locked_by = NULL, locked_at = NULL,
                error_message = ?, finished_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(reason, jobId);

        this.cleanupJobTempFile(job.file_path);
        return { success: true, jobId, status: 'Failed' };
    }

    /**
     * Operator Resolution Workflow: Explicitly requeues an Uncertain/Failed job
     */
    static requeueJob(jobId) {
        const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
        if (!job) return { success: false, error: 'Job not found', code: 'NOT_FOUND' };

        const targetDevice = (job.printer_device_name || job.printer_name || 'Default').toLowerCase();
        this.activePrinters.delete(targetDevice);

        db.prepare(`
            UPDATE print_jobs 
            SET status = 'Queued', locked_by = NULL, locked_at = NULL,
                error_message = NULL
            WHERE id = ?
        `).run(jobId);

        return { success: true, jobId, status: 'Queued' };
    }

    /**
     * Deletes temporary generated PDFs safely, strictly protecting permanent order storage
     * Only deletes files residing inside the dedicated application temp directory
     */
    static cleanupJobTempFile(filePath) {
        if (!filePath || typeof filePath !== 'string') return;
        
        try {
            const appTempDir = this.getAppTempDir();
            const realTempDir = fs.existsSync(appTempDir) ? fs.realpathSync(appTempDir) : path.normalize(appTempDir);
            
            if (!fs.existsSync(filePath)) return;
            const realFile = fs.realpathSync(filePath);

            // Verify canonical path resides strictly inside application temp directory
            const rel = path.relative(realTempDir, realFile);
            const isInsideAppTemp = !rel.startsWith('..') && !path.isAbsolute(rel);

            if (isInsideAppTemp) {
                fs.unlinkSync(realFile);
            }
        } catch (e) {
            // Silently ignore cleanup errors to prevent process aborts
        }
    }

    /**
     * Processes a single claimed print job through the full OS spooler pipeline
     * @param {Object} initialJob - Claimed print_jobs row
     */
    static async processJob(initialJob) {
        const jobId = initialJob.id;
        const targetDevice = (initialJob.printer_device_name || initialJob.printer_name || 'Default').toLowerCase();

        try {
            // 1. Preparing -> Rendering
            this.updateJobStatus(jobId, 'Rendering');

            // Parse settings snapshot if present
            let settingsSnapshot = {};
            if (initialJob.settings_snapshot_json) {
                try {
                    settingsSnapshot = JSON.parse(initialJob.settings_snapshot_json);
                } catch (e) {}
            }

            // Check if Simulator Mode is active in settings
            let isSimulator = false;
            try {
                const settingsRow = db.prepare('SELECT print_simulator_enabled FROM settings WHERE id = 1').get();
                isSimulator = settingsRow ? (settingsRow.print_simulator_enabled === 1) : false;
            } catch (e) {}

            if (isSimulator) {
                // Clearly simulate printing in dedicated simulator directory
                const simulatorDir = path.join(process.cwd(), 'PrintSimulator');
                if (!fs.existsSync(simulatorDir)) fs.mkdirSync(simulatorDir, { recursive: true });

                if (initialJob.file_path && fs.existsSync(initialJob.file_path)) {
                    const dest = path.join(simulatorDir, `simulated_job_${jobId}_${path.basename(initialJob.file_path)}`);
                    fs.copyFileSync(initialJob.file_path, dest);
                }

                // Simulate brief spool delay
                await new Promise(resolve => setTimeout(resolve, 50));

                this.releaseJob(jobId, 'Submitted', null, [{
                    timestamp: new Date().toISOString(),
                    mode: 'SIMULATED',
                    status: 'Submitted'
                }]);
                return { success: true, simulated: true };
            }

            // 2. Rendering -> Submitting
            this.updateJobStatus(jobId, 'Submitting');

            // 3. Delegate to SpoolerAdapter (OS Spooler or Injected Test Adapter)
            const adapter = activeSpoolerAdapter || defaultSpoolerAdapter;
            const result = await adapter.print(initialJob, settingsSnapshot);

            if (result.success) {
                this.releaseJob(jobId, 'Submitted', null, [result.attemptDetails]);
                return { success: true };
            } else if (result.timeout || result.crashed) {
                // Stalled or crashed during Submitting must transition to Uncertain
                this.releaseJob(jobId, 'Uncertain', result.failureReason, [result.attemptDetails]);
                return { success: false, uncertain: true, reason: result.failureReason };
            } else {
                this.releaseJob(jobId, 'Failed', result.failureReason, [result.attemptDetails]);
                return { success: false, reason: result.failureReason };
            }
        } catch (err) {
            console.error(`[PrintQueueManager] Unexpected failure processing job #${jobId}:`, err);
            this.releaseJob(jobId, 'Failed', err.message);
            return { success: false, reason: err.message };
        } finally {
            this.activePrinters.delete(targetDevice);
            this.cleanupJobTempFile(initialJob.file_path);
        }
    }

    /**
     * Processes next available queued jobs concurrently across all free physical printers
     */
    static async processQueue() {
        const workerPromises = [];

        // Find all distinct devices with queued jobs
        const queuedDevices = db.prepare(`
            SELECT DISTINCT COALESCE(printer_device_name, printer_name, 'Default') as device_name
            FROM print_jobs
            WHERE status = 'Queued' AND locked_by IS NULL
        `).all();

        for (const row of queuedDevices) {
            const deviceName = (row.device_name || 'Default').toLowerCase();

            // If this printer is already actively running a worker, skip to preserve single-flight mutex
            if (this.activePrinters.has(deviceName)) {
                continue;
            }

            // Claim first job for this device
            const workerId = `worker_${deviceName}_${crypto.randomUUID().substring(0, 6)}`;
            const job = this.claimNextJob(workerId, deviceName);

            if (job) {
                // Launch dedicated async pipeline for this printer
                const workerPromise = (async () => {
                    let currentJob = job;
                    while (currentJob) {
                        await this.processJob(currentJob);
                        // Claim next job for THIS physical printer device
                        currentJob = this.claimNextJob(workerId, deviceName);
                    }
                })();

                workerPromises.push(workerPromise);
            }
        }

        // Await all concurrent printer workers
        await Promise.allSettled(workerPromises);
    }

    /**
     * Startup Crash Recovery: Recovers Preparing jobs to Queued, Submitting jobs to Uncertain
     */
    static recoverStaleJobsOnStartup() {
        let recovered = 0;
        let markedUncertain = 0;

        try {
            console.log('[PrintQueueManager] Running startup queue recovery...');

            // 1. Recover Preparing/Rendering jobs back to Queued (safe to retry)
            const prepRes = db.prepare(`
                UPDATE print_jobs
                SET status = 'Queued', locked_by = NULL, locked_at = NULL
                WHERE status IN ('Preparing', 'Rendering')
            `).run();
            recovered = prepRes.changes;

            // 2. Transition Submitting jobs to Uncertain (cannot blindly retry without operator confirmation)
            const subRes = db.prepare(`
                UPDATE print_jobs
                SET status = 'Uncertain', locked_by = NULL, locked_at = NULL,
                    error_message = 'Interrupted during printer spooler submission. Operator verification required.'
                WHERE status = 'Submitting'
            `).run();
            markedUncertain = subRes.changes;

            // Clear in-memory printer lock sets
            this.activePrinters.clear();
            this.activeWorkers.clear();

            console.log(`[PrintQueueManager] Queue recovery complete. Re-queued: ${recovered}, Marked Uncertain: ${markedUncertain}`);
        } catch (e) {
            console.error('[PrintQueueManager] Recovery error:', e.message);
        }

        return { recovered, markedUncertain, requeuedCount: recovered, uncertainCount: markedUncertain };
    }

    /**
     * Compatibility alias for startup recovery
     */
    static recoverInterruptedJobs() {
        return this.recoverStaleJobsOnStartup();
    }

    /**
     * Acquires per-printer lock for single-flight concurrency
     */
    static acquirePrinterLock(printerName, workerId = 'worker') {
        const device = (printerName || 'Default').trim().toLowerCase();
        if (this.activePrinters.has(device)) {
            return false;
        }
        this.activePrinters.add(device);
        return true;
    }

    /**
     * Releases per-printer lock
     */
    static releasePrinterLock(printerName, workerId = 'worker') {
        const device = (printerName || 'Default').trim().toLowerCase();
        this.activePrinters.delete(device);
    }

    /**
     * Returns live queue state and active printer locks
     */
    static getQueueStatus() {
        const counts = db.prepare(`
            SELECT status, COUNT(*) as count 
            FROM print_jobs 
            GROUP BY status
        `).all();

        const pendingJobs = db.prepare(`
            SELECT id, order_id, printer_name, printer_device_name, status, copies, pages, created_at, locked_by
            FROM print_jobs 
            WHERE status IN ('Queued', 'Preparing', 'Rendering', 'Submitting', 'Uncertain')
            ORDER BY id ASC
        `).all();

        return {
            activePrinters: Array.from(this.activePrinters),
            statusCounts: counts.reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {}),
            pendingJobs
        };
    }
}

module.exports = PrintQueueManager;
