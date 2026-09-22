/* ====================================================
   CUSTOMER WORKSPACE 2.0 — STABILIZED INTERACTIVE ENGINE
   ==================================================== */

(function () {
    let selectedCustomerId = null;
    let loadedCustomers = [];
    let activeCustomerProfile = null;
    let searchQuery = '';
    let tagFilter = 'All';
    let sortBy = 'last_visit';
    let viewMode = 'cards'; // 'cards' or 'table'
    let offset = 0;
    const limit = 50;
    let searchDebounceTimer = null;
    let isLoading = false;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCustomerWorkspace);
    } else {
        initCustomerWorkspace();
    }

    function initCustomerWorkspace() {
        const searchInput = document.getElementById('cw-search-input');
        const searchClear = document.getElementById('cw-search-clear');
        const tagSelect = document.getElementById('cw-tag-filter');
        const sortSelect = document.getElementById('cw-sort-select');
        const btnCards = document.getElementById('cw-view-cards');
        const btnTable = document.getElementById('cw-view-table');
        const btnAddCustomer = document.getElementById('cw-btn-add-customer');
        const btnLoadMore = document.getElementById('cw-btn-load-more');

        // Search Input Listener with Debounce
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                searchQuery = e.target.value;
                if (searchClear) searchClear.style.display = searchQuery ? 'block' : 'none';
                
                clearTimeout(searchDebounceTimer);
                searchDebounceTimer = setTimeout(() => {
                    offset = 0;
                    loadCustomersList();
                }, 200);
            });
        }

        if (searchClear) {
            searchClear.addEventListener('click', () => {
                if (searchInput) {
                    searchInput.value = '';
                    searchInput.focus();
                }
                searchQuery = '';
                searchClear.style.display = 'none';
                offset = 0;
                loadCustomersList();
            });
        }

        // Tag Filter
        if (tagSelect) {
            tagSelect.addEventListener('change', (e) => {
                tagFilter = e.target.value;
                offset = 0;
                loadCustomersList();
            });
        }

        // Sort Select
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                sortBy = e.target.value;
                offset = 0;
                loadCustomersList();
            });
        }

        // View Mode Toggle
        if (btnCards && btnTable) {
            btnCards.addEventListener('click', () => {
                viewMode = 'cards';
                btnCards.classList.add('active');
                btnTable.classList.remove('active');
                renderCustomerList();
            });
            btnTable.addEventListener('click', () => {
                viewMode = 'table';
                btnTable.classList.add('active');
                btnCards.classList.remove('active');
                renderCustomerList();
            });
        }

        // Load More
        if (btnLoadMore) {
            btnLoadMore.addEventListener('click', () => {
                loadCustomersList(true);
            });
        }

        // Profile Tabs
        const tabs = document.querySelectorAll('.cw-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const targetPane = tab.getAttribute('data-tab');
                const panes = document.querySelectorAll('.cw-tab-pane');
                panes.forEach(p => p.classList.remove('active'));
                const el = document.getElementById(targetPane);
                if (el) el.classList.add('active');
            });
        });

        // Quick Actions
        const btnCreateOrder = document.getElementById('cw-act-create-order');
        if (btnCreateOrder) btnCreateOrder.addEventListener('click', handleCreateOrder);

        const btnRepeatOrder = document.getElementById('cw-act-repeat-order');
        if (btnRepeatOrder) btnRepeatOrder.addEventListener('click', handleRepeatOrder);

        const btnAddNoteAction = document.getElementById('cw-act-add-note');
        if (btnAddNoteAction) {
            btnAddNoteAction.addEventListener('click', () => {
                const tabTimeline = document.querySelector('.cw-tab[data-tab="cw-tab-timeline"]');
                if (tabTimeline) tabTimeline.click();
                const noteInput = document.getElementById('cw-quick-note-input');
                if (noteInput) noteInput.focus();
            });
        }

        const btnViewDocsAction = document.getElementById('cw-act-view-docs');
        if (btnViewDocsAction) {
            btnViewDocsAction.addEventListener('click', () => {
                const tabDocs = document.querySelector('.cw-tab[data-tab="cw-tab-documents"]');
                if (tabDocs) tabDocs.click();
            });
        }

        // Quick Note Input (Enter key & Post button)
        const noteInput = document.getElementById('cw-quick-note-input');
        if (noteInput) {
            noteInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSaveNote();
                }
            });
        }

        const btnSaveNote = document.getElementById('cw-btn-save-note');
        if (btnSaveNote) btnSaveNote.addEventListener('click', handleSaveNote);

        // Save Preferences Button
        const btnSavePrefs = document.getElementById('cw-btn-save-prefs');
        if (btnSavePrefs) btnSavePrefs.addEventListener('click', handleSavePreferences);

        // Modal Handlers & Keyboard Shortcuts
        if (btnAddCustomer) btnAddCustomer.addEventListener('click', () => openCustomerModal());
        const btnEditCustomer = document.getElementById('cw-btn-edit-customer');
        if (btnEditCustomer) btnEditCustomer.addEventListener('click', () => openCustomerModal(activeCustomerProfile?.customer));

        const modalClose = document.getElementById('cw-modal-close');
        const modalCancel = document.getElementById('cw-modal-cancel');
        if (modalClose) modalClose.addEventListener('click', closeCustomerModal);
        if (modalCancel) modalCancel.addEventListener('click', closeCustomerModal);

        const modalOverlay = document.getElementById('cw-customer-modal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) closeCustomerModal();
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeCustomerModal();
            }
        });

        const modalSave = document.getElementById('cw-modal-save');
        if (modalSave) modalSave.addEventListener('click', handleSaveCustomerModal);

        // [NOTE] Navigation handled by executeTabSwitch -> window.loadCustomerWorkspace (no duplicate listener needed here)
    }

    // Expose global reload helper for customer workspace
    window.loadCustomerWorkspace = function () {
        offset = 0;
        loadCustomersList();
    };

    async function loadCustomersList(append = false) {
        if (!window.api || !window.api.searchCustomersAdvanced || isLoading) return;

        isLoading = true;
        const container = document.getElementById('cw-list-scroll');
        if (!append && container) {
            container.innerHTML = `
                <div style="text-align:center; padding:30px; color:var(--text-secondary);">
                    <div style="font-size:1.2rem; font-weight:600; margin-bottom:6px;">Loading workspace...</div>
                </div>
            `;
        }

        if (!append) offset = 0;

        try {
            const results = await window.api.searchCustomersAdvanced({
                query: searchQuery,
                tag: tagFilter,
                sortBy: sortBy,
                limit: limit,
                offset: offset
            });

            const safeResults = Array.isArray(results) ? results : [];
            if (append) {
                loadedCustomers = (Array.isArray(loadedCustomers) ? loadedCustomers : []).concat(safeResults);
            } else {
                loadedCustomers = safeResults;
            }

            offset += safeResults.length;

            const countEl = document.getElementById('cw-list-count');
            if (countEl) countEl.textContent = `${loadedCustomers.length} Customers`;

            const pgnEl = document.getElementById('cw-pagination');
            if (pgnEl) pgnEl.style.display = safeResults.length === limit ? 'block' : 'none';

            renderCustomerList();

            // Auto-select first customer if none selected or previous selection missing
            if (loadedCustomers.length > 0) {
                const exists = loadedCustomers.find(c => c.id === selectedCustomerId);
                if (!exists) {
                    openCustomerProfile(loadedCustomers[0].id);
                }
            } else {
                showEmptyProfilePane();
            }
        } catch(e) {
            console.error("loadCustomersList error:", e);
            if (window.showToast) window.showToast("Failed to load customer list: " + e.message, "error");
        } finally {
            isLoading = false;
        }
    }

    function renderCustomerList() {
        const container = document.getElementById('cw-list-scroll');
        if (!container) return;

        if (loadedCustomers.length === 0) {
            container.innerHTML = `
                <div style="text-align:center; padding:40px 10px; color:var(--text-secondary);">
                    <div style="font-size:2rem; margin-bottom:8px;">🔍</div>
                    <div style="font-weight:600;">No customers found</div>
                    <div style="font-size:0.8rem; margin-top:4px;">Try adjusting your search query or filters.</div>
                </div>
            `;
            return;
        }

        if (viewMode === 'cards') {
            container.innerHTML = loadedCustomers.map(c => {
                const initials = getInitials(c.name);
                const tagClass = getTagClass(c.tag);
                const isSel = c.id === selectedCustomerId ? 'selected' : '';
                const lastVisit = c.last_visit ? formatRelativeDate(c.last_visit) : 'Never';
                const rev = parseFloat(c.total_revenue || 0).toFixed(2);

                return `
                    <div class="cw-card ${isSel}" onclick="window.selectCustomerWorkspace(${c.id})">
                        <div class="cw-card-top">
                            <div class="cw-avatar">${initials}</div>
                            <div class="cw-card-info">
                                <div class="cw-card-name">${escapeHtml(c.name)}</div>
                                <div class="cw-card-sub">
                                    <span>📞 ${escapeHtml(c.phone)}</span>
                                    <span class="cw-tag-badge ${tagClass}">${escapeHtml(c.tag || 'Regular')}</span>
                                </div>
                            </div>
                        </div>
                        <div class="cw-card-metrics">
                            <div class="cw-metric-item">
                                <span class="cw-metric-lbl">Last Visit</span>
                                <span class="cw-metric-val">${lastVisit}</span>
                            </div>
                            <div class="cw-metric-item">
                                <span class="cw-metric-lbl">Orders</span>
                                <span class="cw-metric-val">${c.total_orders || 0}</span>
                            </div>
                            <div class="cw-metric-item">
                                <span class="cw-metric-lbl">Revenue</span>
                                <span class="cw-metric-val" style="color:#10b981;">₹${rev}</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            // Compact Table View
            container.innerHTML = `
                <table class="cw-compact-table">
                    <thead>
                        <tr>
                            <th>Customer</th>
                            <th>Phone</th>
                            <th>Tag</th>
                            <th>Orders</th>
                            <th>Revenue</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${loadedCustomers.map(c => `
                            <tr class="${c.id === selectedCustomerId ? 'selected' : ''}" onclick="window.selectCustomerWorkspace(${c.id})">
                                <td style="font-weight:700;">${escapeHtml(c.name)}</td>
                                <td>${escapeHtml(c.phone)}</td>
                                <td><span class="cw-tag-badge ${getTagClass(c.tag)}">${escapeHtml(c.tag || 'Regular')}</span></td>
                                <td>${c.total_orders || 0}</td>
                                <td style="font-weight:700; color:#10b981;">₹${parseFloat(c.total_revenue || 0).toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
        }
    }

    window.selectCustomerWorkspace = function (id) {
        selectedCustomerId = id;
        renderCustomerList();
        openCustomerProfile(id);
    };

    function showEmptyProfilePane() {
        const emptyPane = document.getElementById('cw-profile-empty');
        const activePane = document.getElementById('cw-profile-active');
        if (emptyPane) emptyPane.style.display = 'flex';
        if (activePane) activePane.style.display = 'none';
        activeCustomerProfile = null;
        selectedCustomerId = null;
    }

    async function openCustomerProfile(customerId) {
        if (!window.api || !window.api.getCustomerProfile) return;

        selectedCustomerId = customerId;
        const emptyPane = document.getElementById('cw-profile-empty');
        const activePane = document.getElementById('cw-profile-active');

        try {
            const data = await window.api.getCustomerProfile(customerId);
            if (!data || !data.customer) {
                showEmptyProfilePane();
                return;
            }

            activeCustomerProfile = data;

            if (emptyPane) emptyPane.style.display = 'none';
            if (activePane) activePane.style.display = 'flex';

            const c = data.customer;
            const s = data.stats || {};

            // Profile Header
            const avatarEl = document.getElementById('cw-prof-avatar');
            const nameEl = document.getElementById('cw-prof-name');
            const tagEl = document.getElementById('cw-prof-tag');
            const phoneEl = document.getElementById('cw-prof-phone');
            const emailEl = document.getElementById('cw-prof-email');
            const compEl = document.getElementById('cw-prof-company');

            if (avatarEl) avatarEl.textContent = getInitials(c.name);
            if (nameEl) nameEl.textContent = c.name;
            if (tagEl) {
                tagEl.textContent = c.tag || 'Regular';
                tagEl.className = `cw-tag-badge ${getTagClass(c.tag)}`;
            }
            if (phoneEl) phoneEl.textContent = c.phone || '--';
            if (emailEl) emailEl.textContent = c.email || 'No Email';
            if (compEl) compEl.textContent = c.company_name || '--';

            // Stats
            const revEl = document.getElementById('cw-stat-revenue');
            const ordEl = document.getElementById('cw-stat-orders');
            const aovEl = document.getElementById('cw-stat-aov');
            const lastEl = document.getElementById('cw-stat-last-visit');
            const pndEl = document.getElementById('cw-stat-pending');

            if (revEl) revEl.textContent = `₹${parseFloat(s.total_revenue || 0).toFixed(2)}`;
            if (ordEl) ordEl.textContent = s.total_orders || 0;
            if (aovEl) aovEl.textContent = `₹${parseFloat(s.avg_order_value || 0).toFixed(2)}`;
            if (lastEl) lastEl.textContent = s.last_visit ? formatRelativeDate(s.last_visit) : 'Never';
            if (pndEl) pndEl.textContent = s.pending_orders_count || 0;

            // Overview tab
            const gstinEl = document.getElementById('cw-ov-gstin');
            const stateEl = document.getElementById('cw-ov-state');
            const addrEl = document.getElementById('cw-ov-address');
            const createdEl = document.getElementById('cw-ov-created');

            if (gstinEl) gstinEl.textContent = c.gstin || 'Not Provided';
            if (stateEl) stateEl.textContent = c.state || 'Local';
            if (addrEl) addrEl.textContent = c.address || 'Not Provided';
            if (createdEl) createdEl.textContent = c.created_at ? new Date(c.created_at).toLocaleDateString() : '--';

            const prefTypeEl = document.getElementById('cw-ov-pref-type');
            const prefSizeEl = document.getElementById('cw-ov-pref-size');
            const prefSidesEl = document.getElementById('cw-ov-pref-sides');

            if (prefTypeEl) prefTypeEl.textContent = c.preferred_print_type || 'B&W (Monochrome)';
            if (prefSizeEl) prefSizeEl.textContent = c.preferred_paper_size || 'A4';
            if (prefSidesEl) prefSidesEl.textContent = c.preferred_sides || 'Single Sided';

            // Prefs tab inputs
            const pCol = document.getElementById('cw-pref-color-input');
            const pSize = document.getElementById('cw-pref-size-input');
            const pSides = document.getElementById('cw-pref-sides-input');
            if (pCol) pCol.value = c.preferred_print_type || 'B&W';
            if (pSize) pSize.value = c.preferred_paper_size || 'A4';
            if (pSides) pSides.value = c.preferred_sides || 'Single';

            // Frequently Used Services
            const freqList = document.getElementById('cw-frequent-services-list');
            if (freqList) {
                const services = data.frequentServices || [];
                if (services.length === 0) {
                    freqList.innerHTML = `<span style="font-size:0.85rem; color:var(--text-secondary);">No print history recorded yet.</span>`;
                } else {
                    freqList.innerHTML = services.map(s => `
                        <div style="background:rgba(99,102,241,0.1); border:1px solid rgba(99,102,241,0.2); color:var(--text-primary); padding:6px 12px; border-radius:8px; font-size:0.82rem; font-weight:600;">
                            📄 ${s.paper_size || 'A4'} • ${s.print_type || 'B&W'} • ${s.sides || 'Single'} (${s.usage_count}x)
                        </div>
                    `).join('');
                }
            }

            // Order History Table
            renderOrderHistoryTab(data.orders || []);

            // Invoices Tab
            renderInvoicesTab(data.invoices || []);

            // Documents Tab
            renderDocumentsTab(data.documents || []);

            // Timeline Tab
            renderTimelineTab(data.timeline || []);
        } catch(e) {
            console.error("openCustomerProfile error:", e);
            if (window.showToast) window.showToast("Failed to load customer profile: " + e.message, "error");
        }
    }

    function renderOrderHistoryTab(orders) {
        const tbody = document.getElementById('cw-history-tbody');
        if (!tbody) return;

        if (orders.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-secondary);">No orders found for this customer.</td></tr>`;
            return;
        }

        tbody.innerHTML = orders.map(o => {
            const dt = new Date(o.created_at).toLocaleString();
            const config = `${o.main_paper_size || 'A4'} • ${o.main_print_type || 'Print'} • ${o.main_sides || 'Simplex'}`;
            const statusColor = o.status === 'Completed' ? '#10b981' : (o.status === 'Pending' ? '#f59e0b' : 'var(--text-secondary)');

            return `
                <tr>
                    <td style="font-weight:700;">#${o.id}</td>
                    <td>${dt}</td>
                    <td>
                        <strong style="color:var(--text-primary);">${escapeHtml(o.job_name || o.product_name || (o.main_paper_size ? `${o.main_paper_size} Print` : 'Print Job'))}</strong>
                        <div style="font-size:0.75rem; color:var(--text-secondary);">📄 File: ${escapeHtml(o.main_file_name || 'Attached File')}</div>
                    </td>
                    <td>${config}</td>
                    <td style="font-weight:700; color:#10b981;">₹${(o.total_price || 0).toFixed(2)}</td>
                    <td><span style="background:${statusColor}; color:white; padding:3px 8px; border-radius:4px; font-size:0.75rem; font-weight:700;">${o.status}</span></td>
                    <td>
                        <button class="cw-act-btn" onclick="window.duplicateCustomerOrder(${o.id})" title="Duplicate & Reorder">🖨️ Reorder</button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    function renderInvoicesTab(invoices) {
        const tbody = document.getElementById('cw-invoices-tbody');
        if (!tbody) return;

        if (invoices.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-secondary);">No GST invoices generated yet.</td></tr>`;
            return;
        }

        tbody.innerHTML = invoices.map(i => {
            const dt = new Date(i.created_at).toLocaleDateString();
            return `
                <tr>
                    <td style="font-weight:700;">${escapeHtml(i.invoice_number)}</td>
                    <td>${dt}</td>
                    <td>₹${(i.subtotal || 0).toFixed(2)}</td>
                    <td>₹${((i.cgst_total || 0) + (i.sgst_total || 0) + (i.igst_total || 0)).toFixed(2)}</td>
                    <td style="font-weight:700; color:#10b981;">₹${(i.grand_total || 0).toFixed(2)}</td>
                    <td><span style="background:#10b981; color:white; padding:3px 8px; border-radius:4px; font-size:0.75rem; font-weight:700;">${i.status || 'Paid'}</span></td>
                </tr>
            `;
        }).join('');
    }

    function renderDocumentsTab(docs) {
        const grid = document.getElementById('cw-documents-grid');
        if (!grid) return;

        if (docs.length === 0) {
            grid.innerHTML = `<div style="grid-column:span 3; text-align:center; color:var(--text-secondary); padding:20px;">No document attachments saved for this customer.</div>`;
            return;
        }

        grid.innerHTML = docs.map(d => {
            const ext = d.file_name ? d.file_name.substring(d.file_name.lastIndexOf('.')).toLowerCase() : '';
            let icon = '📄';
            if (['.jpg', '.jpeg', '.png'].includes(ext)) icon = '🖼️';

            return `
                <div style="background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:10px; padding:12px; display:flex; align-items:center; gap:10px;">
                    <div style="font-size:1.6rem;">${icon}</div>
                    <div style="flex:1; min-width:0;">
                        <div style="font-weight:700; font-size:0.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(d.file_name)}">${escapeHtml(d.file_name)}</div>
                        <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:2px;">${d.category || 'General'} • ${new Date(d.created_at).toLocaleDateString()}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderTimelineTab(timeline) {
        const feed = document.getElementById('cw-timeline-feed');
        if (!feed) return;

        if (timeline.length === 0) {
            feed.innerHTML = `<div style="text-align:center; color:var(--text-secondary); padding:20px;">No timeline events recorded.</div>`;
            return;
        }

        feed.innerHTML = timeline.map(item => {
            let icon = '📌';
            if (item.type === 'order') icon = '🛒';
            else if (item.type === 'note') icon = '💬';
            else if (item.type === 'document') icon = '📎';

            return `
                <div class="cw-tl-item">
                    <div class="cw-tl-icon">${icon}</div>
                    <div class="cw-tl-content">
                        <div class="cw-tl-header">
                            <span class="cw-tl-title">${escapeHtml(item.title)}</span>
                            <span class="cw-tl-time">${new Date(item.timestamp).toLocaleString()}</span>
                        </div>
                        <div class="cw-tl-desc">${escapeHtml(item.description)}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    /* --- QUICK ACTIONS HANDLERS --- */

    // 1-Click Action: Create New Order for Selected Customer
    function handleCreateOrder() {
        if (!activeCustomerProfile || !activeCustomerProfile.customer) return;
        const c = activeCustomerProfile.customer;

        // Populate order wizard fields & notify app.js
        const setupPhone = document.getElementById('setup-phone');
        const setupName = document.getElementById('setup-name');

        if (setupPhone) {
            setupPhone.value = c.phone || '';
            setupPhone.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (setupName) setupName.value = c.name || '';

        // Navigate to Order Workspace view
        const workspaceNavBtn = document.querySelector('.nav-btn[data-target="workspace"]');
        if (workspaceNavBtn) workspaceNavBtn.click();

        if (window.showToast) window.showToast(`Pre-filled customer ${c.name} for Order Workspace`, 'success');
    }

    // 1-Click Action: Repeat / Duplicate Previous Order
    async function handleRepeatOrder() {
        if (!activeCustomerProfile || !activeCustomerProfile.orders || activeCustomerProfile.orders.length === 0) {
            if (window.showToast) window.showToast('No previous orders found to duplicate.', 'warning');
            return;
        }
        const lastOrder = activeCustomerProfile.orders[0];
        window.duplicateCustomerOrder(lastOrder.id);
    }

    window.duplicateCustomerOrder = async function (orderId) {
        if (!window.api || !window.api.duplicateOrderForCustomer) return;

        try {
            const res = await window.api.duplicateOrderForCustomer(orderId);
            if (res.success) {
                if (window.showToast) window.showToast(`Order #${orderId} duplicated! (New Order #${res.orderId})`, 'success');
                if (selectedCustomerId) openCustomerProfile(selectedCustomerId);
            } else {
                if (window.showToast) window.showToast(`Failed to duplicate order: ${res.error}`, 'error');
            }
        } catch(e) {
            if (window.showToast) window.showToast(`Error duplicating order: ${e.message}`, 'error');
        }
    };

    // Quick Note Submission
    async function handleSaveNote() {
        if (!selectedCustomerId || !window.api || !window.api.addCustomerNote) return;

        const noteInput = document.getElementById('cw-quick-note-input');
        if (!noteInput || !noteInput.value.trim()) return;

        const noteText = noteInput.value.trim();
        try {
            const res = await window.api.addCustomerNote(selectedCustomerId, noteText, 'Operator');
            if (res.success) {
                noteInput.value = '';
                if (window.showToast) window.showToast('Note added!', 'success');
                openCustomerProfile(selectedCustomerId);
            } else {
                if (window.showToast) window.showToast('Failed to add note: ' + res.error, 'error');
            }
        } catch(e) {
            if (window.showToast) window.showToast('Error adding note: ' + e.message, 'error');
        }
    }

    // Save Print Preferences
    async function handleSavePreferences() {
        if (!selectedCustomerId || !window.api || !window.api.updateCustomerProfile || !activeCustomerProfile) return;

        const c = activeCustomerProfile.customer;
        const pCol = document.getElementById('cw-pref-color-input')?.value;
        const pSize = document.getElementById('cw-pref-size-input')?.value;
        const pSides = document.getElementById('cw-pref-sides-input')?.value;

        const updatedData = {
            ...c,
            preferred_print_type: pCol,
            preferred_paper_size: pSize,
            preferred_sides: pSides
        };

        try {
            const res = await window.api.updateCustomerProfile(selectedCustomerId, updatedData);
            if (res.success) {
                if (window.showToast) window.showToast('Print preferences saved!', 'success');
                openCustomerProfile(selectedCustomerId);
            } else {
                if (window.showToast) window.showToast('Failed to save preferences: ' + res.error, 'error');
            }
        } catch(e) {
            if (window.showToast) window.showToast('Error saving preferences: ' + e.message, 'error');
        }
    }

    /* --- ADD / EDIT CUSTOMER MODAL --- */
    function openCustomerModal(cust = null) {
        const modal = document.getElementById('cw-customer-modal');
        const title = document.getElementById('cw-modal-title');
        if (!modal) return;

        document.getElementById('cw-modal-cust-id').value = cust ? cust.id : '';
        document.getElementById('cw-modal-name').value = cust ? cust.name : '';
        document.getElementById('cw-modal-phone').value = cust ? cust.phone : '';
        document.getElementById('cw-modal-email').value = cust ? (cust.email || '') : '';
        document.getElementById('cw-modal-tag').value = cust ? (cust.tag || 'Regular') : 'Regular';
        document.getElementById('cw-modal-company').value = cust ? (cust.company_name || '') : '';
        document.getElementById('cw-modal-gstin').value = cust ? (cust.gstin || '') : '';
        document.getElementById('cw-modal-address').value = cust ? (cust.address || '') : '';

        if (title) title.textContent = cust ? 'Edit Customer Profile' : 'Add New Customer';
        modal.style.display = 'flex';
        setTimeout(() => {
            const nameInput = document.getElementById('cw-modal-name');
            if (nameInput) nameInput.focus();
        }, 50);
    }

    function closeCustomerModal() {
        const modal = document.getElementById('cw-customer-modal');
        if (modal) modal.style.display = 'none';
    }

    async function handleSaveCustomerModal() {
        const id = document.getElementById('cw-modal-cust-id').value;
        const name = document.getElementById('cw-modal-name').value.trim();
        const phone = document.getElementById('cw-modal-phone').value.trim();
        const email = document.getElementById('cw-modal-email').value.trim();
        const tag = document.getElementById('cw-modal-tag').value;
        const company = document.getElementById('cw-modal-company').value.trim();
        const gstin = document.getElementById('cw-modal-gstin').value.trim();
        const address = document.getElementById('cw-modal-address').value.trim();

        if (!name || !phone) {
            if (window.showToast) window.showToast('Name and phone number are required.', 'warning');
            return;
        }

        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            if (window.showToast) window.showToast('Please enter a valid email address.', 'warning');
            return;
        }

        const data = { name, phone, email, tag, company_name: company, gstin, address };
        const saveBtn = document.getElementById('cw-save-customer-btn');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML = 'Saving...';
        }

        try {
            if (id) {
                const res = await window.api.updateCustomerProfile(id, data);
                if (res.success) {
                    if (window.showToast) window.showToast('Customer updated!', 'success');
                    closeCustomerModal();
                    openCustomerProfile(id);
                    loadCustomersList();
                } else {
                    if (window.showToast) window.showToast('Failed to update customer: ' + (res.error || 'Unknown error'), 'error');
                }
            } else {
                const res = await window.api.createCustomer(data);
                if (res.success) {
                    if (window.showToast) window.showToast('New customer created!', 'success');
                    closeCustomerModal();
                    if (res.id) openCustomerProfile(res.id);
                    loadCustomersList();
                } else {
                    if (window.showToast) window.showToast('Failed to create customer: ' + (res.error || 'Unknown error'), 'error');
                }
            }
        } catch(e) {
            if (window.showToast) window.showToast('Error saving customer: ' + e.message, 'error');
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = 'Save Customer';
            }
        }
    }

    /* --- HELPERS --- */
    function getInitials(name) {
        if (!name) return 'CU';
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return parts[0].substring(0, 2).toUpperCase();
    }

    function getTagClass(tag) {
        if (!tag) return 'cw-tag-regular';
        const t = tag.toLowerCase();
        if (t === 'vip') return 'cw-tag-vip';
        if (t === 'corporate') return 'cw-tag-corporate';
        if (t === 'wholesale') return 'cw-tag-wholesale';
        if (t === 'walk-in' || t === 'walkin') return 'cw-tag-walk-in';
        return 'cw-tag-regular';
    }

    function formatRelativeDate(dateStr) {
        if (!dateStr) return 'Never';
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return 'Never';
        const now = new Date();
        const diffMs = now - d;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return `${diffDays} days ago`;
        if (diffDays < 30) return `${Math.floor(diffDays / 7)} wks ago`;
        return d.toLocaleDateString();
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

})();
