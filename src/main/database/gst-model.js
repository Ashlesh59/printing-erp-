const db = require('./db');

const GstModel = {
    // Generate next invoice number: GST-YYYYMMDD-XXXX
    generateInvoiceNumber: () => {
        const today = new Date();
        const dateStr = today.getFullYear() + 
            String(today.getMonth() + 1).padStart(2, '0') + 
            String(today.getDate()).padStart(2, '0');
        
        const pattern = `GST-${dateStr}-%`;
        const lastInvoice = db.prepare('SELECT invoice_number FROM gst_invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1').get(pattern);
        
        let seq = 1;
        if (lastInvoice) {
            const parts = lastInvoice.invoice_number.split('-');
            const lastSeq = parseInt(parts[2], 10);
            if (!isNaN(lastSeq)) seq = lastSeq + 1;
        }
        
        return `GST-${dateStr}-${String(seq).padStart(4, '0')}`;
    },

    createInvoice: (invoiceData, items) => {
        const transaction = db.transaction(() => {
            const invoiceNumber = GstModel.generateInvoiceNumber();
            
            // Insert Invoice header
            const stmtInvoice = db.prepare(`
                INSERT INTO gst_invoices (customer_id, invoice_number, invoice_date, subtotal, cgst_total, sgst_total, igst_total, grand_total, state_type, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            const result = stmtInvoice.run(
                invoiceData.customer_id,
                invoiceNumber,
                invoiceData.invoice_date || new Date().toISOString().split('T')[0],
                invoiceData.subtotal || 0,
                invoiceData.cgst_total || 0,
                invoiceData.sgst_total || 0,
                invoiceData.igst_total || 0,
                invoiceData.grand_total || 0,
                invoiceData.state_type || 'Local',
                invoiceData.status || 'Paid'
            );
            
            const invoiceId = result.lastInsertRowid;
            
            // Insert Invoice items
            const stmtItem = db.prepare(`
                INSERT INTO gst_invoice_items (invoice_id, description, hsn_sac, qty, rate, gst_rate, taxable_value, cgst_amount, sgst_amount, igst_amount, total)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            for (const item of items) {
                stmtItem.run(
                    invoiceId,
                    item.description,
                    item.hsn_sac || '',
                    item.qty || 1,
                    item.rate || 0,
                    item.gst_rate || 0,
                    item.taxable_value || 0,
                    item.cgst_amount || 0,
                    item.sgst_amount || 0,
                    item.igst_amount || 0,
                    item.total || 0
                );
            }
            
            // Update customer GSTIN/state if provided
            if (invoiceData.customer_id && invoiceData.gstin) {
                db.prepare('UPDATE customers SET gstin = ?, state = ? WHERE id = ?')
                    .run(invoiceData.gstin, invoiceData.state_type, invoiceData.customer_id);
            }
            
            try {
                db.prepare('INSERT INTO activities (description, type) VALUES (?, ?)').run(`Tax Invoice ${invoiceNumber} created`, 'invoice_created');
            } catch(e) {}
            return { success: true, id: invoiceId, invoiceNumber };
        });

        try {
            return transaction();
        } catch (error) {
            console.error("Failed to create GST invoice:", error);
            return { success: false, error: error.message };
        }
    },

    getInvoices: (limit, offset) => {
        try {
            if (typeof limit === 'number' && typeof offset === 'number') {
                return db.prepare(`
                    SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.gstin as customer_gstin
                    FROM gst_invoices i
                    LEFT JOIN customers c ON i.customer_id = c.id
                    ORDER BY i.id DESC
                    LIMIT ? OFFSET ?
                `).all(limit, offset);
            }
            return db.prepare(`
                SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.gstin as customer_gstin
                FROM gst_invoices i
                LEFT JOIN customers c ON i.customer_id = c.id
                ORDER BY i.id DESC
            `).all();
        } catch (error) {
            console.error("Failed to fetch GST invoices:", error);
            return [];
        }
    },

    getInvoiceItems: (invoiceId) => {
        try {
            return db.prepare('SELECT * FROM gst_invoice_items WHERE invoice_id = ?').all(invoiceId);
        } catch (error) {
            console.error("Failed to fetch invoice items:", error);
            return [];
        }
    },

    getGstSummary: () => {
        try {
            const summary = db.prepare(`
                SELECT 
                    COUNT(CASE WHEN status NOT IN ('Pending', 'Cancelled', 'Declined', 'Draft', 'Saved') THEN 1 END) as count,
                    SUM(CASE WHEN status NOT IN ('Pending', 'Cancelled', 'Declined', 'Draft', 'Saved') THEN subtotal ELSE 0 END) as total_taxable,
                    SUM(CASE WHEN status NOT IN ('Pending', 'Cancelled', 'Declined', 'Draft', 'Saved') THEN cgst_total ELSE 0 END) as total_cgst,
                    SUM(CASE WHEN status NOT IN ('Pending', 'Cancelled', 'Declined', 'Draft', 'Saved') THEN sgst_total ELSE 0 END) as total_sgst,
                    SUM(CASE WHEN status NOT IN ('Pending', 'Cancelled', 'Declined', 'Draft', 'Saved') THEN igst_total ELSE 0 END) as total_igst,
                    SUM(CASE WHEN status NOT IN ('Pending', 'Cancelled', 'Declined', 'Draft', 'Saved') THEN grand_total ELSE 0 END) as total_grand
                FROM gst_invoices
            `).get();
            
            return {
                count: summary.count || 0,
                totalTaxable: summary.total_taxable || 0,
                totalCgst: summary.total_cgst || 0,
                totalSgst: summary.total_sgst || 0,
                totalIgst: summary.total_igst || 0,
                totalGrand: summary.total_grand || 0
            };
        } catch (error) {
            console.error("Failed to calculate GST summary:", error);
            return { count: 0, totalTaxable: 0, totalCgst: 0, totalSgst: 0, totalIgst: 0, totalGrand: 0 };
        }
    },

    updateCustomerGst: (customerId, gstin, state) => {
        try {
            db.prepare('UPDATE customers SET gstin = ?, state = ? WHERE id = ?')
                .run(gstin, state, customerId);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
};

module.exports = GstModel;
