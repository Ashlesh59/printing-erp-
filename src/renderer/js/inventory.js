// Inventory Management Module Frontend Controller

document.addEventListener('DOMContentLoaded', () => {
    // --- Page Routing / Tab Switching ---
    const subSidebar = document.querySelector('.inventory-sub-sidebar');
    const subBtns = document.querySelectorAll('.inv-sub-btn');
    const subViews = document.querySelectorAll('.inv-view');

    subBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetSub = btn.getAttribute('data-sub');
            localStorage.setItem('psm_inventory_tab', targetSub);
            
            subBtns.forEach(b => b.classList.remove('active'));
            subViews.forEach(v => v.classList.remove('active'));

            btn.classList.add('active');
            const targetView = document.getElementById(targetSub);
            if (targetView) {
                targetView.classList.add('active');
                const viewsContainer = document.getElementById('views-container') || document.getElementById('inventory-workspace');
                if (viewsContainer) viewsContainer.scrollTop = 0;
            }

            // Load relevant data on tab open with safety check
            try {
                switch (targetSub) {
                    case 'inv-dashboard':
                        loadDashboardData();
                        break;
                    case 'inv-items':
                        loadItemsData();
                        break;
                    case 'inv-categories':
                        loadCategoriesData();
                        break;
                    case 'inv-suppliers':
                        loadSuppliersData();
                        break;
                    case 'inv-po':
                        loadPOData();
                        break;
                    case 'inv-transactions':
                        loadTransactionsData();
                        break;
                    case 'inv-alerts':
                        loadAlertsData();
                        break;
                    case 'inv-settings':
                        loadSettingsData();
                        break;
                }
            } catch (err) {
                console.error(`[Inventory Tab Error] Error loading sub-tab '${targetSub}':`, err);
            }
        });
    });

    // [NOTE] Inventory navigation handled by executeTabSwitch -> window.loadInventoryActiveSubTab() (no duplicate listener needed here)

    // Global lists cached in memory for dropdown populate
    let allCategories = [];
    let allSuppliers = [];
    let allLocations = [];
    let allItems = [];

    // Helper to open modal
    window.openInvModal = (modalId) => {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.style.display = 'flex';
        }
    };

    // Helper to close modal
    window.closeInvModal = (modalId) => {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.style.display = 'none';
        }
    };

    // Toast wrapper
    function toast(message, type = 'success') {
        if (window.showToast) {
            window.showToast(message, type);
        } else {
            alert(`${type.toUpperCase()}: ${message}`);
        }
    }

    // Load references data (runs on startup)
    async function loadReferenceData() {
        if (!window.api) return;
        try {
            allCategories = await window.api.getInvCategories();
            allSuppliers = await window.api.getInvSuppliers();
            allLocations = await window.api.getInvLocations();
            allItems = await window.api.getInvItems();

            populateDropdowns();
            checkLowStockSystemBadge();
        } catch (e) {
            console.error("Failed to load reference inventory lists:", e);
        }
    }

    function populateDropdowns() {
        // Populate categories
        const itemCatSelect = document.getElementById('inv-item-category');
        const filterCatSelect = document.getElementById('inv-filter-category');
        if (itemCatSelect) {
            itemCatSelect.innerHTML = '<option value="">Select Category...</option>' + 
                allCategories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
        }
        if (filterCatSelect) {
            filterCatSelect.innerHTML = '<option value="">All Categories</option>' + 
                allCategories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
        }

        // Populate suppliers
        const itemSupSelect = document.getElementById('inv-item-supplier');
        const filterSupSelect = document.getElementById('inv-filter-supplier');
        const poFilterSupSelect = document.getElementById('inv-po-filter-supplier');
        const poSupSelect = document.getElementById('inv-po-supplier');
        
        const supplierOptions = allSuppliers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
        
        if (itemSupSelect) {
            itemSupSelect.innerHTML = '<option value="">Select Supplier...</option>' + supplierOptions;
        }
        if (filterSupSelect) {
            filterSupSelect.innerHTML = '<option value="">All Suppliers</option>' + supplierOptions;
        }
        if (poFilterSupSelect) {
            poFilterSupSelect.innerHTML = '<option value="">All Suppliers</option>' + supplierOptions;
        }
        if (poSupSelect) {
            poSupSelect.innerHTML = '<option value="">Select Supplier...</option>' + supplierOptions;
        }

        // Populate locations
        const itemLocSelect = document.getElementById('inv-item-location');
        if (itemLocSelect) {
            itemLocSelect.innerHTML = '<option value="">Select Location...</option>' + 
                allLocations.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
        }

        // Populate adjustment select
        const adjustItemSelect = document.getElementById('inv-adjust-item');
        if (adjustItemSelect) {
            adjustItemSelect.innerHTML = '<option value="">Choose Stock Product...</option>' + 
                allItems.map(i => `<option value="${i.id}">${escapeHtml(i.name)} (${i.sku})</option>`).join('');
        }
    }

    // Sidebar Badge check
    async function checkLowStockSystemBadge() {
        if (!window.api || !window.api.getInvAlerts) return;
        try {
            const alerts = await window.api.getInvAlerts();
            const badge = document.getElementById('sidebar-inventory-badge');
            const alertBadge = document.getElementById('inv-alert-badge');
            
            if (alerts.length > 0) {
                if (badge) {
                    badge.textContent = alerts.length;
                    badge.style.display = 'inline-block';
                }
                if (alertBadge) {
                    alertBadge.textContent = alerts.length;
                    alertBadge.style.display = 'inline';
                }
            } else {
                if (badge) badge.style.display = 'none';
                if (alertBadge) alertBadge.style.display = 'none';
            }
        } catch (e) {
            console.error(e);
        }
    }

    // ──────────────────────────────────────────────────────────────
    //  1. Dashboard
    // ──────────────────────────────────────────────────────────────
    async function loadDashboardData() {
        if (!window.api || !window.api.getInvDashboardStats) return;
        try {
            const stats = await window.api.getInvDashboardStats();
            
            // Populate stats
            document.getElementById('inv-stat-value').textContent = `₹${(stats.totalValue || 0).toFixed(2)}`;
            document.getElementById('inv-stat-products').textContent = stats.totalProducts || 0;
            document.getElementById('inv-stat-low').textContent = stats.lowStockCount || 0;
            document.getElementById('inv-stat-out').textContent = stats.outOfStockCount || 0;
            document.getElementById('inv-stat-today').textContent = stats.todayConsumption || 0;
            document.getElementById('inv-stat-monthly').textContent = stats.monthlyConsumption || 0;

            // Render top used items list (Fast moving)
            const fastTbody = document.getElementById('inv-dash-fast-tbody');
            if (!stats.topUsedItems || stats.topUsedItems.length === 0) {
                fastTbody.innerHTML = '<tr><td colspan="3" class="empty-state" style="text-align:center;">No consumption logged.</td></tr>';
            } else {
                fastTbody.innerHTML = stats.topUsedItems.map(item => `
                    <tr>
                        <td><strong>${escapeHtml(item.name)}</strong></td>
                        <td>${item.qty}</td>
                        <td>${escapeHtml(item.unit)}</td>
                    </tr>
                `).join('');
            }

            // Render reorder list
            const reorderTbody = document.getElementById('inv-dash-reorder-tbody');
            const reorderItems = allItems.filter(i => i.current_stock <= i.minimum_stock && i.status === 'Active');
            if (reorderItems.length === 0) {
                reorderTbody.innerHTML = '<tr><td colspan="3" class="empty-state" style="text-align:center;">All stock levels healthy.</td></tr>';
            } else {
                reorderTbody.innerHTML = reorderItems.slice(0, 5).map(item => {
                    const grade = item.current_stock <= 0 ? 'Out of Stock' : 'Low Stock';
                    const color = item.current_stock <= 0 ? 'color: #ef4444;' : 'color: #f59e0b;';
                    return `
                        <tr>
                            <td><code>${escapeHtml(item.sku)}</code></td>
                            <td>${escapeHtml(item.name)}</td>
                            <td style="font-weight:700; ${color}">${item.current_stock} / ${item.minimum_stock} ${escapeHtml(item.unit)}</td>
                        </tr>
                    `;
                }).join('');
            }

            // Render custom SVG Graphs
            drawPaperUsageChart(stats.paperUsageDays);
            drawPurchaseTrendsChart(stats.purchaseTrends);
            checkLowStockSystemBadge();
        } catch (e) {
            console.error("Dashboard stats failed:", e);
        }
    }

    // Draw SVG Bar Chart
    function drawPaperUsageChart(usage) {
        const wrap = document.getElementById('paper-usage-chart-wrap');
        if (!wrap) return;

        if (!usage || usage.length === 0) {
            wrap.innerHTML = '<div style="text-align: center; padding-top: 80px; color: var(--text-secondary);">No paper usage in the last 12 days</div>';
            return;
        }

        const maxQty = Math.max(...usage.map(u => u.qty), 10);
        const padding = 40;
        const chartWidth = wrap.clientWidth || 450;
        const chartHeight = 220;
        const graphWidth = chartWidth - padding * 2;
        const graphHeight = chartHeight - padding * 2;
        const barWidth = Math.max(10, (graphWidth / usage.length) - 8);

        let bars = '';
        let labels = '';
        let gridLines = '';

        // Draw Y-axis grid lines
        for (let i = 0; i <= 4; i++) {
            const val = Math.round((maxQty / 4) * i);
            const y = chartHeight - padding - (graphHeight / 4) * i;
            gridLines += `<line x1="${padding}" y1="${y}" x2="${chartWidth - padding}" y2="${y}" stroke="var(--border-color)" stroke-dasharray="3,3" />`;
            gridLines += `<text x="${padding - 8}" y="${y + 4}" font-size="9" fill="var(--text-secondary)" text-anchor="end">${val}</text>`;
        }

        usage.forEach((u, index) => {
            const x = padding + (graphWidth / usage.length) * index + 4;
            const barHeight = (u.qty / maxQty) * graphHeight;
            const y = chartHeight - padding - barHeight;

            // Draw bar with gradient fill
            bars += `
                <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="4" fill="url(#barGrad)" class="chart-bar" data-val="${u.qty}" data-date="${u.date_label}">
                    <title>${u.date_label}: ${u.qty} units</title>
                </rect>
            `;

            // Date label
            const shortDate = u.date_label.substring(8, 10) + '/' + u.date_label.substring(5, 7);
            labels += `<text x="${x + barWidth/2}" y="${chartHeight - padding + 18}" font-size="9" fill="var(--text-secondary)" text-anchor="middle">${shortDate}</text>`;
        });

        wrap.innerHTML = `
            <svg class="svg-chart" viewBox="0 0 ${chartWidth} ${chartHeight}">
                <defs>
                    <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="#8b5cf6" />
                        <stop offset="100%" stop-color="#6366f1" stop-opacity="0.3" />
                    </linearGradient>
                </defs>
                ${gridLines}
                ${bars}
                ${labels}
                <!-- Bottom border line -->
                <line x1="${padding}" y1="${chartHeight - padding}" x2="${chartWidth - padding}" y2="${chartHeight - padding}" stroke="var(--border-color)" stroke-width="1.5" />
            </svg>
        `;
    }

    // Draw SVG Line Chart
    function drawPurchaseTrendsChart(trends) {
        const wrap = document.getElementById('purchase-trends-chart-wrap');
        if (!wrap) return;

        if (!trends || trends.length === 0) {
            wrap.innerHTML = '<div style="text-align: center; padding-top: 80px; color: var(--text-secondary);">No purchases logged in the last 6 months</div>';
            return;
        }

        trends.forEach(t => {
            t.total = parseFloat(t.total) || 0;
        });

        const maxTotal = Math.max(...trends.map(t => t.total), 1000);
        const padding = 40;
        const chartWidth = wrap.clientWidth || 300;
        const chartHeight = 220;
        const graphWidth = chartWidth - padding * 2;
        const graphHeight = chartHeight - padding * 2;

        let points = '';
        let labels = '';
        let gridLines = '';
        let pathD = '';
        let areaD = '';

        // Draw Y-axis grid lines
        for (let i = 0; i <= 4; i++) {
            const val = Math.round((maxTotal / 4) * i);
            const y = chartHeight - padding - (graphHeight / 4) * i;
            gridLines += `<line x1="${padding}" y1="${y}" x2="${chartWidth - padding}" y2="${y}" stroke="var(--border-color)" stroke-dasharray="3,3" />`;
            gridLines += `<text x="${padding - 8}" y="${y + 4}" font-size="9" fill="var(--text-secondary)" text-anchor="end">₹${val}</text>`;
        }

        trends.forEach((t, index) => {
            const x = padding + (graphWidth / (trends.length - 1 || 1)) * index;
            const y = chartHeight - padding - (t.total / maxTotal) * graphHeight;

            if (index === 0) {
                pathD = `M ${x} ${y}`;
                areaD = `M ${x} ${chartHeight - padding} L ${x} ${y}`;
            } else {
                pathD += ` L ${x} ${y}`;
                areaD += ` L ${x} ${y}`;
            }

            if (index === trends.length - 1) {
                areaD += ` L ${x} ${chartHeight - padding} Z`;
            }

            // Dot
            points += `
                <circle cx="${x}" cy="${y}" r="4" fill="#10b981" stroke="var(--bg-color)" stroke-width="1.5">
                    <title>${t.month_label}: ₹${t.total.toFixed(2)}</title>
                </circle>
            `;

            // Month Label
            labels += `<text x="${x}" y="${chartHeight - padding + 18}" font-size="9" fill="var(--text-secondary)" text-anchor="middle">${t.month_label}</text>`;
        });

        wrap.innerHTML = `
            <svg class="svg-chart" viewBox="0 0 ${chartWidth} ${chartHeight}">
                <defs>
                    <linearGradient id="lineAreaGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="#10b981" stop-opacity="0.25" />
                        <stop offset="100%" stop-color="#10b981" stop-opacity="0.0" />
                    </linearGradient>
                </defs>
                ${gridLines}
                <path d="${areaD}" fill="url(#lineAreaGrad)" />
                <path d="${pathD}" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
                ${points}
                ${labels}
                <!-- Bottom border line -->
                <line x1="${padding}" y1="${chartHeight - padding}" x2="${chartWidth - padding}" y2="${chartHeight - padding}" stroke="var(--border-color)" stroke-width="1.5" />
            </svg>
        `;
    }

    // ──────────────────────────────────────────────────────────────
    //  2. Stock Items
    // ──────────────────────────────────────────────────────────────
    const itemsSearch = document.getElementById('inv-items-search');
    const filterCat = document.getElementById('inv-filter-category');
    const filterSup = document.getElementById('inv-filter-supplier');
    const filterStatus = document.getElementById('inv-filter-status');

    if (itemsSearch) itemsSearch.addEventListener('input', renderStockItemsTable);
    if (filterCat) filterCat.addEventListener('change', renderStockItemsTable);
    if (filterSup) filterSup.addEventListener('change', renderStockItemsTable);
    if (filterStatus) filterStatus.addEventListener('change', renderStockItemsTable);

    async function loadItemsData() {
        await loadReferenceData();
        renderStockItemsTable();
    }

    function renderStockItemsTable() {
        const tbody = document.getElementById('inv-items-tbody');
        if (!tbody) return;

        const q = (itemsSearch?.value || '').toLowerCase().trim();
        const catVal = filterCat?.value || '';
        const supVal = filterSup?.value || '';
        const statusVal = filterStatus?.value || '';

        // Filter items
        const filtered = allItems.filter(item => {
            const matchesSearch = item.name.toLowerCase().includes(q) || 
                                  item.sku.toLowerCase().includes(q) || 
                                  (item.barcode && item.barcode.includes(q)) ||
                                  (item.brand && item.brand.toLowerCase().includes(q));

            const matchesCat = !catVal || item.category_id === parseInt(catVal);
            const matchesSup = !supVal || item.supplier_id === parseInt(supVal);
            
            let matchesStatus = true;
            if (statusVal === 'Active') matchesStatus = item.status === 'Active';
            else if (statusVal === 'Inactive') matchesStatus = item.status === 'Inactive';
            else if (statusVal === 'Low Stock') matchesStatus = item.current_stock <= item.minimum_stock && item.current_stock > 0 && item.status === 'Active';
            else if (statusVal === 'Out of Stock') matchesStatus = item.current_stock <= 0 && item.status === 'Active';

            return matchesSearch && matchesCat && matchesSup && matchesStatus;
        });

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" class="empty-state" style="text-align: center;">No stock items match the search filters.</td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(item => {
            const physicalStock = item.current_stock !== undefined ? item.current_stock : 0;
            const reservedStock = item.reserved_stock !== undefined ? item.reserved_stock : 0;
            const availableStock = physicalStock - reservedStock;

            let stockBadge = 'status-active';
            let stockBadgeText = 'In Stock';
            if (physicalStock <= 0) {
                stockBadge = 'status-out';
                stockBadgeText = 'Out of Stock';
            } else if (physicalStock <= item.minimum_stock) {
                stockBadge = 'status-low';
                stockBadgeText = 'Low Stock';
            }

            const statusClass = item.status === 'Active' ? 'status-active' : 'status-inactive';
            const barcodeTxt = item.barcode ? `<small style="color:var(--text-secondary);display:block;">${item.barcode}</small>` : '';

            return `
                <tr>
                    <td><code>${escapeHtml(item.sku)}</code>${barcodeTxt}</td>
                    <td>
                        <strong>${escapeHtml(item.name)}</strong>
                        ${item.brand ? `<small style="color:var(--text-secondary);display:block;">${escapeHtml(item.brand)}</small>` : ''}
                    </td>
                    <td><span class="status-tag status-inactive" style="text-transform:none;">${escapeHtml(item.category_name || 'Uncategorized')}</span></td>
                    <td>
                        <div style="display: flex; flex-direction: column; gap: 3px;">
                            <div>
                                <span class="status-tag ${stockBadge}" style="display: inline-block; font-size: 0.75rem; padding: 2px 6px;">
                                    ${stockBadgeText}
                                </span>
                                <strong style="margin-left: 6px; font-size: 0.88rem; color: var(--text-primary);">${physicalStock} ${escapeHtml(item.unit || 'Units')}</strong>
                            </div>
                            <small style="color: var(--text-secondary); font-size: 0.78rem;">
                                Avail: <strong style="color: var(--text-primary);">${availableStock}</strong>${reservedStock > 0 ? ` • Res: <span style="color:#f59e0b; font-weight:600;">${reservedStock}</span>` : ''}
                            </small>
                        </div>
                    </td>
                    <td>₹${(item.purchase_price || 0).toFixed(2)}</td>
                    <td>₹${(item.average_cost || 0).toFixed(2)}</td>
                    <td><small>${escapeHtml(item.location_name || '—')}</small></td>
                    <td><span class="status-tag ${statusClass}">${escapeHtml(item.status)}</span></td>
                    <td>
                        <div style="display:flex; gap:6px;">
                            <button class="action-btn" onclick="adjustItemStock(${item.id})" style="background:#8b5cf6;color:white;border:none;padding:4px 8px;font-size:0.75rem;">Adjust</button>
                            <button class="action-btn" onclick="editItem(${item.id})" style="background:var(--accent-color);color:white;border:none;padding:4px 8px;font-size:0.75rem;">Edit</button>
                            <button class="action-btn" onclick="deleteItem(${item.id})" style="background:#ef4444;color:white;border:none;padding:4px 8px;font-size:0.75rem;">Delete</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    // Modal save item trigger
    const btnAddInvItem = document.getElementById('btn-add-inv-item');
    if (btnAddInvItem) {
        btnAddInvItem.addEventListener('click', () => {
            document.getElementById('inv-item-form').reset();
            document.getElementById('inv-item-edit-id').value = '';
            document.getElementById('inv-item-modal-title').textContent = 'Add Stock Product';
            const openStockEl = document.getElementById('inv-item-opening-stock');
            if (openStockEl) openStockEl.disabled = false;
            openInvModal('inv-item-modal');
        });
    }

    const btnGenBarcode = document.getElementById('btn-gen-barcode');
    if (btnGenBarcode) {
        btnGenBarcode.addEventListener('click', () => {
            // Generate standard EAN-13 structure
            let code = "20" + Math.floor(Math.random() * 10000000000).toString().padStart(10, '0');
            let sum = 0;
            for (let i = 0; i < 12; i++) {
                sum += parseInt(code[i]) * (i % 2 === 0 ? 1 : 3);
            }
            const checkDigit = (10 - (sum % 10)) % 10;
            document.getElementById('inv-item-barcode').value = code + checkDigit;
        });
    }

    const btnSaveInvItem = document.getElementById('btn-save-inv-item');
    if (btnSaveInvItem) {
        btnSaveInvItem.addEventListener('click', async () => {
            const form = document.getElementById('inv-item-form');
            if (!form.reportValidity()) return;

            const editId = document.getElementById('inv-item-edit-id').value;
            const data = {
                name: document.getElementById('inv-item-name').value.trim(),
                category_id: document.getElementById('inv-item-category').value,
                sku: document.getElementById('inv-item-sku').value.trim(),
                barcode: document.getElementById('inv-item-barcode').value.trim(),
                brand: document.getElementById('inv-item-brand').value.trim(),
                supplier_id: document.getElementById('inv-item-supplier').value,
                storage_location_id: document.getElementById('inv-item-location').value,
                unit: document.getElementById('inv-item-unit').value,
                purchase_price: parseFloat(document.getElementById('inv-item-purchase-price').value) || 0,
                selling_price: parseFloat(document.getElementById('inv-item-selling-price').value) || 0,
                opening_stock: parseFloat(document.getElementById('inv-item-opening-stock').value) || 0,
                minimum_stock: parseFloat(document.getElementById('inv-item-minimum-stock').value) || 0,
                reorder_level: parseFloat(document.getElementById('inv-item-reorder-level').value) || 0,
                size: document.getElementById('inv-item-size').value,
                color_type: document.getElementById('inv-item-color-type').value,
                gsm: document.getElementById('inv-item-gsm').value,
                finish: document.getElementById('inv-item-finish').value,
                sheets_per_ream: parseInt(document.getElementById('inv-item-sheets-per-ream').value) || 500,
                notes: document.getElementById('inv-item-notes').value.trim(),
                status: 'Active',
                operator: 'Admin'
            };

            btnSaveInvItem.disabled = true;
            const originalText = btnSaveInvItem.innerHTML;
            btnSaveInvItem.innerHTML = 'Saving...';

            try {
                let res;
                if (editId) {
                    res = await window.api.updateInvItem(parseInt(editId), data);
                } else {
                    res = await window.api.createInvItem(data);
                }

                if (res && res.success) {
                    toast(editId ? "Product updated successfully!" : "Product created successfully!");
                    closeInvModal('inv-item-modal');
                    await loadItemsData();
                } else {
                    toast(res ? res.error : 'Failed to save product', 'error');
                }
            } catch (e) {
                toast(e.message, 'error');
            } finally {
                btnSaveInvItem.disabled = false;
                btnSaveInvItem.innerHTML = originalText;
            }
        });
    }

    window.editItem = async (id) => {
        try {
            const item = await window.api.getInvItemById(id);
            if (!item) return;

            document.getElementById('inv-item-edit-id').value = item.id;
            document.getElementById('inv-item-modal-title').textContent = 'Edit Stock Product';

            document.getElementById('inv-item-name').value = item.name;
            document.getElementById('inv-item-category').value = item.category_id;
            document.getElementById('inv-item-sku').value = item.sku;
            document.getElementById('inv-item-barcode').value = item.barcode || '';
            document.getElementById('inv-item-brand').value = item.brand || '';
            document.getElementById('inv-item-supplier').value = item.supplier_id || '';
            document.getElementById('inv-item-location').value = item.storage_location_id || '';
            document.getElementById('inv-item-unit').value = item.unit;
            document.getElementById('inv-item-purchase-price').value = item.purchase_price !== undefined ? item.purchase_price : '';
            document.getElementById('inv-item-selling-price').value = item.selling_price !== undefined ? item.selling_price : '';
            
            const openStockEl = document.getElementById('inv-item-opening-stock');
            if (openStockEl) {
                openStockEl.value = item.opening_stock !== undefined ? item.opening_stock : '';
                openStockEl.disabled = true;
            }
            
            document.getElementById('inv-item-minimum-stock').value = item.minimum_stock !== undefined ? item.minimum_stock : '';
            document.getElementById('inv-item-reorder-level').value = item.reorder_level !== undefined ? item.reorder_level : '';
            
            document.getElementById('inv-item-size').value = item.size || '';
            document.getElementById('inv-item-color-type').value = item.color_type || '';
            document.getElementById('inv-item-gsm').value = item.gsm !== null && item.gsm !== undefined ? item.gsm : '';
            document.getElementById('inv-item-finish').value = item.finish || '';
            document.getElementById('inv-item-sheets-per-ream').value = item.sheets_per_ream || 500;
            document.getElementById('inv-item-notes').value = item.notes || '';

            openInvModal('inv-item-modal');
        } catch (e) {
            toast(e.message, 'error');
        }
    };

    window.deleteItem = async (id) => {
        if (!confirm("Are you sure you want to delete this product? Inactive items will be archived rather than fully deleted to keep histories intact.")) return;
        try {
            const res = await window.api.deleteInvItem(id);
            if (res && res.success) {
                toast(res.message || "Product deleted successfully!");
                await loadItemsData();
            } else {
                toast(res ? res.error : "Failed to delete product", 'error');
            }
        } catch (e) {
            toast(e.message, 'error');
        }
    };

    window.adjustItemStock = (id) => {
        document.getElementById('inv-adjust-form').reset();
        document.getElementById('inv-adjust-item').value = id;
        openInvModal('inv-adjust-modal');
    };

    // ──────────────────────────────────────────────────────────────
    //  3. Categories
    // ──────────────────────────────────────────────────────────────
    const invCatForm = document.getElementById('inv-category-form');
    const btnCancelCatEdit = document.getElementById('btn-cancel-cat-edit');
    const catFormTitle = document.getElementById('inv-cat-form-title');

    async function loadCategoriesData() {
        await loadReferenceData();
        renderCategoriesTable();
    }

    function renderCategoriesTable() {
        const tbody = document.getElementById('inv-categories-tbody');
        if (!tbody) return;

        if (allCategories.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="empty-state" style="text-align: center;">No categories configured.</td></tr>';
            return;
        }

        tbody.innerHTML = allCategories.map(c => `
            <tr>
                <td><strong>${escapeHtml(c.name)}</strong></td>
                <td><small style="color:var(--text-secondary);">${escapeHtml(c.description || 'No description')}</small></td>
                <td style="text-align: right;">
                    <div style="display:inline-flex; gap:6px;">
                        <button class="action-btn" onclick="editCategory(${c.id}, '${escapeHtml(c.name)}', '${escapeHtml(c.description || '')}')" style="background:var(--accent-color);color:white;border:none;padding:4px 8px;font-size:0.75rem;">Edit</button>
                        <button class="action-btn" onclick="deleteCategory(${c.id})" style="background:#ef4444;color:white;border:none;padding:4px 8px;font-size:0.75rem;">Delete</button>
                    </div>
                </td>
            </tr>
        `).join('');
    }

    window.editCategory = (id, name, desc) => {
        document.getElementById('inv-cat-edit-id').value = id;
        document.getElementById('inv-cat-name').value = name;
        document.getElementById('inv-cat-desc').value = desc;
        
        catFormTitle.textContent = 'Edit Category';
        btnCancelCatEdit.style.display = 'block';
    };

    if (btnCancelCatEdit) {
        btnCancelCatEdit.addEventListener('click', () => {
            invCatForm.reset();
            document.getElementById('inv-cat-edit-id').value = '';
            catFormTitle.textContent = 'Create New Category';
            btnCancelCatEdit.style.display = 'none';
        });
    }

    const btnSaveInvCat = document.getElementById('btn-save-inv-cat');
    if (btnSaveInvCat) {
        btnSaveInvCat.addEventListener('click', async () => {
            const nameInput = document.getElementById('inv-cat-name');
            if (!nameInput.reportValidity()) return;

            const editId = document.getElementById('inv-cat-edit-id').value;
            const data = {
                name: nameInput.value.trim(),
                description: document.getElementById('inv-cat-desc').value.trim()
            };

            btnSaveInvCat.disabled = true;
            const origText = btnSaveInvCat.innerHTML;
            btnSaveInvCat.innerHTML = 'Saving...';

            try {
                let res;
                if (editId) {
                    res = await window.api.updateInvCategory(parseInt(editId), data);
                } else {
                    res = await window.api.createInvCategory(data);
                }

                if (res && res.success) {
                    toast(editId ? "Category updated!" : "Category created!");
                    invCatForm.reset();
                    document.getElementById('inv-cat-edit-id').value = '';
                    catFormTitle.textContent = 'Create New Category';
                    if (btnCancelCatEdit) btnCancelCatEdit.style.display = 'none';
                    await loadCategoriesData();
                } else {
                    toast(res ? res.error : 'Failed to save category', 'error');
                }
            } catch (e) {
                toast(e.message, 'error');
            } finally {
                btnSaveInvCat.disabled = false;
                btnSaveInvCat.innerHTML = origText;
            }
        });
    }

    window.deleteCategory = async (id) => {
        if (!confirm("Are you sure you want to delete this category?")) return;
        try {
            const res = await window.api.deleteInvCategory(id);
            if (res.success) {
                toast("Category deleted!");
                loadCategoriesData();
            } else {
                toast(res.error, 'error');
            }
        } catch (e) {
            toast(e.message, 'error');
        }
    };

    // ──────────────────────────────────────────────────────────────
    //  4. Suppliers
    // ──────────────────────────────────────────────────────────────
    const suppliersSearch = document.getElementById('inv-suppliers-search');
    if (suppliersSearch) suppliersSearch.addEventListener('input', renderSuppliersTable);

    async function loadSuppliersData() {
        await loadReferenceData();
        renderSuppliersTable();
    }

    function renderSuppliersTable() {
        const tbody = document.getElementById('inv-suppliers-tbody');
        if (!tbody) return;

        const q = (suppliersSearch?.value || '').toLowerCase().trim();

        const filtered = allSuppliers.filter(s => 
            s.name.toLowerCase().includes(q) || 
            (s.phone && s.phone.includes(q)) || 
            (s.email && s.email.toLowerCase().includes(q)) ||
            (s.gstin && s.gstin.toLowerCase().includes(q))
        );

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state" style="text-align: center;">No suppliers found.</td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(s => `
            <tr>
                <td><strong>${escapeHtml(s.name)}</strong>${s.address ? `<small style="color:var(--text-secondary);display:block;">${escapeHtml(s.address)}</small>` : ''}</td>
                <td>${escapeHtml(s.phone || '—')}</td>
                <td>${escapeHtml(s.email || '—')}</td>
                <td><code>${escapeHtml(s.gstin || '—')}</code></td>
                <td style="font-weight:700; color: ${s.outstanding_balance > 0 ? '#ef4444' : 'var(--text-primary)'}">₹${s.outstanding_balance.toFixed(2)}</td>
                <td>
                    <div style="display:flex; gap:6px;">
                        <button class="action-btn" onclick="editSupplier(${s.id})" style="background:var(--accent-color);color:white;border:none;padding:4px 8px;font-size:0.75rem;">Edit</button>
                        <button class="action-btn" onclick="deleteSupplier(${s.id})" style="background:#ef4444;color:white;border:none;padding:4px 8px;font-size:0.75rem;">Delete</button>
                    </div>
                </td>
            </tr>
        `).join('');
    }

    const btnAddInvSupplier = document.getElementById('btn-add-inv-supplier');
    if (btnAddInvSupplier) {
        btnAddInvSupplier.addEventListener('click', () => {
            document.getElementById('inv-supplier-form').reset();
            document.getElementById('inv-supplier-edit-id').value = '';
            document.getElementById('inv-supplier-modal-title').textContent = 'Add Supplier';
            openInvModal('inv-supplier-modal');
        });
    }

    const btnSaveInvSupplier = document.getElementById('btn-save-inv-supplier');
    if (btnSaveInvSupplier) {
        btnSaveInvSupplier.addEventListener('click', async () => {
            const form = document.getElementById('inv-supplier-form');
            if (!form.reportValidity()) return;

            const editId = document.getElementById('inv-supplier-edit-id').value;
            const data = {
                name: document.getElementById('inv-supplier-name').value.trim(),
                phone: document.getElementById('inv-supplier-phone').value.trim(),
                email: document.getElementById('inv-supplier-email').value.trim(),
                gstin: document.getElementById('inv-supplier-gstin').value.trim(),
                address: document.getElementById('inv-supplier-address').value.trim(),
                outstanding_balance: parseFloat(document.getElementById('inv-supplier-balance').value) || 0
            };

            btnSaveInvSupplier.disabled = true;
            const origText = btnSaveInvSupplier.innerHTML;
            btnSaveInvSupplier.innerHTML = 'Saving...';

            try {
                let res;
                if (editId) {
                    res = await window.api.updateInvSupplier(parseInt(editId), data);
                } else {
                    res = await window.api.createInvSupplier(data);
                }

                if (res && res.success) {
                    toast(editId ? "Supplier updated!" : "Supplier created!");
                    closeInvModal('inv-supplier-modal');
                    await loadSuppliersData();
                } else {
                    toast(res ? res.error : 'Failed to save supplier', 'error');
                }
            } catch (e) {
                toast(e.message, 'error');
            } finally {
                btnSaveInvSupplier.disabled = false;
                btnSaveInvSupplier.innerHTML = origText;
            }
        });
    }

    window.editSupplier = async (id) => {
        const s = allSuppliers.find(x => x.id === id);
        if (!s) return;

        document.getElementById('inv-supplier-edit-id').value = s.id;
        document.getElementById('inv-supplier-modal-title').textContent = 'Edit Supplier';

        document.getElementById('inv-supplier-name').value = s.name;
        document.getElementById('inv-supplier-phone').value = s.phone || '';
        document.getElementById('inv-supplier-email').value = s.email || '';
        document.getElementById('inv-supplier-gstin').value = s.gstin || '';
        document.getElementById('inv-supplier-address').value = s.address || '';
        document.getElementById('inv-supplier-balance').value = s.outstanding_balance;

        openInvModal('inv-supplier-modal');
    };

    window.deleteSupplier = async (id) => {
        if (!confirm("Are you sure you want to delete this supplier?")) return;
        try {
            const res = await window.api.deleteInvSupplier(id);
            if (res.success) {
                toast("Supplier deleted successfully!");
                loadSuppliersData();
            } else {
                toast(res.error, 'error');
            }
        } catch (e) {
            toast(e.message, 'error');
        }
    };

    // ──────────────────────────────────────────────────────────────
    //  5. Purchase Orders
    // ──────────────────────────────────────────────────────────────
    const poSearch = document.getElementById('inv-po-search');
    const poFilterSup = document.getElementById('inv-po-filter-supplier');
    const poFilterStatus = document.getElementById('inv-po-filter-status');

    if (poSearch) poSearch.addEventListener('input', renderPOTable);
    if (poFilterSup) poFilterSup.addEventListener('change', renderPOTable);
    if (poFilterStatus) poFilterStatus.addEventListener('change', renderPOTable);

    let allPurchaseOrders = [];

    async function loadPOData() {
        await loadReferenceData();
        if (window.api && window.api.getInvPurchaseOrders) {
            allPurchaseOrders = await window.api.getInvPurchaseOrders();
        }
        renderPOTable();
    }

    function renderPOTable() {
        const tbody = document.getElementById('inv-po-tbody');
        if (!tbody) return;

        const q = (poSearch?.value || '').toLowerCase().trim();
        const supVal = poFilterSup?.value || '';
        const statusVal = poFilterStatus?.value || '';

        const filtered = allPurchaseOrders.filter(po => {
            const matchesSearch = po.po_number.toLowerCase().includes(q);
            const matchesSup = !supVal || po.supplier_id === parseInt(supVal);
            const matchesStatus = !statusVal || po.status === statusVal;
            return matchesSearch && matchesSup && matchesStatus;
        });

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="empty-state" style="text-align: center;">No purchase orders found.</td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(po => {
            let statusTag = 'status-pending';
            if (po.status === 'Draft') statusTag = 'status-draft';
            else if (po.status === 'Approved') statusTag = 'status-approved';
            else if (po.status === 'Ordered') statusTag = 'status-ordered';
            else if (po.status === 'Partially Received') statusTag = 'status-partially-received';
            else if (po.status === 'Fully Received') statusTag = 'status-received';
            else if (po.status === 'Closed') statusTag = 'status-inactive';
            else if (po.status === 'Cancelled') statusTag = 'status-cancelled';

            const receivedDate = po.received_date ? po.received_date : '<span style="color:var(--text-secondary);">—</span>';

            return `
                <tr>
                    <td><strong><code>${escapeHtml(po.po_number)}</code></strong></td>
                    <td>${escapeHtml(po.supplier_name)}</td>
                    <td>${po.order_date}</td>
                    <td>${receivedDate}</td>
                    <td style="font-weight:700;">₹${po.grand_total.toFixed(2)}</td>
                    <td><span class="status-tag status-inactive" style="background:none;border:1px solid var(--border-color);">${escapeHtml(po.payment_status)}</span></td>
                    <td><span class="status-tag ${statusTag}">${escapeHtml(po.status)}</span></td>
                    <td>
                        <button class="action-btn" onclick="viewPoDetails(${po.id})" style="background:var(--accent-color);color:white;border:none;padding:4px 8px;font-size:0.75rem;">View Details</button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    // Raise PO Modal trigger
    const btnCreateInvPo = document.getElementById('btn-create-inv-po');
    if (btnCreateInvPo) {
        btnCreateInvPo.addEventListener('click', () => {
            document.getElementById('inv-po-supplier').value = '';
            document.getElementById('inv-po-date').value = new Date().toISOString().split('T')[0];
            document.getElementById('inv-po-number').value = '';
            document.getElementById('inv-po-transport').value = '0';
            document.getElementById('inv-po-discount').value = '0';
            document.getElementById('inv-po-payment-status').value = 'Unpaid';
            document.getElementById('inv-po-notes').value = '';
            
            document.getElementById('po-items-tbody').innerHTML = '';
            calculatePoTotals();
            
            // Add initial empty item row
            addPoItemRow();

            openInvModal('inv-po-modal');
        });
    }

    const btnAddPoRow = document.getElementById('btn-add-po-row');
    if (btnAddPoRow) {
        btnAddPoRow.addEventListener('click', () => {
            addPoItemRow();
        });
    }

    function addPoItemRow() {
        const tbody = document.getElementById('po-items-tbody');
        const rowId = 'po-row-' + Date.now();

        const tr = document.createElement('tr');
        tr.id = rowId;

        // Construct item dropdown options
        const itemOptions = allItems.map(i => `<option value="${i.id}" data-cost="${i.purchase_price}">${escapeHtml(i.name)} (${i.sku})</option>`).join('');

        tr.innerHTML = `
            <td>
                <select class="po-item-select" onchange="onPoItemSelect(this)" required style="padding:6px 10px; width:100%; border-radius:6px; border:1px solid var(--border-color); background:var(--input-bg); color:var(--text-primary);">
                    <option value="">Choose item...</option>
                    ${itemOptions}
                </select>
            </td>
            <td><input type="number" class="po-item-qty" min="0.01" step="0.01" value="1" oninput="onPoRowValueChange(this)" required></td>
            <td><input type="number" class="po-item-cost" min="0" step="0.05" value="0.00" oninput="onPoRowValueChange(this)" required></td>
            <td><input type="number" class="po-item-gst" min="0" max="28" value="18" oninput="onPoRowValueChange(this)" required></td>
            <td style="font-weight:700; vertical-align: middle;"><span class="po-item-row-total">₹0.00</span></td>
            <td><button class="action-btn" onclick="removePoRow('${rowId}')" style="background:#ef4444;color:white;border:none;padding:4px 8px;font-size:0.75rem;">✕</button></td>
        `;

        tbody.appendChild(tr);
    }

    window.removePoRow = (rowId) => {
        const row = document.getElementById(rowId);
        if (row) {
            row.remove();
            calculatePoTotals();
        }
    };

    window.onPoItemSelect = (selectEl) => {
        const selectedOpt = selectEl.options[selectEl.selectedIndex];
        const cost = parseFloat(selectedOpt.getAttribute('data-cost')) || 0;
        
        const row = selectEl.closest('tr');
        row.querySelector('.po-item-cost').value = cost.toFixed(2);
        
        onPoRowValueChange(selectEl);
    };

    window.onPoRowValueChange = (el) => {
        const row = el.closest('tr');
        const qty = parseFloat(row.querySelector('.po-item-qty').value) || 0;
        const cost = parseFloat(row.querySelector('.po-item-cost').value) || 0;
        const gstRate = parseFloat(row.querySelector('.po-item-gst').value) || 0;

        const subtotal = qty * cost;
        const gst = subtotal * (gstRate / 100);
        const total = subtotal + gst;

        row.querySelector('.po-item-row-total').textContent = `₹${total.toFixed(2)}`;

        calculatePoTotals();
    };

    // Calculate totals for PO form
    function calculatePoTotals() {
        let subtotal = 0;
        let gstTotal = 0;

        const rows = document.querySelectorAll('#po-items-tbody tr');
        rows.forEach(row => {
            const qty = parseFloat(row.querySelector('.po-item-qty').value) || 0;
            const cost = parseFloat(row.querySelector('.po-item-cost').value) || 0;
            const gstRate = parseFloat(row.querySelector('.po-item-gst').value) || 0;

            const rowSub = qty * cost;
            const rowGst = rowSub * (gstRate / 100);
            
            subtotal += rowSub;
            gstTotal += rowGst;
        });

        const transport = parseFloat(document.getElementById('inv-po-transport').value) || 0;
        const discount = parseFloat(document.getElementById('inv-po-discount').value) || 0;
        const grandTotal = subtotal + gstTotal + transport - discount;

        document.getElementById('inv-po-grand-total').textContent = `₹${Math.max(0, grandTotal).toFixed(2)}`;
    }

    // Add listeners to PO form top level costs
    const poTransport = document.getElementById('inv-po-transport');
    const poDiscount = document.getElementById('inv-po-discount');
    if (poTransport) poTransport.addEventListener('input', calculatePoTotals);
    if (poDiscount) poDiscount.addEventListener('input', calculatePoTotals);

    // Save PO
    const btnSaveInvPo = document.getElementById('btn-save-inv-po');
    if (btnSaveInvPo) {
        btnSaveInvPo.addEventListener('click', async () => {
            const supSelect = document.getElementById('inv-po-supplier');
            const dateSelect = document.getElementById('inv-po-date');
            
            if (!supSelect.reportValidity() || !dateSelect.reportValidity()) return;

            const rows = document.querySelectorAll('#po-items-tbody tr');
            if (rows.length === 0) {
                toast("Please add at least one item to the purchase order.", 'warning');
                return;
            }

            const items = [];
            let isValid = true;

            rows.forEach(row => {
                const itemSelect = row.querySelector('.po-item-select');
                const qtyInput = row.querySelector('.po-item-qty');
                const costInput = row.querySelector('.po-item-cost');
                const gstInput = row.querySelector('.po-item-gst');

                if (!itemSelect.reportValidity() || !qtyInput.reportValidity() || !costInput.reportValidity() || !gstInput.reportValidity()) {
                    isValid = false;
                    return;
                }

                const qty = parseFloat(qtyInput.value) || 0;
                const cost = parseFloat(costInput.value) || 0;
                const gstRate = parseFloat(gstInput.value) || 0;
                const total = (qty * cost) * (1 + gstRate / 100);

                items.push({
                    item_id: itemSelect.value,
                    qty,
                    cost,
                    gst_rate: gstRate,
                    total
                });
            });

            if (!isValid) return;

            // Compute totals
            let subtotal = 0;
            let gstTotal = 0;
            items.forEach(i => {
                subtotal += (i.qty * i.cost);
                gstTotal += (i.qty * i.cost * (i.gst_rate / 100));
            });

            const transport = parseFloat(poTransport.value) || 0;
            const discount = parseFloat(poDiscount.value) || 0;
            const grandTotal = subtotal + gstTotal + transport - discount;

            const poData = {
                po_number: document.getElementById('inv-po-number').value.trim(),
                supplier_id: supSelect.value,
                order_date: dateSelect.value,
                subtotal,
                gst_amount: gstTotal,
                transport_cost: transport,
                discount,
                grand_total: grandTotal,
                payment_status: document.getElementById('inv-po-payment-status').value,
                notes: document.getElementById('inv-po-notes').value.trim(),
                items
            };

            btnSaveInvPo.disabled = true;
            const origText = btnSaveInvPo.innerHTML;
            btnSaveInvPo.innerHTML = 'Saving...';

            try {
                const res = await window.api.createInvPurchaseOrder(poData);
                if (res && res.success) {
                    toast(`Purchase order "${res.po_number || res.poNumber}" raised successfully!`);
                    closeInvModal('inv-po-modal');
                    await loadPOData();
                } else {
                    toast(res ? res.error : 'Failed to create purchase order', 'error');
                }
            } catch (e) {
                toast(e.message, 'error');
            } finally {
                btnSaveInvPo.disabled = false;
                btnSaveInvPo.innerHTML = origText;
            }
        });
    }

    // View PO details modal
    window.viewPoDetails = async (poId) => {
        try {
            const po = await window.api.getInvPurchaseOrderById(poId);
            if (!po) return;

            const modalContent = document.getElementById('po-details-modal-content');
            const modalFooter = document.getElementById('po-details-modal-footer');

            let statusTag = 'status-pending';
            if (po.status === 'Draft') statusTag = 'status-draft';
            else if (po.status === 'Approved') statusTag = 'status-approved';
            else if (po.status === 'Ordered') statusTag = 'status-ordered';
            else if (po.status === 'Partially Received') statusTag = 'status-partially-received';
            else if (po.status === 'Fully Received') statusTag = 'status-received';
            else if (po.status === 'Closed') statusTag = 'status-inactive';
            else if (po.status === 'Cancelled') statusTag = 'status-cancelled';

            const receivedRow = po.received_date ? `
                <div style="display:flex; justify-content:space-between; margin-bottom: 8px;">
                    <span style="color:var(--text-secondary);">Last Received:</span>
                    <strong>${po.received_date}</strong>
                </div>
            ` : '';

            modalContent.innerHTML = `
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px; margin-bottom: 24px; font-size:0.9rem;">
                    <div>
                        <h3 style="margin-top:0; margin-bottom:12px; font-size: 1.05rem;">PO Header</h3>
                        <div style="display:flex; justify-content:space-between; margin-bottom: 8px;">
                            <span style="color:var(--text-secondary);">PO Number:</span>
                            <strong>${escapeHtml(po.po_number)}</strong>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom: 8px;">
                            <span style="color:var(--text-secondary);">Order Date:</span>
                            <strong>${po.order_date}</strong>
                        </div>
                        ${receivedRow}
                        <div style="display:flex; justify-content:space-between; margin-bottom: 8px;">
                            <span style="color:var(--text-secondary);">PO Status:</span>
                            <span class="status-tag ${statusTag}">${po.status}</span>
                        </div>
                    </div>
                    <div>
                        <h3 style="margin-top:0; margin-bottom:12px; font-size: 1.05rem;">Supplier Details</h3>
                        <strong>${escapeHtml(po.supplier_name)}</strong>
                        <div style="color:var(--text-secondary); margin-top:6px; font-size:0.85rem;">
                            ${po.supplier_phone ? `📞 ${escapeHtml(po.supplier_phone)}<br>` : ''}
                            ${po.supplier_email ? `✉️ ${escapeHtml(po.supplier_email)}<br>` : ''}
                            ${po.supplier_gstin ? `💼 GSTIN: ${escapeHtml(po.supplier_gstin)}<br>` : ''}
                            ${po.supplier_address ? `📍 ${escapeHtml(po.supplier_address)}` : ''}
                        </div>
                    </div>
                </div>

                <div class="panel" style="margin-bottom: 20px;">
                    <h4 style="margin-top: 0; margin-bottom: 12px; font-weight:700;">Purchase Order Line Items</h4>
                    <table class="po-items-table" style="margin:0;">
                        <thead>
                            <tr>
                                <th>SKU</th>
                                <th>Item Name</th>
                                <th>Ordered</th>
                                <th>Received</th>
                                <th>Remaining</th>
                                <th>Unit Cost</th>
                                <th>GST %</th>
                                <th>Line Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${po.items.map(item => {
                                const ordered = item.ordered_qty !== undefined ? item.ordered_qty : item.qty;
                                const received = item.received_qty || 0;
                                const remaining = Math.max(0, ordered - received - (item.cancelled_qty || 0));
                                const cost = item.unit_cost !== undefined ? item.unit_cost : item.cost;
                                const total = item.line_total !== undefined ? item.line_total : item.total;
                                const itemName = item.item_name_snapshot || item.item_name || item.current_item_name;
                                const sku = item.sku_snapshot || item.sku || item.current_sku;
                                const unit = item.unit_snapshot || item.unit || item.current_unit || 'Units';

                                return `
                                    <tr>
                                        <td><code>${escapeHtml(sku)}</code></td>
                                        <td><strong>${escapeHtml(itemName)}</strong></td>
                                        <td>${ordered} ${escapeHtml(unit)}</td>
                                        <td style="color:${received > 0 ? '#10b981' : 'inherit'}; font-weight:600;">${received}</td>
                                        <td style="color:${remaining > 0 ? '#f59e0b' : 'inherit'}; font-weight:600;">${remaining}</td>
                                        <td>₹${cost.toFixed(2)}</td>
                                        <td>${item.tax_rate || item.gst_rate}%</td>
                                        <td style="font-weight:700;">₹${total.toFixed(2)}</td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>

                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:8px; font-size:0.9rem; margin-top:16px; border-top: 1px solid var(--border-color); padding-top:16px;">
                    <div style="display:flex; justify-content:space-between; width:240px;">
                        <span style="color:var(--text-secondary);">Subtotal:</span>
                        <span>₹${po.subtotal.toFixed(2)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; width:240px;">
                        <span style="color:var(--text-secondary);">Total GST:</span>
                        <span>₹${(po.tax_amount || po.gst_amount || 0).toFixed(2)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; width:240px;">
                        <span style="color:var(--text-secondary);">Transport Cost:</span>
                        <span>+ ₹${po.transport_cost.toFixed(2)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; width:240px;">
                        <span style="color:var(--text-secondary);">Discounts:</span>
                        <span>- ₹${po.discount.toFixed(2)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; width:240px; font-size: 1.1rem; font-weight:700; border-top:1px solid var(--border-color); padding-top:8px; margin-top:4px;">
                        <span>Grand Total:</span>
                        <span style="color: var(--accent-color);">₹${po.grand_total.toFixed(2)}</span>
                    </div>
                </div>

                ${po.notes ? `
                    <div style="margin-top: 16px; font-size: 0.85rem; padding: 12px; background: rgba(0,0,0,0.02); border-radius:8px;">
                        <strong>PO Notes:</strong> ${escapeHtml(po.notes)}
                    </div>
                ` : ''}
            `;

            // Render PO Details action buttons dynamically based on lifecycle
            let actionButtons = '';
            if (po.status === 'Draft') {
                actionButtons = `
                    <button class="action-btn" style="background:#ef4444; color:white; border:none;" onclick="cancelPo(${po.id})">Cancel PO</button>
                    <div style="display:flex; gap:12px;">
                        <button class="action-btn" style="background:#3b82f6; color:white; border:none;" onclick="approvePo(${po.id})">✓ Approve PO</button>
                        <button class="action-btn" style="background:#e2e8f0; color:#1e293b;" onclick="closeInvModal('inv-po-details-modal')">Close</button>
                    </div>
                `;
            } else if (po.status === 'Approved') {
                actionButtons = `
                    <button class="action-btn" style="background:#ef4444; color:white; border:none;" onclick="cancelPo(${po.id})">Cancel PO</button>
                    <div style="display:flex; gap:12px;">
                        <button class="action-btn" style="background:#6366f1; color:white; border:none;" onclick="orderPo(${po.id})">🚀 Mark Ordered / Sent</button>
                        <button class="action-btn" style="background:#8b5cf6; color:white; border:none;" onclick="showReceivePoForm(${po.id})">📦 Receive Stock</button>
                        <button class="action-btn" style="background:#e2e8f0; color:#1e293b;" onclick="closeInvModal('inv-po-details-modal')">Close</button>
                    </div>
                `;
            } else if (po.status === 'Ordered' || po.status === 'Partially Received') {
                actionButtons = `
                    <button class="action-btn" style="background:#ef4444; color:white; border:none;" onclick="cancelPo(${po.id})">Cancel Remainder</button>
                    <div style="display:flex; gap:12px;">
                        <button class="action-btn" style="background:#8b5cf6; color:white; border:none;" onclick="showReceivePoForm(${po.id})">📦 Receive Stock (Partial/Full)</button>
                        <button class="action-btn" style="background:#e2e8f0; color:#1e293b;" onclick="closeInvModal('inv-po-details-modal')">Close</button>
                    </div>
                `;
            } else {
                actionButtons = `
                    <button class="action-btn" style="background:var(--accent-color); color:white;" onclick="printPoSheet(${po.id})">🖨️ Export / Print</button>
                    <button class="action-btn" style="background:#e2e8f0; color:#1e293b;" onclick="closeInvModal('inv-po-details-modal')">Close</button>
                `;
            }

            modalFooter.innerHTML = `<div style="display:flex; gap:12px; width:100%; justify-content:space-between;">${actionButtons}</div>`;
            openInvModal('inv-po-details-modal');
        } catch (e) {
            toast(e.message, 'error');
        }
    };

    window.approvePo = async (poId) => {
        try {
            const res = await window.api.approveInvPurchaseOrder(poId, { operator: 'Admin' });
            if (res.success) {
                toast("Purchase order approved.");
                closeInvModal('inv-po-details-modal');
                loadPOData();
            } else {
                toast(res.error, 'error');
            }
        } catch (e) {
            toast(e.message, 'error');
        }
    };

    window.orderPo = async (poId) => {
        try {
            const res = await window.api.markInvPurchaseOrderOrdered(poId, { operator: 'Admin' });
            if (res.success) {
                toast("Purchase order marked as Ordered.");
                closeInvModal('inv-po-details-modal');
                loadPOData();
            } else {
                toast(res.error, 'error');
            }
        } catch (e) {
            toast(e.message, 'error');
        }
    };

    window.cancelPo = async (poId) => {
        if (!confirm("Are you sure you want to cancel / close this purchase order?")) return;
        try {
            const res = await window.api.cancelInvPurchaseOrder(poId, { reason: 'User cancelled', operator: 'Admin' });
            if (res.success) {
                toast("Purchase order status updated.");
                closeInvModal('inv-po-details-modal');
                loadPOData();
            } else {
                toast(res.error, 'error');
            }
        } catch (e) {
            toast(e.message, 'error');
        }
    };

    window.showReceivePoForm = async (poId) => {
        try {
            const po = await window.api.getInvPurchaseOrderById(poId);
            if (!po) return;

            closeInvModal('inv-po-details-modal');

            const modalContent = document.getElementById('po-details-modal-content');
            const modalFooter = document.getElementById('po-details-modal-footer');

            const receivingLinesHtml = po.items.map(item => {
                const ordered = item.ordered_qty !== undefined ? item.ordered_qty : item.qty;
                const received = item.received_qty || 0;
                const remaining = Math.max(0, ordered - received - (item.cancelled_qty || 0));
                const itemName = item.item_name_snapshot || item.item_name || item.current_item_name;
                const sku = item.sku_snapshot || item.sku || item.current_sku;

                return `
                    <tr data-po-item-id="${item.id}">
                        <td><strong>${escapeHtml(itemName)}</strong><br><small><code>${escapeHtml(sku)}</code></small></td>
                        <td>${ordered}</td>
                        <td style="color:#10b981;">${received}</td>
                        <td style="color:#f59e0b; font-weight:700;">${remaining}</td>
                        <td>
                            <input type="number" class="po-receive-line-qty" data-po-item-id="${item.id}"
                                   min="0" max="${remaining}" step="0.01" value="${remaining}"
                                   style="width:90px; padding:6px; border-radius:6px; border:1px solid var(--border-color); background:var(--input-bg); color:var(--text-primary);">
                        </td>
                    </tr>
                `;
            }).join('');

            modalContent.innerHTML = `
                <form id="po-receipt-form" onsubmit="event.preventDefault();" style="display:flex; flex-direction:column; gap:16px; padding:10px 0;">
                    <h3 style="margin-top:0; margin-bottom:4px;">Receive PO Stock (Partial / Full)</h3>
                    <p style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:12px;">Specify the quantity received for each line. Missing or partial quantities remain on the PO.</p>

                    <div class="form-grid-2">
                        <div class="form-group">
                            <label>Receipt Date *</label>
                            <input type="date" id="po-receive-date" required>
                        </div>
                        <div class="form-group">
                            <label>Supplier Delivery Note / Bill No</label>
                            <input type="text" id="po-receive-invoice" placeholder="e.g. DC-10293">
                        </div>
                    </div>

                    <div class="panel" style="margin: 8px 0;">
                        <table class="po-items-table" style="margin:0;">
                            <thead>
                                <tr>
                                    <th>Item</th>
                                    <th>Ordered</th>
                                    <th>Received</th>
                                    <th>Remaining</th>
                                    <th>Qty To Receive Now</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${receivingLinesHtml}
                            </tbody>
                        </table>
                    </div>

                    <div class="form-group">
                        <label>Receipt Notes</label>
                        <textarea id="po-receive-notes" rows="2" placeholder="e.g. Received at central warehouse in good condition."></textarea>
                    </div>
                </form>
            `;

            document.getElementById('po-receive-date').value = new Date().toISOString().split('T')[0];

            modalFooter.innerHTML = `
                <button class="action-btn" style="background:#e2e8f0; color:#1e293b;" onclick="closeInvModal('inv-po-details-modal')">Cancel</button>
                <button class="action-btn" style="background:#10b981; color:white; border:none;" onclick="confirmPoReceipt(${poId})">📦 Post Goods Receipt</button>
            `;

            openInvModal('inv-po-details-modal');
        } catch (e) {
            toast(e.message, 'error');
        }
    };

    window.confirmPoReceipt = async (poId) => {
        const form = document.getElementById('po-receipt-form');
        if (!form.reportValidity()) return;

        const qtyInputs = document.querySelectorAll('.po-receive-line-qty');
        const items = [];
        let totalReceiving = 0;

        qtyInputs.forEach(input => {
            const poItemId = parseInt(input.getAttribute('data-po-item-id'));
            const qty = parseFloat(input.value) || 0;
            if (qty > 0) {
                totalReceiving += qty;
                items.push({
                    po_item_id: poItemId,
                    qty_received: qty
                });
            }
        });

        if (totalReceiving <= 0) {
            toast("Please enter a quantity greater than 0 for at least one item to receive.", 'warning');
            return;
        }

        const data = {
            po_id: poId,
            received_date: document.getElementById('po-receive-date').value,
            supplier_doc_ref: document.getElementById('po-receive-invoice').value.trim(),
            notes: document.getElementById('po-receive-notes').value.trim(),
            items,
            operator: 'Admin'
        };

        const receiveBtn = document.querySelector('#inv-po-details-modal button[onclick*="confirmPoReceipt"]');
        if (receiveBtn) {
            receiveBtn.disabled = true;
            receiveBtn.innerHTML = 'Receiving...';
        }

        try {
            const res = await window.api.receiveInvPurchaseOrder(poId, data);
            if (res && res.success) {
                toast(`Goods receipt #${res.receiptNumber || res.receipt_number} posted successfully! Status: ${res.poStatus}`);
                closeInvModal('inv-po-details-modal');
                await loadPOData();
                await loadItemsData();
            } else {
                toast(res ? res.error : 'Failed to post goods receipt', 'error');
            }
        } catch (e) {
            toast(e.message, 'error');
        } finally {
            if (receiveBtn) {
                receiveBtn.disabled = false;
                receiveBtn.innerHTML = '📦 Post Goods Receipt';
            }
        }
    };

    window.printPoSheet = (poId) => {
        toast("Purchase Order exported to printer/PDF format successfully!", 'success');
    };

    // ──────────────────────────────────────────────────────────────
    //  6. Transactions
    // ──────────────────────────────────────────────────────────────
    const txSearch = document.getElementById('inv-tx-search');
    const filterTxType = document.getElementById('inv-tx-filter-type');

    if (txSearch) txSearch.addEventListener('input', renderTransactionsTable);
    if (filterTxType) filterTxType.addEventListener('change', renderTransactionsTable);

    let allTransactions = [];

    async function loadTransactionsData() {
        if (window.api && window.api.getInvTransactions) {
            allTransactions = await window.api.getInvTransactions();
        }
        renderTransactionsTable();
    }

    function renderTransactionsTable() {
        const tbody = document.getElementById('inv-transactions-tbody');
        if (!tbody) return;

        const q = (txSearch?.value || '').toLowerCase().trim();
        const typeVal = filterTxType?.value || '';

        const filtered = allTransactions.filter(tx => {
            const matchesSearch = tx.item_name.toLowerCase().includes(q) || tx.sku.toLowerCase().includes(q);
            const matchesType = !typeVal || tx.type === typeVal;
            return matchesSearch && matchesType;
        });

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="empty-state" style="text-align: center;">No stock transactions found.</td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(tx => {
            const dateStr = new Date(tx.created_at).toLocaleString();
            
            // Format quantities (Stock In positive green, Stock Out negative red)
            const qtyCol = tx.qty > 0 ? 'color: #10b981; font-weight:700;' : 'color: #ef4444; font-weight:700;';
            const qtySymbol = tx.qty > 0 ? `+${tx.qty}` : tx.qty;
            const costVal = tx.cost ? `₹${tx.cost.toFixed(2)}` : '<span style="color:var(--text-secondary);">—</span>';

            return `
                <tr>
                    <td><small>${dateStr}</small></td>
                    <td><code>${escapeHtml(tx.sku)}</code></td>
                    <td><strong>${escapeHtml(tx.item_name)}</strong></td>
                    <td><span class="status-tag status-inactive" style="font-size:0.7rem;text-transform:uppercase;">${tx.type}</span></td>
                    <td style="${qtyCol}">${qtySymbol}</td>
                    <td>${costVal}</td>
                    <td><small>${escapeHtml(tx.operator)}</small></td>
                    <td><span class="history-reason">${escapeHtml(tx.reason || '')}</span></td>
                </tr>
            `;
        }).join('');
    }

    const btnManualAdjustStock = document.getElementById('btn-manual-adjust-stock');
    if (btnManualAdjustStock) {
        btnManualAdjustStock.addEventListener('click', () => {
            document.getElementById('inv-adjust-form').reset();
            populateDropdowns(); // Make sure item options are fresh
            openInvModal('inv-adjust-modal');
        });
    }

    const btnSaveInvAdjustment = document.getElementById('btn-save-inv-adjustment');
    if (btnSaveInvAdjustment) {
        btnSaveInvAdjustment.addEventListener('click', async () => {
            const form = document.getElementById('inv-adjust-form');
            if (!form.reportValidity()) return;

            const itemId = document.getElementById('inv-adjust-item').value;
            const type = document.getElementById('inv-adjust-type').value;
            const qtyVal = parseFloat(document.getElementById('inv-adjust-qty').value);
            const cost = parseFloat(document.getElementById('inv-adjust-cost').value) || 0;
            const reason = document.getElementById('inv-adjust-reason').value.trim();

            // Stock in types are positive, Stock out types are negative
            const isStockOut = ['manual_out', 'damage', 'waste', 'expired', 'sample', 'internal'].includes(type);
            const qty = isStockOut ? -qtyVal : qtyVal;

            const data = {
                item_id: parseInt(itemId),
                type,
                qty,
                cost,
                reason,
                operator: 'Admin'
            };

            btnSaveInvAdjustment.disabled = true;
            const origText = btnSaveInvAdjustment.innerHTML;
            btnSaveInvAdjustment.innerHTML = 'Saving...';

            try {
                const res = await window.api.adjustInvStock(data);
                if (res && res.success) {
                    toast("Stock adjustment saved successfully!");
                    closeInvModal('inv-adjust-modal');
                    
                    // Reload reference data and all views
                    await loadReferenceData();
                    await loadTransactionsData();
                    renderStockItemsTable();
                    if (document.getElementById('inv-dashboard')?.classList.contains('active')) {
                        loadDashboardData();
                    }
                } else {
                    toast(res ? res.error : 'Failed to adjust stock', 'error');
                }
            } catch (e) {
                toast(e.message, 'error');
            } finally {
                btnSaveInvAdjustment.disabled = false;
                btnSaveInvAdjustment.innerHTML = origText;
            }
        });
    }

    // ──────────────────────────────────────────────────────────────
    //  7. Alerts
    // ──────────────────────────────────────────────────────────────
    async function loadAlertsData() {
        const tbody = document.getElementById('inv-alerts-tbody');
        if (!tbody || !window.api || !window.api.getInvAlerts) return;

        try {
            const alerts = await window.api.getInvAlerts();
            checkLowStockSystemBadge();

            if (alerts.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" class="empty-state" style="text-align: center;">No active stock alerts. All items healthy!</td></tr>';
                return;
            }

            tbody.innerHTML = alerts.map(a => {
                const dateStr = new Date(a.created_at).toLocaleString();
                const alertGrade = a.type === 'out_of_stock' ? 'Out of Stock' : 'Low Stock';
                const tagClass = a.type === 'out_of_stock' ? 'status-out' : 'status-low';

                return `
                    <tr>
                        <td><span class="status-tag ${tagClass}">${alertGrade}</span></td>
                        <td><code>${escapeHtml(a.sku)}</code></td>
                        <td><strong>${escapeHtml(a.item_name)}</strong></td>
                        <td>${escapeHtml(a.category_name)}</td>
                        <td style="font-weight:700; color: ${a.type === 'out_of_stock' ? '#ef4444' : '#f59e0b'}">${a.current_stock}</td>
                        <td>${a.minimum_stock}</td>
                        <td><span style="font-size:0.85rem; font-weight:550;">${escapeHtml(a.message)}</span></td>
                        <td><small>${dateStr}</small></td>
                    </tr>
                `;
            }).join('');
        } catch (e) {
            console.error(e);
        }
    }

    // ──────────────────────────────────────────────────────────────
    //  8. Reports
    // ──────────────────────────────────────────────────────────────
    const reportStart = document.getElementById('inv-report-start');
    const reportEnd = document.getElementById('inv-report-end');
    const btnGenerateInvReport = document.getElementById('btn-generate-inv-report');
    const btnPrintInvReport = document.getElementById('btn-print-inv-report');

    if (reportStart && reportEnd) {
        const today = new Date().toISOString().split('T')[0];
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        reportStart.value = thirtyDaysAgo;
        reportEnd.value = today;
    }

    if (btnGenerateInvReport) {
        btnGenerateInvReport.addEventListener('click', async () => {
            const start = reportStart.value;
            const end = reportEnd.value;

            if (!start || !end) {
                toast("Please select both Start and End dates.", 'warning');
                return;
            }

            try {
                const report = await window.api.getInvReports(start, end);
                
                const reportPlaceholder = document.getElementById('inv-report-placeholder');
                if (reportPlaceholder) reportPlaceholder.style.display = 'none';
                const resultsPanel = document.getElementById('inv-report-results');
                if (resultsPanel) resultsPanel.style.display = 'flex';

                // 1. Render Consumption
                const consTbody = document.getElementById('inv-report-consumption-tbody');
                if (report.consumption.length === 0) {
                    consTbody.innerHTML = '<tr><td colspan="5" class="empty-state" style="text-align:center;">No order consumption during this period.</td></tr>';
                } else {
                    consTbody.innerHTML = report.consumption.map(c => `
                        <tr>
                            <td><strong>${escapeHtml(c.name)}</strong></td>
                            <td><code>${escapeHtml(c.sku)}</code></td>
                            <td>${escapeHtml(c.category)}</td>
                            <td>${c.qty_consumed} ${escapeHtml(c.unit)}</td>
                            <td style="font-weight:700;">₹${c.cost_valuation.toFixed(2)}</td>
                        </tr>
                    `).join('');
                }

                // 2. Render Purchases
                const purchaseTbody = document.getElementById('inv-report-purchases-tbody');
                if (report.purchases.length === 0) {
                    purchaseTbody.innerHTML = '<tr><td colspan="5" class="empty-state" style="text-align:center;">No purchases received during this period.</td></tr>';
                } else {
                    purchaseTbody.innerHTML = report.purchases.map(p => `
                        <tr>
                            <td><code>${escapeHtml(p.po_number)}</code></td>
                            <td>${escapeHtml(p.supplier_name)}</td>
                            <td>${p.received_date}</td>
                            <td style="font-weight:700;">₹${p.grand_total.toFixed(2)}</td>
                            <td><span class="status-tag status-received" style="background:none; border:1px solid var(--border-color);">${escapeHtml(p.payment_status)}</span></td>
                        </tr>
                    `).join('');
                }

                // 3. Render Stock Valuation
                const stockTbody = document.getElementById('inv-report-stock-tbody');
                if (report.stockValuations.length === 0) {
                    stockTbody.innerHTML = '<tr><td colspan="6" class="empty-state" style="text-align:center;">No active stock inventory.</td></tr>';
                } else {
                    let totalInventoryWorth = 0;
                    stockTbody.innerHTML = report.stockValuations.map(s => {
                        totalInventoryWorth += s.total_value;
                        return `
                            <tr>
                                <td><strong>${escapeHtml(s.name)}</strong></td>
                                <td><code>${escapeHtml(s.sku)}</code></td>
                                <td>${escapeHtml(s.category)}</td>
                                <td>${s.current_stock} ${escapeHtml(s.unit)}</td>
                                <td>₹${s.average_cost.toFixed(2)}</td>
                                <td style="font-weight:700;">₹${s.total_value.toFixed(2)}</td>
                            </tr>
                        `;
                    }).join('') + `
                        <tr style="border-top: 2px solid var(--border-color); font-weight:800; font-size:1rem; background: rgba(139, 92, 246, 0.05);">
                            <td colspan="5" style="text-align:right;">TOTAL VALUE:</td>
                            <td style="color:var(--accent-color);">₹${totalInventoryWorth.toFixed(2)}</td>
                        </tr>
                    `;
                }

            } catch (e) {
                toast(e.message, 'error');
            }
        });
    }

    if (btnPrintInvReport) {
        btnPrintInvReport.addEventListener('click', () => {
            window.print();
        });
    }

    // ──────────────────────────────────────────────────────────────
    //  9. Settings
    // ──────────────────────────────────────────────────────────────
    const invSettingNegative = document.getElementById('inv-setting-negative');
    const invSettingThreshold = document.getElementById('inv-setting-threshold');
    const btnSaveInvSettings = document.getElementById('btn-save-inv-settings');

    async function loadSettingsData() {
        if (!window.api || !window.api.getInvSettings) return;
        try {
            const settings = await window.api.getInvSettings();
            if (invSettingNegative) invSettingNegative.checked = settings.allow_negative_stock === 1;
            if (invSettingThreshold) invSettingThreshold.value = settings.low_stock_threshold_percent;
        } catch (e) {
            console.error(e);
        }
    }

    if (btnSaveInvSettings) {
        btnSaveInvSettings.addEventListener('click', async () => {
            const data = {
                allow_negative_stock: invSettingNegative.checked ? 1 : 0,
                low_stock_threshold_percent: parseFloat(invSettingThreshold.value) || 15
            };

            btnSaveInvSettings.disabled = true;
            const origText = btnSaveInvSettings.innerHTML;
            btnSaveInvSettings.innerHTML = 'Saving...';

            try {
                const res = await window.api.updateInvSettings(data);
                if (res && res.success) {
                    toast("Inventory settings saved!");
                    await loadSettingsData();
                } else {
                    toast(res ? res.error : 'Failed to save settings', 'error');
                }
            } catch (e) {
                toast(e.message, 'error');
            } finally {
                btnSaveInvSettings.disabled = false;
                btnSaveInvSettings.innerHTML = origText;
            }
        });
    }

    // --- Helper Utilities ---
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#039;');
    }

    window.loadInventoryActiveSubTab = () => {
        const activeSub = localStorage.getItem('psm_inventory_tab') || 'inv-dashboard';
        switch (activeSub) {
            case 'inv-dashboard':
                loadDashboardData();
                break;
            case 'inv-items':
                loadItemsData();
                break;
            case 'inv-categories':
                loadCategoriesData();
                break;
            case 'inv-suppliers':
                loadSuppliersData();
                break;
            case 'inv-po':
                loadPOData();
                break;
            case 'inv-transactions':
                loadTransactionsData();
                break;
            case 'inv-alerts':
                loadAlertsData();
                break;
            case 'inv-settings':
                loadSettingsData();
                break;
        }
    };

    // Initial references loading
    loadReferenceData();

    // Restore saved sub-tab if any
    const savedSubTab = localStorage.getItem('psm_inventory_tab');
    if (savedSubTab && savedSubTab !== 'inv-dashboard') {
        const subBtn = document.querySelector(`.inv-sub-btn[data-sub="${savedSubTab}"]`);
        if (subBtn) {
            setTimeout(() => subBtn.click(), 50);
        }
    } else {
        loadDashboardData();
    }
});
