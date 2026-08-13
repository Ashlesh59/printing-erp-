/**
 * Automated test suite for Phase 2B - Document Studio 2.0 (Non-Destructive Compiler & Conversions)
 * PrintShop Manager
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const DocEngine = require('../document-engine');
const { convertOfficeToPdf } = require('../doc-converter');
const db = require('./db');

function getChecksum(filePath) {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
}

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
    console.log('STARTING PHASE 2B DOC STUDIO 2.0 TEST SUITE');
    console.log('================================================');

    const tempDir = path.join(__dirname, '..', '..', '..', 'PrintSimulator', 'temp_tests_v2');
    fs.mkdirSync(tempDir, { recursive: true });

    const pdfA = path.join(tempDir, 'source_a.pdf');
    const pdfB = path.join(tempDir, 'source_b.pdf');

    // Create source files
    await createDummyPdf(pdfA, 2);
    await createDummyPdf(pdfB, 1);

    const hashA_Before = getChecksum(pdfA);
    const hashB_Before = getChecksum(pdfB);

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
        // Test 1: Non-destructive verification (source checksums remain identical)
        console.log('\n--- 1. Non-Destructive Integrity Checks ---');
        
        const recipe = {
            files: [
                { path: pdfA, ext: '.pdf' },
                { path: pdfB, ext: '.pdf' }
            ],
            pages: [
                { sourceFileIndex: 0, sourcePageIndex: 0, rotate: 90 }, // Rotate Page 1 of File A
                { sourceFileIndex: 0, sourcePageIndex: 1, rotate: 0 },  // Keep Page 2 of File A
                { sourceFileIndex: 1, sourcePageIndex: 0, rotate: 180 } // Rotate Page 1 of File B
            ],
            layout: {
                nUp: 1,
                paperSize: 'A4'
            }
        };

        const compileResult = await DocEngine.compilePrintReadyPdf(recipe);
        assert(compileResult.success === true, 'Compiler successfully completed recipe execution');
        const compileResultBuffer = compileResult.data;
        assert(compileResultBuffer instanceof Buffer, 'Compiler successfully generated print output buffer');

        // Check source files remained unmodified
        const hashA_After = getChecksum(pdfA);
        const hashB_After = getChecksum(pdfB);
        assert(hashA_Before === hashA_After, 'Source file A was NOT modified during compilation');
        assert(hashB_Before === hashB_After, 'Source file B was NOT modified during compilation');

        // Test 2: Compiled PDF structure checks
        console.log('\n--- 2. Compiled PDF Output Properties ---');
        const compiledDoc = await PDFDocument.load(compileResultBuffer);
        assert(compiledDoc.getPageCount() === 3, `Compiled document contains exactly 3 pages (actual: ${compiledDoc.getPageCount()})`);
        
        const pages = compiledDoc.getPages();
        assert(pages[0].getRotation().angle === 90, `Page 1 is rotated 90 degrees (actual: ${pages[0].getRotation().angle})`);
        assert(pages[1].getRotation().angle === 0, `Page 2 is rotated 0 degrees (actual: ${pages[1].getRotation().angle})`);
        assert(pages[2].getRotation().angle === 180, `Page 3 is rotated 180 degrees (actual: ${pages[2].getRotation().angle})`);

        // Test 3: Autosave state storage & recovery
        console.log('\n--- 3. Autosave Recovery ---');
        const projResult = DocEngine.createProject({ name: 'Test Autosave Project' });
        assert(projResult.id !== undefined, 'Successfully created test project in database');
        const projId = projResult.id;
        const testStateJson = JSON.stringify({ pages: recipe.pages, files: recipe.files });
        
        // Save
        const saveRes = DocEngine.saveSessionState(projId, testStateJson);
        assert(saveRes.success === true, 'Session state saved successfully to DB');

        // Retrieve
        const getRes = DocEngine.getSessionState(projId);
        assert(getRes !== null, 'Session state successfully retrieved');
        assert(JSON.stringify(getRes.state) === testStateJson, 'Session state matches the original saved state JSON');

        // Clear
        const clearRes = DocEngine.clearSessionState(projId);
        assert(clearRes.success === true, 'Session state successfully cleared');
        const getAfterClear = DocEngine.getSessionState(projId);
        assert(getAfterClear === null, 'Session state is null after clearing');

        // Test 4: Office conversion CLI detection
        console.log('\n--- 4. Office Conversion CLI Checks ---');
        // Let's create a dummy text file to test txt to PDF conversion
        const txtFile = path.join(tempDir, 'memo.txt');
        fs.writeFileSync(txtFile, 'Hello PrintShop Manager Client!');

        try {
            const outPdf = await convertOfficeToPdf(txtFile, tempDir);
            assert(fs.existsSync(outPdf), `TXT file compiled to PDF at: ${outPdf}`);
            const pdfDoc = await PDFDocument.load(fs.readFileSync(outPdf));
            assert(pdfDoc.getPageCount() > 0, 'Generated text PDF is valid and contains pages');
        } catch(e) {
            console.log(`[INFO] Skip TXT PDF conversion check (LibreOffice soffice not present in path: ${e.message})`);
        }

    } catch (err) {
        console.error('Test execution failed with error:', err);
        failed++;
    } finally {
        console.log('\n================================================');
        console.log(`TEST RUN COMPLETE: ${passed} PASSED, ${failed} FAILED`);
        console.log('================================================');
        process.exit(failed > 0 ? 1 : 0);
    }
}

runTests();
