document.addEventListener('DOMContentLoaded', () => {
    // API safety reference
    const api = window.parent.api;
    if (!api) {
        console.error("Context Bridge window.parent.api is missing!");
    }

    // STATE
    let allInvoices = [];
    let customersList = [];
    let selectedCustomerId = null;

    // DOM ELEMENTS
    const btnOpenCreateInvoice = document.getElementById('btn-open-create-invoice');
    const btnExportGstr = document.getElementById('btn-export-gstr');
    const billingModal = document.getElementById('billing-modal');
    const btnCloseBillingModal = document.getElementById('btn-close-billing-modal');
    const btnCancelInvoice = document.getElementById('btn-cancel-invoice');
    const btnSavePrintInvoice = document.getElementById('btn-save-print-invoice');
    
    const searchInvoice = document.getElementById('search-invoice');
    const invoiceTbody = document.getElementById('invoice-tbody');
    
    // Form Inputs
    const invCustPhone = document.getElementById('inv-cust-phone');
    const invCustName = document.getElementById('inv-cust-name');
    const invCustGstin = document.getElementById('inv-cust-gstin');
    const invStateType = document.getElementById('inv-state-type');
    const custSearchResults = document.getElementById('cust-search-results');
    const billingItemsTbody = document.getElementById('billing-items-tbody');
    const btnAddItemRow = document.getElementById('btn-add-item-row');

    // Summary Elements
    const sumTaxable = document.getElementById('sum-taxable');
    const sumCgst = document.getElementById('sum-cgst');
    const sumSgst = document.getElementById('sum-sgst');
    const sumIgst = document.getElementById('sum-igst');
    const sumGrand = document.getElementById('sum-grand');
    const rowSumCgst = document.getElementById('row-sum-cgst');
    const rowSumSgst = document.getElementById('row-sum-sgst');
    const rowSumIgst = document.getElementById('row-sum-igst');

    // Print Modal
    const printPreviewModal = document.getElementById('print-preview-modal');
    const btnClosePrintModal = document.getElementById('btn-close-print-modal');
    const btnTriggerPrint = document.getElementById('btn-trigger-print');
    const printableInvoice = document.getElementById('printable-invoice');

    // Core Init
    async function init() {
        await loadDashboardSummary();
        await loadInvoicesList();
    }

    // 1. DASHBOARD SUMMARIZATION
    async function loadDashboardSummary() {
        if (!api || !api.getGstSummary) return;
        const summary = await api.getGstSummary();
        
        // Fetch expenses from received POs
        let totalExpenses = 0;
        if (api.getInvPurchaseOrders) {
            try {
                const rawPos = await api.getInvPurchaseOrders();
                const pos = Array.isArray(rawPos) ? rawPos : [];
                const received = pos.filter(po => po.status === 'Received');
                totalExpenses = received.reduce((sum, po) => sum + (po.grand_total || 0), 0);
            } catch (err) {
                console.error("Failed to load PO expenses for budget tracker:", err);
            }
        }

        const grossSales = (summary && typeof summary.totalGrand === 'number') ? summary.totalGrand : 0;
        const totalGst = ((summary && summary.totalCgst) || 0) + ((summary && summary.totalSgst) || 0) + ((summary && summary.totalIgst) || 0);
        const netProfit = grossSales - totalExpenses;

        // Targets configuration
        const salesTarget = 100000.00;
        const expenseLimit = 40000.00;

        const salesPct = Math.min(100, (grossSales / salesTarget) * 100);
        const expensePct = Math.min(100, (totalExpenses / expenseLimit) * 100);

        // Update elements
        const statCount = document.getElementById('stat-count');
        const statGross = document.getElementById('stat-gross');
        const statExpenses = document.getElementById('stat-expenses');
        const statProfit = document.getElementById('stat-profit');
        const statGst = document.getElementById('stat-gst');
        if (statCount) statCount.textContent = (summary && summary.count) || 0;
        if (statGross) statGross.textContent = `₹${grossSales.toFixed(2)}`;
        if (statExpenses) statExpenses.textContent = `₹${totalExpenses.toFixed(2)}`;
        if (statProfit) statProfit.textContent = `₹${netProfit.toFixed(2)}`;
        if (statGst) statGst.textContent = `₹${totalGst.toFixed(2)}`;

        // Progress bars
        const salesProgress = document.getElementById('sales-budget-progress');
        const expenseProgress = document.getElementById('expense-budget-progress');
        if (salesProgress) salesProgress.style.width = `${salesPct}%`;
        if (expenseProgress) expenseProgress.style.width = `${expensePct}%`;

        // Metas
        const salesMeta = document.getElementById('sales-budget-meta');
        const expenseMeta = document.getElementById('expense-budget-meta');
        if (salesMeta) salesMeta.textContent = `${salesPct.toFixed(0)}% of ₹${salesTarget.toLocaleString('en-IN')}`;
        if (expenseMeta) expenseMeta.textContent = `${expensePct.toFixed(0)}% of ₹${expenseLimit.toLocaleString('en-IN')} Cap`;
    }

    // 2. INVOICES HISTORY LIST
    async function loadInvoicesList() {
        if (!api || !api.getGstInvoices) return;
        try {
            const raw = await api.getGstInvoices();
            allInvoices = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.invoices) ? raw.invoices : []);
            renderInvoices(allInvoices);
        } catch(e) {
            console.error("Failed to load GST invoices:", e);
        }
    }

    function renderInvoices(list) {
        if (!invoiceTbody) return;
        invoiceTbody.innerHTML = '';
        
        if (!Array.isArray(list) || list.length === 0) {
            invoiceTbody.innerHTML = '<tr><td colspan="7" class="empty-state">No GST invoices billed yet.</td></tr>';
            return;
        }

        list.forEach(inv => {
            const date = new Date(inv.invoice_date).toLocaleDateString('en-IN', { dateStyle: 'medium' });
            
            const gstBreakdown = inv.state_type === 'Local'
                ? `CGST: ₹${inv.cgst_total.toFixed(2)}<br>SGST: ₹${inv.sgst_total.toFixed(2)}`
                : `IGST: ₹${inv.igst_total.toFixed(2)}`;

            const customerGstinStr = inv.customer_gstin ? `<br><small style="color:var(--accent-color)">GSTIN: ${inv.customer_gstin}</small>` : '';

            invoiceTbody.innerHTML += `
                <tr>
                    <td><strong style="color:var(--accent-color)">${inv.invoice_number}</strong></td>
                    <td>${date}</td>
                    <td>
                        <div style="font-weight:600;">${inv.customer_name}</div>
                        <small style="color:var(--text-secondary)">${inv.customer_phone}</small>
                        ${customerGstinStr}
                    </td>
                    <td>₹${inv.subtotal.toFixed(2)}</td>
                    <td><div style="font-size:0.8rem; line-height:1.4">${gstBreakdown}</div></td>
                    <td><strong style="color:var(--success-color)">₹${inv.grand_total.toFixed(2)}</strong></td>
                    <td style="text-align: right;">
                        <button class="action-btn btn-secondary btn-sm" onclick="window.viewInvoiceDetail(${inv.id})">👁️ View</button>
                    </td>
                </tr>
            `;
        });
    }

    // Search filter
    if (searchInvoice) {
        searchInvoice.addEventListener('input', (e) => {
            const val = e.target.value.toLowerCase().trim();
            if (!val) {
                renderInvoices(allInvoices);
                return;
            }
            const filtered = allInvoices.filter(inv => 
                inv.invoice_number.toLowerCase().includes(val) ||
                inv.customer_name.toLowerCase().includes(val) ||
                inv.customer_phone.includes(val) ||
                (inv.customer_gstin && inv.customer_gstin.toLowerCase().includes(val))
            );
            renderInvoices(filtered);
        });
    }

    // 3. AUTOCOMPLETE SEARCH FOR CLIENTS
    if (invCustPhone) {
        invCustPhone.addEventListener('input', async (e) => {
            const val = e.target.value.trim();
            selectedCustomerId = null;
            
            if (val.length < 3) {
                custSearchResults.style.display = 'none';
                return;
            }

            if (api && api.searchCustomers) {
                const results = await api.searchCustomers(val);
                if (results.length > 0) {
                    custSearchResults.innerHTML = results.map(c => 
                        `<div class="search-item" data-id="${c.id}" data-name="${c.name}" data-phone="${c.phone}" data-gstin="${c.gstin || ''}" data-state="${c.state || 'Local'}">
                            ${c.phone} - ${c.name}
                        </div>`
                    ).join('');
                    custSearchResults.style.display = 'block';

                    custSearchResults.querySelectorAll('.search-item').forEach(item => {
                        item.addEventListener('click', () => {
                            invCustPhone.value = item.getAttribute('data-phone');
                            invCustName.value = item.getAttribute('data-name');
                            invCustGstin.value = item.getAttribute('data-gstin');
                            invStateType.value = item.getAttribute('data-state');
                            selectedCustomerId = item.getAttribute('data-id');
                            custSearchResults.style.display = 'none';
                            
                            triggerStateChange();
                        });
                    });
                } else {
                    custSearchResults.style.display = 'none';
                }
            }
        });
    }

    // Close autocomplete on blur
    document.addEventListener('click', (e) => {
        if (e.target !== invCustPhone && e.target !== custSearchResults) {
            if (custSearchResults) custSearchResults.style.display = 'none';
        }
    });

    // Toggle local vs interstate summaries
    if (invStateType) {
        invStateType.addEventListener('change', triggerStateChange);
    }

    function triggerStateChange() {
        if (!invStateType) return;
        const isInterstate = invStateType.value === 'Interstate';
        if (isInterstate) {
            if (rowSumCgst) rowSumCgst.style.display = 'none';
            if (rowSumSgst) rowSumSgst.style.display = 'none';
            if (rowSumIgst) rowSumIgst.style.display = 'flex';
        } else {
            if (rowSumCgst) rowSumCgst.style.display = 'flex';
            if (rowSumSgst) rowSumSgst.style.display = 'flex';
            if (rowSumIgst) rowSumIgst.style.display = 'none';
        }
        recalculateInvoiceTotals();
    }

    // 4. ITEMS ROW CREATION & MATHEMATICAL CALCULATIONS
    if (btnAddItemRow) {
        btnAddItemRow.addEventListener('click', () => addItemRow());
    }

    function addItemRow(data = {}) {
        const row = document.createElement('tr');
        row.className = 'item-row';
        
        row.innerHTML = `
            <td><input type="text" class="row-desc" placeholder="e.g. A4 Laser Printing" value="${data.description || ''}" required></td>
            <td><input type="text" class="row-hsn" placeholder="e.g. 998911" value="${data.hsn_sac || ''}"></td>
            <td><input type="number" class="row-qty" value="${data.qty || 1}" min="1" style="text-align: center;"></td>
            <td><input type="number" class="row-rate" value="${data.rate || 0}" min="0" step="0.5" style="text-align: right;"></td>
            <td>
                <select class="row-gst-rate">
                    <option value="0" ${data.gst_rate === 0 ? 'selected' : ''}>0% (Exempt)</option>
                    <option value="5" ${data.gst_rate === 5 ? 'selected' : ''}>5%</option>
                    <option value="12" ${data.gst_rate === 12 ? 'selected' : ''}>12%</option>
                    <option value="18" ${data.gst_rate === 18 || !data.gst_rate ? 'selected' : ''}>18% (Standard)</option>
                    <option value="28" ${data.gst_rate === 28 ? 'selected' : ''}>28%</option>
                </select>
            </td>
            <td style="text-align: right; font-weight: 700; padding-right:12px;" class="row-total-val">₹0.00</td>
            <td><button class="btn-delete-row">&times;</button></td>
        `;

        row.querySelector('.btn-delete-row').addEventListener('click', () => {
            row.remove();
            recalculateInvoiceTotals();
        });

        // Add inputs keyup/change listeners
        row.querySelectorAll('input, select').forEach(el => {
            el.addEventListener('input', recalculateInvoiceTotals);
        });

        billingItemsTbody.appendChild(row);
        recalculateInvoiceTotals();
    }

    function recalculateInvoiceTotals() {
        if (!billingItemsTbody) return;
        const rows = billingItemsTbody.querySelectorAll('.item-row');
        const stateType = invStateType ? invStateType.value : 'Local';
        
        let subtotalAccum = 0;
        let cgstAccum = 0;
        let sgstAccum = 0;
        let igstAccum = 0;
        let grandAccum = 0;

        rows.forEach(row => {
            const qty = parseInt(row.querySelector('.row-qty').value) || 0;
            const rate = parseFloat(row.querySelector('.row-rate').value) || 0;
            const gstRate = parseFloat(row.querySelector('.row-gst-rate').value) || 0;
            
            const taxable = qty * rate;
            const taxFactor = gstRate / 100;
            
            let rowCgst = 0;
            let rowSgst = 0;
            let rowIgst = 0;

            if (stateType === 'Local') {
                rowCgst = taxable * (taxFactor / 2);
                rowSgst = taxable * (taxFactor / 2);
            } else {
                rowIgst = taxable * taxFactor;
            }

            const rowTotal = taxable + rowCgst + rowSgst + rowIgst;

            row.querySelector('.row-total-val').textContent = `₹${rowTotal.toFixed(2)}`;

            subtotalAccum += taxable;
            cgstAccum += rowCgst;
            sgstAccum += rowSgst;
            igstAccum += rowIgst;
            grandAccum += rowTotal;
        });

        sumTaxable.textContent = `₹${subtotalAccum.toFixed(2)}`;
        sumCgst.textContent = `₹${cgstAccum.toFixed(2)}`;
        sumSgst.textContent = `₹${sgstAccum.toFixed(2)}`;
        sumIgst.textContent = `₹${igstAccum.toFixed(2)}`;
        sumGrand.textContent = `₹${grandAccum.toFixed(2)}`;
    }

    // 5. SAVE & LAUNCH BROWSER PRINT
    if (btnSavePrintInvoice) {
        btnSavePrintInvoice.addEventListener('click', async () => {
            const phone = invCustPhone.value.trim();
            const name = invCustName.value.trim();
            const gstin = invCustGstin.value.trim();
            const state = invStateType.value;

            if (!phone || !name) {
                alert("Please fill in customer details (phone and name) first!");
                return;
            }

            if (gstin && gstin.length !== 15) {
                alert("GSTIN must be exactly 15 alphanumeric characters!");
                return;
            }

            const rows = billingItemsTbody.querySelectorAll('.item-row');
            if (rows.length === 0) {
                alert("Please add at least one item to invoice!");
                return;
            }

            btnSavePrintInvoice.disabled = true;
            btnSavePrintInvoice.innerHTML = '⚙️ Generating Invoice...';

            try {
                // Ensure customer exists in the main database
                let custId = selectedCustomerId;
                if (!custId) {
                    const custResult = await api.createCustomer({ name, phone });
                    if (custResult.success) custId = custResult.id;
                    else throw new Error("Failed to register customer: " + custResult.error);
                }

                // If GSTIN or state changed, update customer info
                if (gstin || state) {
                    await api.updateCustomerGst(custId, gstin, state);
                }

                // Compile Invoice row details
                const itemsList = [];
                let subtotalTotal = 0;
                let cgstTotal = 0;
                let sgstTotal = 0;
                let igstTotal = 0;
                let grandTotal = 0;

                rows.forEach(row => {
                    const description = row.querySelector('.row-desc').value.trim();
                    const hsn_sac = row.querySelector('.row-hsn').value.trim();
                    const qty = parseInt(row.querySelector('.row-qty').value) || 0;
                    const rate = parseFloat(row.querySelector('.row-rate').value) || 0;
                    const gst_rate = parseFloat(row.querySelector('.row-gst-rate').value) || 0;

                    const taxable_value = qty * rate;
                    let cgst_amount = 0;
                    let sgst_amount = 0;
                    let igst_amount = 0;

                    if (state === 'Local') {
                        cgst_amount = taxable_value * (gst_rate / 200);
                        sgst_amount = taxable_value * (gst_rate / 200);
                    } else {
                        igst_amount = taxable_value * (gst_rate / 100);
                    }

                    const rowTotal = taxable_value + cgst_amount + sgst_amount + igst_amount;

                    itemsList.push({
                        description,
                        hsn_sac,
                        qty,
                        rate,
                        gst_rate,
                        taxable_value,
                        cgst_amount,
                        sgst_amount,
                        igst_amount,
                        total: rowTotal
                    });

                    subtotalTotal += taxable_value;
                    cgstTotal += cgst_amount;
                    sgstTotal += sgst_amount;
                    igstTotal += igst_amount;
                    grandTotal += rowTotal;
                });

                const invoiceHeader = {
                    customer_id: custId,
                    invoice_date: new Date().toISOString().split('T')[0],
                    subtotal: subtotalTotal,
                    cgst_total: cgstTotal,
                    sgst_total: sgstTotal,
                    igst_total: igstTotal,
                    grand_total: grandTotal,
                    state_type: state,
                    status: 'Paid',
                    gstin: gstin
                };

                const res = await api.createGstInvoice(invoiceHeader, itemsList);
                if (res.success) {
                    // Load print dialog
                    billingModal.style.display = 'none';
                    await openInvoicePrintPreview(res.id, res.invoiceNumber);
                    
                    // Reload data
                    await init();
                } else {
                    alert("Error saving invoice: " + res.error);
                }

            } catch (err) {
                alert("Transaction failed: " + err.message);
            }

            btnSavePrintInvoice.disabled = false;
            btnSavePrintInvoice.innerHTML = 'Save &amp; Print Invoice';
        });
    }

    // 6. POPULATE PRINT PREVIEW MODAL
    async function openInvoicePrintPreview(invoiceId, invoiceNumber) {
        const inv = allInvoices.find(i => i.id === invoiceId) || {
            invoice_number: invoiceNumber,
            invoice_date: new Date().toISOString().split('T')[0],
            customer_name: invCustName.value,
            customer_phone: invCustPhone.value,
            customer_gstin: invCustGstin.value,
            state_type: invStateType.value,
            subtotal: parseFloat(sumTaxable.textContent.replace('₹','')),
            cgst_total: parseFloat(sumCgst.textContent.replace('₹','')),
            sgst_total: parseFloat(sumSgst.textContent.replace('₹','')),
            igst_total: parseFloat(sumIgst.textContent.replace('₹','')),
            grand_total: parseFloat(sumGrand.textContent.replace('₹',''))
        };

        let items = [];
        if (api && api.getGstInvoiceItems) {
            items = await api.getGstInvoiceItems(invoiceId);
        }

        // Fetch shop details from settings
        let shopName = "PrintShop Tax Center";
        let shopGstin = "27AAAAA0000A1Z5 (Sample)";
        if (api && api.getSettings) {
            const settings = await api.getSettings();
            if (settings && settings.shop_name) shopName = settings.shop_name;
        }

        // Generate dynamic table rows
        const tableRowsHtml = items.map((item, idx) => `
            <tr>
                <td style="text-align: center;">${idx + 1}</td>
                <td><strong>${item.description}</strong></td>
                <td style="text-align: center;">${item.hsn_sac || '—'}</td>
                <td style="text-align: center;">${item.qty}</td>
                <td style="text-align: right;">₹${item.rate.toFixed(2)}</td>
                <td style="text-align: center;">${item.gst_rate}%</td>
                <td style="text-align: right;">₹${item.taxable_value.toFixed(2)}</td>
                <td style="text-align: right;">₹${item.total.toFixed(2)}</td>
            </tr>
        `).join('');

        // Generate CGST/SGST/IGST breakdown summary block
        let taxBreakdownHtml = '';
        if (inv.state_type === 'Local') {
            taxBreakdownHtml = `
                <div class="bill-sum-line">
                    <span>CGST Total:</span>
                    <span>₹${inv.cgst_total.toFixed(2)}</span>
                </div>
                <div class="bill-sum-line">
                    <span>SGST Total:</span>
                    <span>₹${inv.sgst_total.toFixed(2)}</span>
                </div>
            `;
        } else {
            taxBreakdownHtml = `
                <div class="bill-sum-line">
                    <span>IGST Total:</span>
                    <span>₹${inv.igst_total.toFixed(2)}</span>
                </div>
            `;
        }

        printableInvoice.innerHTML = `
            <div class="bill-company-header">
                <div class="company-logo-info">
                    <h1>${shopName}</h1>
                    <p>GSTIN: ${shopGstin}</p>
                    <p>Counter Tax Invoice Billing</p>
                </div>
                <div class="invoice-meta-block">
                    <h2>TAX INVOICE</h2>
                    <p><strong>Invoice No:</strong> ${inv.invoice_number}</p>
                    <p><strong>Date:</strong> ${new Date(inv.invoice_date).toLocaleDateString('en-IN')}</p>
                </div>
            </div>

            <div class="bill-parties-row">
                <div class="party-box">
                    <h4>Billed To (Recipient)</h4>
                    <p><strong>Name:</strong> ${inv.customer_name}</p>
                    <p><strong>Phone:</strong> ${inv.customer_phone}</p>
                    ${inv.customer_gstin ? `<p><strong>GSTIN:</strong> ${inv.customer_gstin}</p>` : ''}
                </div>
                <div class="party-box">
                    <h4>Place of Supply</h4>
                    <p><strong>State:</strong> ${inv.state_type === 'Local' ? 'Intra-State (Local Supply)' : 'Inter-State (IGST Supply)'}</p>
                    <p><strong>Payment Status:</strong> Paid</p>
                </div>
            </div>

            <table class="bill-items-table">
                <thead>
                    <tr>
                        <th style="width: 5%; text-align: center;">#</th>
                        <th style="width: 40%;">Description of Services</th>
                        <th style="width: 12%; text-align: center;">HSN/SAC</th>
                        <th style="width: 8%; text-align: center;">Qty</th>
                        <th style="width: 12%; text-align: right;">Rate</th>
                        <th style="width: 8%; text-align: center;">Tax</th>
                        <th style="width: 15%; text-align: right;">Taxable Value</th>
                        <th style="width: 15%; text-align: right;">Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRowsHtml}
                </tbody>
            </table>

            <div class="bill-summary-row">
                <div class="bill-summary-box">
                    <div class="bill-sum-line">
                        <span>Taxable Value:</span>
                        <span>₹${inv.subtotal.toFixed(2)}</span>
                    </div>
                    ${taxBreakdownHtml}
                    <div class="bill-sum-line bill-sum-grand">
                        <span>Grand Total:</span>
                        <span>₹${inv.grand_total.toFixed(2)}</span>
                    </div>
                </div>
            </div>

            <div class="bill-footer-notes">
                <p>This is a computer-generated tax invoice and requires no signature.</p>
                <p>Thank you for doing business with us!</p>
            </div>
        `;

        if (printPreviewModal) printPreviewModal.style.display = 'flex';
    }

    // Globally expose printer previews function so clicking View button works
    window.viewInvoiceDetail = (id) => {
        openInvoicePrintPreview(id, '');
    };

    // 7. EXPORT GSTR-1 TAX CSV FORMAT
    if (btnExportGstr) {
        btnExportGstr.addEventListener('click', () => {
            if (allInvoices.length === 0) {
                alert("No invoices found to export!");
                return;
            }

            let csvContent = "data:text/csv;charset=utf-8,";
            csvContent += "Invoice Number,Invoice Date,Customer Name,Customer Phone,Customer GSTIN,Supply Type,Taxable Value,CGST,SGST,IGST,Total Amount\n";

            allInvoices.forEach(inv => {
                const row = [
                    inv.invoice_number,
                    inv.invoice_date,
                    `"${inv.customer_name}"`,
                    inv.customer_phone,
                    inv.customer_gstin || 'N/A',
                    inv.state_type,
                    inv.subtotal.toFixed(2),
                    inv.cgst_total.toFixed(2),
                    inv.sgst_total.toFixed(2),
                    inv.igst_total.toFixed(2),
                    inv.grand_total.toFixed(2)
                ].join(',');
                csvContent += row + "\n";
            });

            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", `GSTR1_Export_${new Date().toISOString().split('T')[0]}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    }

    // Modal Control triggers
    if (btnOpenCreateInvoice) {
        btnOpenCreateInvoice.addEventListener('click', () => {
            if (invCustPhone) invCustPhone.value = '';
            if (invCustName) invCustName.value = '';
            if (invCustGstin) invCustGstin.value = '';
            if (invStateType) invStateType.value = 'Local';
            if (billingItemsTbody) billingItemsTbody.innerHTML = '';
            selectedCustomerId = null;
            
            addItemRow();
            triggerStateChange();
            
            if (billingModal) billingModal.style.display = 'flex';
            setTimeout(() => { if (invCustPhone) invCustPhone.focus(); }, 100);
        });
    }

    if (btnCloseBillingModal) btnCloseBillingModal.addEventListener('click', () => { if (billingModal) billingModal.style.display = 'none'; });
    if (btnCancelInvoice) btnCancelInvoice.addEventListener('click', () => { if (billingModal) billingModal.style.display = 'none'; });
    
    if (btnClosePrintModal) btnClosePrintModal.addEventListener('click', () => { if (printPreviewModal) printPreviewModal.style.display = 'none'; });
    
    if (btnTriggerPrint) {
        btnTriggerPrint.addEventListener('click', () => {
            window.print();
        });
    }

    // Initialize application data
    init();
});
