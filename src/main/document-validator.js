const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const db = require('./database/db');

// Helper to parse image dimensions from JPEG/PNG buffer
function getImageSize(buffer) {
    try {
        // PNG Signature: 89 50 4E 47
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
            const width = buffer.readInt32BE(16);
            const height = buffer.readInt32BE(20);
            return { width, height };
        }
        
        // JPEG Signature: FF D8
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
            let offset = 2;
            while (offset < buffer.length - 8) {
                const marker = buffer.readUInt16BE(offset);
                offset += 2;
                
                // SOF0 (Start of Frame 0) marker for baseline JPEG: FF C0
                // SOF2 (Start of Frame 2) marker for progressive JPEG: FF C2
                if (marker === 0xFFC0 || marker === 0xFFC2) {
                    offset += 3; // Skip length and precision
                    const height = buffer.readUInt16BE(offset);
                    const width = buffer.readUInt16BE(offset + 2);
                    return { width, height };
                }
                
                // Skip section length
                if (offset + 2 > buffer.length) break;
                const length = buffer.readUInt16BE(offset);
                offset += length;
            }
        }
    } catch (e) {
        console.error("Failed to parse image dimensions from buffer:", e);
    }
    return null;
}

const DocumentValidator = {
    validate: async (filePath) => {
        const stats = fs.statSync(filePath);
        if (stats.size === 0) {
            return { isValid: false, error: "File size is 0 bytes (corrupted)." };
        }

        const ext = path.extname(filePath).toLowerCase();
        
        if (ext === '.pdf') {
            try {
                const fileBytes = fs.readFileSync(filePath);
                
                // Check encryption/password
                let pdfDoc;
                try {
                    pdfDoc = await PDFDocument.load(fileBytes, { ignoreEncryption: false });
                } catch(loadErr) {
                    if (loadErr.message.includes('encrypted') || loadErr.message.includes('password')) {
                        return { 
                            isValid: false, 
                            error: "PDF file is password protected/encrypted.",
                            isEncrypted: true
                        };
                    }
                    throw loadErr;
                }

                if (pdfDoc.isEncrypted) {
                    return { 
                        isValid: false, 
                        error: "PDF file is password protected/encrypted.",
                        isEncrypted: true
                    };
                }

                const pageCount = pdfDoc.getPageCount();
                if (pageCount === 0) {
                    return { isValid: false, error: "PDF document contains 0 pages." };
                }

                const pages = pdfDoc.getPages();
                const orientations = [];
                const pageSizes = [];
                let blankPages = [];
                let mixedSizes = false;

                const firstPage = pages[0].getSize();
                const tolerance = 5.0; // Point tolerance

                for (let i = 0; i < pages.length; i++) {
                    const size = pages[i].getSize();
                    pageSizes.push({ width: Math.round(size.width), height: Math.round(size.height) });
                    
                    const isLandscape = size.width > size.height;
                    orientations.push(isLandscape ? 'landscape' : 'portrait');
                    
                    if (Math.abs(size.width - firstPage.width) > tolerance || Math.abs(size.height - firstPage.height) > tolerance) {
                        mixedSizes = true;
                    }

                    // Simple check for blank pages (check if there are no node objects/contents)
                    try {
                        const contentStream = pages[i].node.Contents;
                        if (!contentStream || (Array.isArray(contentStream) && contentStream.length === 0)) {
                            blankPages.push(i + 1);
                        }
                    } catch(cErr) {
                        // ignore content stream error
                    }
                }

                const uniqueOrientations = [...new Set(orientations)];
                const hasMixedOrientation = uniqueOrientations.length > 1;

                // Match best product recommendation
                const recommendation = DocumentValidator.recommendProduct({
                    type: 'pdf',
                    pageSize: pageSizes[0],
                    orientation: orientations[0],
                    pageCount: pageCount,
                    hasMixedOrientation
                });

                return {
                    isValid: true,
                    type: 'pdf',
                    pages: pageCount,
                    pageSize: pageSizes[0],
                    orientations: orientations,
                    hasMixedOrientation,
                    mixedSizes,
                    blankPages,
                    recommendation
                };

            } catch (err) {
                return { isValid: false, error: `Invalid or corrupted PDF file: ${err.message}` };
            }
        } 
        else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
            try {
                const buffer = fs.readFileSync(filePath);
                const size = getImageSize(buffer);
                
                if (!size) {
                    return { isValid: false, error: "Unsupported image format or corrupt header." };
                }

                // Assume standard print target is A4 (8.27 in x 11.69 in)
                const targetWidthInches = 8.27;
                const dpiWidth = Math.round(size.width / targetWidthInches);
                const isLowDpi = dpiWidth < 150;

                const orientation = size.width > size.height ? 'landscape' : 'portrait';

                // Match best product recommendation
                const recommendation = DocumentValidator.recommendProduct({
                    type: 'image',
                    pageSize: { width: size.width, height: size.height },
                    orientation,
                    pageCount: 1,
                    hasMixedOrientation: false
                });

                return {
                    isValid: true,
                    type: 'image',
                    width: size.width,
                    height: size.height,
                    dpi: dpiWidth,
                    isLowDpi,
                    orientation,
                    recommendation
                };

            } catch (err) {
                return { isValid: false, error: `Failed to analyze image file: ${err.message}` };
            }
        }

        return { isValid: false, error: `Unsupported file type: ${ext}` };
    },

    // Recommendations matching logic based on analyzed attributes
    recommendProduct: (meta) => {
        try {
            // Get all products and profiles
            const products = db.prepare(`
                SELECT p.*, pr.paper_size, pr.color_mode, pr.duplex_mode
                FROM products p
                JOIN print_profiles pr ON p.print_profile_id = pr.id
                WHERE p.is_active = 1
            `).all();

            if (products.length === 0) return null;

            let bestMatch = null;
            let highestScore = -1;

            // Page size matching guidelines
            const isA3 = meta.pageSize.width > 600 || meta.pageSize.height > 900; // rough A3 point boundaries

            for (const prod of products) {
                let score = 0;

                // Match paper size
                if (prod.paper_size === 'A3' && isA3) {
                    score += 10;
                } else if (prod.paper_size === 'A4' && !isA3) {
                    score += 10;
                }

                // Match orientations
                if (meta.orientation === 'landscape' && prod.name.toLowerCase().includes('landscape')) {
                    score += 5;
                }

                // Duplex heuristic matching
                if (meta.pageCount > 5 && prod.duplex_mode !== 'simplex') {
                    score += 3;
                }

                // Color heuristics
                if (meta.type === 'image' && prod.color_mode === 'color') {
                    score += 4;
                }

                if (score > highestScore) {
                    highestScore = score;
                    bestMatch = prod;
                }
            }

            return bestMatch ? { id: bestMatch.id, name: bestMatch.name } : null;

        } catch (e) {
            console.error("Failed to calculate product recommendation:", e);
            return null;
        }
    }
};

module.exports = DocumentValidator;
