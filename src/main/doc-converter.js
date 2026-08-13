const { execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// Resolve soffice path on Windows
function getSofficePath() {
    const paths = [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        'soffice' // Fallback to PATH
    ];
    for (const p of paths) {
        if (p === 'soffice' || fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

/**
 * Convert plain text to PDF natively
 */
async function convertTxtToPdf(inputPath, outputPath) {
    const text = fs.readFileSync(inputPath, 'utf8');
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 10;
    const margin = 50;
    
    const pageWidth = 595.27; // A4 width
    const pageHeight = 841.89; // A4 height
    
    const lines = text.split(/\r?\n/);
    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;
    
    for (const line of lines) {
        // Strip out non-printable control characters
        const safeLine = line.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '');
        
        const maxLineWidth = pageWidth - (margin * 2);
        const words = safeLine.split(' ');
        let currentLine = '';
        
        for (const word of words) {
            const testLine = currentLine ? currentLine + ' ' + word : word;
            const width = font.widthOfTextAtSize(testLine, fontSize);
            if (width > maxLineWidth) {
                if (y < margin + fontSize) {
                    page = pdfDoc.addPage([pageWidth, pageHeight]);
                    y = pageHeight - margin;
                }
                page.drawText(currentLine, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) });
                y -= 14;
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        
        if (currentLine) {
            if (y < margin + fontSize) {
                page = pdfDoc.addPage([pageWidth, pageHeight]);
                y = pageHeight - margin;
            }
            page.drawText(currentLine, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) });
            y -= 14;
        }
    }
    
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(outputPath, pdfBytes);
}

/**
 * Convert Office document (docx, xlsx, pptx, txt) to PDF
 * @param {string} inputPath 
 * @param {string} outputDir 
 * @returns {Promise<string>} Path of the generated PDF
 */
function convertOfficeToPdf(inputPath, outputDir) {
    const ext = path.extname(inputPath).toLowerCase();
    const baseName = path.basename(inputPath, ext);
    const outputPath = path.join(outputDir, baseName + '.pdf');

    return new Promise((resolve, reject) => {
        const soffice = getSofficePath();
        if (!soffice) {
            if (ext === '.txt') {
                console.log(`[DocConverter] Soffice not found. Falling back to native TXT->PDF conversion for ${inputPath}`);
                fs.mkdirSync(outputDir, { recursive: true });
                convertTxtToPdf(inputPath, outputPath)
                    .then(() => resolve(outputPath))
                    .catch(err => reject(new Error(`Native TXT conversion failed: ${err.message}`)));
                return;
            }
            return reject(new Error("LibreOffice 'soffice' executable not found on this system. Please verify installation."));
        }
        if (!fs.existsSync(inputPath)) {
            return reject(new Error(`Input file not found: ${inputPath}`));
        }

        fs.mkdirSync(outputDir, { recursive: true });

        const args = [
            '--headless',
            '--convert-to',
            'pdf',
            '--outdir',
            outputDir,
            inputPath
        ];

        console.log(`[DocConverter] Invoking soffice headless conversion for ${inputPath}`);

        if (soffice === 'soffice') {
            // Run shell command
            exec(`soffice --headless --convert-to pdf --outdir "${outputDir}" "${inputPath}"`, (err, stdout, stderr) => {
                if (err) {
                    return reject(new Error(`LibreOffice conversion error: ${err.message || stderr}`));
                }
                const baseName = path.basename(inputPath, path.extname(inputPath));
                const outputPath = path.join(outputDir, baseName + '.pdf');
                if (fs.existsSync(outputPath)) {
                    resolve(outputPath);
                } else {
                    reject(new Error(`Output PDF file not found after conversion at: ${outputPath}`));
                }
            });
        } else {
            // Execute file directly (Windows safe path)
            execFile(soffice, args, (err, stdout, stderr) => {
                if (err) {
                    return reject(new Error(`LibreOffice execution error: ${err.message || stderr}`));
                }
                const baseName = path.basename(inputPath, path.extname(inputPath));
                const outputPath = path.join(outputDir, baseName + '.pdf');
                if (fs.existsSync(outputPath)) {
                    resolve(outputPath);
                } else {
                    reject(new Error(`Output PDF file not found after execution at: ${outputPath}`));
                }
            });
        }
    });
}

module.exports = {
    convertOfficeToPdf
};
