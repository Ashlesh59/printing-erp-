/**
 * Document Production Engine - Phase 2A
 * PrintShop Manager - Backend PDF operations via pdf-lib
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { PDFDocument, degrees, rgb, StandardFonts } = require('pdf-lib');
const db = require('./database/db');

const TOOL_REGISTRY = new Map();
function registerTool(id, handler) { TOOL_REGISTRY.set(id, handler); }

const PLUGIN_REGISTRY = new Map();
function registerPlugin(plugin) {
    if (!plugin || !plugin.id || typeof plugin.execute !== 'function') {
        throw new Error('Invalid plugin: must have id, name, version, execute(filePath, params)');
    }
    PLUGIN_REGISTRY.set(plugin.id, plugin);
    console.log('[DocEngine] Plugin registered: ' + plugin.name + ' v' + plugin.version);
}

function wrap(fn) {
    return async (...args) => {
        try {
            const data = await fn(...args);
            return { success: true, data };
        } catch (err) {
            console.error('[DocEngine] Error:', err.message);
            return { success: false, error: err.message };
        }
    };
}

async function loadPdfSafe(filePath) {
    if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);
    const bytes = fs.readFileSync(filePath);
    if (bytes.length === 0) throw new Error('File is empty: ' + filePath);
    return PDFDocument.load(bytes, { ignoreEncryption: true });
}

function getPaperDimensions(paperSize, orientation) {
    const sizes = {
        'A4': [595.28, 841.89], 'A3': [841.89, 1190.55],
        'A5': [419.53, 595.28], 'Letter': [612, 792],
        'Legal': [612, 1008], 'A6': [297.64, 419.53]
    };
    const [w, h] = sizes[paperSize] || sizes['A4'];
    return (orientation === 'landscape') ? [h, w] : [w, h];
}

async function rotatePdfPages(filePath, pageIndices, rotDegrees) {
    const pdfDoc = await loadPdfSafe(filePath);
    const pages = pdfDoc.getPages();
    const targets = (pageIndices && pageIndices.length > 0) ? pageIndices : pages.map((_, i) => i);
    for (const idx of targets) {
        if (idx >= 0 && idx < pages.length) {
            const cur = pages[idx].getRotation().angle;
            pages[idx].setRotation(degrees((cur + rotDegrees) % 360));
        }
    }
    return Buffer.from(await pdfDoc.save());
}
registerTool('rotate-pages', rotatePdfPages);

async function deletePages(filePath, pageIndices) {
    if (!pageIndices || pageIndices.length === 0) throw new Error('No pages specified');
    const srcDoc = await loadPdfSafe(filePath);
    const total = srcDoc.getPageCount();
    const keep = Array.from({length: total}, (_, i) => i).filter(i => !pageIndices.includes(i));
    if (keep.length === 0) throw new Error('Cannot delete all pages');
    const newDoc = await PDFDocument.create();
    const copied = await newDoc.copyPages(srcDoc, keep);
    copied.forEach(p => newDoc.addPage(p));
    return Buffer.from(await newDoc.save());
}
registerTool('delete-pages', deletePages);

async function reorderPages(filePath, newOrder) {
    const srcDoc = await loadPdfSafe(filePath);
    const newDoc = await PDFDocument.create();
    const copied = await newDoc.copyPages(srcDoc, newOrder);
    copied.forEach(p => newDoc.addPage(p));
    return Buffer.from(await newDoc.save());
}
registerTool('reorder-pages', reorderPages);

async function duplicatePages(filePath, pageIndices) {
    if (!pageIndices || pageIndices.length === 0) throw new Error('No pages specified');
    const srcDoc = await loadPdfSafe(filePath);
    const total = srcDoc.getPageCount();
    const all = Array.from({length: total}, (_, i) => i);
    const dupes = pageIndices.filter(i => i >= 0 && i < total);
    const combined = [...all, ...dupes];
    const newDoc = await PDFDocument.create();
    const copied = await newDoc.copyPages(srcDoc, combined);
    copied.forEach(p => newDoc.addPage(p));
    return Buffer.from(await newDoc.save());
}
registerTool('duplicate-pages', duplicatePages);

async function extractPages(filePath, pageIndices) {
    if (!pageIndices || pageIndices.length === 0) throw new Error('No pages specified');
    const srcDoc = await loadPdfSafe(filePath);
    const total = srcDoc.getPageCount();
    const valid = pageIndices.filter(i => i >= 0 && i < total);
    if (valid.length === 0) throw new Error('No valid page indices');
    const newDoc = await PDFDocument.create();
    const copied = await newDoc.copyPages(srcDoc, valid);
    copied.forEach(p => newDoc.addPage(p));
    return Buffer.from(await newDoc.save());
}
registerTool('extract-pages', extractPages);

async function splitPdf(filePath, splitPoints) {
    if (!splitPoints || splitPoints.length === 0) throw new Error('No split points specified');
    const srcDoc = await loadPdfSafe(filePath);
    const total = srcDoc.getPageCount();
    const sorted = [...new Set([0, ...splitPoints, total])].sort((a, b) => a - b);
    const results = [];
    for (let i = 0; i < sorted.length - 1; i++) {
        const from = sorted[i], to = sorted[i + 1];
        if (from >= to) continue;
        const seg = Array.from({length: to - from}, (_, k) => from + k);
        const newDoc = await PDFDocument.create();
        const copied = await newDoc.copyPages(srcDoc, seg);
        copied.forEach(p => newDoc.addPage(p));
        results.push(Buffer.from(await newDoc.save()));
    }
    return results;
}
registerTool('split-pdf', splitPdf);

async function mergePdfs(filePaths) {
    if (!filePaths || filePaths.length === 0) throw new Error('No files provided');
    const mergedDoc = await PDFDocument.create();
    for (const fp of filePaths) {
        const srcDoc = await loadPdfSafe(fp);
        const copied = await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices());
        copied.forEach(p => mergedDoc.addPage(p));
    }
    return Buffer.from(await mergedDoc.save());
}
registerTool('merge-pdfs', mergePdfs);

async function insertBlankPages(filePath, positions, paperSize) {
    if (!positions || positions.length === 0) throw new Error('No positions specified');
    const srcDoc = await loadPdfSafe(filePath);
    const total = srcDoc.getPageCount();
    const [pw, ph] = getPaperDimensions(paperSize || 'A4');
    const newDoc = await PDFDocument.create();
    const posSet = new Set([...positions]);
    for (let srcIdx = 0; srcIdx <= total; srcIdx++) {
        if (posSet.has(srcIdx)) { newDoc.addPage([pw, ph]); }
        if (srcIdx < total) {
            const [pg] = await newDoc.copyPages(srcDoc, [srcIdx]);
            newDoc.addPage(pg);
        }
    }
    return Buffer.from(await newDoc.save());
}
registerTool('insert-blank', insertBlankPages);

async function addPageNumbers(filePath, options) {
    const opts = options || {};
    const position = opts.position || 'bottom-center';
    const size = opts.size || 10;
    const startNumber = opts.startNumber || 1;
    const prefix = opts.prefix || '';
    const cR = opts.colorR !== undefined ? opts.colorR : 0.3;
    const cG = opts.colorG !== undefined ? opts.colorG : 0.3;
    const cB = opts.colorB !== undefined ? opts.colorB : 0.3;
    const pdfDoc = await loadPdfSafe(filePath);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    pages.forEach((page, i) => {
        const { width, height } = page.getSize();
        const text = prefix + (startNumber + i);
        const tw = font.widthOfTextAtSize(text, size);
        let x, y;
        if (position === 'bottom-center') { x = (width - tw) / 2; y = 20; }
        else if (position === 'bottom-right') { x = width - tw - 20; y = 20; }
        else if (position === 'top-center') { x = (width - tw) / 2; y = height - 30; }
        else if (position === 'bottom-left') { x = 20; y = 20; }
        else { x = (width - tw) / 2; y = 20; }
        page.drawText(text, { x, y, size, font, color: rgb(cR, cG, cB) });
    });
    return Buffer.from(await pdfDoc.save());
}
registerTool('add-page-numbers', addPageNumbers);

async function addWatermark(filePath, text, options) {
    const opts = options || {};
    const opacity = opts.opacity !== undefined ? opts.opacity : 0.15;
    const angle = opts.angle !== undefined ? opts.angle : 45;
    const size = opts.size || 60;
    const cR = opts.colorR !== undefined ? opts.colorR : 0.5;
    const cG = opts.colorG !== undefined ? opts.colorG : 0.5;
    const cB = opts.colorB !== undefined ? opts.colorB : 0.5;
    const pdfDoc = await loadPdfSafe(filePath);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();
    pages.forEach(page => {
        const { width, height } = page.getSize();
        const tw = font.widthOfTextAtSize(text, size);
        page.drawText(text, {
            x: (width - tw) / 2, y: height / 2 - size / 2,
            size, font, color: rgb(cR, cG, cB), opacity, rotate: degrees(angle)
        });
    });
    return Buffer.from(await pdfDoc.save());
}
registerTool('add-watermark', addWatermark);

async function addStamp(filePath, text, pageIndices, options) {
    const opts = options || {};
    const corner = opts.corner || 'top-right';
    const size = opts.size || 14;
    const cR = opts.colorR !== undefined ? opts.colorR : 0.8;
    const cG = opts.colorG !== undefined ? opts.colorG : 0.1;
    const cB = opts.colorB !== undefined ? opts.colorB : 0.1;
    const pdfDoc = await loadPdfSafe(filePath);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();
    const targets = (pageIndices && pageIndices.length > 0) ? pageIndices : pages.map((_, i) => i);
    targets.forEach(idx => {
        if (idx < 0 || idx >= pages.length) return;
        const page = pages[idx];
        const { width, height } = page.getSize();
        const tw = font.widthOfTextAtSize(text, size);
        const m = 16;
        let x, y;
        if (corner === 'top-right') { x = width - tw - m; y = height - size - m; }
        else if (corner === 'top-left') { x = m; y = height - size - m; }
        else if (corner === 'bottom-right') { x = width - tw - m; y = m; }
        else { x = m; y = m; }
        page.drawText(text, { x, y, size, font, color: rgb(cR, cG, cB) });
    });
    return Buffer.from(await pdfDoc.save());
}
registerTool('add-stamp', addStamp);

async function scalePages(filePath, scaleX, scaleY) {
    if (!scaleX || scaleX <= 0) throw new Error('Invalid scaleX');
    const sy = (scaleY && scaleY > 0) ? scaleY : scaleX;
    const pdfDoc = await loadPdfSafe(filePath);
    const pages = pdfDoc.getPages();
    pages.forEach(page => {
        const { width, height } = page.getSize();
        page.setMediaBox(0, 0, width * scaleX, height * sy);
        page.scaleContent(scaleX, sy);
    });
    return Buffer.from(await pdfDoc.save());
}
registerTool('scale-pages', scalePages);

async function fitToArea(filePath, targetWidth, targetHeight, mode) {
    const pdfDoc = await loadPdfSafe(filePath);
    const pages = pdfDoc.getPages();
    pages.forEach(page => {
        const { width, height } = page.getSize();
        let sx, sy;
        if (mode === 'fill') { sx = targetWidth / width; sy = targetHeight / height; }
        else { const s = Math.min(targetWidth / width, targetHeight / height); sx = s; sy = s; }
        page.setMediaBox(0, 0, width * sx, height * sy);
        page.scaleContent(sx, sy);
    });
    return Buffer.from(await pdfDoc.save());
}
registerTool('fit-to-area', fitToArea);

async function cropPages(filePath, cropBox, pageIndices) {
    if (!cropBox || !cropBox.width || !cropBox.height) throw new Error('Invalid crop box');
    const pdfDoc = await loadPdfSafe(filePath);
    const pages = pdfDoc.getPages();
    const targets = (pageIndices && pageIndices.length > 0) ? pageIndices : pages.map((_, i) => i);
    targets.forEach(idx => {
        if (idx < 0 || idx >= pages.length) return;
        pages[idx].setCropBox(cropBox.x || 0, cropBox.y || 0, cropBox.width, cropBox.height);
    });
    return Buffer.from(await pdfDoc.save());
}
registerTool('crop-pages', cropPages);

async function autoRotateDetect(filePath) {
    const pdfDoc = await loadPdfSafe(filePath);
    const pages = pdfDoc.getPages();
    return pages.map((page, i) => {
        const { width, height } = page.getSize();
        const rotation = page.getRotation().angle;
        const ew = (rotation === 90 || rotation === 270) ? height : width;
        const eh = (rotation === 90 || rotation === 270) ? width : height;
        return { pageIndex: i, width: ew, height: eh, orientation: ew > eh ? 'landscape' : 'portrait', rotation };
    });
}
registerTool('auto-rotate-detect', autoRotateDetect);

async function processWithPlugin(filePath, pluginId, params) {
    const plugin = PLUGIN_REGISTRY.get(pluginId);
    if (!plugin) throw new Error('Plugin not registered: ' + pluginId);
    return await plugin.execute(filePath, params || {});
}

async function batchProcess(filePaths, operation, params) {
    const tool = TOOL_REGISTRY.get(operation);
    if (!tool) throw new Error('Unknown operation: ' + operation);
    const results = [];
    for (const fp of filePaths) {
        try {
            const pArr = Array.isArray(params) ? params : [params];
            const data = await tool(fp, ...pArr);
            results.push({ filePath: fp, success: true, data });
        } catch (err) {
            results.push({ filePath: fp, success: false, error: err.message });
        }
    }
    return results;
}

async function saveOutput(pdfBytes, name, outputDir) {
    let app;
    try { app = require('electron').app; } catch(e) {}
    const os = require('os');
    const defaultBase = (app && typeof app.getPath === 'function') ? path.join(app.getPath('documents'), 'PrintShopManager') : path.join(os.homedir(), 'Documents', 'PrintShopManager');
    const dir = outputDir || path.join(defaultBase, 'DocumentStudio');
    fs.mkdirSync(dir, { recursive: true });
    const safeName = (name || 'output').replace(/[^a-zA-Z0-9_\-. ]/g, '_');
    const filename = safeName.endsWith('.pdf') ? safeName : safeName + '.pdf';
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, Buffer.from(pdfBytes));
    return { filePath };
}

async function saveToOrderIncoming(pdfBytes, name) {
    const incomingPath = path.join(os.homedir(), 'Documents', 'PrintShop', 'IncomingFiles');
    fs.mkdirSync(incomingPath, { recursive: true });
    const safeName = ('DocStudio_' + Date.now() + '_' + (name || 'output')).replace(/[^a-zA-Z0-9_\-. ]/g, '_');
    const filename = safeName.endsWith('.pdf') ? safeName : safeName + '.pdf';
    const filePath = path.join(incomingPath, filename);
    fs.writeFileSync(filePath, Buffer.from(pdfBytes));
    return { filePath, name: filename };
}

const GET_PROJECTS_SQL = "SELECT * FROM doc_projects WHERE status != 'Deleted' ORDER BY updated_at DESC";
const INS_PROJECT_SQL  = "INSERT INTO doc_projects (name, status) VALUES (?, 'Active')";
const UPD_PROJECT_SQL  = "UPDATE doc_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?";
const DEL_PROJECT_SQL  = "UPDATE doc_projects SET status = 'Deleted' WHERE id = ?";
const INS_SESSION_SQL  = "INSERT OR REPLACE INTO doc_session_state (project_id, state_json, saved_at) VALUES (?, ?, CURRENT_TIMESTAMP)";
const GET_SESSION_SQL  = "SELECT * FROM doc_session_state WHERE project_id = ?";
const DEL_SESSION_SQL  = "DELETE FROM doc_session_state WHERE project_id = ?";
const GET_PRESETS_SQL  = "SELECT * FROM doc_presets WHERE preset_type = ? ORDER BY created_at DESC";
const GET_ALL_PRESETS  = "SELECT * FROM doc_presets ORDER BY preset_type, created_at DESC";
const INS_PRESET_SQL   = "INSERT INTO doc_presets (name, preset_type, config_json) VALUES (?, ?, ?)";
const DEL_PRESET_SQL   = "DELETE FROM doc_presets WHERE id = ?";

function getProjects() { return db.prepare(GET_PROJECTS_SQL).all(); }
function createProject(data) {
    const r = db.prepare(INS_PROJECT_SQL).run(data.name || 'Untitled Project');
    return { id: r.lastInsertRowid };
}
function saveProject(projectId, stateJson) {
    db.prepare(UPD_PROJECT_SQL).run(projectId);
    const s = typeof stateJson === 'string' ? stateJson : JSON.stringify(stateJson);
    db.prepare(INS_SESSION_SQL).run(projectId, s);
    return { success: true };
}
function deleteProject(projectId) {
    db.prepare(DEL_PROJECT_SQL).run(projectId);
    return { success: true };
}

function getPresets(type) {
    if (type) return db.prepare(GET_PRESETS_SQL).all(type);
    return db.prepare(GET_ALL_PRESETS).all();
}
function savePreset(data) {
    const c = typeof data.config_json === 'string' ? data.config_json : JSON.stringify(data.config_json);
    const r = db.prepare(INS_PRESET_SQL).run(data.name, data.preset_type, c);
    return { id: r.lastInsertRowid };
}
function deletePreset(id) {
    db.prepare(DEL_PRESET_SQL).run(id);
    return { success: true };
}

function saveSessionState(projectId, stateJson) {
    const s = typeof stateJson === 'string' ? stateJson : JSON.stringify(stateJson);
    db.prepare(INS_SESSION_SQL).run(projectId, s);
    return { success: true };
}
function getSessionState(projectId) {
    const row = db.prepare(GET_SESSION_SQL).get(projectId);
    if (!row) return null;
    try { return { ...row, state: JSON.parse(row.state_json) }; } catch(e) { return row; }
}
function clearSessionState(projectId) {
    db.prepare(DEL_SESSION_SQL).run(projectId);
    return { success: true };
}

async function drawPageToSheetSingle(pdfDoc, tempDoc, pageIdx, pageWidth, pageHeight, scalingMode = 'fit') {
    const tempPage = tempDoc.getPages()[pageIdx];
    const rotAngle = tempPage.getRotation().angle;
    const isRotated90or270 = rotAngle === 90 || rotAngle === 270;
    
    const { width: srcW, height: srcH } = tempPage.getSize();
    const visualW = isRotated90or270 ? srcH : srcW;
    const visualH = isRotated90or270 ? srcW : srcH;
    
    const physicalSizeMatches = (Math.abs(srcW - pageWidth) < 2 && Math.abs(srcH - pageHeight) < 2) ||
                                (Math.abs(srcW - pageHeight) < 2 && Math.abs(srcH - pageWidth) < 2);
    
    if (physicalSizeMatches) {
        const [copiedPage] = await pdfDoc.copyPages(tempDoc, [pageIdx]);
        pdfDoc.addPage(copiedPage);
        return;
    }
    
    const sheet = pdfDoc.addPage([pageWidth, pageHeight]);
    const [embeddedPage] = await pdfDoc.embedPages([tempPage]);
    
    let drawW = visualW;
    let drawH = visualH;
    let scale = 1.0;
    
    if (scalingMode === 'fit' || scalingMode === 'contain') {
        const scaleX = pageWidth / visualW;
        const scaleY = pageHeight / visualH;
        scale = Math.min(scaleX, scaleY);
        drawW = visualW * scale;
        drawH = visualH * scale;
    } else if (scalingMode === 'cover') {
        const scaleX = pageWidth / visualW;
        const scaleY = pageHeight / visualH;
        scale = Math.max(scaleX, scaleY);
        drawW = visualW * scale;
        drawH = visualH * scale;
    } else if (scalingMode === 'stretch') {
        drawW = pageWidth;
        drawH = pageHeight;
    }
    
    const x = (pageWidth - drawW) / 2;
    const y = (pageHeight - drawH) / 2;
    
    const rawScaleX = (isRotated90or270 ? drawH : drawW) / srcW;
    const rawScaleY = (isRotated90or270 ? drawW : drawH) / srcH;
    
    if (rotAngle === 90) {
        sheet.drawPage(embeddedPage, {
            x: x + drawW,
            y: y,
            width: drawH,
            height: drawW,
            rotate: degrees(90),
            xScale: rawScaleX,
            yScale: rawScaleY
        });
    } else if (rotAngle === 180) {
        sheet.drawPage(embeddedPage, {
            x: x + drawW,
            y: y + drawH,
            width: drawW,
            height: drawH,
            rotate: degrees(180),
            xScale: rawScaleX,
            yScale: rawScaleY
        });
    } else if (rotAngle === 270) {
        sheet.drawPage(embeddedPage, {
            x: x,
            y: y + drawH,
            width: drawH,
            height: drawW,
            rotate: degrees(270),
            xScale: rawScaleX,
            yScale: rawScaleY
        });
    } else {
        sheet.drawPage(embeddedPage, {
            x,
            y,
            width: drawW,
            height: drawH
        });
    }
}

async function compilePrintReadyPdf(recipe) {
    const pdfDoc = await PDFDocument.create();
    
    const paperSize = (recipe.layout && recipe.layout.paperSize) || 'A4';
    const orientation = (recipe.layout && recipe.layout.orientation) || 'portrait';
    const [pageWidth, pageHeight] = getPaperDimensions(paperSize, orientation);

    // 1. Resolve source documents
    const sourceDocs = [];
    for (const f of recipe.files) {
        if (f.ext === '.pdf') {
            const doc = await loadPdfSafe(f.path);
            sourceDocs.push(doc);
        } else {
            sourceDocs.push(null);
        }
    }

    // 2. Imposition Sorting
    let pageSpecs = [...recipe.pages];
    if (recipe.layout && recipe.layout.imposition === 'booklet' && pageSpecs.length > 0) {
        const padSize = (4 - (pageSpecs.length % 4)) % 4;
        for (let i = 0; i < padSize; i++) {
            pageSpecs.push({ isBlank: true });
        }
        const sorted = [];
        let left = 0;
        let right = pageSpecs.length - 1;
        while (left < right) {
            sorted.push(pageSpecs[right--]);
            sorted.push(pageSpecs[left++]);
            if (left >= right) break;
            sorted.push(pageSpecs[left++]);
            sorted.push(pageSpecs[right--]);
        }
        pageSpecs = sorted;
    }

    // 3. Build intermediate pages
    const tempDoc = await PDFDocument.create();
    
    for (const pSpec of pageSpecs) {
        let newPage;
        
        if (pSpec.isBlank) {
            newPage = tempDoc.addPage([pageWidth, pageHeight]); // Match target dimensions
        } else {
            const fileIdx = pSpec.sourceFileIndex;
            const srcFile = recipe.files[fileIdx];
            
            if (srcFile.ext === '.pdf') {
                const srcDoc = sourceDocs[fileIdx];
                const srcPageIndex = pSpec.sourcePageIndex;
                const [copiedPage] = await tempDoc.copyPages(srcDoc, [srcPageIndex]);
                newPage = tempDoc.addPage(copiedPage);
            } else {
                // It's an image. Read bytes and embed
                const imgBytes = fs.readFileSync(srcFile.path);
                let embeddedImg;
                if (srcFile.ext === '.png') {
                    embeddedImg = await tempDoc.embedPng(imgBytes);
                } else if (['.jpg', '.jpeg'].includes(srcFile.ext.toLowerCase())) {
                    embeddedImg = await tempDoc.embedJpg(imgBytes);
                } else {
                    throw new Error(`Unsupported image format in compiler: ${srcFile.ext}`);
                }

                const { width, height } = embeddedImg.scale(1.0);
                newPage = tempDoc.addPage([width, height]);
                newPage.drawImage(embeddedImg, { x: 0, y: 0, width, height });
            }
        }

        // Apply Rotations (degrees: 90, 180, 270)
        if (pSpec.rotate) {
            const curRot = newPage.getRotation().angle;
            newPage.setRotation(degrees((curRot + pSpec.rotate) % 360));
        }

        // Apply Crops
        if (pSpec.crop) {
            const { x, y, width, height } = pSpec.crop;
            const pageHeight = newPage.getHeight();
            const pdfY = pageHeight - y - height;
            newPage.setCropBox(x, pdfY, x + width, pdfY + height);
        }

        // Apply Scale
        if (pSpec.scale) {
            newPage.scaleContent(pSpec.scale, pSpec.scale);
        }

        // Apply Punch/Binding Margins (Shifts content)
        if (pSpec.bindingMargin || pSpec.punchMargin) {
            const shiftX = pSpec.bindingMargin || 0;
            const shiftY = pSpec.punchMargin || 0;
            newPage.translateContent(shiftX, shiftY);
        }

        // Apply Brightness adjustments via overlay rects
        if (pSpec.brightness) {
            const opacity = Math.abs(pSpec.brightness) / 100;
            const color = pSpec.brightness > 0 ? rgb(1, 1, 1) : rgb(0, 0, 0);
            newPage.drawRectangle({
                x: 0,
                y: 0,
                width: newPage.getWidth(),
                height: newPage.getHeight(),
                color: color,
                opacity: opacity
            });
        }

        // Apply Grayscale / BW overlays
        if (pSpec.grayscale || pSpec.bw) {
            newPage.drawRectangle({
                x: 0,
                y: 0,
                width: newPage.getWidth(),
                height: newPage.getHeight(),
                color: rgb(0.5, 0.5, 0.5),
                opacity: 0.25
            });
        }

        // Draw Annotations (text or stamps)
        if (pSpec.annotations && Array.isArray(pSpec.annotations)) {
            for (const ann of pSpec.annotations) {
                if (ann.type === 'text') {
                    const font = await tempDoc.embedFont(StandardFonts.Helvetica);
                    const color = ann.color ? rgb(ann.color.r || 0, ann.color.g || 0, ann.color.b || 0) : rgb(0,0,0);
                    const { height: pageH } = newPage.getSize();
                    const pdfY = pageH - (ann.y || 50);
                    newPage.drawText(ann.text, {
                        x: ann.x || 50,
                        y: pdfY,
                        size: ann.size || 12,
                        font,
                        color,
                        opacity: ann.opacity !== undefined ? ann.opacity : 1.0
                    });
                } else if (ann.type === 'watermark') {
                    const font = await tempDoc.embedFont(StandardFonts.HelveticaBold);
                    const size = ann.size || 60;
                    const opacity = ann.opacity !== undefined ? ann.opacity : 0.15;
                    const angle = ann.angle !== undefined ? ann.angle : 45;
                    const { width, height } = newPage.getSize();
                    const tw = font.widthOfTextAtSize(ann.text, size);
                    newPage.drawText(ann.text, {
                        x: (width - tw) / 2,
                        y: height / 2 - size / 2,
                        size,
                        font,
                        color: rgb(0.5, 0.5, 0.5),
                        opacity,
                        rotate: degrees(angle)
                    });
                } else if (ann.type === 'stamp') {
                    const font = await tempDoc.embedFont(StandardFonts.HelveticaBold);
                    const size = ann.size || 14;
                    const { width, height } = newPage.getSize();
                    const tw = font.widthOfTextAtSize(ann.text, size);
                    const m = 16;
                    let x, y;
                    if (ann.corner === 'top-right') { x = width - tw - m; y = height - size - m; }
                    else if (ann.corner === 'top-left') { x = m; y = height - size - m; }
                    else if (ann.corner === 'bottom-right') { x = width - tw - m; y = m; }
                    else { x = m; y = m; }
                    newPage.drawText(ann.text, {
                        x, y, size, font, color: rgb(0.8, 0.1, 0.1)
                    });
                } else if (ann.type === 'image') {
                    try {
                        const imgBytes = fs.readFileSync(ann.path);
                        let embeddedImg;
                        if (ann.path.toLowerCase().endsWith('.png')) {
                            embeddedImg = await tempDoc.embedPng(imgBytes);
                        } else {
                            embeddedImg = await tempDoc.embedJpg(imgBytes);
                        }
                        const { height: pageH } = newPage.getSize();
                        const pdfY = pageH - ann.y - (ann.height * ann.scaleY);
                        newPage.drawImage(embeddedImg, {
                            x: ann.x,
                            y: pdfY,
                            width: ann.width * ann.scaleX,
                            height: ann.height * ann.scaleY,
                            rotate: degrees(ann.angle || 0)
                        });
                    } catch (err) {
                        console.error('Failed to embed overlay image in PDF compile:', err);
                    }
                }
            }
        }
    }

    // 4. Apply N-up layout if nUp > 1
    const nUp = (recipe.layout && recipe.layout.nUp) || 1;

    if (nUp > 1) {
        const embeddedPages = await pdfDoc.embedPages(tempDoc.getPages());
        let currentGroup = [];
        
        for (let i = 0; i < embeddedPages.length; i++) {
            currentGroup.push(embeddedPages[i]);
            if (currentGroup.length === nUp) {
                await drawPagesToSheet(pdfDoc, currentGroup, nUp, pageWidth, pageHeight);
                currentGroup = [];
            }
        }
        if (currentGroup.length > 0) {
            await drawPagesToSheet(pdfDoc, currentGroup, nUp, pageWidth, pageHeight);
        }
    } else {
        const scalingMode = (recipe.layout && recipe.layout.scaling) || 'fit';
        if (scalingMode === 'none') {
            const copiedPages = await pdfDoc.copyPages(tempDoc, tempDoc.getPageIndices());
            copiedPages.forEach(p => pdfDoc.addPage(p));
        } else {
            const tempPages = tempDoc.getPages();
            for (let i = 0; i < tempPages.length; i++) {
                await drawPageToSheetSingle(pdfDoc, tempDoc, i, pageWidth, pageHeight, scalingMode);
            }
        }
    }

    // 4. Apply Page Range if configured
    let finalBytes = await pdfDoc.save();
    if (recipe.layout && recipe.layout.pageRange) {
        const parsedRanges = parsePageRanges(recipe.layout.pageRange);
        if (parsedRanges && parsedRanges.length > 0) {
            const slicedDoc = await PDFDocument.create();
            const srcDoc = await PDFDocument.load(finalBytes);
            const totalPages = srcDoc.getPageCount();
            const targetIndices = [];
            for (const range of parsedRanges) {
                const from = Math.max(0, Math.min(range.from, totalPages - 1));
                const to = Math.max(0, Math.min(range.to, totalPages - 1));
                if (from <= to) {
                    for (let p = from; p <= to; p++) targetIndices.push(p);
                } else {
                    for (let p = from; p >= to; p--) targetIndices.push(p);
                }
            }
            if (targetIndices.length > 0) {
                const copiedPages = await slicedDoc.copyPages(srcDoc, targetIndices);
                copiedPages.forEach(p => slicedDoc.addPage(p));
                finalBytes = await slicedDoc.save();
            }
        }
    }

    return Buffer.from(finalBytes);
}

// Draw embedded PDF page templates N-up onto a single sheet
async function drawPagesToSheet(pdfDoc, embeddedPages, nUp, pageWidth, pageHeight) {
    const sheet = pdfDoc.addPage([pageWidth, pageHeight]);
    if (nUp === 2) {
        const h = pageHeight / 2;
        const w = pageWidth;
        for (let i = 0; i < embeddedPages.length; i++) {
            const page = embeddedPages[i];
            const scale = Math.min(w / page.width, h / page.height);
            const drawW = page.width * scale;
            const drawH = page.height * scale;
            const x = (w - drawW) / 2;
            const y = (i === 0) ? h + (h - drawH) / 2 : (h - drawH) / 2;
            sheet.drawPage(page, { x, y, width: drawW, height: drawH });
        }
    } else if (nUp === 4) {
        const w = pageWidth / 2;
        const h = pageHeight / 2;
        const coords = [
            { x: 0, y: h },
            { x: w, y: h },
            { x: 0, y: 0 },
            { x: w, y: 0 }
        ];
        for (let i = 0; i < embeddedPages.length; i++) {
            const page = embeddedPages[i];
            const scale = Math.min(w / page.width, h / page.height);
            const drawW = page.width * scale;
            const drawH = page.height * scale;
            const target = coords[i];
            const x = target.x + (w - drawW) / 2;
            const y = target.y + (h - drawH) / 2;
            sheet.drawPage(page, { x, y, width: drawW, height: drawH });
        }
    }
}

// Page ranges helper (e.g. 1-3, 5)
function parsePageRanges(rangeStr) {
    if (!rangeStr) return null;
    const ranges = [];
    const parts = rangeStr.split(',');
    for (const part of parts) {
        const range = part.trim().split('-');
        if (range.length === 1) {
            const num = parseInt(range[0]) - 1;
            if (!isNaN(num)) ranges.push({ from: num, to: num });
        } else if (range.length === 2) {
            const from = parseInt(range[0]) - 1;
            const to = parseInt(range[1]) - 1;
            if (!isNaN(from) && !isNaN(to)) ranges.push({ from, to });
        }
    }
    return ranges;
}

module.exports = {
    rotatePdfPages: wrap(rotatePdfPages),
    deletePages: wrap(deletePages),
    reorderPages: wrap(reorderPages),
    duplicatePages: wrap(duplicatePages),
    extractPages: wrap(extractPages),
    splitPdf: wrap(splitPdf),
    mergePdfs: wrap(mergePdfs),
    insertBlankPages: wrap(insertBlankPages),
    addPageNumbers: wrap(addPageNumbers),
    addWatermark: wrap(addWatermark),
    addStamp: wrap(addStamp),
    scalePages: wrap(scalePages),
    fitToArea: wrap(fitToArea),
    cropPages: wrap(cropPages),
    autoRotateDetect: wrap(autoRotateDetect),
    compilePrintReadyPdf: wrap(compilePrintReadyPdf),
    registerTool, registerPlugin,
    processWithPlugin: wrap(processWithPlugin),
    batchProcess: wrap(batchProcess),
    TOOL_REGISTRY, PLUGIN_REGISTRY,
    saveOutput: wrap(saveOutput),
    saveToOrderIncoming: wrap(saveToOrderIncoming),
    getProjects, createProject, saveProject, deleteProject,
    getPresets, savePreset, deletePreset,
    saveSessionState, getSessionState, clearSessionState,
    getPaperDimensions, _loadPdfSafe: loadPdfSafe
};
