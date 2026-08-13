const db = require('./database/db');

const SmartScheduler = {
    calculateJobDuration: (pages = 1, copies = 1, colorMode = 'B&W', paperSize = 'A4', ppm = null) => {
        const totalPages = Math.max(1, (parseInt(pages) || 1) * (parseInt(copies) || 1));
        
        let basePpm = 25; // Default B&W speed
        if (colorMode && colorMode.toLowerCase() === 'color') {
            basePpm = 12; // Color PPM
        }
        if (ppm && parseFloat(ppm) > 0) {
            basePpm = parseFloat(ppm);
        }

        // Adjust speed for larger formats
        if (paperSize && paperSize.toUpperCase() === 'A3') {
            basePpm *= 0.65;
        } else if (paperSize && paperSize.toUpperCase() === 'POSTER') {
            basePpm *= 0.25;
        }

        const printingMinutes = totalPages / basePpm;
        const warmupMinutes = 0.5; // 30 sec warmup/spooling
        const totalMinutes = Math.ceil((printingMinutes + warmupMinutes) * 10) / 10;
        
        return Math.max(1, totalMinutes);
    },

    recommendPrinter: (jobSpecs = {}, availablePrinters = []) => {
        try {
            const paperSize = (jobSpecs.paper_size || 'A4').toUpperCase();
            const isColor = (jobSpecs.color_mode || 'B&W').toLowerCase() === 'color';
            const reqPages = (parseInt(jobSpecs.total_pages) || 1) * (parseInt(jobSpecs.copies) || 1);

            // Fetch printer capabilities from DB if not provided
            let printers = availablePrinters;
            if (!printers || printers.length === 0) {
                try {
                    printers = db.prepare('SELECT * FROM device_capabilities').all();
                } catch(e) {
                    printers = [];
                }
            }

            if (!printers || printers.length === 0) {
                return {
                    recommendedPrinter: 'Default Printer',
                    confidence: 'Low',
                    reason: 'System default printer selected (No detailed device capabilities found).'
                };
            }

            // Score printers based on capability & current queue load
            const scoredPrinters = printers.map(p => {
                let score = 100;
                let reason = [];

                const name = p.display_name || p.device_name || p.name;
                const pColor = p.can_color === 1 || (p.paper_sources_json && p.paper_sources_json.toLowerCase().includes('color'));
                const isOffline = p.status === 'Offline';

                if (isOffline) {
                    score -= 80;
                    reason.push("Printer is OFFLINE");
                }

                if (isColor) {
                    if (pColor) {
                        score += 30;
                        reason.push("Supports Color printing");
                    } else {
                        score -= 50;
                        reason.push("B&W printer (Color requested)");
                    }
                } else {
                    if (!pColor) {
                        score += 15; // Prefer B&W printer for B&W jobs to save color toner
                        reason.push("Optimal B&W dedicated printer");
                    }
                }

                // Check queue workload for this printer
                let queueCount = 0;
                try {
                    const row = db.prepare("SELECT COUNT(*) as cnt FROM production_jobs WHERE assigned_printer = ? AND status IN ('Waiting', 'Scheduled', 'Printing', 'Paused')").get(name);
                    queueCount = row ? row.cnt : 0;
                } catch(e) {}

                score -= (queueCount * 10);
                if (queueCount > 0) {
                    reason.push(`${queueCount} active jobs in queue`);
                } else {
                    reason.push("Zero current queue load");
                }

                return {
                    name,
                    score,
                    reason: reason.join('; '),
                    queueCount,
                    isColor: pColor
                };
            });

            scoredPrinters.sort((a, b) => b.score - a.score);

            const winner = scoredPrinters[0];
            return {
                recommendedPrinter: winner ? winner.name : 'Default Printer',
                confidence: winner && winner.score > 70 ? 'High' : 'Medium',
                reason: winner ? winner.reason : 'Best available match',
                alternatives: scoredPrinters.slice(1, 4).map(sp => ({ name: sp.name, reason: sp.reason }))
            };
        } catch(e) {
            console.error("recommendPrinter error:", e);
            return {
                recommendedPrinter: 'Default Printer',
                confidence: 'Low',
                reason: 'Default fallback recommendation'
            };
        }
    },

    recalculatePrinterEstimates: (printerName) => {
        try {
            const jobs = db.prepare(`
                SELECT * FROM production_jobs 
                WHERE assigned_printer = ? AND status IN ('Waiting', 'Scheduled', 'Printing', 'Paused')
                ORDER BY 
                    CASE priority 
                        WHEN 'Urgent' THEN 1 
                        WHEN 'High' THEN 2 
                        WHEN 'Normal' THEN 3 
                        WHEN 'Low' THEN 4 
                    END ASC,
                    sort_order ASC,
                    created_at ASC
            `).all(printerName);

            let currentTime = new Date();

            const updateStmt = db.prepare(`
                UPDATE production_jobs
                SET estimated_start = ?, estimated_completion = ?
                WHERE id = ?
            `);

            db.transaction(() => {
                for (const job of jobs) {
                    const estStart = new Date(currentTime);
                    const durationMs = (job.estimated_duration_minutes || 5) * 60 * 1000;
                    const estComp = new Date(estStart.getTime() + durationMs);

                    updateStmt.run(
                        estStart.toISOString(),
                        estComp.toISOString(),
                        job.id
                    );

                    currentTime = estComp;
                }
            })();
        } catch(e) {
            console.error("recalculatePrinterEstimates error:", e);
        }
    }
};

module.exports = SmartScheduler;
