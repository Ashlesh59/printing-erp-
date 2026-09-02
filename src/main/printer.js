const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PDFDocument, degrees, rgb } = require('pdf-lib');
const db = require('./database/db');
const NotificationService = require('./database/services/notification-service');
const eventBus = require('./events/EventBus');
const { EventTypes } = require('./events/EventTypes');
const DeviceManager = require('./device-manager');

// Draw PDF Content Page with Imposition, Margins, Bleeds, Alignment, and Calibration
async function drawContentPage(pdfDoc, embeddedPage, srcWidth, srcHeight, targetWidth, targetHeight, options = {}, calibration = null, pageIndex = 0) {
    const sheet = pdfDoc.addPage([targetWidth, targetHeight]);
    
    // 1. Margins (in points)
    let mLeft = 0, mRight = 0, mTop = 0, mBottom = 0;
    if (options.margins_type === 'custom') {
        mLeft = (parseFloat(options.margin_left) || 0) * 2.8346;
        mRight = (parseFloat(options.margin_right) || 0) * 2.8346;
        mTop = (parseFloat(options.margin_top) || 0) * 2.8346;
        mBottom = (parseFloat(options.margin_bottom) || 0) * 2.8346;
    } else if (options.margins_type !== 'zero') {
        // default 10mm margins = 28.35 points
        mLeft = mRight = mTop = mBottom = 28.35;
    }

    // 2. Binding margin (Alternating offset for duplex layouts)
    const bindingPoints = (parseFloat(options.binding_margin) || 0) * 2.8346;
    if (bindingPoints > 0) {
        const isEven = pageIndex % 2 === 1; // 0-indexed: even pages are back sides
        const isDuplex = options.duplex_mode && options.duplex_mode !== 'simplex';
        if (isDuplex && isEven) {
            mRight += bindingPoints;
        } else {
            mLeft += bindingPoints;
        }
    }

    // 3. Bleed margin (adds to borders)
    const bleedPoints = (parseFloat(options.bleed) || 0) * 2.8346;
    mLeft += bleedPoints;
    mRight += bleedPoints;
    mTop += bleedPoints;
    mBottom += bleedPoints;

    // Define target bounding box
    const boxWidth = Math.max(10, targetWidth - mLeft - mRight);
    const boxHeight = Math.max(10, targetHeight - mTop - mBottom);

    // 4. Auto orientation rotation
    let rotateAngle = 0;
    let finalSrcW = srcWidth;
    let finalSrcH = srcHeight;
    const srcIsLandscape = srcWidth > srcHeight;
    const targetIsLandscape = targetWidth > targetHeight;

    if (options.auto_rotate && srcIsLandscape !== targetIsLandscape) {
        rotateAngle = 90;
        finalSrcW = srcHeight;
        finalSrcH = srcWidth;
    }

    // 5. Scaling calculation
    let drawW = finalSrcW;
    let drawH = finalSrcH;
    let scale = 1.0;

    const scalingMode = options.scaling || 'fit';
    if (scalingMode === 'fit') {
        scale = Math.min(boxWidth / finalSrcW, boxHeight / finalSrcH);
        drawW = finalSrcW * scale;
        drawH = finalSrcH * scale;
    } else if (scalingMode === 'fill') {
        scale = Math.max(boxWidth / finalSrcW, boxHeight / finalSrcH);
        drawW = finalSrcW * scale;
        drawH = finalSrcH * scale;
    } else if (scalingMode === 'custom') {
        scale = (parseFloat(options.custom_scale) || 100.0) / 100.0;
        drawW = finalSrcW * scale;
        drawH = finalSrcH * scale;
    }

    // 6. Alignment & Center positioning
    let drawX = mLeft;
    let drawY = mBottom;
    
    const alignment = (options.alignment || 'center').toLowerCase();
    if (alignment === 'center') {
        drawX = mLeft + (boxWidth - drawW) / 2;
        drawY = mBottom + (boxHeight - drawH) / 2;
    } else if (alignment === 'top-left') {
        drawX = mLeft;
        drawY = targetHeight - mTop - drawH;
    } else if (alignment === 'top-right') {
        drawX = targetWidth - mRight - drawW;
        drawY = targetHeight - mTop - drawH;
    } else if (alignment === 'bottom-left') {
        drawX = mLeft;
        drawY = mBottom;
    } else if (alignment === 'bottom-right') {
        drawX = targetWidth - mRight - drawW;
        drawY = mBottom;
    }

    // 7. Apply physical calibration offsets
    if (calibration) {
        const calOffsetX = (parseFloat(calibration.offset_x) || 0.0) * 2.8346;
        const calOffsetY = (parseFloat(calibration.offset_y) || 0.0) * 2.8346;
        const calScaleX = parseFloat(calibration.scale_x) || 1.0;
        const calScaleY = parseFloat(calibration.scale_y) || 1.0;

        drawX += calOffsetX;
        drawY += calOffsetY;
        drawW *= calScaleX;
        drawH *= calScaleY;
    }

    // Draw page
    sheet.drawPage(embeddedPage, {
        x: drawX,
        y: drawY,
        width: drawW,
        height: drawH,
        rotate: degrees(rotateAngle)
    });

    // 8. Draw physical crop lines if crop marks or cut marks enabled
    if (options.crop_marks || options.cut_marks) {
        const len = 12; // line length in points
        const pad = 4;  // distance from crop bounds
        
        const x1 = mLeft;
        const x2 = targetWidth - mRight;
        const y1 = mBottom;
        const y2 = targetHeight - mTop;

        const markColor = rgb(0.4, 0.4, 0.4);

        // Top-Left crop mark lines
        sheet.drawLine({ start: { x: x1 - pad - len, y: y2 }, end: { x: x1 - pad, y: y2 }, color: markColor, thickness: 0.5 });
        sheet.drawLine({ start: { x: x1, y: y2 + pad + len }, end: { x: x1, y: y2 + pad }, color: markColor, thickness: 0.5 });

        // Top-Right crop mark lines
        sheet.drawLine({ start: { x: x2 + pad + len, y: y2 }, end: { x: x2 + pad, y: y2 }, color: markColor, thickness: 0.5 });
        sheet.drawLine({ start: { x: x2, y: y2 + pad + len }, end: { x: x2, y: y2 + pad }, color: markColor, thickness: 0.5 });

        // Bottom-Left crop mark lines
        sheet.drawLine({ start: { x: x1 - pad - len, y: y1 }, end: { x: x1 - pad, y: y1 }, color: markColor, thickness: 0.5 });
        sheet.drawLine({ start: { x: x1, y: y1 - pad - len }, end: { x: x1, y: y1 - pad }, color: markColor, thickness: 0.5 });

        // Bottom-Right crop mark lines
        sheet.drawLine({ start: { x: x2 + pad + len, y: y1 }, end: { x: x2 + pad, y: y1 }, color: markColor, thickness: 0.5 });
        sheet.drawLine({ start: { x: x2, y: y1 - pad - len }, end: { x: x2, y: y1 - pad }, color: markColor, thickness: 0.5 });
    }
}

async function createUnifiedPdf(payload, options) {
    const pdfDoc = await PDFDocument.create();
    
    // Resolve page dimensions: A4 = 595 x 842, A3 = 842 x 1191
    const pSize = options.paperSize || options.paper_size || 'A4';
    const pageWidth = pSize === 'A3' ? 842 : 595;
    const pageHeight = pSize === 'A3' ? 1191 : 842;
    
    let profile = null;
    let calibration = null;
    if (options.printProfileId) {
        profile = db.prepare('SELECT * FROM print_profiles WHERE id = ?').get(options.printProfileId);
    }
    if (options.printerName) {
        calibration = DeviceManager.getCalibration(options.printerName);
    }

    // Merge options into profile defaults
    const combinedOptions = {
        paper_size: pSize,
        duplex_mode: options.sides === 'Double' ? 'longEdge' : 'simplex',
        ...profile,
        ...options
    };

    let imageGroup = [];
    let pageCounter = 0;
    
    for (const fileData of payload) {
        if (fileData.ext === '.pdf') {
            // Flush preceding images
            if (imageGroup.length > 0) {
                await drawImagesToPage(pdfDoc, imageGroup, combinedOptions.n_up || 1, pageWidth, pageHeight, calibration);
                imageGroup = [];
            }
            
            if (!fs.existsSync(fileData.path)) {
                throw new Error(`PDF Validation Error: File does not exist at ${fileData.path}`);
            }
            const stats = fs.statSync(fileData.path);
            if (stats.size === 0) {
                throw new Error("PDF Validation Error: File is empty (0 bytes)");
            }

            let srcPdf;
            try {
                const srcPdfBytes = fs.readFileSync(fileData.path);
                srcPdf = await PDFDocument.load(srcPdfBytes, { ignoreEncryption: false });
                if (srcPdf.isEncrypted) {
                    throw new Error("PDF file is password protected/encrypted");
                }
            } catch (errPdf) {
                throw new Error(`PDF Validation Error: Failed to parse PDF: ${errPdf.message}`);
            }

            const pageIndices = srcPdf.getPageIndices();
            
            // Render each PDF page inside the layout boundary box
            for (const idx of pageIndices) {
                const srcPage = srcPdf.getPage(idx);
                const { width: srcW, height: srcH } = srcPage.getSize();
                
                const [embeddedPage] = await pdfDoc.embedPages([srcPage]);
                
                await drawContentPage(
                    pdfDoc,
                    embeddedPage,
                    srcW,
                    srcH,
                    pageWidth,
                    pageHeight,
                    combinedOptions,
                    calibration,
                    pageCounter++
                );
            }
        } else {
            imageGroup.push(fileData);
            if (imageGroup.length === (combinedOptions.n_up || 1)) {
                await drawImagesToPage(pdfDoc, imageGroup, combinedOptions.n_up || 1, pageWidth, pageHeight, calibration);
                imageGroup = [];
            }
        }
    }
    
    if (imageGroup.length > 0) {
        await drawImagesToPage(pdfDoc, imageGroup, combinedOptions.n_up || 1, pageWidth, pageHeight, calibration);
    }
    
    if (pdfDoc.getPageCount() === 0) {
        const page = pdfDoc.addPage([pageWidth, pageHeight]);
        const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        page.drawText('Print Shop Manager - Order Summary', { x: 50, y: pageHeight - 60, size: 18, font });
    }

    const compiledPdfBytes = await pdfDoc.save();

    // Slicing page range if requested
    if (options && options.pageRange) {
        const parsedRanges = parsePageRanges(options.pageRange);
        if (parsedRanges && parsedRanges.length > 0) {
            const slicedDoc = await PDFDocument.create();
            const srcDoc = await PDFDocument.load(compiledPdfBytes);
            const totalPages = srcDoc.getPageCount();
            
            const targetIndices = [];
            for (const range of parsedRanges) {
                const from = Math.max(0, Math.min(range.from, totalPages - 1));
                const to = Math.max(0, Math.min(range.to, totalPages - 1));
                if (from <= to) {
                    for (let p = from; p <= to; p++) {
                        targetIndices.push(p);
                    }
                } else {
                    for (let p = from; p >= to; p--) {
                        targetIndices.push(p);
                    }
                }
            }
            
            if (targetIndices.length > 0) {
                const copiedPages = await slicedDoc.copyPages(srcDoc, targetIndices);
                copiedPages.forEach(page => slicedDoc.addPage(page));
                return await slicedDoc.save();
            }
        }
    }
    
    return compiledPdfBytes;
}

async function drawImagesToPage(pdfDoc, images, nUp, pageWidth, pageHeight, calibration) {
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    
    let cols = 1, rows = 1;
    if (nUp === 2) { cols = 1; rows = 2; }
    if (nUp === 4) { cols = 2; rows = 2; }
    
    const slotWidth = pageWidth / cols;
    const slotHeight = pageHeight / rows;
    const margin = 20; 
    
    for (let i = 0; i < images.length; i++) {
        const fileData = images[i];
        
        let img;
        try {
            if (fileData.croppedDataUrl) {
                const base64Data = fileData.croppedDataUrl.replace(/^data:image\/\w+;base64,/, "");
                const imageBytes = Buffer.from(base64Data, 'base64');
                img = await pdfDoc.embedJpg(imageBytes).catch(() => pdfDoc.embedPng(imageBytes));
            } else {
                const imageBytes = fs.readFileSync(fileData.path);
                if (fileData.ext === '.png') {
                    img = await pdfDoc.embedPng(imageBytes);
                } else {
                    img = await pdfDoc.embedJpg(imageBytes);
                }
            }
        } catch (err) {
            console.error("Failed to embed image", err);
            continue;
        }
        
        const c = i % cols;
        const r = Math.floor(i / cols);
        
        let x = c * slotWidth + margin;
        let y = pageHeight - ((r + 1) * slotHeight) + margin;
        let w = slotWidth - margin * 2;
        let h = slotHeight - margin * 2;
        
        const imgDims = img.scale(1);
        let drawW, drawH;
        
        const rotateAngle = fileData.rotate || 0;
        const isSwapped = rotateAngle % 180 !== 0;
        
        const imgW = isSwapped ? imgDims.height : imgDims.width;
        const imgH = isSwapped ? imgDims.width : imgDims.height;
        
        if (fileData.fit === 'cover') {
            const scaleFactor = Math.max(w / imgW, h / imgH);
            drawW = imgDims.width * scaleFactor;
            drawH = imgDims.height * scaleFactor;
        } else {
            const scaleFactor = Math.min(w / imgW, h / imgH);
            drawW = imgDims.width * scaleFactor;
            drawH = imgDims.height * scaleFactor;
        }
        
        const centerX = x + w / 2;
        const centerY = y + h / 2;
        
        const theta = -rotateAngle * Math.PI / 180;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        
        const dx = (drawW / 2) * cos - (drawH / 2) * sin;
        const dy = (drawW / 2) * sin + (drawH / 2) * cos;
        
        let drawX = centerX - dx;
        let drawY = centerY - dy;

        // Apply calibration offsets
        if (calibration) {
            const calOffsetX = (parseFloat(calibration.offset_x) || 0.0) * 2.8346;
            const calOffsetY = (parseFloat(calibration.offset_y) || 0.0) * 2.8346;
            const calScaleX = parseFloat(calibration.scale_x) || 1.0;
            const calScaleY = parseFloat(calibration.scale_y) || 1.0;

            drawX += calOffsetX;
            drawY += calOffsetY;
            drawW *= calScaleX;
            drawH *= calScaleY;
        }
        
        page.drawImage(img, {
            x: drawX,
            y: drawY,
            width: drawW,
            height: drawH,
            rotate: degrees(-rotateAngle)
        });
    }
}

function parsePageRanges(rangeStr) {
    if (!rangeStr || typeof rangeStr !== 'string') return null;
    const ranges = [];
    const parts = rangeStr.split(',');
    for (const part of parts) {
        const cleanPart = part.trim();
        if (!cleanPart) continue;
        if (cleanPart.includes('-')) {
            const splitRange = cleanPart.split('-');
            const from = parseInt(splitRange[0].trim(), 10);
            const to = parseInt(splitRange[1].trim(), 10);
            if (!isNaN(from) && !isNaN(to)) {
                ranges.push({ from: from - 1, to: to - 1 });
            }
        } else {
            const val = parseInt(cleanPart, 10);
            if (!isNaN(val)) {
                ranges.push({ from: val - 1, to: val - 1 });
            }
        }
    }
    return ranges.length > 0 ? ranges : null;
}

async function getPrinterCapabilities(printerName) {
    if (!printerName || printerName === 'Default') return null;
    try {
        const printers = DeviceManager.getPrinters();
        const printer = printers.find(p => p.device_name === printerName || p.display_name === printerName);
        if (printer) {
            return {
                name: printer.device_name,
                displayName: printer.display_name,
                status: printer.status,
                color: printer.can_color,
                duplex: printer.can_duplex,
                paperSizes: printer.paper_sizes,
                driverName: printer.driver_name,
                isDefault: printer.is_default
            };
        }
        return null;
    } catch(err) {
        console.error("Failed to query printer capabilities:", err);
        return null;
    }
}

class PrintQueueManager {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        
        // Recover crashed jobs
        try {
            const crashUpdated = db.prepare(`
                UPDATE print_jobs 
                SET status = 'Failed', error_message = 'Application crashed/closed while processing print job', finished_at = CURRENT_TIMESTAMP 
                WHERE status IN ('Preparing', 'Printing')
            `).run();
            if (crashUpdated.changes > 0) {
                console.log(`[RECOVERY] Recovered ${crashUpdated.changes} interrupted print jobs.`);
            }
        } catch(e) {
            console.error("[RECOVERY] Startup print queue recovery failed:", e);
        }
    }

    async enqueue(orderId, printerName, filePath, pages, copies, options = {}) {
        return new Promise(async (resolve, reject) => {
            let jobId = options.printJobId || null;
            let auditLogId;
            try {
                if (!jobId) {
                    const customerId = options.customerId || options.customer_id || null;
                    const paperSize = options.paperSize || options.paper_size || null;
                    const colorMode = options.printType || options.color_mode || null;
                    const duplex = options.sides || options.duplex || null;

                    const stmt = db.prepare(`
                        INSERT INTO print_jobs (order_id, customer_id, printer_name, file_path, pages, copies, paper_size, color_mode, duplex, status, started_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Queued', CURRENT_TIMESTAMP)
                    `);
                    const res = stmt.run(orderId || null, customerId, printerName || 'Default', filePath, pages, copies, paperSize, colorMode, duplex);
                    jobId = res.lastInsertRowid;
                }

                // Create reprint snapshot audit entry
                const profileId = options.printProfileId || null;
                let profile = null;
                if (profileId) {
                    profile = db.prepare('SELECT * FROM print_profiles WHERE id = ?').get(profileId);
                }
                const profileSnapshot = profile ? JSON.stringify(profile) : '{}';
                const product = options.productId ? db.prepare('SELECT * FROM products WHERE id = ?').get(options.productId) : null;
                
                let invUsedJson = '[]';
                if (profile && profile.recipe_id) {
                    try {
                        const RecipeService = require('./database/services/recipe-service');
                        const items = RecipeService.calculateRecipeConsumptionDirect(profile.recipe_id, {
                            pages: pages,
                            copies: copies
                        });
                        invUsedJson = JSON.stringify(items);
                    } catch(e) {}
                }

                const auditStmt = db.prepare(`
                    INSERT INTO print_audit_logs (
                        order_id, customer_id, operator_name, product_id, product_name,
                        print_profile_id, print_profile_name, print_profile_snapshot_json,
                        printer_name, driver_name, paper_size, paper_source, pages, copies,
                        inventory_used_json, duration_ms, status, error_message, is_simulated, started_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'Queued', NULL, 0, CURRENT_TIMESTAMP)
                `);
                const caps = await getPrinterCapabilities(printerName);
                const auditRes = auditStmt.run(
                    orderId || null,
                    customerId,
                    options.operatorName || 'System',
                    product ? product.id : null,
                    product ? product.name : null,
                    profile ? profile.id : null,
                    profile ? profile.name : null,
                    profileSnapshot,
                    printerName || 'Default',
                    caps ? caps.driverName : 'Unknown',
                    profile ? profile.paper_size : paperSize,
                    profile ? profile.paper_source : null,
                    pages,
                    copies,
                    invUsedJson
                );
                auditLogId = auditRes.lastInsertRowid;
            } catch(e) {
                console.error("Failed to log print job or audit:", e);
            }

            const job = {
                id: jobId,
                auditId: auditLogId,
                orderId,
                printerName,
                filePath,
                pages,
                copies,
                options,
                resolve,
                reject,
                retryCount: 0
            };

            this.queue.push(job);
            this.processNext();
        });
    }

    async processNext() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        const job = this.queue[0];
        const startTime = Date.now();
        
        try {
            if (job.id) {
                db.prepare("UPDATE print_jobs SET status = 'Preparing' WHERE id = ?").run(job.id);
            }
            if (job.auditId) {
                db.prepare("UPDATE print_audit_logs SET status = 'Preparing' WHERE id = ?").run(job.auditId);
            }
            
            eventBus.publish(EventTypes.PRINTER_JOB_STARTED, { jobId: job.id, printerName: job.printerName, orderId: job.orderId }, { sourceModule: 'PrinterService' });

            // Document Validation
            try {
                if (!fs.existsSync(job.filePath)) {
                    throw new Error(`File does not exist at: ${job.filePath}`);
                }
                const stats = fs.statSync(job.filePath);
                if (stats.size === 0) {
                    throw new Error("Corrupted PDF payload: File size is 0 bytes");
                }
                const fileBytes = fs.readFileSync(job.filePath);
                const pdfDoc = await PDFDocument.load(fileBytes, { ignoreEncryption: false });
                if (pdfDoc.isEncrypted) {
                    throw new Error("PDF file is password protected/encrypted");
                }
            } catch (errPdf) {
                throw new Error(`PDF Validation Error: ${errPdf.message}`);
            }

            // Printer Discovery, Redundancy, and Failover check
            let resolvedPrinter = job.printerName;
            try {
                let caps = await getPrinterCapabilities(resolvedPrinter);
                if (!caps || caps.status === 'Offline') {
                    // Check failover groups
                    const siblings = DeviceManager.getCompatiblePrintersInGroup(resolvedPrinter);
                    if (siblings && siblings.length > 0) {
                        resolvedPrinter = siblings[0].name;
                        console.warn(`[Failover] Printer "${job.printerName}" is Offline. Auto-rerouted to kompatible printer "${resolvedPrinter}".`);
                        if (job.id) {
                            db.prepare("UPDATE print_jobs SET printer_name = ?, error_message = ? WHERE id = ?").run(
                                resolvedPrinter,
                                `Auto-rerouted from offline printer "${job.printerName}"`,
                                job.id
                            );
                        }
                        if (job.auditId) {
                            db.prepare("UPDATE print_audit_logs SET printer_name = ?, error_message = ? WHERE id = ?").run(
                                resolvedPrinter,
                                `Auto-rerouted from offline printer "${job.printerName}"`,
                                job.auditId
                            );
                        }
                        // Update target printer name in job object
                        job.printerName = resolvedPrinter;
                        caps = await getPrinterCapabilities(resolvedPrinter);
                    } else if (!caps) {
                        throw new Error(`Printer driver configuration "${resolvedPrinter}" is missing.`);
                    } else {
                        throw new Error(`Printer "${resolvedPrinter}" is offline and no groups failover is configured.`);
                    }
                }
            } catch (errCaps) {
                console.error("Capability check warning:", errCaps);
            }

            // Simulator Mode check
            const settings = db.prepare('SELECT print_simulator_enabled FROM settings WHERE id = 1').get();
            const isSimulator = settings ? (settings.print_simulator_enabled === 1) : false;

            if (isSimulator) {
                if (job.id) {
                    db.prepare("UPDATE print_jobs SET is_simulated = 1, status = 'Printing' WHERE id = ?").run(job.id);
                }
                if (job.auditId) {
                    db.prepare("UPDATE print_audit_logs SET is_simulated = 1, status = 'Printing' WHERE id = ?").run(job.auditId);
                }
                
                const simulatorDir = path.join(__dirname, '..', '..', 'PrintSimulator');
                if (!fs.existsSync(simulatorDir)) {
                    fs.mkdirSync(simulatorDir, { recursive: true });
                }
                const destFile = path.join(simulatorDir, `job_${job.id || Date.now()}_${path.basename(job.filePath)}`);
                fs.copyFileSync(job.filePath, destFile);
                console.log(`[SIMULATOR] Saved output PDF to ${destFile}`);

                await new Promise(r => setTimeout(r, 500));

                const durationMs = Date.now() - startTime;
                if (job.id) {
                    db.prepare(`UPDATE print_jobs SET status = 'Printed', duration_ms = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`).run(durationMs, job.id);
                }
                if (job.auditId) {
                    db.prepare(`UPDATE print_audit_logs SET status = 'Completed', duration_ms = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`).run(durationMs, job.auditId);
                }
                
                // Update linked order & production status without mutating payment
                if (job.orderId) {
                    try {
                        db.prepare("UPDATE production_jobs SET status = 'Ready', actual_completion = CURRENT_TIMESTAMP WHERE order_id = ? AND status NOT IN ('Completed', 'Delivered', 'Cancelled')").run(job.orderId);
                        db.prepare("UPDATE orders SET status = 'Ready' WHERE id = ? AND status IN ('Confirmed', 'In Production', 'Waiting')").run(job.orderId);
                    } catch (e) {
                        console.error("Failed to update order/production status on print complete:", e);
                    }
                }
                
                eventBus.publish(EventTypes.PRINTER_JOB_COMPLETED, { jobId: job.id, printerName: job.printerName, pages: job.pages, copies: job.copies, orderId: job.orderId }, { sourceModule: 'PrinterService' });
                
                this.queue.shift();
                this.isProcessing = false;
                job.resolve({ success: true, simulated: true });
                this.processNext();
                return;
            }

            if (job.id) {
                db.prepare("UPDATE print_jobs SET status = 'Printing' WHERE id = ?").run(job.id);
            }
            if (job.auditId) {
                db.prepare("UPDATE print_audit_logs SET status = 'Printing' WHERE id = ?").run(job.auditId);
            }

            console.log(`Printing job #${job.id} to printer "${job.printerName}"...`);
            await this.executePrint(job);
            
            const durationMs = Date.now() - startTime;
            if (job.id) {
                db.prepare(`UPDATE print_jobs SET status = 'Printed', duration_ms = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`).run(durationMs, job.id);
            }
            if (job.auditId) {
                db.prepare(`UPDATE print_audit_logs SET status = 'Completed', duration_ms = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`).run(durationMs, job.auditId);
            }
            
            // Update linked order & production status without mutating payment
            if (job.orderId) {
                try {
                    db.prepare("UPDATE production_jobs SET status = 'Ready', actual_completion = CURRENT_TIMESTAMP WHERE order_id = ? AND status NOT IN ('Completed', 'Delivered', 'Cancelled')").run(job.orderId);
                    db.prepare("UPDATE orders SET status = 'Ready' WHERE id = ? AND status IN ('Confirmed', 'In Production', 'Waiting')").run(job.orderId);
                } catch (e) {
                    console.error("Failed to update order/production status on print complete:", e);
                }
            }
            
            eventBus.publish(EventTypes.PRINTER_JOB_COMPLETED, { jobId: job.id, printerName: job.printerName, pages: job.pages, copies: job.copies, orderId: job.orderId }, { sourceModule: 'PrinterService' });
            
            this.queue.shift();
            this.isProcessing = false;
            job.resolve({ success: true });
            
            this.processNext();
        } catch (err) {
            console.error(`Print job failed:`, err);
            job.retryCount++;
            
            const isCancelled = err.message && (
                err.message.toLowerCase().includes('cancel') ||
                err.message.toLowerCase().includes('abort')
            );
            
            if (job.id) {
                db.prepare("UPDATE print_jobs SET retry_count = ?, error_message = ? WHERE id = ?").run(job.retryCount, isCancelled ? 'Cancelled by user' : (err.message || String(err)), job.id);
            }
            if (job.auditId) {
                db.prepare("UPDATE print_audit_logs SET error_message = ? WHERE id = ?").run(isCancelled ? 'Cancelled by user' : (err.message || String(err)), job.auditId);
            }

            if (job.retryCount <= 3 && !isCancelled) {
                console.log(`Retrying job #${job.id} (Attempt ${job.retryCount}/3)...`);
                this.isProcessing = false;
                setTimeout(() => this.processNext(), 3000);
            } else {
                const finalErrMsg = isCancelled ? 'Cancelled by user' : (err.message || String(err));
                if (job.id) {
                    db.prepare("UPDATE print_jobs SET status = 'Failed', error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(finalErrMsg, job.id);
                }
                if (job.auditId) {
                    db.prepare("UPDATE print_audit_logs SET status = 'Failed', error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(finalErrMsg, job.auditId);
                }
                
                eventBus.publish(EventTypes.PRINTER_JOB_FAILED, { jobId: job.id, printerName: job.printerName, orderId: job.orderId, error: finalErrMsg }, { sourceModule: 'PrinterService' });
                
                this.queue.shift();
                this.isProcessing = false;
                job.reject(err);
                
                this.processNext();
            }
        }
    }

    executePrint(job) {
        return new Promise((resolve, reject) => {
            let printWindow = new BrowserWindow({
                show: false,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                    webSecurity: false
                }
            });

            const onComplete = (event) => {
                if (event.sender === printWindow.webContents) {
                    cleanup();
                    
                    const printOptions = {
                        silent: job.options.silent !== undefined ? job.options.silent : true,
                        color: job.options.printType === 'color',
                        copies: job.copies || 1,
                        duplexMode: job.options.sides === 'Double' ? 'longEdge' : 'simplex'
                    };
                    
                    if (job.printerName && job.printerName !== 'Default') {
                        printOptions.deviceName = job.printerName;
                    }

                    printWindow.webContents.print(printOptions, (success, failureReason) => {
                        printWindow.close();
                        if (success) {
                            resolve();
                        } else {
                            reject(new Error(failureReason || "Local print spooler error"));
                        }
                    });
                }
            };

            const onFailed = (event, errorMsg) => {
                if (event.sender === printWindow.webContents) {
                    cleanup();
                    printWindow.close();
                    reject(new Error(errorMsg));
                }
            };

            const cleanup = () => {
                ipcMain.removeListener('print-render-complete', onComplete);
                ipcMain.removeListener('print-render-failed', onFailed);
            };

            ipcMain.on('print-render-complete', onComplete);
            ipcMain.on('print-render-failed', onFailed);

            printWindow.loadFile(path.join(__dirname, 'print-worker.html'));

            printWindow.webContents.on('did-finish-load', () => {
                printWindow.webContents.send('render-pdf', job.filePath, { printType: job.options.printType });
            });
        });
    }
}

const queueManager = new PrintQueueManager();

function printFile(payload, printerName, options) {
    return new Promise(async (resolve, reject) => {
        try {
            const pdfBytes = await createUnifiedPdf(payload, printerName ? { ...options, printerName } : options);
            
            const tempPdfPath = path.join(os.tmpdir(), `unified_print_${Date.now()}.pdf`);
            fs.writeFileSync(tempPdfPath, pdfBytes);
            
            const srcPdf = await PDFDocument.load(pdfBytes);
            const pageCount = srcPdf.getPageCount();

            const silent = options.silent !== undefined ? options.silent : !options.useSystemDialog;

            const res = await queueManager.enqueue(
                options.orderId || null,
                printerName,
                tempPdfPath,
                pageCount,
                options.copies || 1,
                { ...options, silent }
            );

            try { fs.unlinkSync(tempPdfPath); } catch(e){}
            resolve(res);
        } catch (error) {
            try {
                if (options.printJobId) {
                    db.prepare(`
                        UPDATE print_jobs 
                        SET status = 'Failed', error_message = ?, finished_at = CURRENT_TIMESTAMP 
                        WHERE id = ?
                    `).run(error.message || String(error), options.printJobId);
                } else {
                    const customerId = options.customerId || options.customer_id || null;
                    const paperSize = options.paperSize || options.paper_size || null;
                    const colorMode = options.printType || options.color_mode || null;
                    const duplex = options.sides || options.duplex || null;

                    const stmt = db.prepare(`
                        INSERT INTO print_jobs (order_id, customer_id, printer_name, file_path, pages, copies, paper_size, color_mode, duplex, status, error_message, started_at, finished_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Failed', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    `);
                    stmt.run(options.orderId || null, customerId, printerName || 'Default', 'Generation Phase', 0, options.copies || 1, paperSize, colorMode, duplex, error.message || String(error));
                }
            } catch(dbErr) {
                console.error("Failed to write print job error log:", dbErr);
            }
            reject(error);
        }
    });
}

async function printTestPage(printerName) {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]); // A4 Size

    // Borders
    page.drawRectangle({
        x: 20,
        y: 20,
        width: 555,
        height: 802,
        borderColor: rgb(0.1, 0.1, 0.1),
        borderWidth: 2
    });

    // Cross lines
    page.drawLine({ start: { x: 20, y: 421 }, end: { x: 40, y: 421 }, color: rgb(0.1, 0.1, 0.1), thickness: 1 });
    page.drawLine({ start: { x: 555, y: 421 }, end: { x: 575, y: 421 }, color: rgb(0.1, 0.1, 0.1), thickness: 1 });
    page.drawLine({ start: { x: 297, y: 20 }, end: { x: 297, y: 40 }, color: rgb(0.1, 0.1, 0.1), thickness: 1 });
    page.drawLine({ start: { x: 297, y: 802 }, end: { x: 297, y: 822 }, color: rgb(0.1, 0.1, 0.1), thickness: 1 });

    // Colored blocks
    page.drawRectangle({ x: 50, y: 700, width: 80, height: 40, color: rgb(0.9, 0.1, 0.1) });
    page.drawRectangle({ x: 140, y: 700, width: 80, height: 40, color: rgb(0.1, 0.8, 0.1) });
    page.drawRectangle({ x: 230, y: 700, width: 80, height: 40, color: rgb(0.1, 0.1, 0.9) });
    page.drawRectangle({ x: 320, y: 700, width: 80, height: 40, color: rgb(0.9, 0.9, 0.1) });
    page.drawRectangle({ x: 410, y: 700, width: 80, height: 40, color: rgb(0.1, 0.9, 0.9) });

    // Grayscale
    for (let g = 0; g < 5; g++) {
        const tone = 0.2 * g;
        page.drawRectangle({ x: 50 + g * 90, y: 630, width: 80, height: 40, color: rgb(tone, tone, tone) });
    }

    const font = await pdfDoc.embedFont('Helvetica-Bold');
    page.drawText('PrintShop Manager - Alignment Test Page', {
        x: 50,
        y: 530,
        size: 18,
        font: font,
        color: rgb(0.1, 0.1, 0.1)
    });

    const regularFont = await pdfDoc.embedFont('Helvetica');
    const timestampStr = new Date().toLocaleString();
    page.drawText(`Printer Assigned: ${printerName || 'System Default'}`, { x: 50, y: 490, size: 12, font: regularFont });
    page.drawText(`Printed On: ${timestampStr}`, { x: 50, y: 470, size: 12, font: regularFont });
    page.drawText('Print Quality: Alignment Pattern 100% Scale', { x: 50, y: 450, size: 12, font: regularFont });

    // Mock QR Code block
    page.drawRectangle({
        x: 350,
        y: 350,
        width: 120,
        height: 120,
        borderColor: rgb(0, 0, 0),
        borderWidth: 2
    });
    page.drawText('SCAN QR TO CHECK', { x: 358, y: 415, size: 8, font: font });
    page.drawText('CALIBRATION SETS', { x: 358, y: 395, size: 8, font: font });

    const pdfBytes = await pdfDoc.save();

    const tempPdfPath = path.join(os.tmpdir(), `test_print_${Date.now()}.pdf`);
    fs.writeFileSync(tempPdfPath, pdfBytes);

    await queueManager.enqueue(null, printerName, tempPdfPath, 1, 1, { silent: true });

    try { fs.unlinkSync(tempPdfPath); } catch(e){}
    return { success: true };
}

module.exports = { printFile, createUnifiedPdf, printTestPage };
