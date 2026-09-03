const db = require('./db');
const eventBus = require('../events/EventBus');
const { EventTypes } = require('../events/EventTypes');
const SmartScheduler = require('../smart-scheduler');

const ProductionModel = {
    getJobs: (filters = {}, searchQuery = '') => {
        try {
            let sql = `
                SELECT pj.*, 
                       c.name as customer_name, 
                       c.phone as customer_phone,
                       o.notes as order_notes,
                       (SELECT invoice_number FROM gst_invoices WHERE customer_id = pj.customer_id ORDER BY id DESC LIMIT 1) as invoice_number,
                       CASE 
                           WHEN pj.due_time IS NOT NULL AND (
                               (pj.status NOT IN ('Ready', 'Delivered', 'Cancelled') AND pj.due_time < datetime('now', 'localtime')) OR
                               (pj.estimated_completion IS NOT NULL AND pj.estimated_completion > pj.due_time)
                           ) THEN 1 
                           ELSE 0 
                       END as is_delayed
                FROM production_jobs pj
                LEFT JOIN orders o ON pj.order_id = o.id
                LEFT JOIN customers c ON pj.customer_id = c.id
                WHERE 1=1
            `;

            const params = [];

            // Filters
            if (filters.status && filters.status !== 'All') {
                sql += ` AND pj.status = ?`;
                params.push(filters.status);
            }
            if (filters.priority && filters.priority !== 'All') {
                sql += ` AND pj.priority = ?`;
                params.push(filters.priority);
            }
            if (filters.printer && filters.printer !== 'All') {
                sql += ` AND pj.assigned_printer = ?`;
                params.push(filters.printer);
            }
            if (filters.operator && filters.operator !== 'All') {
                sql += ` AND pj.assigned_operator = ?`;
                params.push(filters.operator);
            }
            if (filters.paperSize && filters.paperSize !== 'All') {
                sql += ` AND pj.paper_size = ?`;
                params.push(filters.paperSize);
            }
            if (filters.bucket) {
                if (filters.bucket === 'today') {
                    sql += ` AND (date(pj.created_at) = date('now', 'localtime') OR date(pj.scheduled_start) = date('now', 'localtime'))`;
                } else if (filters.bucket === 'upcoming') {
                    sql += ` AND pj.status IN ('Waiting', 'Scheduled') AND (pj.due_time IS NULL OR date(pj.due_time) >= date('now', 'localtime'))`;
                } else if (filters.bucket === 'delayed') {
                    sql += ` AND (
                        (pj.status NOT IN ('Ready', 'Delivered', 'Cancelled') AND pj.due_time < datetime('now', 'localtime')) OR
                        (pj.estimated_completion IS NOT NULL AND pj.estimated_completion > pj.due_time)
                    )`;
                } else if (filters.bucket === 'completed') {
                    sql += ` AND pj.status IN ('Ready', 'Delivered')`;
                }
            }

            if (filters.dateStart && filters.dateEnd) {
                sql += ` AND date(IFNULL(pj.scheduled_start, pj.created_at)) >= date(?) AND date(IFNULL(pj.scheduled_start, pj.created_at)) <= date(?)`;
                params.push(filters.dateStart, filters.dateEnd);
            } else if (filters.dateStart) {
                sql += ` AND date(IFNULL(pj.scheduled_start, pj.created_at)) >= date(?)`;
                params.push(filters.dateStart);
            } else if (filters.dateEnd) {
                sql += ` AND date(IFNULL(pj.scheduled_start, pj.created_at)) <= date(?)`;
                params.push(filters.dateEnd);
            }

            // Search Query
            if (searchQuery && searchQuery.trim() !== '') {
                const q = `%${searchQuery.trim()}%`;
                const numQ = parseInt(searchQuery.trim()) || 0;
                sql += ` AND (
                    pj.job_name LIKE ? OR 
                    c.name LIKE ? OR 
                    c.phone LIKE ? OR 
                    pj.id = ? OR
                    pj.order_id = ?
                )`;
                params.push(q, q, q, numQ, numQ);
            }

            // Sorting
            sql += `
                ORDER BY 
                    CASE pj.priority 
                        WHEN 'Urgent' THEN 1 
                        WHEN 'High' THEN 2 
                        WHEN 'Normal' THEN 3 
                        WHEN 'Low' THEN 4 
                    END ASC,
                    pj.sort_order ASC,
                    pj.created_at DESC
            `;

            return db.prepare(sql).all(...params);
        } catch(e) {
            console.error("getJobs error:", e);
            return [];
        }
    },

    getDashboardStats: (filters = {}) => {
        try {
            let dateCond = "1=1";
            let params = [];
            if (filters.dateStart && filters.dateEnd) {
                dateCond = `date(IFNULL(scheduled_start, created_at)) >= date(?) AND date(IFNULL(scheduled_start, created_at)) <= date(?)`;
                params = [filters.dateStart, filters.dateEnd];
            }

            const waiting = db.prepare(`SELECT COUNT(*) as count FROM production_jobs WHERE status = 'Waiting' AND ${dateCond}`).get(...params).count;
            const printing = db.prepare(`SELECT COUNT(*) as count FROM production_jobs WHERE status = 'Printing' AND ${dateCond}`).get(...params).count;
            const completed = db.prepare(`SELECT COUNT(*) as count FROM production_jobs WHERE status IN ('Ready', 'Delivered') AND ${dateCond}`).get(...params).count;
            const totalJobs = db.prepare(`SELECT COUNT(*) as count FROM production_jobs WHERE ${dateCond}`).get(...params).count;
            
            const pages = db.prepare(`SELECT SUM(copies) as count FROM production_jobs WHERE ${dateCond}`).get(...params).count || 0; // fallback if pages not strictly in table, using copies
            
            const delayed = db.prepare(`
                SELECT COUNT(*) as count FROM production_jobs 
                WHERE status NOT IN ('Ready', 'Delivered', 'Cancelled') 
                  AND (due_time < datetime('now', 'localtime') OR (estimated_completion IS NOT NULL AND estimated_completion > due_time))
                  AND ${dateCond}
            `).get(...params).count;

            const avgTimeRow = db.prepare(`
                SELECT AVG((strftime('%s', actual_completion) - strftime('%s', actual_start)) / 60.0) as avg_mins
                FROM production_jobs
                WHERE actual_start IS NOT NULL AND actual_completion IS NOT NULL
            `).get();

            const avgCompletionMinutes = Math.round(avgTimeRow && avgTimeRow.avg_mins ? avgTimeRow.avg_mins : 8);

            // Printer queue counts
            let printerCounts = [];
            try {
                printerCounts = db.prepare(`
                    SELECT assigned_printer as name, COUNT(*) as active_jobs, SUM(CASE WHEN status = 'Printing' THEN 1 ELSE 0 END) as is_printing
                    FROM production_jobs
                    WHERE assigned_printer IS NOT NULL AND status IN ('Waiting', 'Scheduled', 'Printing', 'Paused') AND ${dateCond}
                    GROUP BY assigned_printer
                `).all(...params);
            } catch(e) {}
            
            const printersActive = printerCounts.filter(p => p.is_printing > 0).length;

            return {
                totalJobs: totalJobs,
                jobsWaiting: waiting,
                jobsPrinting: printing,
                completedToday: completed,
                delayedJobs: delayed,
                totalPages: pages,
                printersActive: printersActive,
                avgCompletionMinutes: avgCompletionMinutes,
                printerStats: printerCounts
            };
        } catch(e) {
            console.error("getDashboardStats error:", e);
            return {
                totalJobs: 0,
                jobsWaiting: 0,
                jobsPrinting: 0,
                completedToday: 0,
                delayedJobs: 0,
                totalPages: 0,
                printersActive: 0,
                avgCompletionMinutes: 0,
                printerStats: []
            };
        }
    },

    createJob: (jobData) => {
        try {
            const jobName = jobData.job_name || jobData.file_name || 'Print Task';
            const paperSize = jobData.paper_size || 'A4';
            const colorMode = jobData.color_mode || jobData.print_type || 'B&W';
            const pages = parseInt(jobData.total_pages || jobData.pages) || 1;
            const copies = parseInt(jobData.copies) || 1;
            const priority = jobData.priority || 'Normal';
            const status = jobData.status || 'Waiting';
            
            const durationMins = SmartScheduler.calculateJobDuration(pages, copies, colorMode, paperSize);
            
            let assignedPrinter = jobData.assigned_printer;
            if (!assignedPrinter) {
                const rec = SmartScheduler.recommendPrinter({ paper_size: paperSize, color_mode: colorMode, total_pages: pages, copies });
                assignedPrinter = rec.recommendedPrinter;
            }

            const stmt = db.prepare(`
                INSERT INTO production_jobs (
                    order_id, order_item_id, customer_id, job_name, status, priority,
                    assigned_printer, assigned_operator, paper_size, color_mode,
                    total_pages, copies, estimated_duration_minutes, due_time, scheduled_start, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const res = stmt.run(
                jobData.order_id || null,
                jobData.order_item_id || null,
                jobData.customer_id || null,
                jobName,
                status,
                priority,
                assignedPrinter,
                jobData.assigned_operator || 'Operator',
                paperSize,
                colorMode,
                pages,
                copies,
                durationMins,
                jobData.due_time || null,
                jobData.scheduled_start || jobData.due_time || null,
                jobData.notes || null
            );

            const jobId = res.lastInsertRowid;
            SmartScheduler.recalculatePrinterEstimates(assignedPrinter);

            return { success: true, id: jobId };
        } catch(e) {
            console.error("createJob error:", e);
            return { success: false, error: e.message };
        }
    },

    updateStatus: (jobId, newStatus) => {
        try {
            const validStatuses = ['Queued', 'Waiting', 'Scheduled', 'Printing', 'Paused', 'Finishing', 'Quality Check', 'Ready', 'Completed', 'Delivered', 'Cancelled', 'Failed'];
            if (!validStatuses.includes(newStatus)) {
                return { success: false, error: 'Invalid status: ' + newStatus };
            }

            const currentJob = db.prepare('SELECT * FROM production_jobs WHERE id = ?').get(jobId);
            if (!currentJob) {
                return { success: false, error: 'Production job not found: ' + jobId };
            }

            // Block invalid transitions from terminal states directly to printing
            if ((currentJob.status === 'Completed' || currentJob.status === 'Cancelled') && newStatus === 'Printing') {
                return { success: false, error: `Cannot transition from ${currentJob.status} to Printing directly.` };
            }

            let extraSql = '';
            if (newStatus === 'Printing') {
                extraSql = `, actual_start = COALESCE(actual_start, CURRENT_TIMESTAMP)`;
            } else if (newStatus === 'Ready' || newStatus === 'Completed' || newStatus === 'Delivered') {
                extraSql = `, actual_completion = COALESCE(actual_completion, CURRENT_TIMESTAMP)`;
            }

            const stmt = db.prepare(`UPDATE production_jobs SET status = ? ${extraSql} WHERE id = ?`);
            stmt.run(newStatus, jobId);

            // Fetch job to update queue estimates
            if (currentJob.assigned_printer) {
                SmartScheduler.recalculatePrinterEstimates(currentJob.assigned_printer);
            }

            // If order_id exists, inspect multi-job cardinality before updating order or fulfilling inventory
            if (currentJob.order_id) {
                const allOrderJobs = db.prepare('SELECT id, status FROM production_jobs WHERE order_id = ?').all(currentJob.order_id);
                
                if (newStatus === 'Completed' || newStatus === 'Delivered') {
                    const allDone = allOrderJobs.every(j => j.status === 'Completed' || j.status === 'Delivered' || j.status === 'Cancelled');
                    const hasAtLeastOneDelivered = allOrderJobs.some(j => j.status === 'Completed' || j.status === 'Delivered');
                    
                    if (allDone && hasAtLeastOneDelivered) {
                        // Update order status to Completed
                        db.prepare("UPDATE orders SET status = 'Completed' WHERE id = ? AND status != 'Cancelled'").run(currentJob.order_id);
                        // Fulfill inventory reservations for this order (idempotent)
                        try {
                            const ReservationService = require('./services/reservation-service');
                            if (ReservationService && typeof ReservationService.fulfill === 'function') {
                                ReservationService.fulfill(currentJob.order_id, 'Production', 'Operator');
                            }
                        } catch (e) {
                            console.error('[ProductionModel] Reservation fulfillment error:', e.message);
                        }
                    }
                } else if (newStatus === 'Cancelled') {
                    const allCancelled = allOrderJobs.every(j => j.status === 'Cancelled');
                    if (allCancelled) {
                        // All jobs cancelled -> Cancel the order and release inventory reservations
                        db.prepare("UPDATE orders SET status = 'Cancelled' WHERE id = ? AND status != 'Completed'").run(currentJob.order_id);
                        try {
                            const ReservationService = require('./services/reservation-service');
                            if (ReservationService && typeof ReservationService.release === 'function') {
                                ReservationService.release(currentJob.order_id, 'Production', 'Job Cancellation');
                            }
                        } catch (e) {
                            console.error('[ProductionModel] Reservation release error:', e.message);
                        }
                    }
                }
            }

            return { success: true };
        } catch(e) {
            console.error("updateStatus error:", e);
            return { success: false, error: e.message };
        }
    },

    moveJobUp: (jobId) => {
        try {
            const allJobs = db.prepare('SELECT id, sort_order FROM production_jobs ORDER BY sort_order ASC, id ASC').all();
            const idx = allJobs.findIndex(j => j.id === jobId);
            if (idx <= 0) return { success: true }; // Already at top

            const current = allJobs[idx];
            const prev = allJobs[idx - 1];

            const stmt = db.prepare('UPDATE production_jobs SET sort_order = ? WHERE id = ?');
            const tx = db.transaction(() => {
                stmt.run(prev.sort_order || idx, current.id);
                stmt.run(current.sort_order || (idx + 1), prev.id);
            });
            tx();
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },

    moveJobDown: (jobId) => {
        try {
            const allJobs = db.prepare('SELECT id, sort_order FROM production_jobs ORDER BY sort_order ASC, id ASC').all();
            const idx = allJobs.findIndex(j => j.id === jobId);
            if (idx < 0 || idx >= allJobs.length - 1) return { success: true }; // Already at bottom

            const current = allJobs[idx];
            const next = allJobs[idx + 1];

            const stmt = db.prepare('UPDATE production_jobs SET sort_order = ? WHERE id = ?');
            const tx = db.transaction(() => {
                stmt.run(next.sort_order || (idx + 2), current.id);
                stmt.run(current.sort_order || (idx + 1), next.id);
            });
            tx();
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },

    updatePriority: (jobId, newPriority) => {
        try {
            const validPriorities = ['Low', 'Normal', 'High', 'Urgent'];
            if (!validPriorities.includes(newPriority)) return { success: false, error: 'Invalid priority' };

            db.prepare('UPDATE production_jobs SET priority = ? WHERE id = ?').run(newPriority, jobId);
            
            const job = db.prepare('SELECT assigned_printer FROM production_jobs WHERE id = ?').get(jobId);
            if (job && job.assigned_printer) {
                SmartScheduler.recalculatePrinterEstimates(job.assigned_printer);
            }
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },

    assignPrinter: (jobId, printerName) => {
        try {
            const oldJob = db.prepare('SELECT assigned_printer FROM production_jobs WHERE id = ?').get(jobId);
            
            db.prepare('UPDATE production_jobs SET assigned_printer = ? WHERE id = ?').run(printerName, jobId);

            if (oldJob && oldJob.assigned_printer) {
                SmartScheduler.recalculatePrinterEstimates(oldJob.assigned_printer);
            }
            SmartScheduler.recalculatePrinterEstimates(printerName);

            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },

    reorderQueue: (jobIdList) => {
        try {
            if (!Array.isArray(jobIdList)) return { success: false, error: 'Invalid job order array' };

            const stmt = db.prepare('UPDATE production_jobs SET sort_order = ? WHERE id = ?');
            const tx = db.transaction(() => {
                jobIdList.forEach((id, idx) => {
                    stmt.run(idx + 1, id);
                });
            });
            tx();

            if (jobIdList.length > 0) {
                const firstJob = db.prepare('SELECT assigned_printer FROM production_jobs WHERE id = ?').get(jobIdList[0]);
                if (firstJob && firstJob.assigned_printer) {
                    SmartScheduler.recalculatePrinterEstimates(firstJob.assigned_printer);
                }
            }

            return { success: true };
        } catch(e) {
            console.error("reorderQueue error:", e);
            return { success: false, error: e.message };
        }
    },

    duplicateJob: (jobId) => {
        try {
            const orig = db.prepare('SELECT * FROM production_jobs WHERE id = ?').get(jobId);
            if (!orig) return { success: false, error: 'Original job not found' };

            const newJobData = {
                order_id: orig.order_id,
                order_item_id: orig.order_item_id,
                customer_id: orig.customer_id,
                job_name: `${orig.job_name} (Copy)`,
                status: 'Waiting',
                priority: orig.priority,
                assigned_printer: orig.assigned_printer,
                assigned_operator: orig.assigned_operator,
                paper_size: orig.paper_size,
                color_mode: orig.color_mode,
                total_pages: orig.total_pages,
                copies: orig.copies,
                due_time: orig.due_time,
                notes: orig.notes
            };

            return ProductionModel.createJob(newJobData);
        } catch(e) {
            return { success: false, error: e.message };
        }
    },

    deleteJob: (jobId) => {
        try {
            db.prepare('DELETE FROM production_jobs WHERE id = ?').run(jobId);
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },

    autoCreateFromOrder: (orderId, scheduleDetails = {}) => {
        try {
            const order = db.prepare('SELECT o.*, c.name as customer_name FROM orders o LEFT JOIN customers c ON o.customer_id = c.id WHERE o.id = ?').get(orderId);
            if (!order) return;

            const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
            if (!items || items.length === 0) return;

            const custName = order.customer_name || 'Walk-in Customer';

            const prodStatus = (order.status === 'Scheduled' || scheduleDetails.status === 'Scheduled') ? 'Scheduled' : 'Waiting';
            const scheduledStart = scheduleDetails.scheduledStart || scheduleDetails.dueTime || scheduleDetails.scheduled_start || null;
            const dueTime = scheduleDetails.dueTime || scheduleDetails.scheduledStart || scheduleDetails.due_time || null;
            const operator = scheduleDetails.operator || scheduleDetails.assigned_operator || 'Operator';
            const priority = scheduleDetails.priority || 'Normal';
            const assignedPrinter = scheduleDetails.assignedPrinter || scheduleDetails.assigned_printer || null;
            const combinedNotes = scheduleDetails.notes || order.notes;

            for (const item of items) {
                // Check if already created
                const existing = db.prepare('SELECT id FROM production_jobs WHERE order_id = ? AND order_item_id = ?').get(orderId, item.id);
                if (!existing) {
                    const prodName = item.product_name || item.job_name || (item.paper_size ? `${item.paper_size} Print` : 'Print Order');
                    const finalJobTitle = `${custName} — ${prodName}`;

                    ProductionModel.createJob({
                        order_id: orderId,
                        order_item_id: item.id,
                        customer_id: order.customer_id,
                        job_name: finalJobTitle,
                        file_name: item.file_name,
                        paper_size: item.paper_size || 'A4',
                        color_mode: item.print_type || 'B&W',
                        total_pages: item.pages || 1,
                        copies: item.copies || 1,
                        priority: priority,
                        status: prodStatus,
                        assigned_operator: operator,
                        assigned_printer: assignedPrinter,
                        scheduled_start: scheduledStart,
                        due_time: dueTime,
                        notes: combinedNotes
                    });
                }
            }
        } catch(e) {
            console.error("autoCreateFromOrder error:", e);
        }
    },

    scheduleJob: (jobId, scheduleData = {}) => {
        try {
            const scheduledStart = scheduleData.scheduledStart || scheduleData.dueTime || (scheduleData.scheduledDate ? `${scheduleData.scheduledDate} ${scheduleData.scheduledTime || '10:00'}:00` : new Date().toISOString());
            const dueTime = scheduleData.dueTime || scheduledStart;
            const operator = scheduleData.operator || scheduleData.assigned_operator || 'Production Team';
            const priority = scheduleData.priority || 'Normal';
            const notes = scheduleData.notes || null;

            db.prepare(`
                UPDATE production_jobs 
                SET status = 'Scheduled',
                    scheduled_start = ?,
                    due_time = ?,
                    assigned_operator = ?,
                    priority = ?,
                    notes = COALESCE(?, notes)
                WHERE id = ?
            `).run(scheduledStart, dueTime, operator, priority, notes, jobId);

            const job = db.prepare('SELECT assigned_printer FROM production_jobs WHERE id = ?').get(jobId);
            if (job && job.assigned_printer) {
                SmartScheduler.recalculatePrinterEstimates(job.assigned_printer);
            }

            return { success: true, jobId };
        } catch(e) {
            console.error("scheduleJob error:", e);
            return { success: false, error: e.message };
        }
    }
};

module.exports = ProductionModel;
