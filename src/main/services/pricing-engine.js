/**
 * Authoritative Pricing & Quantity Calculation Engine
 * 
 * Guarantees distinct metrics for:
 * - source_pages, logical_pages, n_up, physical_sheets, copies, total_sheets, billable_units
 * - Tax-inclusive/exclusive GST calculations (Local CGST+SGST vs Inter-state IGST)
 * - Immutable pricing snapshots
 */

const db = require('../database/db');

class PricingEngine {
    /**
     * Parses a page range string (e.g. '1-3, 5, 8-10') against total source pages
     * @param {string} rangeStr 
     * @param {number} totalSourcePages 
     * @returns {number} Count of logical pages selected
     */
    static parsePageRange(rangeStr, totalSourcePages = 1) {
        if (!rangeStr || typeof rangeStr !== 'string' || rangeStr.trim() === '') {
            return Math.max(1, totalSourcePages);
        }

        const clean = rangeStr.trim();
        const pagesSet = new Set();
        const parts = clean.split(',');

        for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.includes('-')) {
                const [startStr, endStr] = trimmed.split('-');
                const start = parseInt(startStr, 10);
                const end = parseInt(endStr, 10);
                if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start) {
                    for (let i = start; i <= Math.min(end, totalSourcePages); i++) {
                        pagesSet.add(i);
                    }
                }
            } else {
                const pageNum = parseInt(trimmed, 10);
                if (!isNaN(pageNum) && pageNum > 0 && pageNum <= totalSourcePages) {
                    pagesSet.add(pageNum);
                }
            }
        }

        return pagesSet.size > 0 ? pagesSet.size : Math.max(1, totalSourcePages);
    }

    /**
     * Calculates authoritative quantities for a discrete order item
     * @param {Object} itemConfig
     * @returns {Object} Quantity metrics
     */
    static calculateItemQuantities(itemConfig = {}) {
        const sourcePages = Math.max(1, parseInt(itemConfig.sourcePages || itemConfig.pages) || 1);
        const pageRange = itemConfig.pageRange || '';
        const logicalPagesPerCopy = this.parsePageRange(pageRange, sourcePages);
        const nUp = Math.max(1, parseInt(itemConfig.nUp || itemConfig.n_up) || 1);
        const isDuplex = (itemConfig.sides || '').toLowerCase() === 'double' || (itemConfig.sides || '').toLowerCase() === 'duplex';
        const copies = Math.max(1, parseInt(itemConfig.copies) || 1);

        // N-up grouping: how many document pages fit on one side of a sheet
        const printedPagesPerCopy = Math.ceil(logicalPagesPerCopy / nUp);

        // Physical sheets per copy (Duplex prints 2 pages per physical sheet)
        const physicalSheetsPerCopy = isDuplex ? Math.ceil(printedPagesPerCopy / 2) : printedPagesPerCopy;

        // Total physical sheets for all copies
        const totalPhysicalSheets = physicalSheetsPerCopy * copies;
        const totalLogicalPages = logicalPagesPerCopy * copies;

        return {
            sourcePages,
            logicalPagesPerCopy,
            nUp,
            isDuplex,
            sides: isDuplex ? 'Double' : 'Single',
            copies,
            printedPagesPerCopy,
            physicalSheetsPerCopy,
            totalPhysicalSheets,
            totalLogicalPages
        };
    }

    /**
     * Look up authoritative base paper rate
     */
    static getBaseRate(paperSize = 'A4', colorType = 'bw', sides = 'Single') {
        const isColor = colorType.toLowerCase() === 'color';
        const colorKey = isColor ? 'color' : 'bw';
        const sidesKey = (sides.toLowerCase() === 'double' || sides.toLowerCase() === 'duplex') ? 'Double' : 'Single';

        try {
            const priceRow = db.prepare(`
                SELECT price FROM pricing 
                WHERE category = 'paper' 
                  AND UPPER(paper_size) = UPPER(?) 
                  AND LOWER(color_type) = LOWER(?)
                  AND (sides = ? OR sides IS NULL)
                ORDER BY sides DESC LIMIT 1
            `).get(paperSize, colorKey, sidesKey);

            if (priceRow && typeof priceRow.price === 'number') {
                return priceRow.price;
            }
        } catch (e) {
            console.warn('[PricingEngine] Database price lookup warning:', e.message);
        }

        // Fallback to settings defaults
        try {
            const settings = db.prepare('SELECT bw_price_per_page, color_price_per_page FROM settings WHERE id = 1').get();
            if (settings) {
                return isColor ? (parseFloat(settings.color_price_per_page) || 10.0) : (parseFloat(settings.bw_price_per_page) || 2.0);
            }
        } catch (e) {}

        return isColor ? 10.0 : 2.0;
    }

    /**
     * Calculates complete pricing and GST breakdown for an order
     * @param {Array} rawItems 
     * @param {Object} options - { customerState, discount, gstin }
     * @returns {Object} Complete calculated pricing snapshot
     */
    static calculateOrderPricing(rawItems = [], options = {}) {
        const stateType = (options.customerState || options.state || 'Local').toLowerCase() === 'interstate' ? 'Interstate' : 'Local';
        const discountAmount = Math.max(0, parseFloat(options.discount || options.discountAmount) || 0);

        // Fetch GST settings
        let gstRate = 18.0;
        let enableGst = true;
        try {
            const settings = db.prepare('SELECT default_gst_rate, enable_gst FROM settings WHERE id = 1').get();
            if (settings) {
                enableGst = settings.enable_gst !== 0;
                gstRate = enableGst ? (parseFloat(settings.default_gst_rate) || 18.0) : 0.0;
            }
        } catch (e) {}

        const gstFactor = 1 + (gstRate / 100);

        let subtotalGross = 0;
        const calculatedItems = [];

        for (const rawItem of rawItems) {
            const quantities = this.calculateItemQuantities(rawItem);
            const paperSize = rawItem.paperSize || rawItem.paper_size || 'A4';
            const printType = (rawItem.printType || rawItem.print_type || 'bw').toLowerCase() === 'color' ? 'color' : 'bw';
            const sides = quantities.sides;

            // Unit rate per physical sheet
            let unitPrice = rawItem.unitPrice !== undefined ? parseFloat(rawItem.unitPrice) : this.getBaseRate(paperSize, printType, sides);
            if (isNaN(unitPrice) || unitPrice < 0) unitPrice = 0;

            // Finishing extras (e.g. Lamination, Spiral Binding)
            let extrasTotal = 0;
            if (Array.isArray(rawItem.extras)) {
                for (const extra of rawItem.extras) {
                    const price = typeof extra === 'object' ? parseFloat(extra.price || 0) : 0;
                    if (!isNaN(price)) extrasTotal += price;
                }
            }

            // Item Gross Price = (Total Physical Sheets * Unit Price) + Extras Total
            let itemGross = (quantities.totalPhysicalSheets * unitPrice) + (extrasTotal * quantities.copies);
            if (rawItem.product_id && rawItem.fixedPrice !== undefined) {
                itemGross = parseFloat(rawItem.fixedPrice) || itemGross;
            }

            itemGross = Math.round(itemGross * 100) / 100;
            subtotalGross += itemGross;

            // Calculate item-level tax breakdown
            const itemTaxable = enableGst ? (itemGross / gstFactor) : itemGross;
            const itemGst = itemGross - itemTaxable;

            let itemCgst = 0, itemSgst = 0, itemIgst = 0;
            if (stateType === 'Local') {
                itemCgst = itemGst / 2;
                itemSgst = itemGst / 2;
            } else {
                itemIgst = itemGst;
            }

            calculatedItems.push({
                ...rawItem,
                fileName: rawItem.fileName || rawItem.file_name || 'Document.pdf',
                filePath: rawItem.filePath || rawItem.file_path || '',
                printType,
                paperSize,
                sides,
                sourcePages: quantities.sourcePages,
                logicalPages: quantities.totalLogicalPages,
                nUp: quantities.nUp,
                physicalSheets: quantities.totalPhysicalSheets,
                copies: quantities.copies,
                unitPrice,
                totalPrice: itemGross,
                price: itemGross,
                taxableValue: Math.round(itemTaxable * 100) / 100,
                gstRate: enableGst ? gstRate : 0,
                cgstAmount: Math.round(itemCgst * 100) / 100,
                sgstAmount: Math.round(itemSgst * 100) / 100,
                igstAmount: Math.round(itemIgst * 100) / 100
            });
        }

        // Apply order-level discount
        const grossAfterDiscount = Math.max(0, subtotalGross - discountAmount);
        const grandTotal = Math.round(grossAfterDiscount * 100) / 100;

        const taxableTotal = enableGst ? (grandTotal / gstFactor) : grandTotal;
        const totalGst = grandTotal - taxableTotal;

        let cgstTotal = 0, sgstTotal = 0, igstTotal = 0;
        if (stateType === 'Local') {
            cgstTotal = totalGst / 2;
            sgstTotal = totalGst / 2;
        } else {
            igstTotal = totalGst;
        }

        return {
            items: calculatedItems,
            subtotal: Math.round(subtotalGross * 100) / 100,
            discountAmount,
            taxableAmount: Math.round(taxableTotal * 100) / 100,
            gstRate: enableGst ? gstRate : 0,
            gstAmount: Math.round(totalGst * 100) / 100,
            cgstTotal: Math.round(cgstTotal * 100) / 100,
            sgstTotal: Math.round(sgstTotal * 100) / 100,
            igstTotal: Math.round(igstTotal * 100) / 100,
            grandTotal,
            stateType,
            enableGst
        };
    }
}

module.exports = PricingEngine;
