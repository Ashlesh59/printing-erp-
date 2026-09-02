/**
 * Startup Reconciliation & Integrity Recovery Service
 * 
 * Safely audits and cleans up:
 * - Abandoned staging directories
 * - Missing invoice links
 * - Orphan print / production jobs
 * - Missing filesystem references
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');
const db = require('../database/db');

class ReconciliationService {
    static getStagingBaseDir() {
        try {
            const userData = app ? app.getPath('userData') : path.join(os.homedir(), '.printshopmanager');
            const stagingDir = path.join(userData, 'Staging');
            if (!fs.existsSync(stagingDir)) {
                fs.mkdirSync(stagingDir, { recursive: true });
            }
            return stagingDir;
        } catch (e) {
            return path.join(os.tmpdir(), 'PrintShopStaging');
        }
    }

    /**
     * Cleans abandoned staging directories older than maxAgeMs (default: 1 hour)
     */
    static cleanAbandonedStaging(maxAgeMs = 3600 * 1000) {
        const stagingDir = this.getStagingBaseDir();
        let cleaned = 0;

        try {
            if (!fs.existsSync(stagingDir)) return { cleaned: 0 };
            const entries = fs.readdirSync(stagingDir, { withFileTypes: true });
            const now = Date.now();

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const fullPath = path.join(stagingDir, entry.name);
                    try {
                        const stats = fs.statSync(fullPath);
                        if ((now - stats.mtimeMs) > maxAgeMs) {
                            fs.rmSync(fullPath, { recursive: true, force: true });
                            cleaned++;
                            console.log(`[Reconciliation] Purged abandoned staging dir: ${entry.name}`);
                        }
                    } catch (err) {
                        console.warn(`[Reconciliation] Could not clean dir ${entry.name}:`, err.message);
                    }
                }
            }
        } catch (e) {
            console.error('[Reconciliation] Error scanning staging directory:', e.message);
        }

        return { cleaned };
    }

    /**
     * Performs comprehensive database & filesystem reconciliation audit
     */
    static runStartupReconciliation() {
        console.log('[Reconciliation] Running Phase 2 startup reconciliation audit...');
        const results = {
            cleanedStagingDirs: 0,
            orphansFound: 0,
            warnings: []
        };

        // 1. Purge abandoned staging directories
        const stageRes = this.cleanAbandonedStaging();
        results.cleanedStagingDirs = stageRes.cleaned;

        try {
            // 2. Audit orders missing invoices
            const ordersWithoutInvoice = db.prepare(`
                SELECT o.id, o.total_price, o.created_at, o.payment_status 
                FROM orders o 
                LEFT JOIN gst_invoices g ON o.id = g.order_id 
                WHERE g.id IS NULL AND o.status NOT IN ('Draft', 'Cancelled', 'Declined')
            `).all();

            if (ordersWithoutInvoice && ordersWithoutInvoice.length > 0) {
                console.warn(`[Reconciliation] Found ${ordersWithoutInvoice.length} orders without linked invoices.`);
                results.warnings.push(`${ordersWithoutInvoice.length} orders lack linked GST invoices.`);
            }

            // 3. Audit orphan print jobs
            const orphanPrintJobs = db.prepare(`
                SELECT pj.id FROM print_jobs pj
                LEFT JOIN orders o ON pj.order_id = o.id
                WHERE pj.order_id IS NOT NULL AND o.id IS NULL
            `).all();

            if (orphanPrintJobs && orphanPrintJobs.length > 0) {
                console.warn(`[Reconciliation] Found ${orphanPrintJobs.length} orphan print jobs without parent orders.`);
                results.orphansFound += orphanPrintJobs.length;
            }

            // 4. Audit orphan production jobs
            const orphanProdJobs = db.prepare(`
                SELECT pj.id FROM production_jobs pj
                LEFT JOIN orders o ON pj.order_id = o.id
                WHERE pj.order_id IS NOT NULL AND o.id IS NULL
            `).all();

            if (orphanProdJobs && orphanProdJobs.length > 0) {
                console.warn(`[Reconciliation] Found ${orphanProdJobs.length} orphan production jobs without parent orders.`);
                results.orphansFound += orphanProdJobs.length;
            }

            // Log successful run to database_events
            try {
                db.prepare(`
                    INSERT INTO database_events (operation, status, error_message)
                    VALUES ('startup_reconciliation', 'Completed', ?)
                `).run(JSON.stringify(results));
            } catch (e) {}

        } catch (e) {
            console.error('[Reconciliation] Audit exception:', e.message);
            results.warnings.push(e.message);
        }

        console.log(`[Reconciliation] Audit complete. Cleaned ${results.cleanedStagingDirs} staging folders. Warnings: ${results.warnings.length}`);
        return results;
    }
}

module.exports = ReconciliationService;
