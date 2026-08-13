/**
 * Automated test suite for Phase 2C - Document Studio 3.0 (Interactive Workspace & Compiler)
 * PrintShop Manager
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const DocEngine = require('../document-engine');

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
    console.log('STARTING PHASE 2C DOC STUDIO 3.0 TEST SUITE');
    console.log('================================================');

    const tempDir = path.join(__dirname, '..', '..', '..', 'PrintSimulator', 'temp_tests_v3');
    fs.mkdirSync(tempDir, { recursive: true });

    const pdfA = path.join(tempDir, 'src_doc3_a.pdf');
    await createDummyPdf(pdfA, 3); // 3 pages

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
        // Test 1: Booklet Signature Imposition & Blank Padding
        console.log('\n--- 1. Booklet Imposition & Padding ---');
        
        const recipe = {
            files: [{ path: pdfA, ext: '.pdf' }],
            pages: [
                { sourceFileIndex: 0, sourcePageIndex: 0 }, // Page 1
                { sourceFileIndex: 0, sourcePageIndex: 1 }, // Page 2
                { sourceFileIndex: 0, sourcePageIndex: 2 }  // Page 3
            ],
            layout: {
                imposition: 'booklet',
                paperSize: 'A4'
            }
        };

        const result = await DocEngine.compilePrintReadyPdf(recipe);
        assert(result.success === true, 'Booklet compiler successfully executed recipe');
        
        const compiledDoc = await PDFDocument.load(result.data);
        // Pad size = (4 - (3 % 4)) % 4 = 1. Total pages = 3 + 1 = 4.
        assert(compiledDoc.getPageCount() === 4, `Compiled booklet contains exactly 4 signature pages (actual: ${compiledDoc.getPageCount()})`);

        // Test 2: Brightness and Grayscale adjustments
        console.log('\n--- 2. Brightness & Grayscale Filter Compilations ---');
        const filterRecipe = {
            files: [{ path: pdfA, ext: '.pdf' }],
            pages: [
                { sourceFileIndex: 0, sourcePageIndex: 0, brightness: 20 },      // Brighter
                { sourceFileIndex: 0, sourcePageIndex: 1, grayscale: true },    // Grayscale
                { sourceFileIndex: 0, sourcePageIndex: 2, bw: true }            // B&W
            ],
            layout: {
                imposition: 'simplex',
                paperSize: 'A4'
            }
        };

        const filterResult = await DocEngine.compilePrintReadyPdf(filterRecipe);
        assert(filterResult.success === true, 'Filter compiler successfully executed recipe');
        const filterDoc = await PDFDocument.load(filterResult.data);
        assert(filterDoc.getPageCount() === 3, `Filter output contains exactly 3 adjusted pages (actual: ${filterDoc.getPageCount()})`);

        // Test 3: Autosave state storage & recovery
        console.log('\n--- 3. Database Autosave Integrity ---');
        const projResult = DocEngine.createProject({ name: 'Current Draft Session' });
        assert(projResult.id !== undefined, 'Successfully created/loaded project in database');
        
        const projId = projResult.id;
        const testStateJson = JSON.stringify({ pages: recipe.pages, files: recipe.files });
        
        const saveRes = DocEngine.saveSessionState(projId, testStateJson);
        assert(saveRes.success === true, 'Session state saved successfully to SQLite');

        const getRes = DocEngine.getSessionState(projId);
        assert(getRes !== null, 'Session state successfully loaded from SQLite');
        assert(JSON.stringify(getRes.state) === testStateJson, 'Retrieved session state matches original JSON state');

        const clearRes = DocEngine.clearSessionState(projId);
        assert(clearRes.success === true, 'Session state successfully cleared');

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
