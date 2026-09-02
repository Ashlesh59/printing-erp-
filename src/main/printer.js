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

const PrintQueueManager = require('./services/printing/print-queue-manager');
const PrintDiagnosticsService = require('./services/printing/print-diagnostics-service');

async function printFile(payload, printerName, options = {}) {
    let targetFilePath = options.filePath || null;
    let isTemp = false;

    try {
        if (!targetFilePath && payload) {
            const pdfBytes = await createUnifiedPdf(payload, printerName ? { ...options, printerName } : options);
            const crypto = require('crypto');
            targetFilePath = path.join(PrintQueueManager.getAppTempDir(), `unified_print_${Date.now()}_${crypto.randomUUID().substring(0, 6)}.pdf`);
            fs.writeFileSync(targetFilePath, pdfBytes);
            isTemp = true;
        }

        if (!targetFilePath || !fs.existsSync(targetFilePath)) {
            throw new Error(`Print file not found: ${targetFilePath}`);
        }

        let pageCount = options.pages || 1;
        try {
            const srcPdf = await PDFDocument.load(fs.readFileSync(targetFilePath));
            pageCount = srcPdf.getPageCount();
        } catch(e) {}

        let job;
        if (options.printJobId) {
            const existing = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(options.printJobId);
            if (!existing) {
                throw new Error(`Print job #${options.printJobId} not found.`);
            }
            if (['Submitted', 'Confirmed Printed', 'Cancelled', 'Preparing', 'Rendering', 'Submitting'].includes(existing.status)) {
                throw new Error(`Cannot re-enqueue print job #${options.printJobId} in state '${existing.status}'. Create a new print job instead.`);
            }
            db.prepare(`
                UPDATE print_jobs 
                SET status = 'Queued', printer_name = ?, file_path = ?, pages = ?, copies = ?, error_message = NULL
                WHERE id = ?
            `).run(printerName || 'Default', targetFilePath, pageCount, options.copies || 1, options.printJobId);
            job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(options.printJobId);
        } else {
            job = PrintQueueManager.enqueue({
                orderId: options.orderId || options.order_id || null,
                customerId: options.customerId || options.customer_id || null,
                printerName: printerName || 'Default',
                printerDeviceName: options.printerDeviceName || printerName || 'Default',
                filePath: targetFilePath,
                copies: options.copies || 1,
                pages: pageCount,
                paperSize: options.paperSize || options.paper_size || 'A4',
                colorMode: options.printType || options.color_mode || 'bw',
                duplex: options.sides || options.duplex || 'Single',
                scalingMode: options.scaling || options.scalingMode || 'fit',
                settingsSnapshot: options,
                isTempFile: isTemp
            });
        }

        // Trigger queue processing worker asynchronously
        PrintQueueManager.processQueue().catch(err => {
            console.error('[PrintQueueManager] Worker execution notice:', err.message);
        });

        return { success: true, jobId: job.id, status: job.status };
    } catch (error) {
        try {
            if (options.printJobId) {
                const existing = db.prepare('SELECT status FROM print_jobs WHERE id = ?').get(options.printJobId);
                if (existing && !['Submitted', 'Confirmed Printed', 'Cancelled'].includes(existing.status)) {
                    db.prepare(`
                        UPDATE print_jobs 
                        SET status = 'Failed', error_message = ?, finished_at = CURRENT_TIMESTAMP 
                        WHERE id = ?
                    `).run(error.message || String(error), options.printJobId);
                }
            } else {
                const customerId = options.customerId || options.customer_id || null;
                const paperSize = options.paperSize || options.paper_size || null;
                const colorMode = options.printType || options.color_mode || null;
                const duplex = options.sides || options.duplex || null;

                const stmt = db.prepare(`
                    INSERT INTO print_jobs (order_id, customer_id, printer_name, file_path, pages, copies, paper_size, color_mode, duplex, status, error_message, started_at, finished_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Failed', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `);
                stmt.run(options.orderId || null, customerId, printerName || 'Default', targetFilePath || 'Generation Phase', 0, options.copies || 1, paperSize, colorMode, duplex, error.message || String(error));
            }
        } catch(dbErr) {
            console.error("Failed to write print job error log:", dbErr);
        }
        throw error;
    }
}

async function printTestPage(printerName) {
    return await PrintDiagnosticsService.runTestPrint(printerName);
}

module.exports = { printFile, createUnifiedPdf, printTestPage };
