/**
 * Authoritative Print Settings & Option Mapper
 * 
 * Validates print options and creates strictly compliant Electron print options.
 * Guarantees that every supported UI selection reaches the printing API accurately,
 * prevents double-application of copies/N-up/orientation, and creates immutable snapshots.
 */

class PrintSettings {
    static STANDARD_PAPER_SIZES = {
        'A4': { name: 'A4', widthMm: 210, heightMm: 297, widthMicrons: 210000, heightMicrons: 297000 },
        'A3': { name: 'A3', widthMm: 297, heightMm: 420, widthMicrons: 297000, heightMicrons: 420000 },
        'A5': { name: 'A5', widthMm: 148, heightMm: 210, widthMicrons: 148000, heightMicrons: 210000 },
        'Letter': { name: 'Letter', widthMm: 215.9, heightMm: 279.4, widthMicrons: 215900, heightMicrons: 279400 },
        'Legal': { name: 'Legal', widthMm: 215.9, heightMm: 355.6, widthMicrons: 215900, heightMicrons: 355600 },
        'Photo 4x6': { name: 'Photo 4x6', widthMm: 101.6, heightMm: 152.4, widthMicrons: 101600, heightMicrons: 152400 },
        '4x6': { name: 'Photo 4x6', widthMm: 101.6, heightMm: 152.4, widthMicrons: 101600, heightMicrons: 152400 },
        'Photo 5x7': { name: 'Photo 5x7', widthMm: 127.0, heightMm: 177.8, widthMicrons: 127000, heightMicrons: 177800 },
        '5x7': { name: 'Photo 5x7', widthMm: 127.0, heightMm: 177.8, widthMicrons: 127000, heightMicrons: 177800 }
    };

    /**
     * Resolves paper dimensions in microns and name
     */
    static resolvePaperSize(paperSizeInput, customDimensions = null) {
        if (!paperSizeInput && !customDimensions) {
            return this.STANDARD_PAPER_SIZES['A4'];
        }

        if (typeof paperSizeInput === 'string') {
            const key = Object.keys(this.STANDARD_PAPER_SIZES).find(
                k => k.toLowerCase() === paperSizeInput.trim().toLowerCase()
            );
            if (key) return this.STANDARD_PAPER_SIZES[key];
        }

        if (customDimensions && typeof customDimensions === 'object') {
            const width = parseFloat(customDimensions.width || customDimensions.widthMm || customDimensions.widthMicrons);
            const height = parseFloat(customDimensions.height || customDimensions.heightMm || customDimensions.heightMicrons);

            if (!isNaN(width) && !isNaN(height) && width > 0 && height > 0) {
                // If dimensions are <= 1000, treat as mm and convert to microns
                const widthMicrons = width < 1000 ? Math.round(width * 1000) : Math.round(width);
                const heightMicrons = height < 1000 ? Math.round(height * 1000) : Math.round(height);
                return {
                    name: 'Custom',
                    widthMm: Math.round(widthMicrons / 1000),
                    heightMm: Math.round(heightMicrons / 1000),
                    widthMicrons,
                    heightMicrons
                };
            }
        }

        return this.STANDARD_PAPER_SIZES['A4'];
    }

    /**
     * Parses page range string and converts to 0-indexed Electron pageRanges array
     * @param {string} rangeStr - e.g. '1-3, 5'
     * @param {number} totalPages - Total pages in document
     * @returns {Array<{from: number, to: number}>|null}
     */
    static parsePageRanges(rangeStr, totalPages = 1) {
        if (!rangeStr || typeof rangeStr !== 'string' || rangeStr.trim() === '') {
            return null; // Print all pages
        }

        const ranges = [];
        const parts = rangeStr.trim().split(',');

        for (const part of parts) {
            const clean = part.trim();
            if (!clean) continue;

            if (clean.includes('-')) {
                const [startStr, endStr] = clean.split('-');
                const start = parseInt(startStr, 10);
                const end = parseInt(endStr, 10);

                if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
                    throw new Error(`Invalid page range format: "${clean}"`);
                }

                if (start > totalPages) {
                    throw new Error(`Page range start (${start}) exceeds total document pages (${totalPages})`);
                }

                const boundedEnd = Math.min(end, totalPages);
                ranges.push({ from: start - 1, to: boundedEnd - 1 });
            } else {
                const pageNum = parseInt(clean, 10);
                if (isNaN(pageNum) || pageNum < 1) {
                    throw new Error(`Invalid page number: "${clean}"`);
                }
                if (pageNum > totalPages) {
                    throw new Error(`Page number ${pageNum} exceeds total document pages (${totalPages})`);
                }
                ranges.push({ from: pageNum - 1, to: pageNum - 1 });
            }
        }

        return ranges.length > 0 ? ranges : null;
    }

    /**
     * Validates input settings and maps to Electron print options
     * @param {Object} rawSettings 
     * @param {Object} printerCapabilities - Optional capability object for target printer
     * @param {number} documentTotalPages - Total pages in document
     * @returns {Object} { isValid, electronOptions, snapshot, errors, warnings }
     */
    static mapToElectronPrintOptions(rawSettings = {}, printerCapabilities = null, documentTotalPages = 1) {
        const errors = [];
        const warnings = [];

        // 1. Device Name Resolution
        const deviceName = rawSettings.printerDeviceName || rawSettings.deviceName || rawSettings.printerName || 'Default';

        // 2. Paper Size & Dimensions
        const paperSizeInfo = this.resolvePaperSize(rawSettings.paperSize || rawSettings.paper_size, rawSettings.customDimensions);
        const isLandscape = rawSettings.landscape === true || (rawSettings.orientation || '').toLowerCase() === 'landscape';

        // Construct pageSize for Electron
        let pageSize;
        if (paperSizeInfo.name === 'Custom') {
            pageSize = {
                width: isLandscape ? paperSizeInfo.heightMicrons : paperSizeInfo.widthMicrons,
                height: isLandscape ? paperSizeInfo.widthMicrons : paperSizeInfo.heightMicrons
            };
        } else {
            pageSize = paperSizeInfo.name;
        }

        // 3. Duplex Mode
        const sidesRaw = (rawSettings.sides || rawSettings.duplex || 'Single').toLowerCase();
        let duplexMode = 'simplex';
        if (sidesRaw === 'double' || sidesRaw === 'duplex' || sidesRaw === 'longedge') {
            duplexMode = 'longEdge';
        } else if (sidesRaw === 'shortedge') {
            duplexMode = 'shortEdge';
        }

        // 4. Color Mode
        const printTypeRaw = (rawSettings.printType || rawSettings.colorMode || 'bw').toLowerCase();
        const isColor = printTypeRaw === 'color';

        // 5. Copies
        const copies = Math.max(1, parseInt(rawSettings.copies, 10) || 1);

        // 6. Page Ranges (0-indexed)
        let pageRanges = null;
        try {
            pageRanges = this.parsePageRanges(rawSettings.pageRange || rawSettings.pageRanges, documentTotalPages);
        } catch (rangeErr) {
            errors.push(rangeErr.message);
        }

        // 7. Margins
        const marginType = rawSettings.marginType || 'default';
        let margins = { marginType };
        if (marginType === 'custom' && rawSettings.margins) {
            margins = {
                marginType: 'custom',
                top: Math.max(0, parseInt(rawSettings.margins.top) || 0),
                bottom: Math.max(0, parseInt(rawSettings.margins.bottom) || 0),
                left: Math.max(0, parseInt(rawSettings.margins.left) || 0),
                right: Math.max(0, parseInt(rawSettings.margins.right) || 0)
            };
        }

        // 8. Scaling & DPI
        const scaleFactor = typeof rawSettings.scaleFactor === 'number' ? Math.max(0.1, Math.min(3.0, rawSettings.scaleFactor)) : 1.0;
        let dpi = undefined;
        if (rawSettings.dpi && typeof rawSettings.dpi === 'object') {
            dpi = rawSettings.dpi;
        } else if (typeof rawSettings.dpi === 'number' && rawSettings.dpi > 0) {
            dpi = { horizontal: rawSettings.dpi, vertical: rawSettings.dpi };
        }

        // 9. Validate against Printer Capabilities (if provided)
        if (printerCapabilities) {
            if (isColor && printerCapabilities.canColor === false) {
                errors.push(`Printer "${deviceName}" does not support Color printing.`);
            }
            if (duplexMode !== 'simplex' && printerCapabilities.canDuplex === false) {
                errors.push(`Printer "${deviceName}" does not support 2-Sided Duplex printing.`);
            }
            if (Array.isArray(printerCapabilities.paperSizes) && printerCapabilities.paperSizes.length > 0) {
                const supported = printerCapabilities.paperSizes.some(
                    p => p.toLowerCase() === paperSizeInfo.name.toLowerCase()
                );
                if (!supported && paperSizeInfo.name !== 'Custom') {
                    warnings.push(`Paper size "${paperSizeInfo.name}" may not be natively supported by "${deviceName}".`);
                }
            }
        }

        // 10. Assemble Final Electron Print Options
        const electronOptions = {
            silent: rawSettings.silent !== undefined ? Boolean(rawSettings.silent) : true,
            printBackground: rawSettings.printBackground !== undefined ? Boolean(rawSettings.printBackground) : true,
            color: isColor,
            copies: copies,
            landscape: isLandscape,
            duplexMode: duplexMode,
            pageSize: pageSize,
            margins: margins,
            scaleFactor: scaleFactor,
            collate: rawSettings.collate !== undefined ? Boolean(rawSettings.collate) : true
        };

        if (deviceName && deviceName !== 'Default') {
            electronOptions.deviceName = deviceName;
        }

        if (pageRanges) {
            electronOptions.pageRanges = pageRanges;
        }

        if (dpi) {
            electronOptions.dpi = dpi;
        }

        // 11. Create Immutable Settings Snapshot
        const snapshot = {
            printerDeviceName: deviceName,
            paperSize: paperSizeInfo.name,
            paperDimensionsMicrons: { width: paperSizeInfo.widthMicrons, height: paperSizeInfo.heightMicrons },
            orientation: isLandscape ? 'Landscape' : 'Portrait',
            colorMode: isColor ? 'Color' : 'Monochrome',
            duplexMode: duplexMode,
            copies: copies,
            pageRange: rawSettings.pageRange || 'All',
            scalingMode: rawSettings.scalingMode || 'fit',
            scaleFactor: scaleFactor,
            margins: margins,
            dpi: dpi || 'Default',
            collate: electronOptions.collate,
            printBackground: electronOptions.printBackground,
            timestamp: new Date().toISOString()
        };

        return {
            isValid: errors.length === 0,
            electronOptions,
            snapshot,
            snapshotJson: JSON.stringify(snapshot),
            errors,
            warnings
        };
    }
}

module.exports = PrintSettings;
