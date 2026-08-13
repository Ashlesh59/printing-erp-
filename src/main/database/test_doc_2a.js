/**
 * Automated test suite for Phase 2A - Document Production Engine
 * PrintShop Manager
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { initDatabase } = require('./schema');
const DocEngine = require('../document-engine');
const db = require('./db');

async function createDummyPdf(filePath, pagesCount = 1) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pagesCount; i++) {
        const page = doc.addPage([595.28, 841.89]); // A4
        page.drawText(`Page ${i + 1}`, { x: 50, y: 800, size: 24 });
    }
    const bytes = await doc.save();
    fs.writeFileSync(filePath, Buffer.from(bytes));
}

async function runTests() {
    console.log('================================================');
    console.log('STARTING PHASE 2A DOCUMENT ENGINE TEST SUITE');
    console.log('================================================');

    const tempDir = path.join(__dirname, '..', '..', '..', 'PrintSimulator', 'temp_tests');
    fs.mkdirSync(tempDir, { recursive: true });

    const pdfA = path.join(tempDir, 'pdf_a.pdf');
    const pdfB = path.join(tempDir, 'pdf_b.pdf');
    const pdfC = path.join(tempDir, 'pdf_c.pdf');

    // Setup dummy PDFs
    await createDummyPdf(pdfA, 2); // 2 pages
    await createDummyPdf(pdfB, 3); // 3 pages
    await createDummyPdf(pdfC, 1); // 1 page

    let passed = 0;
    let failed = 0;

    function assert(cond, msg) {
        if (cond) {
            console.log(`[PASS] ${msg}`);
            passed++;
        } else {
            console.error(`[FAIL] ${msg}`);
            failed++;
        }
    }

    try {
        // Test 1: Migration Verification
        console.log('\n--- 1. Schema & Migration Verification ---');
        initDatabase();
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
        assert(tables.includes('doc_projects'), 'doc_projects table exists');
        assert(tables.includes('doc_project_files'), 'doc_project_files table exists');
        assert(tables.includes('doc_file_edits'), 'doc_file_edits table exists');
        assert(tables.includes('doc_presets'), 'doc_presets table exists');
        assert(tables.includes('doc_session_state'), 'doc_session_state table exists');
        assert(tables.includes('doc_plugins'), 'doc_plugins table exists');

        const columns = db.prepare("PRAGMA table_info(settings)").all().map(c => c.name);
        assert(columns.includes('doc_studio_output_dir'), 'doc_studio_output_dir setting exists');
        assert(columns.includes('doc_autosave_enabled'), 'doc_autosave_enabled setting exists');
        assert(columns.includes('doc_autosave_interval_sec'), 'doc_autosave_interval_sec setting exists');

        // Test 2: PDF Merge
        console.log('\n--- 2. PDF Merge Verification ---');
        const startMerge = Date.now();
        const mergeRes = await DocEngine.mergePdfs([pdfA, pdfB]);
        const mergeTime = Date.now() - startMerge;
        assert(mergeRes.success === true, 'Merge operation reported success');
        const mergedPdf = await PDFDocument.load(mergeRes.data);
        assert(mergedPdf.getPageCount() === 5, `Merged PDF page count is 5 (actual: ${mergedPdf.getPageCount()})`);
        assert(mergeTime < 3000, `Merge completed in under 3s (actual: ${mergeTime}ms)`);

        const mergedPath = path.join(tempDir, 'merged.pdf');
        fs.writeFileSync(mergedPath, mergeRes.data);

        // Test 3: PDF Split
        console.log('\n--- 3. PDF Split Verification ---');
        const splitRes = await DocEngine.splitPdf(mergedPath, [2]); // Split at index 2 (between page 2 and page 3)
        assert(splitRes.success === true, 'Split operation reported success');
        assert(splitRes.data.length === 2, `Split returned exactly 2 documents (actual: ${splitRes.data.length})`);
        const part1 = await PDFDocument.load(splitRes.data[0]);
        const part2 = await PDFDocument.load(splitRes.data[1]);
        assert(part1.getPageCount() === 2, `Part 1 page count is 2 (actual: ${part1.getPageCount()})`);
        assert(part2.getPageCount() === 3, `Part 2 page count is 3 (actual: ${part2.getPageCount()})`);

        // Test 4: PDF Rotation
        console.log('\n--- 4. Page Rotation Verification ---');
        const rotateRes = await DocEngine.rotatePdfPages(pdfA, [0], 90);
        assert(rotateRes.success === true, 'Rotate operation reported success');
        const rotatedPdf = await PDFDocument.load(rotateRes.data);
        assert(rotatedPdf.getPages()[0].getRotation().angle === 90, `Page 0 rotation is 90 deg (actual: ${rotatedPdf.getPages()[0].getRotation().angle})`);
        assert(rotatedPdf.getPages()[1].getRotation().angle === 0, `Page 1 rotation is 0 deg (actual: ${rotatedPdf.getPages()[1].getRotation().angle})`);

        // Test 5: Page Deletion
        console.log('\n--- 5. Page Deletion Verification ---');
        const deleteRes = await DocEngine.deletePages(pdfB, [1]); // delete index 1
        assert(deleteRes.success === true, 'Delete operation reported success');
        const deletedPdf = await PDFDocument.load(deleteRes.data);
        assert(deletedPdf.getPageCount() === 2, `Deleted PDF page count is 2 (actual: ${deletedPdf.getPageCount()})`);

        // Test 6: Page Reordering
        console.log('\n--- 6. Page Reordering Verification ---');
        const reorderRes = await DocEngine.reorderPages(pdfB, [2, 0, 1]);
        assert(reorderRes.success === true, 'Reorder operation reported success');
        const reorderedPdf = await PDFDocument.load(reorderRes.data);
        assert(reorderedPdf.getPageCount() === 3, 'Reordered PDF page count is 3');

        // Test 7: Page Duplication
        console.log('\n--- 7. Page Duplication Verification ---');
        const dupeRes = await DocEngine.duplicatePages(pdfC, [0]);
        assert(dupeRes.success === true, 'Duplicate operation reported success');
        const dupedPdf = await PDFDocument.load(dupeRes.data);
        assert(dupedPdf.getPageCount() === 2, `Duplicated PDF page count is 2 (actual: ${dupedPdf.getPageCount()})`);

        // Test 8: Page Extraction
        console.log('\n--- 8. Page Extraction Verification ---');
        const extractRes = await DocEngine.extractPages(pdfB, [0, 2]);
        assert(extractRes.success === true, 'Extract operation reported success');
        const extractedPdf = await PDFDocument.load(extractRes.data);
        assert(extractedPdf.getPageCount() === 2, `Extracted PDF page count is 2 (actual: ${extractedPdf.getPageCount()})`);

        // Test 9: Insert Blank Pages
        console.log('\n--- 9. Insert Blank Pages Verification ---');
        const insertRes = await DocEngine.insertBlankPages(pdfC, [0], 'A4');
        assert(insertRes.success === true, 'Insert blank operation reported success');
        const insertedPdf = await PDFDocument.load(insertRes.data);
        assert(insertedPdf.getPageCount() === 2, `Inserted PDF page count is 2 (actual: ${insertedPdf.getPageCount()})`);

        // Test 10: Page Numbers Annotation
        console.log('\n--- 10. Page Numbers Verification ---');
        const pnRes = await DocEngine.addPageNumbers(pdfB, { prefix: 'Doc-', startNumber: 10 });
        assert(pnRes.success === true, 'Add page numbers reported success');
        assert(pnRes.data instanceof Buffer, 'Returned page numbers data is a Buffer');

        // Test 11: Watermark Annotation
        console.log('\n--- 11. Watermark Verification ---');
        const wmRes = await DocEngine.addWatermark(pdfC, 'CONFIDENTIAL');
        assert(wmRes.success === true, 'Add watermark reported success');
        assert(wmRes.data instanceof Buffer, 'Returned watermark data is a Buffer');

        // Test 12: Stamp Annotation
        console.log('\n--- 12. Stamp Verification ---');
        const stampRes = await DocEngine.addStamp(pdfC, 'DRAFT', [0]);
        assert(stampRes.success === true, 'Add stamp reported success');
        assert(stampRes.data instanceof Buffer, 'Returned stamp data is a Buffer');

        // Test 13: Scale Pages
        console.log('\n--- 13. Scale Pages Verification ---');
        const scaleRes = await DocEngine.scalePages(pdfC, 0.5, 0.5);
        assert(scaleRes.success === true, 'Scale pages reported success');
        const scaledPdf = await PDFDocument.load(scaleRes.data);
        const { width, height } = scaledPdf.getPages()[0].getSize();
        assert(Math.round(width) === Math.round(595.28 * 0.5), `Scaled page width matches (actual: ${width})`);

        // Test 14: Fit To Area
        console.log('\n--- 14. Fit To Area Verification ---');
        const fitRes = await DocEngine.fitToArea(pdfC, 100, 200);
        assert(fitRes.success === true, 'Fit to area reported success');

        // Test 15: Crop Pages
        console.log('\n--- 15. Crop Pages Verification ---');
        const cropRes = await DocEngine.cropPages(pdfC, { x: 10, y: 10, width: 200, height: 200 });
        assert(cropRes.success === true, 'Crop pages reported success');

        // Test 16: Auto Orientation Detection
        console.log('\n--- 16. Auto Rotate/Orientation Detection Verification ---');
        const detectRes = await DocEngine.autoRotateDetect(pdfA);
        assert(detectRes.success === true, 'Auto rotate orientation detection reported success');
        assert(detectRes.data[0].orientation === 'portrait', 'Page orientation identified as portrait');

        // Test 17: Project Database Round-trip
        console.log('\n--- 17. SQLite Project Round-trip ---');
        const proj = DocEngine.createProject({ name: 'Test Studio Project' });
        assert(proj.id > 0, `Project created with ID: ${proj.id}`);
        const stateMock = { files: [{ path: 'x.pdf', name: 'x' }], selection: [] };
        const saveRes = DocEngine.saveProject(proj.id, stateMock);
        assert(saveRes.success === true, 'Project state saved');
        const loadedState = DocEngine.getSessionState(proj.id);
        assert(loadedState.state.files[0].name === 'x', 'Session state successfully read back');

        // Test 18: Presets Database Round-trip
        console.log('\n--- 18. SQLite Presets Round-trip ---');
        const preset = DocEngine.savePreset({ name: 'A4 Portrait Fit', preset_type: 'layout', config_json: { fit: 'contain' } });
        assert(preset.id > 0, `Preset saved with ID: ${preset.id}`);
        const loadedPresets = DocEngine.getPresets('layout');
        assert(loadedPresets.length > 0 && loadedPresets[0].name === 'A4 Portrait Fit', 'Preset loaded back successfully');

    } catch (err) {
        console.error('Unhandled error in test runner:', err);
        failed++;
    } finally {
        // Cleanup temp files
        try {
            fs.readdirSync(tempDir).forEach(f => fs.unlinkSync(path.join(tempDir, f)));
            fs.rmdirSync(tempDir);
        } catch(e) {}

        console.log('\n================================================');
        console.log(`TEST SUITE COMPLETE: Passed: ${passed}, Failed: ${failed}`);
        console.log('================================================');
        process.exit(failed > 0 ? 1 : 0);
    }
}

runTests();
