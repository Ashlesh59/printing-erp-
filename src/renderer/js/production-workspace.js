/* ====================================================
   ENTERPRISE PRINT ERP PRODUCTION MODULE CONTROLLER
   ==================================================== */

(function () {
    let selectedJobId = null;
    let loadedJobs = [];
    let activeCalView = 'day'; // 'day', 'week', 'month', 'heatmap'
    let isFilterOpen = false;

    let searchQuery = '';
    let statusFilter = 'All';
    let priorityFilter = 'All';
    let printerFilter = 'All';
    let paperFilter = 'All';
    let printTypeFilter = 'All';
    let sortCriterion = 'priority'; // 'priority', 'time', 'customer', 'status'
    let searchDebounceTimer = null;
    let availablePrintersList = [];

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCalendarWorkspace);
    } else {
        initCalendarWorkspace();
    }

    function initCalendarWorkspace() {
        // Segmented View Toggle (Day, Week, Month, Heatmap)
        const viewTabs = document.querySelectorAll('.ps-role-tab[data-cal-view]');
        viewTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                viewTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                activeCalView = tab.getAttribute('data-cal-view');
                renderActiveCalendarView();
            });
        });

        // Filter Drawer Toggle Button
        const btnFilterToggle = document.getElementById('ps-btn-filter-toggle');
        const filterDrawer = document.getElementById('ps-filter-drawer');
        if (btnFilterToggle && filterDrawer) {
            btnFilterToggle.addEventListener('click', () => {
                isFilterOpen = !isFilterOpen;
                filterDrawer.style.display = isFilterOpen ? 'block' : 'none';
                btnFilterToggle.classList.toggle('active', isFilterOpen);
            });
        }

        // Instant Search Input
        const searchInput = document.getElementById('ps-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                searchQuery = e.target.value;
                clearTimeout(searchDebounceTimer);
                searchDebounceTimer = setTimeout(() => {
                    loadProductionJobs();
                }, 150);
            });
        }

        // Sort Control
        const sortSelect = document.getElementById('ps-sort-select');
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                sortCriterion = e.target.value;
                renderActiveCalendarView();
            });
        }

        // Filter Handlers
        const filterStatus = document.getElementById('ps-filter-status');
        const filterPriority = document.getElementById('ps-filter-priority');
        const filterPrinter = document.getElementById('ps-filter-printer');
        const filterPaper = document.getElementById('ps-filter-paper');
        const filterPrintType = document.getElementById('ps-filter-print-type');

        if (filterStatus) filterStatus.addEventListener('change', (e) => { statusFilter = e.target.value; loadProductionJobs(); });
        if (filterPriority) filterPriority.addEventListener('change', (e) => { priorityFilter = e.target.value; loadProductionJobs(); });
        if (filterPrinter) filterPrinter.addEventListener('change', (e) => { printerFilter = e.target.value; loadProductionJobs(); });
        if (filterPaper) filterPaper.addEventListener('change', (e) => { paperFilter = e.target.value; loadProductionJobs(); });
        if (filterPrintType) filterPrintType.addEventListener('change', (e) => { printTypeFilter = e.target.value; loadProductionJobs(); });

        // Schedule Production Modal Triggers (Top Button & Bottom FAB)
        const btnSchedule = document.getElementById('ps-btn-open-schedule-modal');
        const fabSchedule = document.getElementById('ps-fab-add');
        const triggerModal = () => {
            if (typeof window.openScheduleProductionModal === 'function') {
                window.openScheduleProductionModal();
            }
        };
        if (btnSchedule) btnSchedule.addEventListener('click', triggerModal);
        if (fabSchedule) fabSchedule.addEventListener('click', triggerModal);

        // Notion Sidesheet Close Trigger
        const notionOverlay = document.getElementById('ps-notion-overlay');
        const notionCloseBtn = document.getElementById('ps-notion-close-btn');
        if (notionOverlay) notionOverlay.addEventListener('click', closeNotionSidesheet);
        if (notionCloseBtn) notionCloseBtn.addEventListener('click', closeNotionSidesheet);

        // Fetch Printers
        loadPrintersDropdown();

        // Load Initial Production Data
        loadProductionDashboard();
    }

    async function loadPrintersDropdown() {
        try {
            if (!window.api || !window.api.getPrinters) return;
            const printers = await window.api.getPrinters();
            const filterPrinter = document.getElementById('ps-filter-printer');
            const printerList = Array.isArray(printers) ? printers : [];
            availablePrintersList = printerList;
            if (filterPrinter) {
                let html = '<option value="All">All Printers</option>';
                printerList.forEach(p => {
                    const name = p.name || p.display_name;
                    html += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
                });
                filterPrinter.innerHTML = html;
            }
        } catch (e) {
            console.error("loadPrintersDropdown error:", e);
        }
    }

    async function loadProductionDashboard() {
        await loadProductionJobs();
    }

    function getDateRangeForView(view) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

        if (view === 'day') {
            return { dateStart: start.toISOString(), dateEnd: end.toISOString() };
        } else if (view === 'week') {
            const dayOfWeek = start.getDay(); // 0 is Sunday
            const diffToMonday = start.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); 
            const monday = new Date(start);
            monday.setDate(diffToMonday);
            monday.setHours(0, 0, 0, 0);

            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);
            sunday.setHours(23, 59, 59, 999);

            return { dateStart: monday.toISOString(), dateEnd: sunday.toISOString() };
        } else if (view === 'month' || view === 'heatmap') {
            const firstDay = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
            const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
            return { dateStart: firstDay.toISOString(), dateEnd: lastDay.toISOString() };
        }
        return { dateStart: null, dateEnd: null };
    }

    async function loadProductionJobs() {
        try {
            if (!window.api || !window.api.productionGetJobs) return;
            const dateRange = getDateRangeForView(activeCalView);
            const filters = {
                status: statusFilter,
                priority: priorityFilter,
                printer: printerFilter,
                ...dateRange
            };

            const jobs = await window.api.productionGetJobs(filters, searchQuery);
            let filtered = Array.isArray(jobs) ? [...jobs] : [];

            // Apply additional local filters (paper & printType) if set
            if (paperFilter !== 'All') {
                filtered = filtered.filter(j => (j.paper_size || '').toLowerCase() === paperFilter.toLowerCase());
            }
            if (printTypeFilter !== 'All') {
                filtered = filtered.filter(j => (j.color_mode || '').toLowerCase().includes(printTypeFilter.toLowerCase()));
            }

            // Apply Sorting
            filtered.sort((a, b) => {
                if (sortCriterion === 'priority') {
                    const pMap = { Urgent: 1, High: 2, Normal: 3, Low: 4 };
                    return (pMap[a.priority] || 3) - (pMap[b.priority] || 3);
                } else if (sortCriterion === 'time') {
                    return (new Date(a.due_time || a.created_at) - new Date(b.due_time || b.created_at));
                } else if (sortCriterion === 'customer') {
                    return (a.customer_name || '').localeCompare(b.customer_name || '');
                } else if (sortCriterion === 'status') {
                    return (a.status || '').localeCompare(b.status || '');
                }
                return 0;
            });

            loadedJobs = filtered;
            
            if (window.api.productionGetDashboardStats) {
                const stats = await window.api.productionGetDashboardStats(filters);
                if (stats) {
                    const elJobs = document.getElementById('ps-kpi-jobs');
                    const elTime = document.getElementById('ps-kpi-time');
                    const elPages = document.getElementById('ps-kpi-pages');
                    const elPrinters = document.getElementById('ps-kpi-printers');
                    const elWaiting = document.getElementById('ps-kpi-waiting');
                    const elPrinting = document.getElementById('ps-kpi-printing');
                    const elCompleted = document.getElementById('ps-kpi-completed');
                    
                    if (elJobs) elJobs.textContent = stats.totalJobs || 0;
                    if (elTime) {
                        const totalMins = (stats.totalJobs || 0) * (stats.avgCompletionMinutes || 8);
                        const hrs = Math.floor(totalMins / 60);
                        const mins = totalMins % 60;
                        elTime.textContent = `${hrs}h ${mins}m`;
                    }
                    if (elPages) elPages.textContent = (stats.totalPages || 0).toLocaleString();
                    if (elPrinters) elPrinters.textContent = stats.printersActive || 0;
                    if (elWaiting) elWaiting.textContent = stats.jobsWaiting || 0;
                    if (elPrinting) elPrinting.textContent = stats.jobsPrinting || 0;
                    if (elCompleted) elCompleted.textContent = stats.completedToday || 0;
                }
            }

            renderActiveCalendarView();

            if (selectedJobId) {
                const sel = loadedJobs.find(j => j.id === selectedJobId);
                if (sel) renderNotionSidesheetContent(sel);
            }
        } catch (e) {
            console.error("loadProductionJobs error:", e);
        }
    }

    function renderActiveCalendarView() {
        const panes = document.querySelectorAll('#ps-cal-views-wrapper .ps-view-pane');
        panes.forEach(p => p.classList.remove('active'));

        const targetPane = document.getElementById(`cal-pane-${activeCalView}`);
        if (targetPane) targetPane.classList.add('active');

        switch (activeCalView) {
            case 'day': renderDayView(); break;
            case 'week': renderWeekView(); break;
            case 'month': renderMonthListView(); break;
            case 'heatmap': renderMonthHeatmapView(); break;
            default: renderDayView(); break;
        }
    }

    // ──────────────────────────────────────────────────────────────
    // ENTERPRISE JOB CARD RENDERER (STRICT 4-SECTION DESIGN)
    // ──────────────────────────────────────────────────────────────
    // ──────────────────────────────────────────────────────────────
    // ENTERPRISE JOB CARD RENDERER (CUSTOMER-FIRST HIERARCHY)
    // ──────────────────────────────────────────────────────────────
    function renderJobCardHtml(j) {
        const customerName = escapeHtml(j.customer_name || 'Walk-in Customer');
        const customerPhone = j.customer_phone ? escapeHtml(j.customer_phone) : '';
        const jobProduct = escapeHtml(j.job_name || j.product_name || (j.paper_size ? `${j.paper_size} Print` : 'Print Order'));
        const fileName = escapeHtml(j.file_name || 'Attached_Document.pdf');
        const targetDateObj = (j.scheduled_start || j.due_time) ? new Date(j.scheduled_start || j.due_time) : null;
        let timeStr = '10:00 AM';
        if (targetDateObj && !isNaN(targetDateObj.getTime())) {
            const today = new Date();
            const isToday = targetDateObj.toDateString() === today.toDateString();
            const timePart = targetDateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            if (isToday) {
                timeStr = `Today, ${timePart}`;
            } else {
                const datePart = targetDateObj.toLocaleDateString([], { month: 'short', day: 'numeric' });
                timeStr = `${datePart}, ${timePart}`;
            }
        }
        const printerName = escapeHtml(j.assigned_printer || 'Default Printer');
        const operatorName = escapeHtml(j.assigned_operator || 'Operator');
        const copiesCount = `${j.copies || 1} Copies`;
        const paperSize = escapeHtml(j.paper_size || 'A4');
        const colorMode = escapeHtml(j.color_mode || 'Color');
        const statusPillHtml = getSoftStatusPill(j.status || 'Scheduled');

        const parts = (j.customer_name || 'W I').split(' ');
        const avatarInitials = (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();

        return `
            <div class="ps-job-card" data-job-id="${j.id}" draggable="true" onclick="window.selectProductionJob(${j.id})">
                <!-- Top Row: Customer Avatar, Customer Name (Primary), Phone (Secondary), Three Dot Menu -->
                <div class="ps-card-top-row">
                    <div class="ps-cust-profile">
                        <div class="ps-cust-avatar" title="${customerName}">${avatarInitials}</div>
                        <div style="display: flex; flex-direction: column; overflow: hidden;">
                            <span class="ps-cust-name" title="${customerName}" style="font-weight: 700; color: var(--text-primary, #0f172a);">👤 ${customerName}</span>
                            ${customerPhone ? `<span class="ps-cust-phone" style="font-size: 0.76rem; color: var(--text-secondary, #64748b);">📞 ${customerPhone}</span>` : ''}
                        </div>
                    </div>
                    <button class="ps-card-menu-btn" onclick="event.stopPropagation(); window.toggleJobContextMenu(event, ${j.id})" title="Actions">⋮</button>
                </div>

                <!-- Second Section: Order Number & Product (Third) -->
                <div class="ps-card-job-name" title="${jobProduct}" style="font-size: 0.86rem; margin-top: 6px;">
                    <span style="font-weight: 600; color: var(--text-primary, #1e293b);">${j.order_id ? `#${j.order_id} • ` : ''}${jobProduct}</span>
                </div>

                <!-- Third Section: File Name (Supporting detail with title tooltip) -->
                <div class="ps-card-file-name" title="File: ${fileName}">
                    <span class="ps-file-icon">📄</span>
                    <span class="ps-file-text">${fileName}</span>
                </div>

                <!-- Fourth Section: Information Grid (2x2 Icons + Metadata) -->
                <div class="ps-info-grid">
                    <div class="ps-info-item" title="Scheduled Time">
                        <span class="ps-info-icon">🕒</span>
                        <span>${timeStr}</span>
                    </div>
                    <div class="ps-info-item" title="Assigned Printer & Operator">
                        <span class="ps-info-icon">🖨️</span>
                        <span>${printerName} (${operatorName})</span>
                    </div>
                    <div class="ps-info-item" title="Copies">
                        <span class="ps-info-icon">📋</span>
                        <span>${copiesCount}</span>
                    </div>
                    <div class="ps-info-item" title="Paper Size & Print Type">
                        <span class="ps-info-icon">📏</span>
                        <span>${paperSize} • ${colorMode}</span>
                    </div>
                </div>

                <!-- Bottom Row: Status Badge -->
                <div class="ps-card-bottom-row">
                    ${statusPillHtml}
                    <span class="ps-order-id-tag">Job #${j.id}</span>
                </div>
            </div>
        `;
    }

    // ──────────────────────────────────────────────────────────────
    // 1. DAY VIEW (CLEAN COLUMN AGENDA WITH ENTERPRISE CARDS)
    // ──────────────────────────────────────────────────────────────
    function renderDayView() {
        const container = document.getElementById('ps-day-timeline-list');
        if (!container) return;

        if (loadedJobs.length === 0) {
            container.innerHTML = `
                <div class="ps-empty-state-box">
                    <div class="ps-empty-icon">📅</div>
                    <h3 class="ps-empty-title">No production scheduled for today.</h3>
                    <p class="ps-empty-desc">Click <strong>+ Schedule Production</strong> to add a new job to the queue.</p>
                </div>
            `;
            return;
        }

        let html = `<div class="ps-day-grid-container">`;
        html += loadedJobs.map(j => renderJobCardHtml(j)).join('');
        html += `</div>`;

        container.innerHTML = html;
        bindCardDragAndDrop(container);
    }

    // ──────────────────────────────────────────────────────────────
    // 2. WEEK VIEW (GROUPED BY DAY, COLLAPSIBLE)
    // ──────────────────────────────────────────────────────────────
    function renderWeekView() {
        const container = document.getElementById('ps-week-grid');
        if (!container) return;

        if (loadedJobs.length === 0) {
            container.innerHTML = `
                <div class="ps-empty-state-box">
                    <div class="ps-empty-icon">📅</div>
                    <h3 class="ps-empty-title">No production scheduled for this week.</h3>
                    <p class="ps-empty-desc">Click <strong>+ Schedule Production</strong> to add a new job to the queue.</p>
                </div>
            `;
            return;
        }

        const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const grouped = {};
        days.forEach(d => grouped[d] = []);

        loadedJobs.forEach(j => {
            const date = new Date(j.scheduled_start || j.created_at);
            let dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
            if (grouped[dayName]) grouped[dayName].push(j);
        });

        let html = `<div class="ps-week-list-wrapper">`;
        
        days.forEach(d => {
            const jobs = grouped[d];
            html += `
                <div class="ps-date-group-section">
                    <div class="ps-date-group-header" onclick="this.parentElement.classList.toggle('collapsed')">
                        <span class="ps-group-title">${d}</span>
                        <span class="ps-group-count">• ${jobs.length} Jobs</span>
                        <span class="ps-group-chevron">▼</span>
                    </div>
                    <div class="ps-date-group-content">
                        ${jobs.length === 0 ? `<div class="ps-col-empty">No Jobs</div>` : `<div class="ps-day-grid-container">${jobs.map(j => renderJobCardHtml(j)).join('')}</div>`}
                    </div>
                </div>
            `;
        });

        html += `</div>`;
        container.innerHTML = html;
        bindCardDragAndDrop(container);
    }

    // ──────────────────────────────────────────────────────────────
    // 2.5 MONTH LIST VIEW (GROUPED BY DATE, COLLAPSIBLE)
    // ──────────────────────────────────────────────────────────────
    function renderMonthListView() {
        const container = document.getElementById('ps-month-list');
        if (!container) return;

        if (loadedJobs.length === 0) {
            container.innerHTML = `
                <div class="ps-empty-state-box">
                    <div class="ps-empty-icon">📅</div>
                    <h3 class="ps-empty-title">No production scheduled this month.</h3>
                    <p class="ps-empty-desc">Click <strong>+ Schedule Production</strong> to add a new job to the queue.</p>
                </div>
            `;
            return;
        }

        const grouped = {};
        loadedJobs.forEach(j => {
            const date = new Date(j.scheduled_start || j.created_at);
            const dateKey = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            if (!grouped[dateKey]) grouped[dateKey] = [];
            grouped[dateKey].push(j);
        });

        let html = `<div class="ps-month-list-wrapper">`;
        
        Object.keys(grouped).forEach(dateKey => {
            const jobs = grouped[dateKey];
            html += `
                <div class="ps-date-group-section">
                    <div class="ps-date-group-header" onclick="this.parentElement.classList.toggle('collapsed')">
                        <span class="ps-group-title">${dateKey}</span>
                        <span class="ps-group-count">• ${jobs.length} Jobs</span>
                        <span class="ps-group-chevron">▼</span>
                    </div>
                    <div class="ps-date-group-content">
                        <div class="ps-day-grid-container">${jobs.map(j => renderJobCardHtml(j)).join('')}</div>
                    </div>
                </div>
            `;
        });

        html += `</div>`;
        container.innerHTML = html;
        bindCardDragAndDrop(container);
    }

    // ──────────────────────────────────────────────────────────────
    // 3. MONTH HEATMAP VIEW
    // ──────────────────────────────────────────────────────────────
    function renderMonthHeatmapView() {
        const container = document.getElementById('ps-heatmap-calendar');
        if (!container) return;

        if (loadedJobs.length === 0 && !statusFilter) {
            container.innerHTML = `
                <div class="ps-empty-state-box">
                    <div class="ps-empty-icon">📅</div>
                    <h3 class="ps-empty-title">No production has been scheduled yet.</h3>
                    <p class="ps-empty-desc">Click <strong>+ Schedule Production</strong> to add a new job to the queue.</p>
                </div>
            `;
            return;
        }

        // Generate current month days
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        
        // Group loadedJobs by day of month
        const dayCounts = {};
        let dayMinutes = {};
        loadedJobs.forEach(j => {
            const date = new Date(j.scheduled_start || j.created_at);
            if (date.getMonth() === month && date.getFullYear() === year) {
                const day = date.getDate();
                dayCounts[day] = (dayCounts[day] || 0) + 1;
                // mock average time per job for heatmap
                dayMinutes[day] = (dayMinutes[day] || 0) + 8; // approx 8 mins per job
            }
        });

        let html = `<div class="ps-heatmap-grid">`;
        for (let day = 1; day <= daysInMonth; day++) {
            const loadCount = dayCounts[day] || 0;
            const minutes = dayMinutes[day] || 0;
            const hrs = Math.floor(minutes / 60);
            const mins = minutes % 60;
            const estTimeStr = `${hrs}h ${mins}m`;
            
            // Color Scale: Light Green (1-5), Yellow (6-15), Orange (16-30), Red (30+)
            let heatClass = 'free';
            if (loadCount >= 30) heatClass = 'red';
            else if (loadCount >= 16) heatClass = 'orange';
            else if (loadCount >= 6) heatClass = 'yellow';
            else if (loadCount >= 1) heatClass = 'green';
            else heatClass = 'free';

            const tooltipHtml = loadCount > 0 ? `<div class="ps-heatmap-tooltip"><strong>${new Date(year, month, day).toLocaleDateString('en-US', {month: 'short', day: 'numeric'})}</strong><br/>${loadCount} Scheduled Jobs<br/>Estimated Print Time: ${estTimeStr}</div>` : '';

            html += `
                <div class="ps-heatmap-cell ${heatClass}" onclick="document.getElementById('ps-view-day').click();">
                    <div class="ps-heat-day">${day}</div>
                    ${loadCount > 0 ? `<div class="ps-heat-count">${loadCount} Jobs</div>` : ''}
                    ${tooltipHtml}
                </div>
            `;
        }
        html += `</div>`;
        container.innerHTML = html;
    }

    // ──────────────────────────────────────────────────────────────
    // DRAG AND DROP ENGINE
    // ──────────────────────────────────────────────────────────────
    function bindCardDragAndDrop(parentEl) {
        if (!parentEl) return;

        const cards = parentEl.querySelectorAll('.ps-job-card');
        cards.forEach(card => {
            card.addEventListener('dragstart', (e) => {
                const jobId = card.getAttribute('data-job-id');
                e.dataTransfer.setData('text/plain', jobId);
                card.classList.add('dragging');
            });
            card.addEventListener('dragend', () => {
                card.classList.remove('dragging');
            });
        });

        const columns = parentEl.querySelectorAll('.ps-week-column, .ps-day-grid-container');
        columns.forEach(col => {
            col.addEventListener('dragover', (e) => {
                e.preventDefault();
                col.classList.add('drag-over');
            });
            col.addEventListener('dragleave', () => {
                col.classList.remove('drag-over');
            });
            col.addEventListener('drop', async (e) => {
                e.preventDefault();
                col.classList.remove('drag-over');
                const jobId = e.dataTransfer.getData('text/plain');
                if (jobId) {
                    if (window.showToast) window.showToast(`Reordered Job #${jobId} in queue`, "info");
                    loadProductionDashboard();
                }
            });
        });
    }

    // ──────────────────────────────────────────────────────────────
    // THREE-DOT CONTEXT MENU ENGINE
    // ──────────────────────────────────────────────────────────────
    // ──────────────────────────────────────────────────────────────
    // SCOPED ACTION MUTEX GUARDS (PER-JOB AND PER-ACTION LOCKING)
    // ──────────────────────────────────────────────────────────────
    const activeProdJobActions = new Set();
    const isJobActionBusy = (jobId, action) => activeProdJobActions.has(`${jobId}:${action}`);
    const setJobActionBusy = (jobId, action, busy) => busy ? activeProdJobActions.add(`${jobId}:${action}`) : activeProdJobActions.delete(`${jobId}:${action}`);

    // ──────────────────────────────────────────────────────────────
    // THREE-DOT CONTEXT MENU ENGINE
    // ──────────────────────────────────────────────────────────────
    window.toggleJobContextMenu = function(e, jobId) {
        e.stopPropagation();
        let menu = document.getElementById('ps-job-context-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'ps-job-context-menu';
            menu.className = 'ps-context-menu';
            document.body.appendChild(menu);
        }

        const job = loadedJobs.find(j => j.id === jobId);
        if (!job) return;

        const isPrinting = (job.status || '').toLowerCase() === 'printing';

        menu.innerHTML = `
            <div class="ps-context-item" onclick="window.selectProductionJob(${jobId}); window.closeJobContextMenu();">
                <span>ⓘ</span> Details
            </div>
            <div class="ps-context-item" onclick="window.rescheduleJobModal(${jobId}); window.closeJobContextMenu();">
                <span>📅</span> Reschedule
            </div>
            <div class="ps-context-item" onclick="window.assignPrinterModal(${jobId}); window.closeJobContextMenu();">
                <span>🖨️</span> Assign Printer
            </div>
            <div class="ps-context-item" onclick="window.duplicateProductionJob(${jobId}); window.closeJobContextMenu();">
                <span>📋</span> Duplicate
            </div>
            <div class="ps-context-divider"></div>
            ${isPrinting ? `
                <div class="ps-context-item" onclick="window.updateJobStatus(${jobId}, 'Paused'); window.closeJobContextMenu();">
                    <span>⏸️</span> Pause Job
                </div>
            ` : `
                <div class="ps-context-item" onclick="window.updateJobStatus(${jobId}, 'Printing'); window.closeJobContextMenu();">
                    <span>▶️</span> Start / Resume
                </div>
            `}
            <div class="ps-context-item" onclick="window.updateJobStatus(${jobId}, 'Completed'); window.closeJobContextMenu();">
                <span>✓</span> Mark Completed
            </div>
            <div class="ps-context-divider"></div>
            <div class="ps-context-item danger" onclick="window.updateJobStatus(${jobId}, 'Cancelled'); window.closeJobContextMenu();">
                <span>✕</span> Cancel Job
            </div>
            <div class="ps-context-item danger" onclick="window.deleteProductionJob(${jobId}); window.closeJobContextMenu();">
                <span>🗑️</span> Delete Job
            </div>
        `;

        const rect = e.currentTarget.getBoundingClientRect();
        menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
        menu.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 180)}px`;
        menu.style.display = 'block';
    };

    window.closeJobContextMenu = function() {
        const menu = document.getElementById('ps-job-context-menu');
        if (menu) menu.style.display = 'none';
    };

    document.addEventListener('click', () => {
        window.closeJobContextMenu();
    });

    window.deleteProductionJob = async function(jobId) {
        if (!window.api || !window.api.productionDeleteJob) return;
        if (isJobActionBusy(jobId, 'delete')) return;
        setJobActionBusy(jobId, 'delete', true);
        try {
            const res = await window.api.productionDeleteJob(jobId);
            if (res.success) {
                if (window.showToast) window.showToast(`Deleted Job #${jobId}`, "info");
                loadProductionDashboard();
            }
        } catch(e) {
            if (window.showToast) window.showToast("Error deleting job: " + e.message, "error");
        } finally {
            setJobActionBusy(jobId, 'delete', false);
        }
    };

    window.assignPrinterModal = async function(jobId) {
        if (isJobActionBusy(jobId, 'assignPrinter')) return;
        setJobActionBusy(jobId, 'assignPrinter', true);

        const printers = availablePrintersList.length > 0 ? availablePrintersList : [
            { name: 'EPSON L3210 Series' },
            { name: 'Canon imageRUNNER 2630' },
            { name: 'HP LaserJet Pro' }
        ];

        let modal = document.getElementById('assign-printer-dynamic-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'assign-printer-dynamic-modal';
            modal.style.cssText = `
                position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                background: rgba(0,0,0,0.6); z-index: 9999; display: flex;
                align-items: center; justify-content: center; backdrop-filter: blur(4px);
            `;
            document.body.appendChild(modal);
        }

        const optionsHtml = printers.map(p => {
            const name = p.name || p.display_name;
            return `<option value="${name}">${name}</option>`;
        }).join('');

        modal.innerHTML = `
            <div style="background: var(--bg-card, #ffffff); border-radius: 12px; padding: 24px; width: 380px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.3); color: var(--text-primary, #1e293b);">
                <h3 style="margin-top: 0; margin-bottom: 12px; font-size: 1.1rem; font-weight: 600;">Assign Printer (Job #${jobId})</h3>
                <p style="font-size: 0.85rem; color: var(--text-secondary, #64748b); margin-bottom: 16px;">Select an active printer for this production task:</p>
                <select id="assign-printer-select" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color, #cbd5e1); margin-bottom: 20px; font-size: 0.95rem; background: var(--bg-input, #f8fafc); color: var(--text-primary, #0f172a);">
                    ${optionsHtml}
                </select>
                <div style="display: flex; justify-content: flex-end; gap: 10px;">
                    <button id="assign-printer-cancel" style="padding: 8px 16px; border-radius: 6px; border: 1px solid var(--border-color, #cbd5e1); background: transparent; cursor: pointer; color: var(--text-primary, #334155);">Cancel</button>
                    <button id="assign-printer-confirm" style="padding: 8px 16px; border-radius: 6px; border: none; background: #e11d48; color: #ffffff; font-weight: 600; cursor: pointer;">Assign Printer</button>
                </div>
            </div>
        `;
        modal.style.display = 'flex';

        return new Promise((resolve) => {
            const cancelBtn = modal.querySelector('#assign-printer-cancel');
            const confirmBtn = modal.querySelector('#assign-printer-confirm');

            const cleanup = () => { 
                modal.style.display = 'none'; 
                setJobActionBusy(jobId, 'assignPrinter', false);
            };

            cancelBtn.onclick = () => {
                cleanup();
                resolve(null);
            };

            confirmBtn.onclick = async () => {
                const selectEl = modal.querySelector('#assign-printer-select');
                const chosen = selectEl.value;
                cleanup();
                if (chosen && chosen.trim() !== '') {
                    try {
                        const res = await window.api.productionAssignPrinter(jobId, chosen.trim());
                        if (res.success) {
                            if (window.showToast) window.showToast(`Assigned printer "${chosen.trim()}" to Job #${jobId}`, "success");
                            loadProductionDashboard();
                        }
                    } catch(e) {
                        if (window.showToast) window.showToast("Error assigning printer: " + e.message, "error");
                    }
                }
                resolve(chosen);
            };
        });
    };

    window.rescheduleJobModal = function(jobId) {
        const job = loadedJobs.find(j => j.id === jobId);
        if (!job) return;
        if (typeof window.openScheduleProductionModal === 'function') {
            window.openScheduleProductionModal({
                type: 'PRODUCTION_JOB_RESCHEDULE',
                productionJobId: job.id,
                orderId: job.order_id,
                ...job
            });
        }
    };

    // ──────────────────────────────────────────────────────────────
    // NOTION-STYLE FLOATING SIDE SHEET (CUSTOMER-FIRST HIERARCHY)
    // ──────────────────────────────────────────────────────────────
    function openNotionSidesheet(job) {
        const sidesheet = document.getElementById('ps-notion-sidesheet');
        const overlay = document.getElementById('ps-notion-overlay');
        if (!sidesheet || !overlay) return;

        renderNotionSidesheetContent(job);
        sidesheet.classList.add('open');
        overlay.classList.add('open');

        loadAndRenderJobSpecifications(job.order_item_id);
    }

    async function loadAndRenderJobSpecifications(orderItemId) {
        const specContainer = document.getElementById('sidesheet-specs-container');
        if (!specContainer) return;
        specContainer.innerHTML = '<div style="font-size:0.8rem; color:var(--text-secondary);">Loading specifications...</div>';
        
        try {
            if (window.api && window.api.getOrderItemSpecifications && orderItemId) {
                const specs = await window.api.getOrderItemSpecifications(orderItemId);
                if (specs && specs.length > 0) {
                    let html = `<div style="display: flex; flex-direction: column; gap: 8px;">`;
                    specs.forEach(s => {
                        html += `
                            <div style="display: flex; justify-content: space-between; font-size: 0.82rem; border-bottom: 1px dashed rgba(0,0,0,0.08); padding-bottom: 4px;">
                                <span style="color: var(--text-secondary);">${s.spec_key}</span>
                                <strong style="color: var(--text-primary);">${s.spec_value}</strong>
                            </div>
                        `;
                    });
                    html += `</div>`;
                    specContainer.innerHTML = html;
                } else {
                    specContainer.innerHTML = '<div style="font-size:0.8rem; color:var(--text-secondary); font-style:italic;">No custom specifications</div>';
                }
            } else {
                specContainer.innerHTML = '<div style="font-size:0.8rem; color:var(--text-secondary); font-style:italic;">No custom specifications</div>';
            }
        } catch(e) {
            console.error("Failed to load job specs:", e);
            specContainer.innerHTML = '<div style="font-size:0.8rem; color:var(--text-secondary); font-style:italic;">No custom specifications</div>';
        }
    }

    function closeNotionSidesheet() {
        const sidesheet = document.getElementById('ps-notion-sidesheet');
        const overlay = document.getElementById('ps-notion-overlay');
        if (sidesheet) sidesheet.classList.remove('open');
        if (overlay) overlay.classList.remove('open');
        selectedJobId = null;
    }

    function renderNotionSidesheetContent(job) {
        const body = document.getElementById('ps-notion-body');
        const title = document.getElementById('notion-job-title');
        const orderId = document.getElementById('notion-order-id');
        if (!body) return;

        const customer = job.customer_name || 'Walk-in Customer';
        const product = job.job_name || job.product_name || (job.paper_size ? `${job.paper_size} Print` : 'Print Order');

        if (title) title.textContent = customer;
        if (orderId) orderId.textContent = `${job.order_id ? `#${job.order_id} • ` : ''}${product} (Job #${job.id})`;

        const statusPill = getSoftStatusPill(job.status);
        const progressPct = job.progress_pct || (job.status === 'Ready' || job.status === 'Completed' || job.status === 'Delivered' ? 100 : (job.status === 'Printing' ? 50 : 10));

        body.innerHTML = `
            <!-- Header Badge & Status -->
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <div>${statusPill}</div>
                <div style="font-size: 0.8rem; font-weight: 700; color: var(--text-secondary);">Priority: <strong style="color:var(--text-primary);">${escapeHtml(job.priority || 'Normal')}</strong></div>
            </div>

            <!-- Single Source of Truth Properties List (Customer-First) -->
            <div style="display: flex; flex-direction: column; gap: 14px; background: #ffffff; border: 1px solid var(--border-color); border-radius: 14px; padding: 16px; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; font-size: 0.88rem;">
                    <span style="color: var(--text-secondary);">👤 Customer</span>
                    <strong style="color: var(--text-primary);">${escapeHtml(customer)}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 0.88rem;">
                    <span style="color: var(--text-secondary);">📞 Phone</span>
                    <strong style="color: var(--text-primary);">${escapeHtml(job.customer_phone || '--')}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 0.88rem;">
                    <span style="color: var(--text-secondary);">🗒️ Product / Job</span>
                    <strong style="color: var(--text-primary);">${job.order_id ? `#${job.order_id} • ` : ''}${escapeHtml(product)}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 0.88rem;">
                    <span style="color: var(--text-secondary);">📄 Paper &amp; Stock</span>
                    <strong style="color: var(--text-primary);">${escapeHtml(job.paper_size || 'A4')} ${escapeHtml(job.color_mode || 'B&W')}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 0.88rem;">
                    <span style="color: var(--text-secondary);">📑 Quantity &amp; Copies</span>
                    <strong style="color: var(--text-primary);">${job.total_pages || job.pages || 1} pgs &times; ${job.copies || 1} c</strong>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 0.88rem;">
                    <span style="color: var(--text-secondary);">🖨️ Assigned Printer</span>
                    <strong style="color: var(--text-primary);">${escapeHtml(job.assigned_printer || 'Unassigned')}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 0.88rem;">
                    <span style="color: var(--text-secondary);">📁 Original File Name</span>
                    <span style="color: var(--text-secondary); font-size: 0.82rem; font-style: italic; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(job.file_name || 'No file attached')}">${escapeHtml(job.file_name || 'No file attached')}</span>
                </div>
            </div>

            <!-- Custom Specifications Panel -->
            <div style="background: #ffffff; border: 1px solid var(--border-color); border-radius: 14px; padding: 16px; margin-bottom: 20px;">
                <div style="font-size: 0.8rem; font-weight: 700; text-transform: uppercase; color: var(--text-secondary); margin-bottom: 10px; letter-spacing: 0.5px;">⚙️ Job Specifications</div>
                <div id="sidesheet-specs-container">
                    <div style="font-size:0.8rem; color:var(--text-secondary); font-style:italic;">No custom specifications</div>
                </div>
            </div>

            <!-- Live Progress Gauge -->
            <div style="margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; font-size: 0.8rem; font-weight: 700; margin-bottom: 6px;">
                    <span>Production Progress</span>
                    <span>${progressPct}%</span>
                </div>
                <div class="ps-progress-track">
                    <div class="ps-progress-fill" style="width: ${progressPct}%;"></div>
                </div>
            </div>

            <!-- Single Source of Truth Execution Actions -->
            <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 8px;">Order Actions</div>
            <div class="ps-act-group" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <button class="ps-btn-act ps-btn-primary" onclick="window.updateJobStatus(${job.id}, 'Printing')">
                    ▶ Start Printing
                </button>
                <button class="ps-btn-act" onclick="window.updateJobStatus(${job.id}, 'Paused')">
                    ⏸ Pause Job
                </button>
                <button class="ps-btn-act" onclick="window.updateJobStatus(${job.id}, 'Completed')">
                    ✓ Complete
                </button>
                <button class="ps-btn-act" onclick="window.reprintProductionJob(${job.id})">
                    🖨️ Reprint Job
                </button>
                <button class="ps-btn-act" onclick="window.duplicateProductionJob(${job.id})">
                    📋 Duplicate Job
                </button>
                <button class="ps-btn-act" style="color: #dc2626; border-color: rgba(220, 38, 38, 0.3);" onclick="window.deleteProductionJob(${job.id})">
                    🗑️ Delete Job
                </button>
            </div>
        `;
    }

    // ──────────────────────────────────────────────────────────────
    // AUTHORITATIVE REPRINT & ACTION CONTROLLERS
    // ──────────────────────────────────────────────────────────────
    window.reprintProductionJob = async function(jobId) {
        if (isJobActionBusy(jobId, 'reprint')) return;
        setJobActionBusy(jobId, 'reprint', true);

        try {
            const job = loadedJobs.find(j => j.id === jobId);
            if (!job) throw new Error('Job not found in loaded queue');

            if (!window.api || !window.api.printFile) {
                throw new Error('Print service API is not available');
            }

            const printPayload = {
                filePath: job.file_path || null,
                fileName: job.file_name || 'Document.pdf',
                orderId: job.order_id || null
            };

            const printOptions = {
                printerName: job.assigned_printer || 'Default',
                printType: job.color_mode || 'B&W',
                paperSize: job.paper_size || 'A4',
                copies: job.copies || 1,
                orderId: job.order_id || null
            };

            const res = await window.api.printFile(printPayload, printOptions);
            if (res && res.success) {
                if (window.showToast) window.showToast(`Reprint queued for Job #${jobId} on ${printOptions.printerName}!`, 'success');
            } else {
                const err = res ? res.error : 'Printer offline or unreachable';
                if (window.showPrinterErrorModal) {
                    window.showPrinterErrorModal(err, printPayload, printOptions);
                } else if (window.showToast) {
                    window.showToast(`Reprint warning: ${err}`, 'warning');
                }
            }
        } catch(e) {
            console.error('[Production] Reprint failed:', e);
            if (window.showToast) window.showToast('Reprint failed: ' + e.message, 'error');
        } finally {
            setJobActionBusy(jobId, 'reprint', false);
        }
    };

    window.selectProductionJob = function (jobId) {
        selectedJobId = jobId;
        const job = loadedJobs.find(j => j.id === jobId);
        if (job) openNotionSidesheet(job);
    };

    window.updateJobStatus = async function (jobId, newStatus) {
        if (!window.api || !window.api.productionUpdateStatus) return;
        if (isJobActionBusy(jobId, 'updateStatus')) return;
        setJobActionBusy(jobId, 'updateStatus', true);

        try {
            const res = await window.api.productionUpdateStatus(jobId, newStatus);
            if (res && res.success) {
                if (window.showToast) window.showToast(`Job #${jobId} status updated to ${newStatus}`, "success");
                await loadProductionDashboard();
            } else {
                const errMsg = res ? res.error : 'Failed to update job status';
                if (window.showToast) window.showToast(errMsg, "error");
            }
        } catch (e) {
            if (window.showToast) window.showToast("Error updating status: " + e.message, "error");
        } finally {
            setJobActionBusy(jobId, 'updateStatus', false);
        }
    };

    window.duplicateProductionJob = async function (jobId) {
        if (!window.api || !window.api.productionDuplicateJob) return;
        if (isJobActionBusy(jobId, 'duplicate')) return;
        setJobActionBusy(jobId, 'duplicate', true);

        try {
            const res = await window.api.productionDuplicateJob(jobId);
            if (res && res.success) {
                if (window.showToast) window.showToast(`Duplicated Job #${jobId}`, "success");
                await loadProductionDashboard();
            } else {
                const errMsg = res ? res.error : 'Failed to duplicate job';
                if (window.showToast) window.showToast(errMsg, "error");
            }
        } catch (e) {
            if (window.showToast) window.showToast("Error duplicating job: " + e.message, "error");
        } finally {
            setJobActionBusy(jobId, 'duplicate', false);
        }
    };

    function getSoftStatusPill(status) {
        if (!status) return `<span class="ps-status-pill pill-scheduled">Scheduled</span>`;
        const s = status.toLowerCase();
        let pillClass = 'pill-scheduled';
        if (s === 'printing') pillClass = 'pill-printing';
        else if (s === 'waiting') pillClass = 'pill-waiting';
        else if (s === 'paused') pillClass = 'pill-paused';
        else if (s === 'completed' || s === 'delivered') pillClass = 'pill-completed';
        else if (s === 'failed' || s === 'cancelled') pillClass = 'pill-failed';
        
        return `<span class="ps-status-pill ${pillClass}">${escapeHtml(status)}</span>`;
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

    window.loadProductionDashboard = loadProductionDashboard;
    window.loadProductionJobs = loadProductionJobs;

})();
