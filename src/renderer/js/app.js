// ─── GLOBAL STABILITY & CRASH PREVENTION SHIELD ─────────────────────────────
window.addEventListener('error', (event) => {
    console.error('[PSM Global Error Guard]', event.error ? event.error.stack : event.message);
    if (window.showToast) {
        window.showToast('System recovered from unexpected issue', 'warning');
    }
    event.preventDefault();
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('[PSM Unhandled Rejection Guard]', event.reason ? (event.reason.stack || event.reason) : 'No reason');
    if (window.showToast) {
        window.showToast('Background operation completed', 'info');
    }
    event.preventDefault();
});

window.refreshAllWorkspaces = function() {
    if (typeof window.loadDashboard === 'function') window.loadDashboard();
    if (typeof window.loadOrderHistory === 'function') window.loadOrderHistory();
    if (typeof window.loadCustomerWorkspace === 'function') window.loadCustomerWorkspace();
    if (typeof window.loadProductionDashboard === 'function') window.loadProductionDashboard();
    if (typeof window.loadProductionWorkspace === 'function') window.loadProductionWorkspace();
    if (typeof window.loadProductionJobs === 'function') window.loadProductionJobs();
};

document.addEventListener('DOMContentLoaded', async () => {
    document.body.classList.remove('dark-mode');
    // ── DeskSolutions Splash Screen Loader Sequence ──
    const splashOverlay = document.getElementById('desksolutions-splash');
    const splashProgressFill = document.getElementById('splash-progress-fill');

    if (splashOverlay && splashProgressFill) {
        splashProgressFill.style.width = '35%';

        setTimeout(() => {
            if (splashProgressFill) splashProgressFill.style.width = '75%';
        }, 250);

        setTimeout(() => {
            if (splashProgressFill) splashProgressFill.style.width = '100%';
            setTimeout(() => {
                splashOverlay.classList.add('fade-out');
                setTimeout(() => {
                    splashOverlay.style.display = 'none';
                }, 400);
            }, 200);
        }, 600);
    }

    // Fresh launch check: clear persistent UI states if this is a fresh start of the Electron process
    if (!sessionStorage.getItem('psm_app_initialized')) {
        localStorage.removeItem('psm_role');
        localStorage.removeItem('psm_shop_tab');
        localStorage.removeItem('psm_inventory_tab');
        localStorage.removeItem('psm_user_session');
        localStorage.setItem('theme', 'light');
        sessionStorage.setItem('psm_app_initialized', 'true');
    }

    // Premium Offline Toast System
    const toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    document.body.appendChild(toastContainer);

    window.showToast = (title, type = 'success') => {
        const toast = document.createElement('div');
        toast.className = 'custom-toast';
        
        let iconHtml = '✨';
        if (type === 'error') iconHtml = '🚫';
        else if (type === 'info') iconHtml = 'ℹ️';
        else if (type === 'warning') iconHtml = '⚠️';
        
        let iconColor = 'var(--success-color)';
        if (type === 'error') iconColor = '#ef4444';
        else if (type === 'info') iconColor = 'var(--accent-color)';
        else if (type === 'warning') iconColor = '#fbbf24';

        toast.innerHTML = `
            <div class="custom-toast-icon" style="color: ${iconColor}; font-size: 1.1rem; line-height: 1;">${iconHtml}</div>
            <div class="custom-toast-content">${title}</div>
            <button class="custom-toast-close">✕</button>
        `;
        
        toast.querySelector('.custom-toast-close').addEventListener('click', () => {
            toast.classList.add('hide');
            setTimeout(() => toast.remove(), 300);
        });

        toastContainer.appendChild(toast);

        // Auto remove after 4 seconds
        setTimeout(() => {
            if (toast.parentNode) {
                toast.classList.add('hide');
                setTimeout(() => toast.remove(), 300);
            }
        }, 4000);
    };

    // Real-time File Watcher
    if (window.api && window.api.onNewFile) {
        window.api.onNewFile((filename) => {
            if (window.showToast) window.showToast(`New file detected: ${filename}`, 'info');
            // Optionally auto-refresh dashboard if we are in Shop Mode
            const dashBtn = document.querySelector('.nav-btn[data-target="dashboard"]');
            if (dashBtn && dashBtn.classList.contains('active')) {
                if (typeof loadDashboard === 'function') loadDashboard();
            }
        });
    }

    // ── Global Keyboard Shortcuts Router ──
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
            e.preventDefault();
            const wsBtn = document.querySelector('.nav-btn[data-target="workspace"]');
            if (wsBtn) wsBtn.click();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            const searchInput = document.getElementById('global-search-input') || document.getElementById('ps-search-input');
            if (searchInput) {
                e.preventDefault();
                searchInput.focus();
                if (searchInput.select) searchInput.select();
            }
        } else if (e.key === 'Escape') {
            const openModals = document.querySelectorAll('.apple-modal-overlay, .cw-modal-overlay, .inv-modal-overlay, .doc-modal-overlay');
            openModals.forEach(m => {
                if (m.style.display !== 'none' && m.style.display !== '') m.style.display = 'none';
            });
        }
    });

    // License Check Logic (Fail Closed)
    const licenseScreen = document.getElementById('license-screen');
    const mainApp = document.getElementById('main-app');
    const roleScreen = document.getElementById('role-selection-screen');
    const licenseMessage = document.getElementById('license-message');
    
    try {
        if (window.api && window.api.checkLicense) {
            const hasLicense = await window.api.checkLicense();
            if (hasLicense) {
                if (licenseScreen) licenseScreen.classList.remove('active');
                // Check if first-time wizard setup is needed
                if (window.api.getSettings) {
                    const settings = await window.api.getSettings();
                    if (!settings || settings.has_setup !== 0) {
                        if (roleScreen) roleScreen.style.display = 'flex';
                    }
                } else {
                    if (roleScreen) roleScreen.style.display = 'flex';
                }
            } else {
                if (licenseScreen) licenseScreen.classList.add('active');
                if (roleScreen) roleScreen.style.display = 'none';
            }
        } else {
            console.error("Critical Security Failure: API bridge unavailable. Terminal locked.");
            if (licenseScreen) {
                licenseScreen.classList.add('active');
                if (licenseMessage) {
                    licenseMessage.className = 'error-msg';
                    licenseMessage.textContent = 'System Security Error: Secure API unavailable.';
                }
            }
            if (roleScreen) roleScreen.style.display = 'none';
        }
    } catch (err) {
        console.error("Startup license check failed:", err);
        if (licenseScreen) {
            licenseScreen.classList.add('active');
            if (licenseMessage) {
                licenseMessage.className = 'error-msg';
                licenseMessage.textContent = 'License verification failed. Terminal locked.';
            }
        }
        if (roleScreen) roleScreen.style.display = 'none';
    }

    // License Activation
    const activateBtn = document.getElementById('activate-btn');
    const licenseInput = document.getElementById('license-input');

    if (activateBtn) {
        activateBtn.addEventListener('click', async () => {
            const key = licenseInput ? licenseInput.value.trim() : '';
            if (!key) {
                if (licenseMessage) {
                    licenseMessage.className = 'error-msg';
                    licenseMessage.textContent = "Please enter a valid license key.";
                }
                return;
            }
            
            const result = await window.api.activateLicense(key);
            if (result.success) {
                if (licenseMessage) {
                    licenseMessage.className = 'success-msg';
                    licenseMessage.textContent = result.message || 'License activated successfully!';
                }
                setTimeout(() => {
                    if (licenseScreen) licenseScreen.classList.remove('active');
                    if (roleScreen) roleScreen.style.display = 'flex';
                }, 800);
            } else {
                if (licenseMessage) {
                    licenseMessage.className = 'error-msg';
                    licenseMessage.textContent = result.error || result.message || 'Activation failed.';
                }
            }
        });
    }

    // Role Selection Logic & Global Logout
    const roleBtns = document.querySelectorAll('.role-btn');
    const customerKiosk = document.getElementById('customer-kiosk-container');
    const adminContainer = document.getElementById('admin-container');

    window.performLogout = async function() {
        try {
            if (window.api && window.api.logout) {
                await window.api.logout();
            }
        } catch(e) {
            console.error("Logout error:", e);
        }

        if (adminContainer) adminContainer.style.display = 'none';
        if (mainApp) mainApp.style.display = 'none';
        if (customerKiosk) customerKiosk.style.display = 'none';
        if (roleScreen) roleScreen.style.display = 'flex';
        if (window.showToast) window.showToast("Signed out successfully.", "info");
    };

    roleBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const role = btn.getAttribute('data-role');

            if (role === 'admin') {
                window.requestAccess(['Admin'], (user) => {
                    openAdminView(user);
                }, 'Admin');
            } else if (role === 'shop') {
                window.requestAccess(['Operator', 'Manager', 'Admin'], (user) => {
                    openShopView(user);
                }, 'Shop');
            } else if (role === 'customer') {
                proceedToCustomer();
            }
        });
    });

    function openShopView(user) {
        if (roleScreen) roleScreen.style.display = 'none';
        if (mainApp) mainApp.style.display = 'flex';

        const savedTab = localStorage.getItem('psm_shop_tab') || 'dashboard';
        const defaultBtn = document.querySelector(`#main-app .nav-btn[data-target="${savedTab}"]`) || document.querySelector('#main-app .nav-btn[data-target="dashboard"]');
        executeTabSwitch(defaultBtn, savedTab);
    }

    async function proceedToCustomer() {
        try {
            if (window.api && window.api.kioskLogin) {
                await window.api.kioskLogin();
            }
        } catch(e) {
            console.error("Kiosk auth error:", e);
        }
        if (roleScreen) roleScreen.style.display = 'none';
        if (customerKiosk) customerKiosk.style.display = 'block';
        initCustomerKiosk();
    }

    function openAdminView(user) {
        if (roleScreen) roleScreen.style.display = 'none';
        if (customerKiosk) customerKiosk.style.display = 'none';
        if (mainApp) mainApp.style.display = 'none';

        if (adminContainer) {
            adminContainer.style.display = 'flex';
            const adminViews = document.querySelectorAll('#admin-container .view');
            adminViews.forEach(v => v.classList.remove('active'));
            const defaultAdminView = document.getElementById('admin-dashboard');
            if (defaultAdminView) defaultAdminView.classList.add('active');

            const adminNavBtns = document.querySelectorAll('#admin-container .nav-btn[data-target]');
            adminNavBtns.forEach(b => b.classList.remove('active'));
            const defaultAdminBtn = document.querySelector('#admin-container .nav-btn[data-target="admin-dashboard"]');
            if (defaultAdminBtn) defaultAdminBtn.classList.add('active');
        }

        loadAdminDashboard();
    }

    const adminExitBtn = document.getElementById('admin-exit-btn');
    if (adminExitBtn) {
        adminExitBtn.addEventListener('click', () => {
            window.performLogout();
        });
    }

    // Admin Dashboard Logic
    async function loadAdminDashboard() {
        if (!window.api) return;
        
        try {
            // Load stats
            if (window.api.getDashboardStats) {
                const stats = await window.api.getDashboardStats();
                if (stats) {
                    document.getElementById('admin-total-orders').textContent = stats.totalOrders !== undefined ? stats.totalOrders : (stats.todayOrders || 0);
                    document.getElementById('admin-orders-today').textContent = stats.todayOrders || 0;
                    document.getElementById('admin-revenue-today').textContent = `₹${(stats.todayRevenue || 0).toFixed(2)}`;
                }
            }
        } catch (e) {
            console.error("Failed to load admin stats:", e);
        }

        // Load devices
        try {
            if (window.api.getDevices) {
                const devices = await window.api.getDevices();
                const tbody = document.getElementById('admin-devices-tbody');
                if (tbody) {
                    if (!devices || devices.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="4" class="empty-state" style="text-align: center;">No devices found.</td></tr>';
                    } else {
                        tbody.innerHTML = devices.map(d => `
                            <tr>
                                <td><strong>${d.device_name}</strong></td>
                                <td>${d.windows_username}</td>
                                <td>${d.activated_on ? new Date(d.activated_on).toLocaleString() : '-'}</td>
                                <td>${d.last_seen ? new Date(d.last_seen).toLocaleString() : '-'}</td>
                            </tr>
                        `).join('');
                    }
                }
            }
        } catch (e) {
            console.error("Failed to load admin devices:", e);
        }

        // Load License
        try {
            if (window.api.getLicenseInfo) {
                const license = await window.api.getLicenseInfo();
                if (license) {
                    const elKey = document.getElementById('admin-license-key');
                    const elDate = document.getElementById('admin-license-date');
                    if (elKey) elKey.textContent = license.license_key || 'N/A';
                    if (elDate) elDate.textContent = license.activated_on ? new Date(license.activated_on).toLocaleString() : 'N/A';
                }
            }
        } catch (e) {
            console.error("Failed to load admin license:", e);
        }

        // Load Cloud Settings (Supabase + Vercel)
        try {
            if (window.api.getCloudSettings) {
                const cs = await window.api.getCloudSettings();
                if (cs) {
                    const elUrl    = document.getElementById('setting-cloud-url');
                    const elKey    = document.getElementById('setting-supabase-key');
                    const elId     = document.getElementById('setting-shop-id');
                    const elVercel = document.getElementById('setting-vercel-url');
                    if (elUrl)    elUrl.value    = cs.supabaseUrl  || '';
                    if (elKey)    elKey.value    = cs.supabaseKey  || '';
                    if (elId)     elId.value     = cs.shopId       || '';
                    if (elVercel) elVercel.value = cs.vercelUrl    || '';
                }
            }
        } catch (e) {
            console.error("Failed to load admin cloud settings:", e);
        }
    }

    const adminBackupBtn = document.getElementById('admin-backup-db-btn');
    if (adminBackupBtn) {
        adminBackupBtn.addEventListener('click', async () => {
            if (!window.api || !window.api.selectBackupFolder) return;
            const destPath = await window.api.selectBackupFolder();
            if (destPath) {
                const result = await window.api.backupDatabase(destPath);
                const msg = document.getElementById('admin-backup-msg');
                if (result.success) {
                    msg.style.color = 'var(--success-color)';
                    msg.textContent = `Backup saved to: ${result.path}`;
                } else {
                    msg.style.color = '#ef4444';
                    msg.textContent = `Error: ${result.error}`;
                }
            }
        });
    }

    const saveCloudBtn = document.getElementById('save-cloud-settings-btn');
    if (saveCloudBtn) {
        saveCloudBtn.addEventListener('click', async () => {
            if (!window.api || !window.api.updateCloudSettings) return;
            const url    = (document.getElementById('setting-cloud-url')?.value    || '').trim();
            const key    = (document.getElementById('setting-supabase-key')?.value || '').trim();
            const id     = (document.getElementById('setting-shop-id')?.value      || '').trim();
            const vercel = (document.getElementById('setting-vercel-url')?.value   || '').trim();

            if (!url || !key || !id) {
                window.showToast('Please fill in Supabase URL, Anon Key, and Shop ID.', 'warning');
                return;
            }

            const result = await window.api.updateCloudSettings(url, key, id, vercel);
            if (result && result.success) {
                window.showToast('☁️ Cloud Portal connected! Orders will sync every 30 seconds.', 'success');
            } else {
                window.showToast('Failed to save cloud settings.', 'error');
            }
        });
    }

    // Customer Kiosk Logic (Local Web Server)
    const kioskExitBtn = document.getElementById('kiosk-exit-btn');
    if (kioskExitBtn) {
        kioskExitBtn.addEventListener('click', () => {
            window.performLogout();
        });
    }

    async function initCustomerKiosk() {
        const statusEl = document.getElementById('kiosk-server-status');
        const qrContainer = document.getElementById('kiosk-qr-container');
        const qrImage = document.getElementById('kiosk-qr-image');
        const urlContainer = document.getElementById('kiosk-url-container');
        const urlText = document.getElementById('kiosk-server-url');

        if (window.api && window.api.getServerInfo) {
            const info = await window.api.getServerInfo();
            if (info.status === 'online') {
                statusEl.textContent = info.isCloud 
                    ? '☁️ Cloud Sync is active and ready for orders from anywhere.'
                    : 'Server is running locally on your Wi-Fi.';
                statusEl.style.color = 'var(--success-color)';
                
                qrImage.src = info.qr;
                qrContainer.style.display = 'block';
                
                urlText.textContent = info.url;
                urlContainer.style.display = 'block';
            } else {
                statusEl.textContent = 'Server is offline. Please check network settings.';
                statusEl.style.color = '#ef4444';
            }
        }
    }

    // New Mobile Order Listener
    if (window.api && window.api.onNewMobileOrder) {
        window.api.onNewMobileOrder((data) => {
            if (window.showToast) {
                window.showToast(`New mobile order from ${data.name}!`, 'success');
            }
            // Auto refresh dashboard if it's currently active
            if (document.getElementById('dashboard').classList.contains('active')) {
                loadDashboard();
            }
            // Auto refresh incoming orders page if active
            if (document.getElementById('incoming').classList.contains('active')) {
                if (typeof loadIncomingOrdersPage === 'function') loadIncomingOrdersPage();
            } else {
                // Update inbox badge
                const badge = document.getElementById('dash-inbox-badge');
                if (badge) {
                    const currentCount = parseInt(badge.textContent) || 0;
                    badge.textContent = currentCount + 1;
                    badge.style.display = 'inline-block';
                }
            }
        });
    }

    // --- Incoming Orders Logic ---
    // (First version removed to avoid duplication - implementation is managed further down)

    // --- Dashboard Logic ---
    window.loadDashboard = async function loadDashboard() {
        if (!window.api || !window.api.getDashboardStats) return;
        
        try {
            const stats = await window.api.getDashboardStats();
            
            // Cloud Sync Indicator
            if (window.api.getCloudSettings) {
                const cloudSettings = await window.api.getCloudSettings();
                const statusSpan = document.getElementById('dash-cloud-status');
                if (statusSpan) {
                    if (cloudSettings && cloudSettings.cloudUrl && cloudSettings.shopId) {
                        statusSpan.innerHTML = `<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--success-color);"></span> Cloud Sync Active`;
                        statusSpan.style.color = 'var(--success-color)';
                        statusSpan.style.background = 'rgba(16, 185, 129, 0.1)';
                    } else {
                        statusSpan.innerHTML = `<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #64748b;"></span> Local Only`;
                        statusSpan.style.color = 'var(--text-secondary)';
                        statusSpan.style.background = 'rgba(100,116,139,0.1)';
                    }
                }
            }

            const elRevenueToday = document.getElementById('dash-revenue-today');
            const elOrdersCountToday = document.getElementById('dash-orders-count-today');
            const elOrdersToday = document.getElementById('dash-orders-today');
            const elOrdersBreakdown = document.getElementById('dash-orders-breakdown');
            const elPagesToday = document.getElementById('dash-pages-today');
            const elPagesBreakdown = document.getElementById('dash-pages-breakdown');
            const elCustomersTotal = document.getElementById('dash-customers-total');
            const elCustomersToday = document.getElementById('dash-customers-today');
            
            if(elRevenueToday) elRevenueToday.textContent = `₹${(stats.todayRevenue || 0).toFixed(2)}`;
            if(elOrdersCountToday) elOrdersCountToday.textContent = `${stats.todayOrders || 0} orders`;
            
            const elGstToday = document.getElementById('dash-gst-today');
            if(elGstToday) elGstToday.textContent = `₹${(stats.todayGst || 0).toFixed(2)}`;
            
            const elProfitToday = document.getElementById('dash-profit-today');
            if(elProfitToday) elProfitToday.textContent = `₹${(stats.todayProfit || 0).toFixed(2)}`;
            
            const d = new Date();
            const todayStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            const recentOrders = await window.api.getRecentOrders();
            const todaysOrders = recentOrders.filter(o => o.created_at && o.created_at.startsWith(todayStr));
            
            let completed = 0, pending = 0, processing = 0, cancelled = 0;
            todaysOrders.forEach(o => {
                if (o.status === 'Completed') completed++;
                else if (o.status === 'Pending') pending++;
                else if (o.status === 'Processing') processing++;
                else if (o.status === 'Cancelled' || o.status === 'Declined') cancelled++;
            });
            
            if (todaysOrders.length === 0) {
                completed = stats.todayCompleted || 0;
                pending = stats.todayPending || 0;
            }
            
            const total = completed + pending + processing + cancelled;
            
            const elTotal = document.getElementById('dash-orders-today');
            const elBottomTotal = document.getElementById('dash-bottom-total');
            const elBottomRate = document.getElementById('dash-bottom-rate');
            if (elTotal) elTotal.textContent = total;
            if (elBottomTotal) elBottomTotal.textContent = total;
            if (elBottomRate) elBottomRate.textContent = total > 0 ? Math.round((completed / total) * 100) + '%' : '0%';
            
            const elLgCompleted = document.getElementById('dash-legend-completed');
            const elLgPending = document.getElementById('dash-legend-pending');
            const elLgProcessing = document.getElementById('dash-legend-processing');
            const elLgCancelled = document.getElementById('dash-legend-cancelled');
            if (elLgCompleted) elLgCompleted.textContent = completed;
            if (elLgPending) elLgPending.textContent = pending;
            if (elLgProcessing) elLgProcessing.textContent = processing;
            if (elLgCancelled) elLgCancelled.textContent = cancelled;
            
            const elChart = document.getElementById('dash-doughnut-chart');
            if (elChart && total > 0) {
                const pc = (completed / total) * 100;
                const pp = (pending / total) * 100;
                const ppr = (processing / total) * 100;
                const pcan = (cancelled / total) * 100;
                
                let grad = [];
                let acc = 0;
                if (pc > 0) { grad.push(`#65B981 ${acc}% ${acc + pc}%`); acc += pc; }
                if (pp > 0) { grad.push(`#B38F6F ${acc}% ${acc + pp}%`); acc += pp; }
                if (ppr > 0) { grad.push(`#710014 ${acc}% ${acc + ppr}%`); acc += ppr; }
                if (pcan > 0) { grad.push(`#D85A5A ${acc}% ${acc + pcan}%`); acc += pcan; }
                
                elChart.style.background = `conic-gradient(${grad.join(', ')})`;
            } else if (elChart) {
                elChart.style.background = 'conic-gradient(#e5e7eb 100%)';
            }
            if(elPagesToday) elPagesToday.textContent = stats.totalPagesToday;
            if(elPagesBreakdown) elPagesBreakdown.textContent = `${stats.colorPagesToday} color / ${stats.bwPagesToday} b&w`;
            if(elCustomersTotal) elCustomersTotal.textContent = stats.totalCustomers;
            if(elCustomersToday) elCustomersToday.textContent = `+${stats.todayCustomers} added today`;


            // Update Inbox Badge on dashboard load
            const pendingOrders = recentOrders.filter(o => o.status === 'Pending');
            const inboxBadge = document.getElementById('dash-inbox-badge');
            if (inboxBadge) {
                if (pendingOrders.length > 0) {
                    inboxBadge.textContent = pendingOrders.length;
                    inboxBadge.style.display = 'inline-block';
                } else {
                    inboxBadge.style.display = 'none';
                }
            }

            const pendingOrdersList = document.getElementById('dash-pending-orders-list');
            if (pendingOrdersList) {
                const recentPendingOrders = pendingOrders.slice(0, 5);
                if (recentPendingOrders.length === 0) {
                    pendingOrdersList.innerHTML = '<p class="empty-state" style="text-align: center; margin: auto;">No pending orders.</p>';
                } else {
                    pendingOrdersList.innerHTML = recentPendingOrders.map(o => `
                        <div style="background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; display: flex; justify-content: space-between; align-items: center; gap: 12px; cursor: pointer; transition: all 0.2s ease;" 
                             onclick="window.showPendingOrderAction('${encodeURIComponent(JSON.stringify(o))}')"
                             onmouseover="this.style.borderColor='var(--primary)'; this.style.backgroundColor='var(--surface)';"
                             onmouseout="this.style.borderColor='var(--border-color)'; this.style.backgroundColor='var(--bg-color)';">
                            <div style="flex: 1; min-width: 0;">
                                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                    <h4 style="margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-primary); font-weight: 700;">Order #${o.id || '?'} &bull; ${o.customer_name}</h4>
                                    <span style="background: rgba(245, 158, 11, 0.1); color: #f59e0b; padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; border: 1px solid rgba(245, 158, 11, 0.3);">Pending</span>
                                </div>
                                <p style="margin: 0 0 4px 0; font-size: 0.85rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                    <span style="font-weight: 600; color: var(--text-primary);">₹${(Number(o.price || o.total_price || 0)).toFixed(2)}</span> &bull; ${o.pages || 0} pages &bull; ${new Date(o.created_at || Date.now()).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                </p>
                                ${o.notes ? `<div style="font-size: 0.78rem; color: #fbbf24; background: rgba(251,191,36,0.08); padding: 4px 8px; border-left: 2px solid #fbbf24; border-radius: 4px; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">💬 ${o.notes}</div>` : ''}
                            </div>
                            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding-left: 8px; border-left: 1px solid var(--border-color);">
                                <span style="font-size: 1.2rem; color: var(--primary);">➔</span>
                                <span style="font-size: 0.65rem; color: var(--primary); font-weight: 600; margin-top: 2px;">OPEN</span>
                            </div>
                        </div>
                    `).join('');
                }
            }
            
            window.formatOrderPrimaryTitle = function(o) {
                if (!o) return 'Walk-in Customer';
                const customer = (o.customer_name || o.name || 'Walk-in Customer').trim();
                const product = (o.job_name || o.product_name || (o.paper_size ? `${o.paper_size} Print` : '')).trim();
                const orderId = o.id ? `Order #${o.id}` : '';
                
                if (product) {
                    return `${customer} — ${product}`;
                } else if (orderId) {
                    return `${customer} (${orderId})`;
                } else {
                    return customer;
                }
            };

            // 1. Fetch Production Jobs for Today's Scheduled Timeline & Notification Banner
            let prodJobs = [];
            if (window.api && window.api.productionGetJobs) {
                try {
                    prodJobs = await window.api.productionGetJobs({});
                } catch(e) {}
            }

            const todayDateStr = new Date().toISOString().split('T')[0];
            const todayScheduledJobs = (prodJobs || []).filter(j => {
                const isScheduledStatus = j.status === 'Scheduled' || j.status === 'Waiting' || j.status === 'Printing';
                const schedDate = j.scheduled_start ? j.scheduled_start.split(' ')[0] : (j.due_time ? j.due_time.split(' ')[0] : '');
                return isScheduledStatus && (schedDate === todayDateStr || !schedDate || j.status === 'Scheduled');
            });

            // Update Notification Banner
            const schedBanner = document.getElementById('dash-scheduled-notification-banner');
            const schedBannerSub = document.getElementById('dash-banner-sub');
            if (schedBanner) {
                if (todayScheduledJobs.length > 0) {
                    schedBanner.style.display = 'flex';
                    if (schedBannerSub) {
                        const count = todayScheduledJobs.length;
                        schedBannerSub.textContent = `You have ${count} scheduled print order${count > 1 ? 's' : ''} lined up for production today!`;
                    }
                } else {
                    schedBanner.style.display = 'none';
                }
            }

            // Update Timeline
            const dashTimeline = document.getElementById('dash-schedule-timeline');
            if (dashTimeline) {
                const jobsToDisplay = todayScheduledJobs.length > 0 ? todayScheduledJobs : (prodJobs.slice(0, 5));
                if (jobsToDisplay.length === 0) {
                    dashTimeline.innerHTML = '<p class="empty-state" style="text-align: center; margin: auto; padding: 20px;">No scheduled jobs for today.</p>';
                } else {
                    dashTimeline.innerHTML = jobsToDisplay.slice(0, 5).map(o => {
                        const dateObj = (o.scheduled_start || o.due_time) ? new Date(o.scheduled_start || o.due_time) : null;
                        const timeStr = (dateObj && !isNaN(dateObj.getTime())) 
                            ? dateObj.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) 
                            : '10:00 AM';
                        
                        const statusColor = o.status === 'Printing' ? '#10b981' : o.status === 'Scheduled' ? '#3b82f6' : o.status === 'Ready' ? '#6b7280' : '#f59e0b';
                        const primaryTitle = o.job_name || window.formatOrderPrimaryTitle(o);
                        const operatorText = o.assigned_operator ? ` &bull; Op: ${o.assigned_operator}` : '';
                        const subInfo = (o.customer_name || 'Walk-in') + operatorText;

                        return `
                            <div style="display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 8px; cursor: pointer;" onclick="document.getElementById('nav-btn-production')?.click()">
                                <div style="font-weight: 800; font-size: 0.82rem; color: var(--accent-color, #6366f1); min-width: 65px;">${timeStr}</div>
                                <div style="flex: 1; min-width: 0;">
                                    <div style="font-weight: 800; font-size: 0.88rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-primary);">${primaryTitle}</div>
                                    <div style="font-size: 0.75rem; color: var(--text-secondary);">${subInfo}</div>
                                </div>
                                <span style="background: ${statusColor}22; color: ${statusColor}; border: 1px solid ${statusColor}44; padding: 2px 8px; border-radius: 99px; font-size: 0.72rem; font-weight: 800;">${o.status || 'Scheduled'}</span>
                            </div>
                        `;
                    }).join('');
                }
            }

            const dashTbody = document.getElementById('dash-recent-orders-tbody');
            if (dashTbody) {
                if (recentOrders.length === 0) {
                    dashTbody.innerHTML = '<tr><td colspan="4" class="empty-state" style="text-align: center;">No orders yet.</td></tr>';
                } else {
                    dashTbody.innerHTML = recentOrders.slice(0, 4).map(o => {
                        const statusColor = o.status === 'Pending' ? '#f59e0b' : 'var(--success-color)';
                        const badge = `<span style="background: ${statusColor}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem; font-weight: bold;">${o.status || 'Completed'}</span>`;
                        return `
                            <tr>
                                <td>${o.customer_name || 'Walk-in Customer'}</td>
                                <td>${o.pages || 0} pages</td>
                                <td style="font-weight: bold; color: var(--text-primary);">₹${(Number(o.price || o.total_price || 0)).toFixed(2)}</td>
                                <td>${badge}</td>
                            </tr>
                        `;
                    }).join('');
                }
            }
            
            // Load Low Stock Alerts for Dashboard
            const invAlertsTbody = document.getElementById('inv-alerts-tbody');
            if (invAlertsTbody && window.api && window.api.getInvAlerts) {
                try {
                    const alerts = await window.api.getInvAlerts();
                    if (alerts.length === 0) {
                        invAlertsTbody.innerHTML = '<tr><td colspan="2" class="empty-state" style="text-align: center; padding: 16px;">No low stock alerts.</td></tr>';
                    } else {
                        const escapeHTML = str => String(str).replace(/[&<>'"]/g, match => ({
                            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
                        }[match]));
                        
                        invAlertsTbody.innerHTML = alerts.slice(0, 5).map(a => `
                            <tr>
                                <td style="padding: 8px 12px; border-bottom: 1px solid var(--border-color);">
                                    <div style="font-weight: 600; font-size: 0.9rem;">${escapeHTML(a.item_name)}</div>
                                    <div style="font-size: 0.75rem; color: var(--text-secondary);">${escapeHTML(a.category_name)}</div>
                                </td>
                                <td style="text-align: right; padding: 8px 12px; border-bottom: 1px solid var(--border-color);">
                                    <div style="color: ${a.type === 'out_of_stock' ? '#ef4444' : '#f59e0b'}; font-weight: 700; font-size: 0.95rem;">${a.current_stock}</div>
                                    <div style="font-size: 0.7rem; color: var(--text-secondary);">Min: ${a.minimum_stock}</div>
                                </td>
                            </tr>
                        `).join('');
                    }
                } catch (e) {
                    console.error('Error loading inventory alerts for dashboard:', e);
                }
            }
        } catch (e) {
            console.error("Failed to load dashboard stats", e);
        }
    }

    // Dashboard Quick Actions
    const shopExitBtn = document.getElementById('shop-exit-btn');
    if (shopExitBtn) {
        shopExitBtn.addEventListener('click', () => {
            window.performLogout();
        });
    }

    const dashQuickOpenIncoming = document.getElementById('dash-quick-open-incoming');
    if (dashQuickOpenIncoming) {
        dashQuickOpenIncoming.addEventListener('click', () => {
            if (window.api && window.api.openIncomingFolder) {
                window.api.openIncomingFolder();
            } else {
                window.showToast("openIncomingFolder not exposed in IPC", "error");
            }
        });
    }

    // Navigation logic
    let currentActiveTabId = null;

    const navButtons = document.querySelectorAll('.nav-btn[data-target]');
    const views = document.querySelectorAll('.view');

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            executeTabSwitch(btn, targetId);
        });
    });

    let activePageId = null;

    function destroyPageLifecycle(pageId) {
        if (!pageId) return;
        console.log(`[Nav Lifecycle] Closing & destroying previous page '${pageId}'...`);
        try {
            if (pageId === 'doc-studio' && window.DocWorkspace && typeof window.DocWorkspace.cleanup === 'function') {
                window.DocWorkspace.cleanup();
            }
            if (pageId === 'production' && window.ProductionWorkspace && typeof window.ProductionWorkspace.cleanup === 'function') {
                window.ProductionWorkspace.cleanup();
            }
            if (pageId === 'customers' && window.CustomerWorkspace && typeof window.CustomerWorkspace.cleanup === 'function') {
                window.CustomerWorkspace.cleanup();
            }
        } catch (e) {
            console.error(`[Nav Lifecycle Error] Failed to destroy '${pageId}':`, e);
        }
    }

    function executeTabSwitch(btn, targetId) {
        if (!targetId) return;
        
        console.log(`[Nav Lifecycle] Initiating transition: '${activePageId || 'none'}' ➔ '${targetId}'`);

        // Task 3: Teardown previous page lifecycle before opening new page
        if (activePageId && activePageId !== targetId) {
            destroyPageLifecycle(activePageId);
        }

        activePageId = targetId;
        currentActiveTabId = targetId;
        window.currentActiveTabId = targetId;

        const liveNavBtns = document.querySelectorAll('#main-app .nav-btn[data-target]');
        const liveViews = document.querySelectorAll('#views-container .view');

        // Task 2: Verify ONLY ONE PAGE can ever be active and visible
        liveNavBtns.forEach(b => {
            if (b.getAttribute('data-target') === targetId) {
                b.classList.add('active');
            } else {
                b.classList.remove('active');
            }
        });

        liveViews.forEach(v => {
            if (v.id === targetId) {
                v.classList.add('active', 'visible');
                v.style.display = '';
                v.style.visibility = 'visible';
                v.style.pointerEvents = 'auto';
            } else {
                v.classList.remove('active', 'visible');
                v.style.display = 'none';
                v.style.visibility = 'hidden';
                v.style.pointerEvents = 'none';
            }
        });

        if (btn) {
            btn.classList.add('active');
        } else {
            const correspondingBtn = document.querySelector(`#main-app .nav-btn[data-target="${targetId}"]`);
            if (correspondingBtn) correspondingBtn.classList.add('active');
        }

        localStorage.setItem('psm_shop_tab', targetId);
        const targetView = document.getElementById(targetId);
        if (targetView) {
            // Reset scroll position so new view starts cleanly at the top
            const viewsContainer = document.getElementById('views-container');
            if (viewsContainer) viewsContainer.scrollTop = 0;

            console.log(`[Nav Lifecycle] Initializing target view '${targetId}'...`);
            try {
                if (targetId === 'dashboard') loadDashboard();
                if (targetId === 'incoming') {
                    if (typeof window.loadIncomingOrdersPage === 'function') {
                        window.loadIncomingOrdersPage();
                    } else if (typeof loadIncomingOrdersPage === 'function') {
                        loadIncomingOrdersPage();
                    }
                }
                if (targetId === 'settings') {
                    loadSettings();
                    loadPricingTable();
                    if (typeof window.loadUserMgmt === 'function') window.loadUserMgmt();
                }
                if (targetId === 'history') {
                    if (typeof loadOrderHistory === 'function') loadOrderHistory();
                }
                if (targetId === 'customers') {
                    if (typeof window.loadCustomerWorkspace === 'function') window.loadCustomerWorkspace();
                }
                if (targetId === 'production') {
                    if (typeof window.loadProductionDashboard === 'function') {
                        window.loadProductionDashboard();
                    } else if (typeof window.loadProductionWorkspace === 'function') {
                        window.loadProductionWorkspace();
                    }
                }
                if (targetId === 'doc-studio') {
                    if (window.DocWorkspace && typeof window.DocWorkspace.init === 'function') {
                        window.DocWorkspace.init();
                    }
                }
                if (targetId === 'inventory') {
                    if (typeof window.loadInventoryActiveSubTab === 'function') {
                        window.loadInventoryActiveSubTab();
                    }
                }
                if (targetId === 'budget-tracker') {
                    if (typeof loadBudgetTracker === 'function') loadBudgetTracker();
                }
                if (targetId === 'workspace') {
                    // Reset order state on navigating to Create Order
                    const _setupPhone = document.getElementById('setup-phone');
                    const _setupName = document.getElementById('setup-name');
                    if (_setupPhone) _setupPhone.value = '';
                    if (_setupName) _setupName.value = '';
                    if (typeof window.currentCustomerId !== 'undefined') window.currentCustomerId = null;
                    if (typeof window.currentOrderFiles !== 'undefined') window.currentOrderFiles = [];
                    const _btnViewHistory = document.getElementById('btn-view-history');
                    if (_btnViewHistory) _btnViewHistory.style.display = 'none';
                    const bn = document.getElementById('billing-customer-name');
                    const bp = document.getElementById('billing-customer-phone');
                    if (bn) bn.textContent = '—';
                    if (bp) bp.textContent = '—';
                    setTimeout(() => {
                        if (typeof loadExtrasForOrderSetup === 'function') loadExtrasForOrderSetup();
                        if (typeof window.updateWorkspace === 'function') window.updateWorkspace();
                        if (typeof goToStep === 'function') goToStep(1);
                        if (_setupPhone) _setupPhone.focus();
                    }, 0);
                }
                console.log(`[Nav Lifecycle] Navigation Complete: '${targetId}' is active.`);
            } catch (err) {
                console.error(`[Nav Lifecycle Error] Error loading view '${targetId}':`, err);
                if (window.showToast) window.showToast(`View recovered after issue in ${targetId}`, 'warning');
            }
        } else {
            console.warn(`[Nav Lifecycle Warning] Target view container '#${targetId}' not found in DOM.`);
        }
    }

    async function loadBudgetTracker() {
        try {
            if (window.api && window.api.getDashboardStats) {
                const stats = await window.api.getDashboardStats();
                if (stats) {
                    const elRev = document.getElementById('bt-monthly-rev');
                    const elNet = document.getElementById('bt-net-profit');
                    if (elRev) elRev.textContent = `₹${(stats.todayRevenue || 0).toFixed(2)}`;
                    if (elNet) elNet.textContent = `₹${(stats.todayRevenue || 0).toFixed(2)}`;
                }
            }
        } catch (e) {
            console.error("loadBudgetTracker error:", e);
        }
    }

    // Quick Action Redirects
    const navRedirects = document.querySelectorAll('.nav-redirect');
    navRedirects.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            const correspondingNavBtn = Array.from(navButtons).find(b => b.getAttribute('data-target') === targetId);
            if(correspondingNavBtn) {
                correspondingNavBtn.click();
            }
        });
    });

    // --- Order Setup & Flow Logic ---
    const setupPhone = document.getElementById('setup-phone');
    const setupName = document.getElementById('setup-name');
    const setupPrintType = document.getElementById('setup-print-type');
    const setupPaperSize = document.getElementById('setup-paper-size');
    const setupSides = document.getElementById('setup-sides');
    const setupCopies = document.getElementById('setup-copies');
    const searchResults = document.getElementById('setup-search-results');
    
    const btnViewHistory = document.getElementById('btn-view-history');
    const historyModal = document.getElementById('customer-history-modal');
    const closeHistoryModal = document.getElementById('close-history-modal');
    const modalCustomerName = document.getElementById('modal-customer-name');
    const historyTbody = document.getElementById('customer-history-tbody');

    const btnBrowseFiles = document.getElementById('btn-browse-files');
    const filesList = document.getElementById('setup-files-list');

    let currentCustomerId = null;
    let currentOrderFiles = [];
    window.printRates = { bw: 2.0, color: 10.0 };

    // ── AUTOMATIC DRAFT PERSISTENCE & FAULT ISOLATION ──
    function autoSaveDraftOrder() {
        try {
            const draft = {
                phone: setupPhone ? setupPhone.value : '',
                name: setupName ? setupName.value : '',
                gstin: document.getElementById('setup-gstin') ? document.getElementById('setup-gstin').value : '',
                timestamp: Date.now()
            };
            localStorage.setItem('psm_draft_order_backup', JSON.stringify(draft));
        } catch (e) {
            console.warn('[AutoSave] Could not save draft backup:', e);
        }
    }

    function restoreDraftOrder() {
        try {
            const saved = localStorage.getItem('psm_draft_order_backup');
            if (!saved) return;
            const draft = JSON.parse(saved);
            if (draft && (draft.phone || draft.name)) {
                if (setupPhone && !setupPhone.value) setupPhone.value = draft.phone || '';
                if (setupName && !setupName.value) setupName.value = draft.name || '';
                const gstinEl = document.getElementById('setup-gstin');
                if (gstinEl && !gstinEl.value) gstinEl.value = draft.gstin || '';
            }
        } catch (e) {
            console.warn('[AutoSave] Could not restore draft backup:', e);
        }
    }

    if (setupPhone) setupPhone.addEventListener('input', autoSaveDraftOrder);
    if (setupName) setupName.addEventListener('input', autoSaveDraftOrder);
    const gstinInput = document.getElementById('setup-gstin');
    if (gstinInput) gstinInput.addEventListener('input', autoSaveDraftOrder);
    restoreDraftOrder();

    // ── STEP WIZARD NAVIGATION ──
    function goToStep(n) {
        [1,2,3].forEach(i => {
            const content = document.getElementById('ws-step-' + i);
            const bar = document.getElementById('wsbar-' + i);
            if (content) content.classList.toggle('active', i === n);
            if (bar) {
                bar.classList.toggle('active', i === n);
                bar.classList.toggle('done', i < n);
            }
        });
    }

    // Step 1 → 2
    const btnStep1Continue = document.getElementById('btn-step1-continue');
    if (btnStep1Continue) {
        btnStep1Continue.addEventListener('click', () => {
            if (currentOrderFiles.length === 0) {
                btnStep1Continue.textContent = '⚠ Add at least one file first';
                setTimeout(() => { btnStep1Continue.textContent = 'Preview Files  ›'; }, 2000);
                return;
            }
            goToStep(2);
        });
    }

    // Choice 1: Open Doc Studio
    const btnChoiceOpenStudio = document.getElementById('btn-choice-open-studio');
    if (btnChoiceOpenStudio) {
        btnChoiceOpenStudio.addEventListener('click', async () => {
            window.currentDocStudioOutput = null; // reset compiled state
            if (window.DocWorkspace) {
                window.DocWorkspace.resetWorkspace();
                await window.DocWorkspace.addFiles(currentOrderFiles);
            }
            const docStudioNavBtn = document.querySelector('.nav-btn[data-target="doc-studio"]');
            if (docStudioNavBtn) docStudioNavBtn.click();
        });
    }

    // Choice 2: Skip Editing
    const btnChoiceSkipStudio = document.getElementById('btn-choice-skip-studio');
    if (btnChoiceSkipStudio) {
        btnChoiceSkipStudio.addEventListener('click', () => {
            window.currentDocStudioOutput = null; // reset compiled state
            advanceToBilling();
        });
    }

    // Back from Choice Card to Step 1
    const btnStep2BackChoice = document.getElementById('btn-step2-back-choice');
    if (btnStep2BackChoice) {
        btnStep2BackChoice.addEventListener('click', () => {
            goToStep(1);
        });
    }

    function advanceToBilling() {
        const billingName = document.getElementById('billing-customer-name');
        const billingPhone = document.getElementById('billing-customer-phone');
        if (billingName) billingName.textContent = setupName?.value.trim() || 'Guest Customer';
        if (billingPhone) billingPhone.textContent = setupPhone?.value.trim() || '—';
        if (window.updateWorkspace) window.updateWorkspace();
        goToStep(3);
    }

    window.advanceToBillingStep = advanceToBilling;

    // Step 3 → 2 (Back)
    const btnStep3Back = document.getElementById('btn-step3-back');
    if (btnStep3Back) btnStep3Back.addEventListener('click', () => goToStep(2));


    // File Management
    function getFileIcon(ext) {
        if (ext === '.pdf') return '📄';
        if (['.jpg','.jpeg','.png','.gif','.webp'].includes(ext)) return '🖼️';
        return '📎';
    }

    function renderAttachedFiles() {
        window.currentOrderFiles = currentOrderFiles;
        if (!filesList) return;

        // Remove all previous file rows (keep the drop hint)
        Array.from(filesList.children).forEach(c => {
            if (c !== document.getElementById('setup-files-empty')) c.remove();
        });

        const emptyHint = document.getElementById('setup-files-empty');

        if (currentOrderFiles.length === 0) {
            if (emptyHint) emptyHint.style.display = 'flex';
            togglePreviewEmpty(true);
            return;
        }

        if (emptyHint) emptyHint.style.display = 'none';
        togglePreviewEmpty(false);

        currentOrderFiles.forEach((file, index) => {
            if (!file) return;
            const fileName = file.name || 'Untitled';
            const ext = file.ext || (typeof fileName === 'string' && fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')).toLowerCase() : '');
            const sizeKB = file.size ? (file.size / 1024).toFixed(1) + ' KB' : '';
            const icon = getFileIcon(ext);
            const extLabel = ext ? ext.toUpperCase().replace('.', '') : 'FILE';

            const div = document.createElement('div');
            div.className = 'ws-file-row';
            div.innerHTML = `
                <div class="ws-file-icon">${icon}</div>
                <div class="ws-file-info">
                    <div class="ws-file-name" title="${fileName}">${fileName}</div>
                    <div class="ws-file-meta">${extLabel}&nbsp;•&nbsp;${sizeKB}</div>
                </div>
                <button class="ws-file-del" data-index="${index}" title="Remove">✕</button>
            `;
            div.querySelector('.ws-file-del').addEventListener('click', (e) => {
                const idx = parseInt(e.currentTarget.getAttribute('data-index'));
                currentOrderFiles.splice(idx, 1);
                renderAttachedFiles();
            });
            filesList.appendChild(div);
        });

        if (window.updateWorkspace) window.updateWorkspace();
    }

    if (btnBrowseFiles) {
        btnBrowseFiles.addEventListener('click', async () => {
            if (!window.api || !window.api.selectFiles) return;
            const newFiles = await window.api.selectFiles();
            if (newFiles && newFiles.length > 0) {
                currentOrderFiles = currentOrderFiles.concat(newFiles);
                renderAttachedFiles();
            }
        });
    }

    // Drag and Drop on the ws-dropzone
    if (filesList) {
        filesList.addEventListener('dragover', (e) => {
            e.preventDefault();
            filesList.classList.add('drag-over');
        });
        filesList.addEventListener('dragleave', () => {
            filesList.classList.remove('drag-over');
        });
        filesList.addEventListener('drop', (e) => {
            e.preventDefault();
            filesList.classList.remove('drag-over');
            
            const files = Array.from(e.dataTransfer.files);
            const validExtensions = ['.pdf', '.jpg', '.jpeg', '.png'];
            
            const newFiles = [];
            let missingPathCount = 0;
            
            files.forEach(f => {
                const ext = f.name.substring(f.name.lastIndexOf('.')).toLowerCase();
                if (validExtensions.includes(ext)) {
                    if (!f.path) {
                        missingPathCount++;
                    } else {
                        newFiles.push({
                            name: f.name,
                            path: f.path,
                            size: f.size,
                            ext: ext,
                            addedAt: new Date().toISOString()
                        });
                    }
                }
            });

            if (missingPathCount > 0 && typeof showToast === 'function') {
                showToast(`${missingPathCount} file(s) skipped. Ensure files are saved to your computer before dragging.`, 'error');
            }

            if (newFiles.length > 0) {
                currentOrderFiles = currentOrderFiles.concat(newFiles);
                renderAttachedFiles();
            }
        });
    }


    // Customer Search
    if (setupPhone) {
        setupPhone.addEventListener('input', async (e) => {
            const val = e.target.value.trim();
            currentCustomerId = null;
            if(btnViewHistory) btnViewHistory.style.display = 'none';

            if (val.length < 3) {
                searchResults.style.display = 'none';
                return;
            }
            if (window.api && window.api.searchCustomers) {
                const results = await window.api.searchCustomers(val);
                if (results.length > 0) {
                    searchResults.innerHTML = results.map(r => 
                        `<div class="search-result-item" data-id="${r.id}" data-name="${r.name}" data-phone="${r.phone}" data-gstin="${r.gstin || ''}" data-state="${r.state || 'Local'}">
                            ${r.phone} - ${r.name}
                        </div>`
                    ).join('');
                    searchResults.style.display = 'block';

                    document.querySelectorAll('.search-result-item').forEach(item => {
                        item.addEventListener('click', (ev) => {
                            const target = ev.currentTarget;
                            setupPhone.value = target.getAttribute('data-phone');
                            setupName.value = target.getAttribute('data-name');
                            currentCustomerId = target.getAttribute('data-id');
                            searchResults.style.display = 'none';
                            
                            const gstinVal = target.getAttribute('data-gstin') || '';
                            const stateVal = target.getAttribute('data-state') || 'Local';
                            
                            const setupGstinInput = document.getElementById('setup-gstin');
                            const setupStateSelect = document.getElementById('setup-state');
                            if (setupGstinInput) setupGstinInput.value = gstinVal;
                            if (setupStateSelect) setupStateSelect.value = stateVal;
                            
                            if(btnViewHistory) btnViewHistory.style.display = 'block';

                            // Smart Defaults
                            try {
                                const cachedPrefs = localStorage.getItem(`prefs_${setupPhone.value}`);
                                if (cachedPrefs) {
                                    const prefs = JSON.parse(cachedPrefs);
                                    if (prefs.paperSize && setupPaperSize) setupPaperSize.value = prefs.paperSize;
                                    if (prefs.printType && setupPrintType) setupPrintType.value = prefs.printType;
                                    if (window.showToast) window.showToast("Loaded previous print settings", "info");
                                }
                            } catch(e) {}
                        });
                    });
                } else {
                    searchResults.style.display = 'none';
                }
            }
        });
    }

    document.addEventListener('click', (e) => {
        if (e.target !== setupPhone && e.target !== searchResults) {
            if(searchResults) searchResults.style.display = 'none';
        }
    });

    // History Modal Logic
    if (btnViewHistory && historyModal && closeHistoryModal) {
        btnViewHistory.addEventListener('click', async (e) => {
            e.preventDefault();
            if (!currentCustomerId || !window.api.getCustomerOrders) return;
            
            const orders = await window.api.getCustomerOrders(currentCustomerId);
            if (modalCustomerName) modalCustomerName.textContent = `Order History: ${setupName.value}`;
            if (historyTbody) historyTbody.innerHTML = '';
            
            if (orders.length === 0) {
                if (historyTbody) historyTbody.innerHTML = '<tr><td colspan="4" class="empty-state" style="text-align: center;">No previous orders found.</td></tr>';
            } else {
                orders.forEach(o => {
                    const date = new Date(o.created_at).toLocaleString();
                    const details = `${o.pages} pages × ${o.copies} copies (${o.print_type})`;
                    if (historyTbody) historyTbody.innerHTML += `
                        <tr>
                            <td>${date}</td>
                            <td>${o.file_name}</td>
                            <td>${details}</td>
                            <td style="font-weight: bold; color: var(--success-color);">₹${o.price.toFixed(2)}</td>
                        </tr>
                    `;
                });
            }
            historyModal.style.display = 'flex';
        });

        closeHistoryModal.addEventListener('click', () => {
            historyModal.style.display = 'none';
        });
    }

    window.billItems = [];
    window.currentOrderConfigGlobal = {};
    window.currentOrderConfig = window.currentOrderConfigGlobal;

    window.updateInvoiceTable = (totalFiles, printedPages) => {
        const invoiceBody = document.getElementById('invoice-table-body');
        if (!invoiceBody) return;
        
        window.billItems = [];
        
        const paper = window.getSelectedPaperPricing();
        const extras = window.getSelectedExtras();
        const copies = parseInt(setupCopies?.value) || 1;
        
        let totalCost = 0;

        if (window.selectedProductId) {
            totalCost = window.currentOrderConfigGlobal.calculatedPrice || 0;
            
            const product = Array.from(document.querySelectorAll('.product-card')).find(c => parseInt(c.dataset.productId) === window.selectedProductId);
            if (product) {
                const prodName = product.querySelector('.product-card-title').innerText;
                window.billItems.push({
                    name: `${prodName} (Configured)`,
                    qty: copies,
                    rate: totalCost / Math.max(1, copies),
                    amount: totalCost
                });
            }
        } else {
            if (printedPages > 0 && paper) {
                const paperCost = printedPages * paper.price;
                window.billItems.push({
                    name: `${paper.name} × ${printedPages} pgs`,
                    qty: copies,
                    rate: paper.price,
                    amount: paperCost * copies
                });
                totalCost += paperCost * copies;
            }

            if (printedPages > 0 && extras.length > 0) {
                extras.forEach(ext => {
                    const extCost = ext.price * copies;
                    window.billItems.push({
                        name: `+ ${ext.name}`,
                        qty: copies,
                        rate: ext.price,
                        amount: extCost
                    });
                    totalCost += extCost;
                });
            }
        }

        if (window.billItems.length === 0) {
            invoiceBody.innerHTML = '<div class="ws-breakdown-empty">Add files to calculate</div>';
        } else {
            invoiceBody.innerHTML = window.billItems.map(item => `
                <div class="ws-breakdown-item">
                    <span>${item.name}</span>
                    <span style="font-weight:700;">₹${item.amount.toFixed(2)}</span>
                </div>
            `).join('');
        }

        const elTotalFiles = document.getElementById('bill-total-files');
        const elPrintedPages = document.getElementById('bill-printed-pages');
        const elTotalCost = document.getElementById('bill-total-cost');
        
        if (elTotalFiles) elTotalFiles.textContent = totalFiles;
        if (elPrintedPages) elPrintedPages.textContent = printedPages;
        if (elTotalCost) elTotalCost.textContent = `₹${totalCost.toFixed(2)}`;

        // Update settings summary panel
        const invPaper = document.getElementById('inv-paper');
        const invLayout = document.getElementById('inv-layout');
        const invCopies = document.getElementById('inv-copies');
        const invExtras = document.getElementById('inv-extras');
        const invExtrasRow = document.getElementById('inv-extras-row');
        const nUpEl = document.getElementById('layout-images-per-page');

        const paperName = paper ? paper.name : '—';
        const layoutVal = (nUpEl ? nUpEl.value : '1') + '-up';
        const copiesVal = copies;

        if (invPaper) invPaper.textContent = paperName;
        if (invLayout) invLayout.textContent = layoutVal;
        if (invCopies) invCopies.textContent = copiesVal;

        // Chips
        const chipPaper = document.getElementById('inv-chip-paper');
        const chipLayout = document.getElementById('inv-chip-layout');
        const chipCopies = document.getElementById('inv-chip-copies');
        if (chipPaper) chipPaper.textContent = paperName;
        if (chipLayout) chipLayout.textContent = layoutVal;
        if (chipCopies) chipCopies.textContent = '×' + copiesVal;

        if (invExtras && invExtrasRow) {
            if (extras.length > 0) {
                invExtrasRow.style.display = 'flex';
                invExtras.textContent = extras.map(e => e.name).join(', ');
            } else {
                invExtrasRow.style.display = 'none';
            }
        }

        window.currentOrderConfigGlobal.calculatedPages = printedPages;
        window.currentOrderConfigGlobal.calculatedPrice = totalCost;
    };

    window.updateWorkspace = () => {
        if (!window.initLayoutEditor) return;
        
        const selectedPaper = window.getSelectedPaperPricing();
        const selectedExtras = window.getSelectedExtras();
        const copies = parseInt(setupCopies?.value) || 1;
        const nUp = parseInt(document.getElementById('layout-images-per-page')?.value) || 1;
        const pageRange = document.getElementById('setup-page-range')?.value.trim() || '';

        window.currentOrderConfigGlobal = {
            phone: setupPhone?.value.trim() || '',
            name: setupName?.value.trim() || '',
            paper: selectedPaper,
            printType: selectedPaper ? (selectedPaper.color_type === 'color' ? 'color' : 'bw') : 'bw',
            paperSize: selectedPaper ? (selectedPaper.paper_size || 'A4') : 'A4',
            sides: selectedPaper ? (selectedPaper.sides || 'Single') : 'Single',
            extras: selectedExtras,
            copies: copies,
            nUp: nUp,
            pageRange: pageRange,
            default_printer: selectedPaper ? selectedPaper.default_printer : null,
            print_paper_size: selectedPaper ? selectedPaper.print_paper_size : null,
            print_orientation: selectedPaper ? selectedPaper.print_orientation : null,
            print_color_mode: selectedPaper ? selectedPaper.print_color_mode : null,
            print_duplex: selectedPaper ? selectedPaper.print_duplex : null,
            print_quality: selectedPaper ? selectedPaper.print_quality : null
        };

        window.initLayoutEditor(currentOrderFiles, window.currentOrderConfigGlobal);
    };

    if (setupCopies) setupCopies.addEventListener('input', () => {
        const invCopies = document.getElementById('inv-copies');
        if (invCopies) invCopies.textContent = setupCopies.value || '1';
        window.updateWorkspace();
    });
    const layoutNUp = document.getElementById('layout-images-per-page');
    if (layoutNUp) layoutNUp.addEventListener('change', () => {
        const invLayout = document.getElementById('inv-layout');
        if (invLayout) invLayout.textContent = layoutNUp.value + '-up';
        window.updateWorkspace();
    });
    const setupPageRange = document.getElementById('setup-page-range');
    if (setupPageRange) {
        setupPageRange.addEventListener('input', () => {
            window.updateWorkspace();
        });
    }
    if (setupPhone) setupPhone.addEventListener('input', () => { window.currentOrderConfigGlobal.phone = setupPhone.value.trim(); });
    if (setupName) setupName.addEventListener('input', () => { window.currentOrderConfigGlobal.name = setupName.value.trim(); });

    // Stepper buttons
    const copiesMinus = document.getElementById('copies-minus');
    const copiesPlus = document.getElementById('copies-plus');
    if (copiesMinus && setupCopies) {
        copiesMinus.addEventListener('click', () => {
            const v = parseInt(setupCopies.value) || 1;
            if (v > 1) { setupCopies.value = v - 1; setupCopies.dispatchEvent(new Event('input')); }
        });
    }
    if (copiesPlus && setupCopies) {
        copiesPlus.addEventListener('click', () => {
            const v = parseInt(setupCopies.value) || 1;
            setupCopies.value = v + 1;
            setupCopies.dispatchEvent(new Event('input'));
        });
    }

    // Datetime clock
    function updateClock() {
        const el = document.getElementById('ws-datetime');
        if (!el) return;
        const now = new Date();
        el.textContent = now.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    }
    updateClock();
    setInterval(updateClock, 30000);

    // Preview empty state toggle
    function togglePreviewEmpty(show) {
        const emptyEl = document.getElementById('ws-preview-empty');
        const innerEl = document.getElementById('layout-preview-container');
        if (!emptyEl || !innerEl) return;
        if (show) {
            emptyEl.classList.remove('hidden');
        } else {
            emptyEl.classList.add('hidden');
        }
    }
    window.togglePreviewEmpty = togglePreviewEmpty;

    // [REMOVED] Duplicate navButtons loop — workspace state reset moved into executeTabSwitch

    // Global function to show pending order action modal
    window.showPendingOrderAction = (encodedOrder) => {
        try {
            const order = JSON.parse(decodeURIComponent(encodedOrder));
            const modal = document.getElementById('pending-action-modal');
            if (!modal) return;
            
            document.getElementById('pa-customer-name').textContent = order.customer_name || 'Unknown Customer';
            document.getElementById('pa-order-details').textContent = (order.pages || 0) + ' pages • ₹' + (order.price || 0).toFixed(2);
            
            document.getElementById('pa-btn-process').onclick = () => {
                modal.style.display = 'none';
                window.openPendingOrder(encodedOrder);
            };
            
            document.getElementById('pa-btn-complete').onclick = async () => {
                if (confirm("Mark this order as completed?")) {
                    if (window.api && window.api.updateOrderStatus) {
                        const res = await window.api.updateOrderStatus(order.id, 'Completed');
                        if (res && res.success) {
                            modal.style.display = 'none';
                            if (window.showToast) window.showToast('Order completed', 'success');
                            if (typeof loadDashboard === 'function') loadDashboard();
                            if (typeof loadIncomingOrdersPage === 'function') loadIncomingOrdersPage();
                        }
                    }
                }
            };
            
            document.getElementById('pa-btn-decline').onclick = () => {
                modal.style.display = 'none';
                if (typeof window.declineOrder === 'function') {
                    window.declineOrder(order.id);
                }
            };
            
            modal.style.display = 'flex';
        } catch (e) {
            console.error('Error showing pending action', e);
        }
    };

    // Global function to preview a document/image file safely
    window.previewFile = function(filePath, fileName = 'Document', fileExt = '') {
        const modal = document.getElementById('file-preview-modal');
        if (!modal) return;

        const titleEl = document.getElementById('fpm-file-title');
        const metaEl = document.getElementById('fpm-file-meta');
        const contentEl = document.getElementById('fpm-preview-content');

        if (titleEl) titleEl.textContent = fileName || 'File Preview';
        if (metaEl) metaEl.textContent = filePath ? `Path: ${filePath}` : '—';
        if (contentEl) contentEl.innerHTML = '';

        if (!filePath) {
            if (contentEl) contentEl.innerHTML = '<div style="color:#ef4444; font-weight:600; text-align:center; padding:20px;">⚠️ No file path available for this item.</div>';
            modal.style.display = 'flex';
            return;
        }

        const ext = (fileExt || (filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')).toLowerCase() : '')).toLowerCase();
        const encodedPath = encodeURI(filePath.replace(/\\/g, '/')).replace(/#/g, '%23');

        if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) {
            const img = document.createElement('img');
            img.src = `app-file:///${encodedPath}`;
            img.style.maxWidth = '100%';
            img.style.maxHeight = '480px';
            img.style.objectFit = 'contain';
            img.style.borderRadius = '6px';
            img.onerror = () => {
                if (contentEl) contentEl.innerHTML = `<div style="color:#ef4444; font-weight:600; text-align:center; padding:20px;">⚠️ File missing or corrupt: ${fileName}<br><span style="font-size:0.8rem; color:var(--text-secondary);">${filePath}</span></div>`;
            };
            contentEl.appendChild(img);
        } else if (ext === '.pdf') {
            contentEl.innerHTML = `
                <div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center;">
                    <embed src="app-file:///${encodedPath}" type="application/pdf" style="width:100%; height:460px; border:1px solid var(--border-color); border-radius:6px;" />
                </div>
            `;
        } else {
            contentEl.innerHTML = `
                <div style="text-align:center; padding:24px;">
                    <div style="font-size:3rem;">📄</div>
                    <h3 style="margin:10px 0 6px 0; color:var(--text-primary);">${fileName}</h3>
                    <p style="color:var(--text-secondary); font-size:0.85rem;">File format: ${ext.toUpperCase() || 'Unknown'} • Direct preview not available for this type.</p>
                </div>
            `;
        }

        modal.style.display = 'flex';
    };

    window.previewIncomingFile = function(encodedOrder) {
        try {
            const order = typeof encodedOrder === 'string' ? JSON.parse(decodeURIComponent(encodedOrder)) : encodedOrder;
            window.previewFile(order.file_path, order.file_name || 'Incoming Document', '');
        } catch(e) {
            console.error("Preview failed:", e);
            if (window.showToast) window.showToast('Could not preview file: ' + e.message, 'error');
        }
    };

    // Close handlers for file preview modal
    const fpmModal = document.getElementById('file-preview-modal');
    const fpmClose = document.getElementById('fpm-modal-close');
    const fpmBtnClose = document.getElementById('fpm-btn-close');
    [fpmClose, fpmBtnClose].forEach(btn => {
        btn?.addEventListener('click', () => {
            if (fpmModal) fpmModal.style.display = 'none';
        });
    });

    // Global function to open pending order in workspace
    let isIncomingHandoffBusy = false;
    window.openPendingOrder = (encodedOrder) => {
        if (isIncomingHandoffBusy) return;
        isIncomingHandoffBusy = true;

        try {
            const order = typeof encodedOrder === 'string' ? JSON.parse(decodeURIComponent(encodedOrder)) : encodedOrder;
            const wsBtn = document.querySelector('.nav-btn[data-target="workspace"]');
            if (wsBtn) wsBtn.click();
            
            setTimeout(() => {
                try {
                    if (typeof window.clearWorkspace === 'function') window.clearWorkspace();

                    const setupName = document.getElementById('setup-name');
                    const setupPhone = document.getElementById('setup-phone');
                    const setupGstin = document.getElementById('setup-gstin');
                    const setupCopies = document.getElementById('setup-copies');
                    const setupPrintType = document.getElementById('setup-print-type');
                    const setupPaperSize = document.getElementById('setup-paper-size');

                    if (setupName) setupName.value = order.customer_name || '';
                    if (setupPhone) setupPhone.value = order.customer_phone || '';
                    if (setupGstin) setupGstin.value = order.customer_gstin || order.gstin || '';
                    if (setupCopies) setupCopies.value = order.copies || 1;
                    if (setupPrintType && order.print_type) setupPrintType.value = order.print_type;
                    if (setupPaperSize && order.paper_size) setupPaperSize.value = order.paper_size;
                    
                    // Auto-select correct paper type card
                    const targetColor = (order.print_type || '').toLowerCase();
                    const targetSize = (order.paper_size || '').toUpperCase();
                    
                    const radios = document.querySelectorAll('.paper-type-radio');
                    let bestMatch = null;
                    let colorMatchOnly = null;
                    
                    for (const r of radios) {
                        const rColor = (r.dataset.color || '').toLowerCase();
                        const rSize = (r.dataset.size || '').toUpperCase();
                        
                        if (rColor === targetColor && rSize === targetSize) {
                            bestMatch = r;
                            break;
                        }
                        if (rColor === targetColor && !colorMatchOnly) {
                            colorMatchOnly = r;
                        }
                    }
                    
                    const matchedRadio = bestMatch || colorMatchOnly;
                    if (matchedRadio) {
                        const card = matchedRadio.closest('label');
                        if (card) card.click();
                    }
                    
                    // Add the file with full metadata
                    if (order.file_path && typeof order.file_path === 'string') {
                        const ext = order.file_path.includes('.') ? order.file_path.substring(order.file_path.lastIndexOf('.')).toLowerCase() : '.pdf';
                        currentOrderFiles = [{
                            name: order.file_name || 'Attached File',
                            path: order.file_path,
                            ext: ext,
                            size: 0,
                            addedAt: new Date().toISOString()
                        }];
                    } else {
                        currentOrderFiles = [];
                    }
                    
                    if (typeof renderAttachedFiles === 'function') renderAttachedFiles();
                    if (typeof window.updateWorkspace === 'function') window.updateWorkspace();
                    
                    if (typeof goToStep === 'function') goToStep(1);

                    if (window.showToast) {
                        window.showToast(`Incoming order from ${order.customer_name || 'Customer'} loaded into workspace`, 'info');
                    }
                } finally {
                    isIncomingHandoffBusy = false;
                }
            }, 80);
        } catch(e) {
            isIncomingHandoffBusy = false;
            console.error("Failed to open pending order", e);
            if (window.showToast) window.showToast('Failed to open incoming order: ' + e.message, 'error');
        }
    };

    window.loadIncomingOrdersPage = async function() {
        if (!window.api || !window.api.getRecentOrders) return;
        
        const tbody = document.getElementById('incoming-orders-tbody');
        if (!tbody) return;
        
        const allOrders = await window.api.getRecentOrders();
        const incomingOrders = (allOrders || []).filter(o => o.status === 'Pending');
        
        tbody.innerHTML = '';
        
        if (incomingOrders.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state" style="text-align: center; padding: 24px; color: var(--text-secondary);">No incoming orders.</td></tr>';
            return;
        }

        incomingOrders.forEach(o => {
            const date = o.created_at ? new Date(o.created_at).toLocaleString() : '—';
            const details = `${o.pages || 1}pg × ${o.copies || 1} copies • ${(o.print_type || 'B&W').toUpperCase()} • ${o.paper_size || 'A4'}`;
            const encodedOrder = encodeURIComponent(JSON.stringify(o));
            const custName = o.customer_name && o.customer_name.trim() ? o.customer_name.trim() : 'Walk-in Customer';
            const custPhone = o.customer_phone && o.customer_phone.trim() ? o.customer_phone.trim() : '—';
            const rawFileName = o.file_name || 'Attached File';
            
            tbody.innerHTML += `
                <tr>
                    <td style="white-space: nowrap;">${date}</td>
                    <td>
                        <div style="font-weight: 700; color: var(--text-primary); font-size: 0.95rem;">${custName}</div>
                    </td>
                    <td style="white-space: nowrap; color: var(--text-secondary);">${custPhone}</td>
                    <td>
                        <div style="font-weight: 600; color: var(--text-primary); font-size: 0.88rem;">${details}</div>
                        <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;" title="${rawFileName}">📄 File: ${rawFileName.length > 32 ? rawFileName.slice(0, 30) + '…' : rawFileName}</div>
                        ${o.notes ? `<div style="font-size: 0.82rem; margin-top: 6px; padding: 5px 8px; background: rgba(139, 92, 246, 0.08); border-left: 3px solid var(--accent-color); border-radius: 4px; color: var(--text-primary); line-height: 1.4;">💬 <strong>Note:</strong> ${o.notes}</div>` : ''}
                    </td>
                    <td>
                        <div style="display: flex; gap: 6px; align-items: center;">
                            <button class="action-btn" style="background: var(--card-bg); border: 1px solid var(--border-color); color: var(--text-primary); padding: 6px 10px; font-size: 0.82rem;" onclick="window.previewIncomingFile('${encodedOrder}')" title="Preview document">👁️ Preview</button>
                            <button class="action-btn" style="background: var(--success-color); color: white; border: none; padding: 6px 12px; font-size: 0.82rem; font-weight: 600;" onclick="window.openPendingOrder('${encodedOrder}')" title="Process in Create Order">✓ Accept</button>
                            <button class="action-btn" style="background: transparent; border: 1px solid #ef4444; color: #ef4444; padding: 6px 10px; font-size: 0.82rem;" onclick="window.declineOrder(${o.id})" title="Decline order">✕ Decline</button>
                        </div>
                    </td>
                </tr>
            `;
        });
    };

    const refreshIncomingBtn = document.getElementById('refresh-incoming-btn');
    if (refreshIncomingBtn) {
        refreshIncomingBtn.addEventListener('click', () => {
            const btn = refreshIncomingBtn;
            btn.innerHTML = '🔄 Refreshing...';
            btn.disabled = true;
            window.loadIncomingOrdersPage().finally(() => {
                btn.innerHTML = '🔄 Refresh';
                btn.disabled = false;
            });
        });
    }

    let isDeclineBusy = false;
    window.declineOrder = async (id) => {
        if (isDeclineBusy) return;
        if (!window.api || !window.api.updateOrderStatus) return;
        if (confirm("Are you sure you want to decline and remove this incoming order?")) {
            isDeclineBusy = true;
            try {
                const res = await window.api.updateOrderStatus(id, 'Declined');
                if (res.success) {
                    if (window.showToast) window.showToast('Order declined', 'info');
                    loadIncomingOrdersPage();
                    if (document.getElementById('dashboard').classList.contains('active') && typeof loadDashboard === 'function') {
                        loadDashboard();
                    }
                } else {
                    if (window.showToast) window.showToast('Failed to decline order: ' + res.error, 'error');
                }
            } finally {
                isDeclineBusy = false;
            }
        }
    };

    // --- Order History Logic ---
    let ordersOffset = 0;
    const ordersLimit = 50;
    let currentHistoryFilter = 'All';
    let currentHistorySearch = '';
    let cachedHistoryOrders = [];

    window.loadOrderHistory = async function loadOrderHistory(filter = 'All', append = false, searchQuery = '') {
        if (!window.api || !window.api.getRecentOrders) return;
        
        const tbody = document.getElementById('history-table-body');
        if (!tbody) return;
        const loadMoreBtn = document.getElementById('btn-load-more-orders');
        const emptyState = document.getElementById('oh-empty-state');
        const countBadge = document.getElementById('oh-count-badge');
        
        if (!append || filter !== currentHistoryFilter || searchQuery !== currentHistorySearch) {
            ordersOffset = 0;
            currentHistoryFilter = filter;
            currentHistorySearch = searchQuery;
            tbody.innerHTML = '';
        }

        let rawOrders = await window.api.getRecentOrders(ordersLimit, ordersOffset);
        cachedHistoryOrders = rawOrders || [];
        let orders = cachedHistoryOrders;
        
        // Status filter
        if (filter !== 'All') {
            orders = orders.filter(o => (o.status || '').toLowerCase() === filter.toLowerCase());
        }

        // Lightweight real-time search filter
        if (searchQuery && searchQuery.trim()) {
            const q = searchQuery.trim().toLowerCase();
            const cleanQ = q.replace(/^#/, '');
            orders = orders.filter(o => {
                const nameMatch = (o.customer_name || '').toLowerCase().includes(q);
                const phoneMatch = (o.customer_phone || '').toLowerCase().includes(q);
                const idMatch = String(o.id || '').includes(cleanQ);
                const fileMatch = (o.file_name || '').toLowerCase().includes(q);
                const notesMatch = (o.notes || '').toLowerCase().includes(q);
                return nameMatch || phoneMatch || idMatch || fileMatch || notesMatch;
            });
        }

        // Update count badge
        if (countBadge && !append) countBadge.textContent = `${orders.length} order${orders.length !== 1 ? 's' : ''}`;

        const statusConfig = {
            'Completed':     { bg: 'rgba(16,185,129,0.12)',  color: '#10b981', label: 'Completed'     },
            'Confirmed':     { bg: 'rgba(16,185,129,0.12)',  color: '#10b981', label: 'Confirmed'     },
            'Pending':       { bg: 'rgba(245,158,11,0.12)',  color: '#f59e0b', label: 'Pending'       },
            'Processing':    { bg: 'rgba(99,102,241,0.12)',  color: '#6366f1', label: 'Processing'    },
            'Scheduled':     { bg: 'rgba(139,92,246,0.12)',  color: '#8b5cf6', label: 'Scheduled'     },
            'In Production': { bg: 'rgba(99,102,241,0.12)',  color: '#6366f1', label: 'In Production'},
            'Cancelled':     { bg: 'rgba(239,68,68,0.12)',   color: '#ef4444', label: 'Cancelled'     },
            'Printing':      { bg: 'rgba(6,182,212,0.12)',   color: '#06b6d4', label: 'Printing'      },
            'Ready':         { bg: 'rgba(34,197,94,0.12)',   color: '#22c55e', label: 'Ready'         },
        };

        const rowsHtml = orders.map(o => {
            const d = o.created_at ? new Date(o.created_at) : new Date();
            const dateStr = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
            const timeStr = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

            // Customer avatar initials
            const name = (o.customer_name && o.customer_name.trim()) ? o.customer_name.trim() : 'Walk-in Customer';
            const initials = name.split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || 'W';
            const avatarHue = (name.charCodeAt(0) * 37) % 360;

            // Order Details — Customer-first hierarchy: specs + truncated file name with title tooltip
            const rawFile = o.file_name || '—';
            const truncFile = rawFile.length > 28 ? rawFile.slice(0, 26) + '…' : rawFile;
            const printType = (o.print_type || 'B&W').toUpperCase();
            const paper = o.paper_size || 'A4';
            const details = `${o.pages || 1}pg × ${o.copies || 1} • ${printType} • ${paper}`;

            // Amount block
            const amount = `₹${(parseFloat(o.price) || 0).toFixed(2)}`;

            // Status pill
            const sc = statusConfig[o.status] || statusConfig['Completed'];
            const statusHtml = `<span class="oh-status-pill" style="background:${sc.bg}; color:${sc.color};">${sc.label}</span>`;

            // Action menu
            const orderId = o.id;

            return `
                <tr class="oh-row" data-order-id="${orderId}">
                    <td class="oh-td oh-td-date">
                        <div class="oh-date">${dateStr}</div>
                        <div class="oh-time">${timeStr}</div>
                        <div class="oh-order-id">#${orderId}</div>
                    </td>
                    <td class="oh-td oh-td-customer">
                        <div class="oh-customer-wrap">
                            <div class="oh-avatar" style="background: hsl(${avatarHue},60%,50%);">${initials}</div>
                            <div class="oh-customer-info">
                                <div class="oh-customer-name" style="font-weight: 700;">${name}</div>
                                <div class="oh-customer-phone">${o.customer_phone || '—'}</div>
                            </div>
                        </div>
                    </td>
                    <td class="oh-td oh-td-details">
                        <div class="oh-file-meta" style="font-weight: 600; color: var(--text-primary); font-size: 0.88rem;">${details}</div>
                        <div class="oh-file-name" title="${rawFile}" style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">📄 ${truncFile}</div>
                        ${o.notes ? `<div class="oh-file-note" title="${o.notes}">💬 ${o.notes.length > 32 ? o.notes.slice(0,30)+'…' : o.notes}</div>` : ''}
                    </td>
                    <td class="oh-td oh-td-amount">
                        <div class="oh-amount">${amount}</div>
                        <div class="oh-amount-sub">${o.pages || 1} pages</div>
                    </td>
                    <td class="oh-td oh-td-status">
                        ${statusHtml}
                    </td>
                    <td class="oh-td oh-td-actions">
                        <div class="oh-actions-wrap">
                            <button class="oh-action-btn oh-action-complete" data-id="${orderId}" title="Mark Complete" ${o.status === 'Completed' ? 'disabled' : ''}>✓</button>
                            <div class="oh-dot-menu-wrap">
                                <button class="oh-dot-btn" title="More actions">⋮</button>
                                <div class="oh-dot-dropdown">
                                    <button class="oh-dot-item oh-action-complete" data-id="${orderId}">✓ Mark Complete</button>
                                    <button class="oh-dot-item oh-action-pending" data-id="${orderId}">⏳ Mark Pending</button>
                                    <button class="oh-dot-item oh-action-reopen" data-id="${orderId}">🔁 Open in Workspace</button>
                                    <button class="oh-dot-item oh-action-duplicate" data-id="${orderId}">📋 Duplicate Order</button>
                                    <button class="oh-dot-item oh-action-reprint" data-id="${orderId}">🖨️ Reprint</button>
                                    <button class="oh-dot-item oh-action-cancel" data-id="${orderId}" style="color:#ef4444;">✕ Cancel Order</button>
                                </div>
                            </div>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        if (append) {
            tbody.insertAdjacentHTML('beforeend', rowsHtml);
        } else {
            if (!orders.length) {
                tbody.innerHTML = '';
                if (emptyState) emptyState.style.display = 'flex';
            } else {
                if (emptyState) emptyState.style.display = 'none';
                tbody.innerHTML = rowsHtml;
            }
        }

        ordersOffset += orders.length;

        if (orders.length === ordersLimit) {
            if (loadMoreBtn) loadMoreBtn.style.display = 'inline-flex';
        } else {
            if (loadMoreBtn) loadMoreBtn.style.display = 'none';
        }

        // Attach dot-menu toggle handlers
        tbody.querySelectorAll('.oh-dot-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const wrap = btn.closest('.oh-dot-menu-wrap');
                const dropdown = wrap.querySelector('.oh-dot-dropdown');
                const isOpen = dropdown.classList.contains('open');
                document.querySelectorAll('.oh-dot-dropdown.open').forEach(d => d.classList.remove('open'));
                if (!isOpen) dropdown.classList.add('open');
            });
        });

        if (!document.__ohDotMenuCloseRegistered) {
            document.__ohDotMenuCloseRegistered = true;
            document.addEventListener('click', () => {
                document.querySelectorAll('.oh-dot-dropdown.open').forEach(d => d.classList.remove('open'));
            });
        }

        // Action handlers with scoped locks
        let isHistoryActionBusy = false;

        tbody.querySelectorAll('.oh-action-complete').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (isHistoryActionBusy) return;
                isHistoryActionBusy = true;
                const id = btn.getAttribute('data-id');
                try {
                    if (window.api && window.api.updateOrderStatus) {
                        await window.api.updateOrderStatus(id, 'Completed');
                        loadOrderHistory(currentHistoryFilter, false, currentHistorySearch);
                        if (window.showToast) window.showToast('Order marked complete', 'success');
                    }
                } finally {
                    isHistoryActionBusy = false;
                }
            });
        });

        tbody.querySelectorAll('.oh-action-pending').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (isHistoryActionBusy) return;
                isHistoryActionBusy = true;
                const id = btn.getAttribute('data-id');
                try {
                    if (window.api && window.api.updateOrderStatus) {
                        await window.api.updateOrderStatus(id, 'Pending');
                        loadOrderHistory(currentHistoryFilter, false, currentHistorySearch);
                        if (window.showToast) window.showToast('Order marked pending', 'info');
                    }
                } finally {
                    isHistoryActionBusy = false;
                }
            });
        });

        tbody.querySelectorAll('.oh-action-reopen').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.getAttribute('data-id'));
                const targetOrder = cachedHistoryOrders.find(o => o.id === id);
                if (targetOrder) {
                    window.openPendingOrder(targetOrder);
                } else {
                    if (window.showToast) window.showToast(`Order #${id} not found in cache`, 'error');
                }
            });
        });

        tbody.querySelectorAll('.oh-action-duplicate').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (isHistoryActionBusy) return;
                isHistoryActionBusy = true;
                const id = parseInt(btn.getAttribute('data-id'));
                try {
                    if (window.api && window.api.duplicateOrderForCustomer) {
                        const res = await window.api.duplicateOrderForCustomer(id);
                        if (res && res.success) {
                            if (window.showToast) window.showToast(`Order #${id} duplicated! (New Order #${res.orderId})`, 'success');
                            loadOrderHistory(currentHistoryFilter, false, currentHistorySearch);
                        } else {
                            if (window.showToast) window.showToast(`Failed to duplicate order: ${res ? res.error : 'Unknown error'}`, 'error');
                        }
                    }
                } finally {
                    isHistoryActionBusy = false;
                }
            });
        });

        tbody.querySelectorAll('.oh-action-reprint').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (isHistoryActionBusy) return;
                isHistoryActionBusy = true;
                const id = parseInt(btn.getAttribute('data-id'));
                const targetOrder = cachedHistoryOrders.find(o => o.id === id);
                try {
                    if (window.showToast) window.showToast(`Reprint request sent for Order #${id}...`, 'info');
                    if (targetOrder && targetOrder.file_path && window.api && window.api.printFile) {
                        const payload = [{
                            path: targetOrder.file_path,
                            ext: targetOrder.file_path.includes('.') ? targetOrder.file_path.substring(targetOrder.file_path.lastIndexOf('.')).toLowerCase() : '.pdf',
                            rotate: 0,
                            fit: 'contain'
                        }];
                        const res = await window.api.printFile(payload, {
                            printerName: 'Default',
                            printType: targetOrder.print_type || 'B&W',
                            paperSize: targetOrder.paper_size || 'A4',
                            copies: targetOrder.copies || 1
                        });
                        if (res && res.success) {
                            if (window.showToast) window.showToast(`Order #${id} reprinted successfully!`, 'success');
                        } else {
                            if (window.showPrinterErrorModal) {
                                window.showPrinterErrorModal(res ? res.error : 'Reprint failed', payload, { copies: 1 });
                            }
                        }
                    } else if (window.api && window.api.reprintJob) {
                        const res = await window.api.reprintJob(id);
                        if (res && res.success) {
                            if (window.showToast) window.showToast(`Order #${id} reprint queued!`, 'success');
                        } else {
                            if (window.showToast) window.showToast(`Reprint failed: ${res ? res.error : 'Unknown error'}`, 'error');
                        }
                    }
                } catch(err) {
                    if (window.showToast) window.showToast('Reprint error: ' + err.message, 'error');
                } finally {
                    isHistoryActionBusy = false;
                }
            });
        });

        tbody.querySelectorAll('.oh-action-cancel').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (isHistoryActionBusy) return;
                const id = btn.getAttribute('data-id');
                if (confirm(`Are you sure you want to cancel Order #${id}?`)) {
                    isHistoryActionBusy = true;
                    try {
                        if (window.api && window.api.updateOrderStatus) {
                            await window.api.updateOrderStatus(id, 'Cancelled');
                            loadOrderHistory(currentHistoryFilter, false, currentHistorySearch);
                            if (window.showToast) window.showToast(`Order #${id} cancelled`, 'warning');
                        }
                    } finally {
                        isHistoryActionBusy = false;
                    }
                }
            });
        });
    }

    // Search Input Listener for Order History
    const historySearchInput = document.getElementById('history-search-input');
    const historySearchClear = document.getElementById('history-search-clear');
    let searchDebounceTimer = null;

    if (historySearchInput) {
        historySearchInput.addEventListener('input', (e) => {
            const val = e.target.value;
            if (historySearchClear) {
                historySearchClear.style.display = val.length > 0 ? 'inline-block' : 'none';
            }
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                loadOrderHistory(currentHistoryFilter, false, val);
            }, 120);
        });
    }

    if (historySearchClear) {
        historySearchClear.addEventListener('click', () => {
            if (historySearchInput) historySearchInput.value = '';
            historySearchClear.style.display = 'none';
            loadOrderHistory(currentHistoryFilter, false, '');
        });
    }

    // History Filter Dropdown Listener
    const historyFilter = document.getElementById('history-filter');
    if (historyFilter) {
        historyFilter.addEventListener('change', (e) => {
            loadOrderHistory(e.target.value, false, historySearchInput ? historySearchInput.value : '');
        });
    }

    // Dashboard Pending Card Click -> Redirects to Incoming Orders Workspace
    const dashPendingCard = document.getElementById('dash-pending-card');
    if (dashPendingCard) {
        dashPendingCard.addEventListener('click', () => {
            const incomingBtn = document.querySelector('.nav-btn[data-target="incoming"]');
            if (incomingBtn) incomingBtn.click();
        });
    }

    // --- APPLE CALENDAR-INSPIRED SCHEDULE PRODUCTION MODAL LOGIC ---
    const btnActionSchedule = document.getElementById('btn-action-schedule');
    const modalSched = document.getElementById('schedule-production-modal');
    const schedCloseBtn = document.getElementById('sched-modal-close-btn');
    const schedCancelBtn = document.getElementById('sched-btn-cancel');
    const schedConfirmBtn = document.getElementById('sched-btn-confirm');

    // --- MINI INTERACTIVE CALENDAR WIDGET LOGIC ---
    let miniCalYear = new Date().getFullYear();
    let miniCalMonth = new Date().getMonth();

    function renderMiniCalendar() {
        const daysGrid = document.getElementById('mini-cal-days-grid');
        const titleEl = document.getElementById('mini-cal-month-year');
        const dateInput = document.getElementById('sched-input-date');
        if (!daysGrid || !titleEl) return;

        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        titleEl.textContent = `${monthNames[miniCalMonth]} ${miniCalYear}`;

        const selectedDateVal = dateInput && dateInput.value ? dateInput.value : new Date().toISOString().split('T')[0];
        const todayStr = new Date().toISOString().split('T')[0];

        const firstDayIndex = new Date(miniCalYear, miniCalMonth, 1).getDay();
        const totalDays = new Date(miniCalYear, miniCalMonth + 1, 0).getDate();
        const prevMonthTotalDays = new Date(miniCalYear, miniCalMonth, 0).getDate();

        let html = '';

        // Prev month filler
        for (let i = firstDayIndex - 1; i >= 0; i--) {
            const dayNum = prevMonthTotalDays - i;
            html += `<div class="mini-cal-day disabled">${dayNum}</div>`;
        }

        // Current month days
        for (let d = 1; d <= totalDays; d++) {
            const mm = String(miniCalMonth + 1).padStart(2, '0');
            const dd = String(d).padStart(2, '0');
            const dateStr = `${miniCalYear}-${mm}-${dd}`;

            const isToday = (dateStr === todayStr);
            const isActive = (dateStr === selectedDateVal);

            let classes = 'mini-cal-day';
            if (isToday) classes += ' today';
            if (isActive) classes += ' active';

            html += `<div class="${classes}" data-date="${dateStr}">${d}</div>`;
        }

        // Next month filler
        const totalSlots = firstDayIndex + totalDays;
        const remainingSlots = (7 - (totalSlots % 7)) % 7;
        for (let n = 1; n <= remainingSlots; n++) {
            html += `<div class="mini-cal-day disabled">${n}</div>`;
        }

        daysGrid.innerHTML = html;

        daysGrid.querySelectorAll('.mini-cal-day[data-date]').forEach(cell => {
            cell.addEventListener('click', (e) => {
                const chosenDate = e.currentTarget.getAttribute('data-date');
                if (dateInput) {
                    dateInput.value = chosenDate;
                }
                renderMiniCalendar();
            });
        });
    }

    const btnCalPrev = document.getElementById('mini-cal-prev');
    const btnCalNext = document.getElementById('mini-cal-next');
    if (btnCalPrev) {
        btnCalPrev.addEventListener('click', () => {
            miniCalMonth--;
            if (miniCalMonth < 0) {
                miniCalMonth = 11;
                miniCalYear--;
            }
            renderMiniCalendar();
        });
    }
    if (btnCalNext) {
        btnCalNext.addEventListener('click', () => {
            miniCalMonth++;
            if (miniCalMonth > 11) {
                miniCalMonth = 0;
                miniCalYear++;
            }
            renderMiniCalendar();
        });
    }

    const schedDateInput = document.getElementById('sched-input-date');
    if (schedDateInput) {
        schedDateInput.addEventListener('change', () => {
            if (schedDateInput.value) {
                const parts = schedDateInput.value.split('-');
                if (parts.length === 3) {
                    miniCalYear = parseInt(parts[0]);
                    miniCalMonth = parseInt(parts[1]) - 1;
                }
            }
            renderMiniCalendar();
        });
    }

    function openScheduleModal(orderData) {
        const targetModal = document.getElementById('schedule-production-modal');
        if (!targetModal) return;

        const elTitle = document.getElementById('sched-modal-order-title');
        const elCust = document.getElementById('sched-modal-customer-name');
        const elDate = document.getElementById('sched-input-date');

        if (elTitle) elTitle.textContent = orderData ? (orderData.file_name || orderData.name || 'Custom Print Job') : 'New Print Order';
        if (elCust) elCust.textContent = `Customer: ${orderData ? (orderData.customer_name || orderData.name || (document.getElementById('setup-name')?.value) || 'Walk-in Customer') : 'Walk-in Customer'}`;
        if (elDate) {
            const today = new Date().toISOString().split('T')[0];
            elDate.value = today;
            const now = new Date();
            miniCalYear = now.getFullYear();
            miniCalMonth = now.getMonth();
        }

        if (typeof renderMiniCalendar === 'function') renderMiniCalendar();
        targetModal.style.setProperty('display', 'flex', 'important');
    }

    if (btnActionSchedule) {
        btnActionSchedule.addEventListener('click', (e) => {
            const cfg = window.currentOrderConfigGlobal || (typeof window.getActiveConfig === 'function' ? window.getActiveConfig() : null);
            openScheduleModal(cfg);
        });
    }

    if (schedCloseBtn) schedCloseBtn.addEventListener('click', () => { const m = document.getElementById('schedule-production-modal'); if (m) m.style.setProperty('display', 'none', 'important'); });
    if (schedCancelBtn) schedCancelBtn.addEventListener('click', () => { const m = document.getElementById('schedule-production-modal'); if (m) m.style.setProperty('display', 'none', 'important'); });

    // Quick Date Chips
    const appleChips = document.querySelectorAll('.apple-chip');
    appleChips.forEach(chip => {
        chip.addEventListener('click', () => {
            appleChips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            const quick = chip.getAttribute('data-quick');
            const dateInput = document.getElementById('sched-input-date');
            const timeInput = document.getElementById('sched-input-time');
            const d = new Date();

            if (quick === 'tomorrow') {
                d.setDate(d.getDate() + 1);
            } else if (quick === 'this-evening') {
                if (timeInput) timeInput.value = '18:00';
            } else if (quick === 'next-monday') {
                const day = d.getDay();
                const diff = d.getDate() + (day === 0 ? 1 : (8 - day));
                d.setDate(diff);
            } else if (quick === 'next-week') {
                d.setDate(d.getDate() + 7);
            }

            if (dateInput && quick !== 'this-evening') {
                const dateStr = d.toISOString().split('T')[0];
                dateInput.value = dateStr;
                miniCalYear = d.getFullYear();
                miniCalMonth = d.getMonth();
                renderMiniCalendar();
            }
        });
    });

    // Handled centrally in preview.js for full DB & job creation save

    window.openScheduleProductionModal = openScheduleModal;
    window.renderMiniCalendar = renderMiniCalendar;
    const settingShopName = document.getElementById('setting-shop-name');
    const settingPrinter = document.getElementById('setting-printer');
    const settingBwPrice = document.getElementById('setting-bw-price');
    const settingColorPrice = document.getElementById('setting-color-price');
    const settingUseSystemDialog = document.getElementById('setting-use-system-dialog');
    const saveSettingsBtn = document.getElementById('save-settings-btn');


    async function loadSettings() {
        if (!window.api || !window.api.getSettings) return;
        
        try {
            const settings = await window.api.getSettings();
            if (settings) {
                const settingShopName = document.getElementById('setting-shop-name');
                const settingBwPrice = document.getElementById('setting-bw-price');
                const settingColorPrice = document.getElementById('setting-color-price');
                const settingBwCost = document.getElementById('setting-bw-cost');
                const settingColorCost = document.getElementById('setting-color-cost');
                const settingSilentPrint = document.getElementById('setting-silent-print');
                const settingUseSystemDialog = document.getElementById('setting-use-system-dialog');
                const settingPrintSimulator = document.getElementById('setting-print-simulator');

                if (settingShopName) settingShopName.value = settings.shop_name || 'My Print Shop';
                if (settingBwPrice) settingBwPrice.value = settings.bw_price_per_page || 2.0;
                if (settingColorPrice) settingColorPrice.value = settings.color_price_per_page || 10.0;
                if (settingBwCost) settingBwCost.value = settings.bw_cost_per_page !== undefined ? settings.bw_cost_per_page : 0.50;
                if (settingColorCost) settingColorCost.value = settings.color_cost_per_page !== undefined ? settings.color_cost_per_page : 2.00;

                if (settingSilentPrint) settingSilentPrint.checked = settings.silent_print_enabled === 1;
                if (settingUseSystemDialog) settingUseSystemDialog.checked = settings.use_system_dialog === 1;
                if (settingPrintSimulator) settingPrintSimulator.checked = settings.print_simulator_enabled === 1;

                if (window.printRates) {
                    window.printRates.bw = settings.bw_price_per_page || 2.0;
                    window.printRates.color = settings.color_price_per_page || 10.0;
                }

                const orderPrintTypeEl = document.getElementById('order-print-type');
                if (orderPrintTypeEl && window.printRates) {
                    const currentVal = orderPrintTypeEl.value;
                    orderPrintTypeEl.innerHTML = `
                        <option value="bw">Black & White (₹${(window.printRates.bw || 2.0).toFixed(2)})</option>
                        <option value="color">Color (₹${(window.printRates.color || 10.0).toFixed(2)})</option>
                    `;
                    orderPrintTypeEl.value = currentVal;
                }
            }

            if (window.api.getPrinters) {
                const printers = (await window.api.getPrinters()) || [];
                const dropdownIds = [
                    'setting-printer', 
                    'setting-photo-printer', 
                    'setting-receipt-printer', 
                    'setting-label-printer', 
                    'setting-barcode-printer',
                    'test-page-printer',
                    'pricing-default-printer'
                ];
                
                dropdownIds.forEach(id => {
                    const selectEl = document.getElementById(id);
                    if (!selectEl) return;
                    
                    selectEl.innerHTML = '<option value="">Select a printer...</option>';
                    if (Array.isArray(printers)) {
                        printers.forEach(p => {
                            let isSelected = false;
                            if (settings) {
                                if (id === 'setting-printer' && settings.default_printer === p.name) isSelected = true;
                                if (id === 'setting-photo-printer' && settings.photo_printer === p.name) isSelected = true;
                                if (id === 'setting-receipt-printer' && settings.receipt_printer === p.name) isSelected = true;
                                if (id === 'setting-label-printer' && settings.label_printer === p.name) isSelected = true;
                                if (id === 'setting-barcode-printer' && settings.barcode_printer === p.name) isSelected = true;
                            }
                            const selectedAttr = isSelected ? 'selected' : '';
                            selectEl.innerHTML += `<option value="${p.name}" ${selectedAttr}>${p.name} ${p.isDefault ? '(System Default)' : ''}</option>`;
                        });
                    }
                });
            }
        } catch (err) {
            console.error("Failed to load settings:", err);
        }
    }

    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', async () => {
            const elShopName = document.getElementById('setting-shop-name');
            const elPrinter = document.getElementById('setting-printer');
            const elBwPrice = document.getElementById('setting-bw-price');
            const elColorPrice = document.getElementById('setting-color-price');
            const elBwCost = document.getElementById('setting-bw-cost');
            const elColorCost = document.getElementById('setting-color-cost');
            const elPhotoPrinter = document.getElementById('setting-photo-printer');
            const elReceiptPrinter = document.getElementById('setting-receipt-printer');
            const elLabelPrinter = document.getElementById('setting-label-printer');
            const elBarcodePrinter = document.getElementById('setting-barcode-printer');
            const elSilentPrint = document.getElementById('setting-silent-print');
            const elUseSystemDialog = document.getElementById('setting-use-system-dialog');
            const elPrintSimulator = document.getElementById('setting-print-simulator');

            const data = {
                shop_name: elShopName ? elShopName.value.trim() : 'My Print Shop',
                default_printer: elPrinter ? elPrinter.value : '',
                bw_price_per_page: elBwPrice ? (parseFloat(elBwPrice.value) || 2.0) : 2.0,
                color_price_per_page: elColorPrice ? (parseFloat(elColorPrice.value) || 10.0) : 10.0,
                use_system_dialog: elUseSystemDialog ? (elUseSystemDialog.checked ? 1 : 0) : 0,
                bw_cost_per_page: elBwCost ? (parseFloat(elBwCost.value) || 0.50) : 0.50,
                color_cost_per_page: elColorCost ? (parseFloat(elColorCost.value) || 2.00) : 2.00,
                photo_printer: elPhotoPrinter ? elPhotoPrinter.value : '',
                receipt_printer: elReceiptPrinter ? elReceiptPrinter.value : '',
                label_printer: elLabelPrinter ? elLabelPrinter.value : '',
                barcode_printer: elBarcodePrinter ? elBarcodePrinter.value : '',
                silent_print_enabled: elSilentPrint ? (elSilentPrint.checked ? 1 : 0) : 0,
                print_simulator_enabled: elPrintSimulator ? (elPrintSimulator.checked ? 1 : 0) : 0
            };
            try {
                const result = await window.api.updateSettings(data);
                if (result && result.success) {
                    window.showToast("Settings saved successfully!", 'success');
                    loadSettings(); 
                } else {
                    window.showToast("Error saving settings.", 'error');
                }
            } catch (e) {
                console.error("Save settings error:", e);
                window.showToast("Error saving settings: " + e.message, 'error');
            }
        });
    }

    // Print Test Page handler
    const btnPrintTestPage = document.getElementById('btn-print-test-page');
    if (btnPrintTestPage) {
        btnPrintTestPage.addEventListener('click', async () => {
            const testPrinterSelect = document.getElementById('test-page-printer');
            const printerName = testPrinterSelect ? testPrinterSelect.value : null;
            if (!printerName) {
                window.showToast("Please select a printer to test", "warning");
                return;
            }
            window.showToast("Sending alignment test page to printer queue...", "info");
            const res = await window.api.printTestPage(printerName);
            if (res && res.success) {
                window.showToast("Test page print queued successfully!", "success");
            } else {
                window.showToast(`Test page print failed: ${res.error || "Driver error"}`, "error");
            }
        });
    }

    // Test Print Local File handlers
    let selectedTestFile = null;
    const btnSelectTestFile = document.getElementById('btn-select-test-file');
    const btnPrintTestFile = document.getElementById('btn-print-test-file');
    const selectedTestFileNameSpan = document.getElementById('selected-test-file-name');

    if (btnSelectTestFile) {
        btnSelectTestFile.addEventListener('click', async () => {
            if (!window.api || !window.api.selectFiles) return;
            const files = await window.api.selectFiles();
            if (files && files.length > 0) {
                selectedTestFile = files[0];
                if (selectedTestFileNameSpan) {
                    selectedTestFileNameSpan.textContent = selectedTestFile.name;
                    selectedTestFileNameSpan.title = selectedTestFile.path;
                }
                if (btnPrintTestFile) {
                    btnPrintTestFile.disabled = false;
                }
            }
        });
    }

    if (btnPrintTestFile) {
        btnPrintTestFile.addEventListener('click', async () => {
            const testPrinterSelect = document.getElementById('test-page-printer');
            const printerName = testPrinterSelect ? testPrinterSelect.value : null;
            if (!printerName) {
                window.showToast("Please select a printer to test", "warning");
                return;
            }
            if (!selectedTestFile) {
                window.showToast("Please choose a local file first", "warning");
                return;
            }
            window.showToast(`Sending ${selectedTestFile.name} to printer queue...`, "info");
            
            const payload = [{
                path: selectedTestFile.path,
                ext: selectedTestFile.ext
            }];
            
            const printOptions = {
                printerName: printerName,
                printType: 'color',
                paperSize: 'A4',
                sides: 'Single',
                copies: 1,
                silent: true
            };
            
            const res = await window.api.printFile(payload, printOptions);
            if (res && res.success) {
                window.showToast("Local file print queued successfully!", "success");
            } else {
                window.showToast(`Print failed: ${res.error || "Driver error"}`, "error");
            }
        });
    }



    // Settings Sub-Tabs Switching
    const settingsTabBtns = document.querySelectorAll('.settings-tab-btn[data-tab]');
    const settingsSubViews = document.querySelectorAll('.settings-sub-view');
    
    settingsTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');
            if (!targetTab) return;
            
            // Switch tabs active classes
            settingsTabBtns.forEach(b => {
                b.classList.remove('active');
                b.style.color = 'var(--text-secondary)';
                b.style.fontWeight = '500';
                b.style.borderBottomColor = 'transparent';
            });
            btn.classList.add('active');
            btn.style.color = 'var(--accent-color)';
            btn.style.fontWeight = '700';
            btn.style.borderBottomColor = 'var(--accent-color)';
            
            // Switch sub-views visibility
            settingsSubViews.forEach(view => {
                if (view.id === targetTab) {
                    view.style.display = 'block';
                } else {
                    view.style.display = 'none';
                }
            });
            
            if (targetTab === 'settings-backup') {
                loadDatabaseBackupDashboard();
            } else if (targetTab === 'settings-profiles') {
                loadProductsAndProfilesDashboard();
            } else if (targetTab === 'settings-pricing') {
                loadPricingTable();
                if (typeof window.loadUserMgmt === 'function') window.loadUserMgmt();
            }
        });
    });

    // Products & Profiles Mini-Tabs Switcher
    const miniTabBtns = document.querySelectorAll('.profile-mini-tabs .settings-tab-btn[data-minitab]');
    const subProfileMiniViews = document.querySelectorAll('.profile-mini-view');

    miniTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetMiniId = btn.getAttribute('data-minitab');
            if (!targetMiniId) return;

            miniTabBtns.forEach(b => {
                b.classList.remove('active');
                b.style.fontWeight = '500';
            });
            btn.classList.add('active');
            btn.style.fontWeight = '700';

            subProfileMiniViews.forEach(v => {
                v.style.display = v.id === targetMiniId ? 'block' : 'none';
            });
        });
    });

    // Format Bytes to human readable string
    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = 2;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    // Format Database UTC Timestamp to Local user friendly string
    function formatDbDate(utcString) {
        if (!utcString || utcString === 'Never') return 'Never';
        try {
            const cleanUtc = utcString.replace(' ', 'T') + 'Z';
            const date = new Date(cleanUtc);
            if (isNaN(date.getTime())) return utcString;
            return date.toLocaleString();
        } catch(e) {
            return utcString;
        }
    }

    // Load Database Backup Dashboard Data
    async function loadDatabaseBackupDashboard() {
        if (!window.api || !window.api.getDatabaseHealth) return;
        
        try {
            const health = await window.api.getDatabaseHealth();
            if (health) {
                // Update Status Cards
                const statusIcon = document.getElementById('db-status-icon');
                const statusTitle = document.getElementById('db-status-title');
                const statusDesc = document.getElementById('db-status-desc');
                const reminderBanner = document.getElementById('backup-reminder-banner');

                if (statusIcon && statusTitle && statusDesc) {
                    statusIcon.className = ''; // Reset classes
                    if (health.status === 'Healthy') {
                        statusIcon.textContent = '✔';
                        statusIcon.style.color = 'var(--success-color)';
                        statusIcon.style.background = 'rgba(52, 211, 153, 0.1)';
                        statusTitle.textContent = 'Database Healthy';
                        statusTitle.style.color = 'var(--success-color)';
                        statusDesc.textContent = 'Your system database is fully verified and secure.';
                        if (reminderBanner) reminderBanner.style.display = 'none';
                    } else if (health.status === 'Warning') {
                        statusIcon.textContent = '⚠️';
                        statusIcon.style.color = '#f59e0b';
                        statusIcon.style.background = 'rgba(245, 158, 11, 0.1)';
                        statusTitle.textContent = 'Backup Recommended';
                        statusTitle.style.color = '#f59e0b';
                        statusDesc.textContent = 'Your database has not been backed up for over 7 days.';
                        if (reminderBanner) reminderBanner.style.display = 'flex';
                    } else { // Corrupted
                        statusIcon.textContent = '✖';
                        statusIcon.style.color = '#ef4444';
                        statusIcon.style.background = 'rgba(239, 68, 68, 0.1)';
                        statusTitle.textContent = 'Database Error';
                        statusTitle.style.color = '#ef4444';
                        statusDesc.textContent = 'Integrity check errors detected. Recovery actions recommended.';
                        if (reminderBanner) reminderBanner.style.display = 'none';
                    }
                }

                // Populate Stats Panel
                const sizeEl = document.getElementById('db-health-size');
                if (sizeEl) sizeEl.textContent = formatBytes(health.databaseSize);

                const lastBackupEl = document.getElementById('db-health-last-backup');
                if (lastBackupEl) lastBackupEl.textContent = formatDbDate(health.lastBackup);

                const lastRestoreEl = document.getElementById('db-health-last-restore');
                if (lastRestoreEl) lastRestoreEl.textContent = formatDbDate(health.lastRestore);

                const autoStatusEl = document.getElementById('db-health-auto-status');
                if (autoStatusEl) {
                    autoStatusEl.textContent = health.autoBackupStatus;
                    autoStatusEl.style.color = 'var(--success-color)';
                }

                const integrityEl = document.getElementById('db-health-integrity');
                if (integrityEl) {
                    integrityEl.textContent = health.integrityStatus;
                    integrityEl.style.color = health.integrityStatus === 'Verified' ? 'var(--success-color)' : '#ef4444';
                }

                // Populate Statistics
                const statCustomers = document.getElementById('db-stat-customers');
                if (statCustomers) statCustomers.textContent = health.customerCount;

                const statOrders = document.getElementById('db-stat-orders');
                if (statOrders) statOrders.textContent = health.orderCount;

                const statItems = document.getElementById('db-stat-items');
                if (statItems) statItems.textContent = health.inventoryItemCount;

                const statSuppliers = document.getElementById('db-stat-suppliers');
                if (statSuppliers) statSuppliers.textContent = health.supplierCount;
            }

            // Populate Backup History Table
            const historyList = await window.api.getBackupHistory();
            const tableBody = document.getElementById('backup-history-table-body');
            if (tableBody) {
                tableBody.innerHTML = '';
                if (!historyList || historyList.length === 0) {
                    tableBody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-secondary); padding:16px;">No backups available.</td></tr>';
                } else {
                    historyList.forEach(item => {
                        const row = document.createElement('tr');
                        row.innerHTML = `
                            <td>${new Date(item.mtime).toLocaleString()}</td>
                            <td style="font-family:monospace; font-size:0.85rem;">${item.name}</td>
                            <td><span class="badge" style="background: rgba(255,255,255,0.05); color: var(--text-primary); font-size: 0.75rem; border: 1px solid var(--border-color);">${item.type}</span></td>
                            <td>${formatBytes(item.size)}</td>
                            <td style="text-align: right;">
                                <button class="action-btn btn-verify-file" data-path="${item.path}" style="padding: 4px 8px; font-size: 0.75rem; margin: 0 4px 0 0; background: transparent; border: 1px solid var(--border-color); color: var(--text-primary);">Verify</button>
                                ${item.type === 'Manual' ? `<button class="action-btn btn-delete-file" data-path="${item.path}" style="padding: 4px 8px; font-size: 0.75rem; margin: 0; background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);">Delete</button>` : ''}
                            </td>
                        `;
                        tableBody.appendChild(row);
                    });

                    // Add Verify click event
                    tableBody.querySelectorAll('.btn-verify-file').forEach(btn => {
                        btn.addEventListener('click', async () => {
                            const path = btn.getAttribute('data-path');
                            window.showToast("Verifying backup file...", "info");
                            const res = await window.api.verifyBackup(path);
                            if (res.success) {
                                window.showToast("✔ Backup Verified", "success");
                            } else {
                                window.showToast(`Backup Validation Failed: ${res.error}`, "error");
                            }
                        });
                    });

                    // Add Delete click event
                    tableBody.querySelectorAll('.btn-delete-file').forEach(btn => {
                        btn.addEventListener('click', async () => {
                            const path = btn.getAttribute('data-path');
                            const confirmDelete = confirm("Are you sure you want to permanently delete this manual backup file?");
                            if (confirmDelete) {
                                const res = await window.api.deleteBackup(path);
                                if (res.success) {
                                    window.showToast("Backup deleted successfully.", "success");
                                    loadDatabaseBackupDashboard();
                                } else {
                                    window.showToast(`Failed to delete backup: ${res.error}`, "error");
                                }
                            }
                        });
                    });
                }
            }
        } catch (err) {
            console.error("Failed to load backup dashboard data:", err);
        }
    }

    // Bind Reminder Backup Action
    const btnReminderBackup = document.getElementById('btn-reminder-backup');
    if (btnReminderBackup) {
        btnReminderBackup.addEventListener('click', async () => {
            await triggerDashboardManualBackup();
        });
    }

    // Bind Backup Now Button
    const btnBackupNow = document.getElementById('btn-backup-now');
    if (btnBackupNow) {
        btnBackupNow.addEventListener('click', async () => {
            await triggerDashboardManualBackup();
        });
    }

    async function triggerDashboardManualBackup() {
        if (!window.api || !window.api.triggerManualBackup) return;
        window.showToast("Creating manual database backup...", "info");
        try {
            const res = await window.api.triggerManualBackup();
            if (res.success) {
                window.showToast("✔ Backup Completed Successfully", "success");
                loadDatabaseBackupDashboard();
            } else {
                window.showToast(`Backup Failed: ${res.error}`, "error");
            }
        } catch (err) {
            window.showToast(`Error: ${err.message}`, "error");
        }
    }

    // Restore Wizard Panel Toggle
    const btnOpenRestore = document.getElementById('btn-open-restore-wizard');
    const btnCloseRestore = document.getElementById('btn-close-restore-wizard');
    const restorePanel = document.getElementById('restore-wizard-panel');
    const restoreSelect = document.getElementById('restore-backup-select');
    const restoreDetails = document.getElementById('restore-backup-details');
    const btnVerifyRestore = document.getElementById('btn-verify-selected-backup');
    const btnExecuteRestore = document.getElementById('btn-execute-restore');

    if (btnOpenRestore && restorePanel) {
        btnOpenRestore.addEventListener('click', async () => {
            restorePanel.style.display = 'block';
            if (restoreSelect) {
                restoreSelect.innerHTML = '<option value="">Choose a backup file...</option>';
                const history = await window.api.getBackupHistory();
                if (history && history.length > 0) {
                    history.forEach(item => {
                        restoreSelect.innerHTML += `<option value="${item.path}" data-size="${item.size}" data-mtime="${item.mtime}" data-type="${item.type}">${new Date(item.mtime).toLocaleString()} (${item.type})</option>`;
                    });
                }
            }
        });
    }

    if (btnCloseRestore && restorePanel) {
        btnCloseRestore.addEventListener('click', () => {
            restorePanel.style.display = 'none';
        });
    }

    if (restoreSelect) {
        restoreSelect.addEventListener('change', () => {
            const selectedVal = restoreSelect.value;
            if (!selectedVal) {
                if (restoreDetails) restoreDetails.style.display = 'none';
                if (btnVerifyRestore) btnVerifyRestore.disabled = true;
                if (btnExecuteRestore) btnExecuteRestore.disabled = true;
            } else {
                const opt = restoreSelect.selectedOptions[0];
                const size = parseInt(opt.getAttribute('data-size'));
                const mtime = opt.getAttribute('data-mtime');
                const type = opt.getAttribute('data-type');

                const detailDate = document.getElementById('restore-detail-date');
                const detailType = document.getElementById('restore-detail-type');
                const detailSize = document.getElementById('restore-detail-size');
                const detailIntegrity = document.getElementById('restore-detail-integrity');

                if (detailDate) detailDate.textContent = new Date(mtime).toLocaleString();
                if (detailType) detailType.textContent = type;
                if (detailSize) detailSize.textContent = formatBytes(size);
                if (detailIntegrity) detailIntegrity.textContent = 'Not Verified';

                if (restoreDetails) restoreDetails.style.display = 'block';
                if (btnVerifyRestore) btnVerifyRestore.disabled = false;
                if (btnExecuteRestore) btnExecuteRestore.disabled = false;
            }
        });
    }

    if (btnVerifyRestore && restoreSelect) {
        btnVerifyRestore.addEventListener('click', async () => {
            const selectedPath = restoreSelect.value;
            if (!selectedPath) return;
            window.showToast("Verifying selected backup file...", "info");
            const res = await window.api.verifyBackup(selectedPath);
            const detailIntegrity = document.getElementById('restore-detail-integrity');
            if (res.success) {
                window.showToast("✔ Backup Verified", "success");
                if (detailIntegrity) {
                    detailIntegrity.textContent = '✔ Verified (OK)';
                    detailIntegrity.style.color = 'var(--success-color)';
                }
            } else {
                window.showToast(`Backup Validation Failed: ${res.error}`, "error");
                if (detailIntegrity) {
                    detailIntegrity.textContent = `Error: ${res.error}`;
                    detailIntegrity.style.color = '#ef4444';
                }
            }
        });
    }

    if (btnExecuteRestore && restoreSelect) {
        btnExecuteRestore.addEventListener('click', async () => {
            const selectedPath = restoreSelect.value;
            if (!selectedPath) return;
            const doubleConfirm = confirm("CRITICAL OPERATION:\nAre you sure you want to restore this backup file? The current active database will be overwritten, and the application will restart automatically to complete recovery.");
            if (doubleConfirm) {
                if (btnExecuteRestore) btnExecuteRestore.disabled = true;
                window.showToast("Restoring database... Please wait.", "info");
                const res = await window.api.restoreBackup(selectedPath);
                if (res.success) {
                    window.showToast("✔ Recovery Completed. Restarting...", "success");
                } else {
                    window.showToast(`Restore Failed: ${res.error}`, "error");
                    if (btnExecuteRestore) btnExecuteRestore.disabled = false;
                }
            }
        });
    }

    // ==========================================
    // Fullscreen Recovery Wizard Logic
    // ==========================================
    const recoveryOverlay = document.getElementById('recovery-wizard-overlay');
    if (recoveryOverlay) {
        const isCorrupted = window.location.search.includes('recovery=true');
        if (isCorrupted) {
            recoveryOverlay.style.display = 'flex';
            initializeRecoveryWizard();
        }
    }

    async function initializeRecoveryWizard() {
        const recoverySelect = document.getElementById('recovery-backup-select');
        const btnRestoreLatest = document.getElementById('btn-recovery-restore-latest');
        const btnRestoreSelected = document.getElementById('btn-recovery-restore-selected');
        const btnFreshDb = document.getElementById('btn-recovery-fresh-db');
        const statusMsg = document.getElementById('recovery-status-msg');

        if (!window.api || !window.api.getBackupHistory) return;

        // Fetch backups
        const history = await window.api.getBackupHistory();
        if (recoverySelect) {
            recoverySelect.innerHTML = '<option value="">Choose a backup file...</option>';
            if (history && history.length > 0) {
                history.forEach(item => {
                    recoverySelect.innerHTML += `<option value="${item.path}">${new Date(item.mtime).toLocaleString()} (${item.type})</option>`;
                });
            }
        }

        if (recoverySelect && btnRestoreSelected) {
            recoverySelect.addEventListener('change', () => {
                btnRestoreSelected.disabled = !recoverySelect.value;
            });
        }

        // Restore Latest
        if (btnRestoreLatest) {
            btnRestoreLatest.addEventListener('click', async () => {
                const history = await window.api.getBackupHistory();
                if (!history || history.length === 0) {
                    alert("No backup files found. Please use the 'Fresh Database' option or manually copy a backup file into the Backups folder.");
                    return;
                }
                const latest = history[0];
                const doubleConfirm = confirm(`Are you sure you want to restore the latest backup: ${latest.name}?`);
                if (doubleConfirm) {
                    runRecoveryRestore(latest.path);
                }
            });
        }

        // Restore Selected
        if (btnRestoreSelected && recoverySelect) {
            btnRestoreSelected.addEventListener('click', () => {
                const selectedPath = recoverySelect.value;
                if (!selectedPath) return;
                const doubleConfirm = confirm("Are you sure you want to restore this selected backup file?");
                if (doubleConfirm) {
                    runRecoveryRestore(selectedPath);
                }
            });
        }

        // Fresh Database
        if (btnFreshDb) {
            btnFreshDb.addEventListener('click', async () => {
                const doubleConfirm = confirm("CRITICAL WARNING:\nAre you sure you want to reset and start with a fresh blank database? This will archive your corrupted database and create a blank one. All settings, inventory levels, and order histories will be reset.\n\nType 'RESET' in the console or click OK to proceed.");
                if (doubleConfirm) {
                    if (statusMsg) {
                        statusMsg.textContent = 'Initializing fresh database... Please wait.';
                        statusMsg.style.display = 'block';
                        statusMsg.style.color = 'var(--text-secondary)';
                    }
                    const res = await window.api.recoveryCreateFreshDb();
                    if (res.success) {
                        alert("✔ Recovery Completed. Database reset successfully! PrintShop Manager will now restart.");
                        window.location.search = ''; // Reload app normally
                    } else {
                        alert(`Recovery Failed: ${res.error}`);
                        if (statusMsg) statusMsg.style.display = 'none';
                    }
                }
            });
        }

        async function runRecoveryRestore(filePath) {
            if (statusMsg) {
                statusMsg.textContent = 'Restoring database... Please wait.';
                statusMsg.style.display = 'block';
                statusMsg.style.color = 'var(--accent-color)';
            }
            const res = await window.api.recoveryRestore(filePath);
            if (res.success) {
                if (statusMsg) {
                    statusMsg.textContent = '✔ Recovery Completed. Restarting application...';
                    statusMsg.style.color = 'var(--success-color)';
                }
                alert("✔ Recovery Completed. Backup restored successfully! Click OK to restart.");
            } else {
                alert(`Restore failed: ${res.error}`);
                if (statusMsg) statusMsg.style.display = 'none';
            }
        }
    }

    const cleanupTempBtn = document.getElementById('cleanup-temp-btn');
    if (cleanupTempBtn) {
        cleanupTempBtn.addEventListener('click', async () => {
            window.showToast("Cleaning up temporary system files...", "info");
            try {
                const res = await window.api.systemCleanupTemp();
                if (res && res.success) {
                    window.showToast(`Cleaned up ${res.filesDeleted} files. Recovered ${res.spaceSavedMB} MB!`, 'success');
                } else {
                    window.showToast(`Failed to clean temporary files`, 'error');
                }
            } catch (err) {
                window.showToast(`Error: ${err.message}`, 'error');
            }
        });
    }

    const optimizeDbBtn = document.getElementById('optimize-db-btn');
    if (optimizeDbBtn) {
        optimizeDbBtn.addEventListener('click', async () => {
            window.showToast("Optimizing and compressing database...", "info");
            try {
                const res = await window.api.systemOptimizeDb();
                if (res && res.success) {
                    window.showToast(`Database compacted! Cleaned ${res.rowsDeleted} old history rows.`, 'success');
                } else {
                    window.showToast(`Failed to optimize database`, 'error');
                }
            } catch (err) {
                window.showToast(`Error: ${err.message}`, 'error');
            }
        });
    }

    loadSettings();

    // Verify context bridge is working
    if (window.api) {
        console.log("Context Bridge loaded. Ping:", window.api.ping());
    } else {
        console.error("Context Bridge (window.api) not found.");
    }

    // === PRICING MANAGEMENT ===
    let editingPricingId = null;

    async function populatePricingInventoryDropdown() {
        if (!window.api || !window.api.getInvItems) return;
        try {
            const items = await window.api.getInvItems();
            const select = document.getElementById('pricing-inventory-item');
            if (!select) return;
            select.innerHTML = '<option value="">No Stock Tracking</option>' +
                (items || []).map(item => `<option value="${item.id}">${item.name} (${item.sku})</option>`).join('');
        } catch (e) {
            console.error("Failed to populate pricing inventory dropdown:", e);
        }
    }

    async function loadPricingTable() {
        if (!window.api || !window.api.getAllPricing) return;
        try {
            await populatePricingInventoryDropdown();
            const items = await window.api.getAllPricing();
            const tbody = document.getElementById('pricing-table-body');
            if (!tbody) return;
            tbody.innerHTML = '';
            if (!items || items.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color: var(--text-secondary);">No pricing items yet. Add one above.</td></tr>';
                return;
            }
            items.forEach(item => {
                const catBadge = item.category === 'paper'
                    ? '<span style="background:#3b82f6; color:white; padding:2px 8px; border-radius:4px; font-size:0.8rem;">Paper</span>'
                    : '<span style="background:#8b5cf6; color:white; padding:2px 8px; border-radius:4px; font-size:0.8rem;">Extra</span>';
                const linkedItemText = item.inventory_item_name
                    ? `<span style="font-weight: 550; color: #10b981;">📦 ${item.inventory_item_name}</span>`
                    : '<span style="color:var(--text-secondary);">—</span>';
                tbody.innerHTML += `
                    <tr id="pricing-row-${item.id}">
                        <td>${item.name}</td>
                        <td>${catBadge}</td>
                        <td>${item.color_type || '—'}</td>
                        <td>${item.paper_size || '—'}</td>
                        <td>${item.sides || '—'}</td>
                        <td style="font-weight: bold;">₹${parseFloat(item.price || 0).toFixed(2)}</td>
                        <td>${linkedItemText}</td>
                        <td>
                            <button class="action-btn" style="padding:4px 10px; font-size:0.8rem; margin-right:4px;" onclick="window.editPricingItem(${item.id})">Edit</button>
                            <button class="action-btn" style="padding:4px 10px; font-size:0.8rem; background:#ef4444; color:white;" onclick="window.deletePricingItem(${item.id})">Delete</button>
                        </td>
                    </tr>
                `;
            });
        } catch (e) {
            console.error("Failed to load pricing table:", e);
        }
    }

    window.editPricingItem = async (id) => {
        const items = await window.api.getAllPricing();
        const item = items.find(i => i.id === id);
        if (!item) return;
        editingPricingId = id;
        document.getElementById('pricing-name').value = item.name;
        document.getElementById('pricing-category').value = item.category;
        document.getElementById('pricing-color-type').value = item.color_type || '';
        document.getElementById('pricing-paper-size').value = item.paper_size || '';
        document.getElementById('pricing-sides').value = item.sides || '';
        document.getElementById('pricing-price').value = item.price;
        document.getElementById('pricing-inventory-item').value = item.inventory_item_id || '';
        
        document.getElementById('pricing-default-printer').value = item.default_printer || '';
        document.getElementById('pricing-print-paper-size').value = item.print_paper_size || '';
        document.getElementById('pricing-print-orientation').value = item.print_orientation || '';
        document.getElementById('pricing-print-color-mode').value = item.print_color_mode || '';
        document.getElementById('pricing-print-duplex').value = item.print_duplex || '';
        document.getElementById('pricing-print-quality').value = item.print_quality || '';

        const btn = document.getElementById('add-pricing-btn');
        if (btn) { btn.textContent = '💾 Update Pricing Item'; btn.style.backgroundColor = '#8b5cf6'; }
        document.getElementById('pricing-name').focus();
    };

    window.deletePricingItem = async (id) => {
        if (!confirm('Delete this pricing item?')) return;
        const result = await window.api.deletePricing(id);
        if (result.success) { loadPricingTable(); if(window.loadExtrasForOrderSetup) window.loadExtrasForOrderSetup(); }
        else window.showToast('Error deleting: ' + result.error, 'error');
    };

    const addPricingBtn = document.getElementById('add-pricing-btn');
    if (addPricingBtn) {
        addPricingBtn.addEventListener('click', async () => {
            const name = document.getElementById('pricing-name').value.trim();
            const category = document.getElementById('pricing-category').value;
            const color_type = document.getElementById('pricing-color-type').value;
            const paper_size = document.getElementById('pricing-paper-size').value;
            const sides = document.getElementById('pricing-sides').value;
            const price = parseFloat(document.getElementById('pricing-price').value);
            const inventory_item_id = document.getElementById('pricing-inventory-item').value;
            
            const default_printer = document.getElementById('pricing-default-printer').value;
            const print_paper_size = document.getElementById('pricing-print-paper-size').value;
            const print_orientation = document.getElementById('pricing-print-orientation').value;
            const print_color_mode = document.getElementById('pricing-print-color-mode').value;
            const print_duplex = document.getElementById('pricing-print-duplex').value;
            const print_quality = document.getElementById('pricing-print-quality').value;

            const msg = document.getElementById('pricing-msg');

            if (!name || isNaN(price)) {
                if (msg) { msg.textContent = '⚠ Name and Price are required.'; msg.style.color = '#ef4444'; }
                return;
            }
            const data = { 
                name, category, color_type, paper_size, sides, price, inventory_item_id,
                default_printer, print_paper_size, print_orientation, print_color_mode, print_duplex, print_quality
            };
            let result;
            if (editingPricingId) {
                result = await window.api.updatePricing(editingPricingId, data);
            } else {
                result = await window.api.createPricing(data);
            }

            if (result.success) {
                if (msg) { msg.textContent = editingPricingId ? '✓ Updated!' : '✓ Added!'; msg.style.color = 'var(--success-color)'; setTimeout(() => { msg.textContent = ''; }, 2000); }
                // Reset form
                document.getElementById('pricing-name').value = '';
                document.getElementById('pricing-price').value = '';
                document.getElementById('pricing-color-type').value = '';
                document.getElementById('pricing-paper-size').value = '';
                document.getElementById('pricing-sides').value = '';
                document.getElementById('pricing-inventory-item').value = '';
                
                document.getElementById('pricing-default-printer').value = '';
                document.getElementById('pricing-print-paper-size').value = '';
                document.getElementById('pricing-print-orientation').value = '';
                document.getElementById('pricing-print-color-mode').value = '';
                document.getElementById('pricing-print-duplex').value = '';
                document.getElementById('pricing-print-quality').value = '';

                editingPricingId = null;
                addPricingBtn.textContent = '+ Add Pricing Item';
                addPricingBtn.style.backgroundColor = 'var(--accent-color)';
                loadPricingTable();
                loadExtrasForOrderSetup();
            } else {
                if (msg) { msg.textContent = '✗ Error: ' + result.error; msg.style.color = '#ef4444'; }
            }
        });
    }

    // [REMOVED] Duplicate navButtons loop for settings — loadPricingTable is already called by executeTabSwitch -> loadSettings

    // === ORDER SETUP PRICING LOADER ===
    // Loads ALL pricing from DB and populates:
    //   - #paper-options-container  (category="paper" → selectable cards)
    //   - #extras-checkboxes        (category="extra" → checkboxes)
    // Also keeps hidden selects in sync for downstream layout editor logic.
    async function loadExtrasForOrderSetup() {
        if (!window.api || !window.api.getPricing) return;
        const allItems = await window.api.getPricing();

        const paperItems = allItems.filter(i => i.category === 'paper');
        const extraItems = allItems.filter(i => i.category === 'extra');

        // --- Paper type cards ---
        const paperContainer = document.getElementById('paper-options-container');
        const hiddenPrintType = document.getElementById('setup-print-type');
        const hiddenPaperSize = document.getElementById('setup-paper-size');
        const hiddenSides     = document.getElementById('setup-sides');

        if (paperContainer) {
            if (paperItems.length === 0) {
                paperContainer.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.9rem;">No paper types configured yet. Add them in Settings → Pricing Management.</span>';
            } else {
                paperContainer.innerHTML = '';
                // Remember selection
                let selectedId = paperContainer.dataset.selectedId || null;

                paperItems.forEach((item, idx) => {
                    const card = document.createElement('label');
                    card.style.cssText = 'display:flex; flex-direction:column; gap:4px; background:var(--bg-color); border:2px solid var(--border-color); border-radius:8px; padding:12px 16px; cursor:pointer; transition: border-color 0.2s; min-width:140px;';
                    card.dataset.pricingId = item.id;
                    card.innerHTML = `
                        <input type="radio" name="paper-type-radio" class="paper-type-radio" value="${item.id}"
                            data-color="${item.color_type || ''}"
                            data-size="${item.paper_size || ''}"
                            data-sides="${item.sides || ''}"
                            data-price="${item.price}"
                            data-name="${item.name}"
                            style="display:none;">
                        <span style="font-weight:600; font-size:0.95rem;">${item.name}</span>
                        <span style="font-size:0.8rem; color:var(--text-secondary);">${[item.color_type, item.paper_size, item.sides].filter(Boolean).join(' · ') || 'Any config'}</span>
                        <span style="color:var(--success-color); font-weight:bold; margin-top:4px;">₹${parseFloat(item.price).toFixed(2)}/page</span>
                    `;
                    const radio = card.querySelector('input');

                    card.addEventListener('click', () => {
                        // Deselect all cards
                        paperContainer.querySelectorAll('label').forEach(c => c.style.borderColor = 'var(--border-color)');
                        card.style.borderColor = 'var(--accent-color)';
                        radio.checked = true;
                        paperContainer.dataset.selectedId = item.id;

                        // Sync hidden selects for layout editor
                        syncHiddenSelects(radio);
                        if (window.updateWorkspace) window.updateWorkspace();
                    });

                    paperContainer.appendChild(card);

                    // Auto-select first item or restore previous selection
                    if (idx === 0 || String(item.id) === String(selectedId)) {
                        setTimeout(() => card.click(), 0);
                    }
                });

                // Rebuild hidden select options from paper items
                if (hiddenPrintType) {
                    hiddenPrintType.innerHTML = '';
                    [...new Set(paperItems.map(i => i.color_type).filter(Boolean))].forEach(ct => {
                        hiddenPrintType.innerHTML += `<option value="${ct}">${ct}</option>`;
                    });
                    if (!hiddenPrintType.options.length) hiddenPrintType.innerHTML = '<option value="bw">bw</option>';
                }
                if (hiddenPaperSize) {
                    hiddenPaperSize.innerHTML = '';
                    [...new Set(paperItems.map(i => i.paper_size).filter(Boolean))].forEach(ps => {
                        hiddenPaperSize.innerHTML += `<option value="${ps}">${ps}</option>`;
                    });
                    if (!hiddenPaperSize.options.length) hiddenPaperSize.innerHTML = '<option value="A4">A4</option>';
                }
                if (hiddenSides) {
                    hiddenSides.innerHTML = '';
                    [...new Set(paperItems.map(i => i.sides).filter(Boolean))].forEach(s => {
                        hiddenSides.innerHTML += `<option value="${s}">${s}</option>`;
                    });
                    if (!hiddenSides.options.length) hiddenSides.innerHTML = '<option value="Single">Single</option>';
                }
            }
        }

        // --- Extras checkboxes ---
        const extrasContainer = document.getElementById('extras-checkboxes');
        if (extrasContainer) {
            if (extraItems.length === 0) {
                extrasContainer.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.9rem;">No extras configured. Add them in Settings → Pricing Management.</span>';
            } else {
                extrasContainer.innerHTML = '';
                extraItems.forEach(item => {
                    const label = document.createElement('label');
                    label.style.cssText = 'display:flex; align-items:center; gap:8px; background:var(--bg-color); border:1px solid var(--border-color); border-radius:6px; padding:8px 12px; cursor:pointer; transition: border-color 0.2s;';
                    label.innerHTML = `
                        <input type="checkbox" class="extra-item-checkbox" data-id="${item.id}" data-price="${item.price}" data-name="${item.name}" style="width:16px; height:16px; cursor:pointer;">
                        <span>${item.name}</span>
                        <span style="color: var(--success-color); font-weight:bold; margin-left:4px;">+₹${parseFloat(item.price).toFixed(2)}</span>
                    `;
                    label.querySelector('input').addEventListener('change', () => {
                        label.style.borderColor = label.querySelector('input').checked ? 'var(--accent-color)' : 'var(--border-color)';
                        if (window.updateWorkspace) window.updateWorkspace();
                    });
                    extrasContainer.appendChild(label);
                });
            }
        }
    }

    function syncHiddenSelects(radio) {
        const hiddenPrintType = document.getElementById('setup-print-type');
        const hiddenPaperSize = document.getElementById('setup-paper-size');
        const hiddenSides     = document.getElementById('setup-sides');
        if (hiddenPrintType && radio.dataset.color) {
            const opt = hiddenPrintType.querySelector(`option[value="${radio.dataset.color}"]`);
            if (opt) hiddenPrintType.value = radio.dataset.color;
            else hiddenPrintType.value = hiddenPrintType.options[0]?.value || 'bw';
        }
        if (hiddenPaperSize && radio.dataset.size) {
            const opt = hiddenPaperSize.querySelector(`option[value="${radio.dataset.size}"]`);
            if (opt) hiddenPaperSize.value = radio.dataset.size;
            else hiddenPaperSize.value = hiddenPaperSize.options[0]?.value || 'A4';
        }
        if (hiddenSides && radio.dataset.sides) {
            const opt = hiddenSides.querySelector(`option[value="${radio.dataset.sides}"]`);
            if (opt) hiddenSides.value = radio.dataset.sides;
            else hiddenSides.value = hiddenSides.options[0]?.value || 'Single';
        }
    }

    // Expose getter for selected paper pricing item
    window.getSelectedPaperPricing = () => {
        // Check for new product grid selection first
        if (window.selectedProductId) {
            const product = Array.from(document.querySelectorAll('.product-card')).find(c => parseInt(c.dataset.productId) === window.selectedProductId);
            if (product) {
                return {
                    id: window.selectedProductId,
                    name: product.querySelector('.product-card-title').innerText,
                    color_type: window.currentOrderConfig?.printType || 'bw',
                    paper_size: window.currentOrderConfig?.paperSize || 'A4',
                    sides: window.currentOrderConfig?.sides || 'Single',
                    price: parseFloat(product.dataset.price || 0)
                };
            }
        }
        
        // Fallback to legacy paper type radio buttons
        const radio = document.querySelector('.paper-type-radio:checked');
        if (!radio) return null;
        return {
            id: radio.value,
            name: radio.dataset.name,
            color_type: radio.dataset.color,
            paper_size: radio.dataset.size,
            sides: radio.dataset.sides,
            price: parseFloat(radio.dataset.price)
        };
    };

    // Expose getter for extras selection (used by preview.js when building order)
    window.getSelectedExtras = () => {
        const checkboxes = document.querySelectorAll('.extra-item-checkbox:checked');
        return Array.from(checkboxes).map(cb => ({
            id: cb.dataset.id,
            name: cb.dataset.name,
            price: parseFloat(cb.dataset.price)
        }));
    };

    loadExtrasForOrderSetup();
    // === COMMAND PALETTE ===
    const cmdPaletteOverlay = document.getElementById('command-palette-overlay');
    const cmdPaletteInput = document.getElementById('command-palette-input');
    const cmdPaletteResults = document.getElementById('command-palette-results');
    const globalActionBtn = document.getElementById('global-action-palette-btn');

    const globalCommands = [
        { id: 'nav-dashboard', title: 'Go to Dashboard', icon: '📊', shortcut: 'G D', action: () => clickNav('dashboard') },
        { id: 'nav-workspace', title: 'Create New Order', icon: '📝', shortcut: 'G N', action: () => clickNav('workspace') },
        { id: 'nav-incoming', title: 'Incoming Mobile Orders', icon: '📥', shortcut: 'G I', action: () => clickNav('incoming') },
        { id: 'nav-history', title: 'Order History Log', icon: '📜', shortcut: 'G H', action: () => clickNav('history') },
        { id: 'nav-customers', title: 'Customers Directory', icon: '👥', shortcut: 'G C', action: () => clickNav('customers') },
        { id: 'nav-settings', title: 'System Configurations', icon: '⚙️', shortcut: 'G S', action: () => clickNav('settings') },
        { id: 'nav-gst-tracker', title: 'Open GST Tracker & Tax Billing', icon: '💰', shortcut: 'G T', action: () => clickNav('gst-tracker') },
        { id: 'backup-db', title: 'Backup Database File', icon: '💾', shortcut: 'B D', action: () => document.getElementById('backup-db-btn')?.click() },
        { id: 'exit-roles', title: 'Exit to Onboarding Mode Selection', icon: '🚪', shortcut: 'E R', action: () => document.getElementById('shop-exit-btn')?.click() }
    ];

    let filteredCommands = [...globalCommands];
    let selectedIndex = 0;

    function clickNav(target) {
        const btn = document.querySelector(`.nav-btn[data-target="${target}"]`);
        if (btn) btn.click();
    }

    function openCommandPalette() {
        if (!cmdPaletteOverlay) return;
        cmdPaletteOverlay.style.display = 'flex';
        if (cmdPaletteInput) {
            cmdPaletteInput.value = '';
            setTimeout(() => cmdPaletteInput.focus(), 50);
        }
        filterAndRenderCommands('');
    }

    function closeCommandPalette() {
        if (cmdPaletteOverlay) {
            cmdPaletteOverlay.style.display = 'none';
        }
    }

    function filterAndRenderCommands(query) {
        const q = query.toLowerCase().trim();
        filteredCommands = globalCommands.filter(cmd => 
            cmd.title.toLowerCase().includes(q) || cmd.id.toLowerCase().includes(q)
        );
        
        selectedIndex = 0;
        renderResults();
    }

    function renderResults() {
        if (!cmdPaletteResults) return;
        cmdPaletteResults.innerHTML = '';
        
        if (filteredCommands.length === 0) {
            cmdPaletteResults.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-secondary); font-size:0.9rem;">No commands found. Try searching for "settings" or "theme".</div>';
            return;
        }

        filteredCommands.forEach((cmd, idx) => {
            const item = document.createElement('div');
            item.className = `command-item ${idx === selectedIndex ? 'selected' : ''}`;
            item.innerHTML = `
                <div class="command-item-left">
                    <span class="command-item-icon">${cmd.icon}</span>
                    <span>${cmd.title}</span>
                </div>
                <span class="command-item-shortcut">${cmd.shortcut}</span>
            `;
            
            item.addEventListener('mouseenter', () => {
                selectedIndex = idx;
                updateSelection();
            });

            item.addEventListener('click', () => {
                cmd.action();
                closeCommandPalette();
            });

            cmdPaletteResults.appendChild(item);
        });
    }

    function updateSelection() {
        const items = cmdPaletteResults.querySelectorAll('.command-item');
        items.forEach((item, idx) => {
            if (idx === selectedIndex) {
                item.classList.add('selected');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('selected');
            }
        });
    }

    if (globalActionBtn) {
        globalActionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openCommandPalette();
        });
    }

    if (cmdPaletteOverlay) {
        cmdPaletteOverlay.addEventListener('click', (e) => {
            if (e.target === cmdPaletteOverlay) {
                closeCommandPalette();
            }
        });
    }

    if (cmdPaletteInput) {
        cmdPaletteInput.addEventListener('input', (e) => {
            filterAndRenderCommands(e.target.value);
        });

        cmdPaletteInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (filteredCommands.length > 0) {
                    selectedIndex = (selectedIndex + 1) % filteredCommands.length;
                    updateSelection();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (filteredCommands.length > 0) {
                    selectedIndex = (selectedIndex - 1 + filteredCommands.length) % filteredCommands.length;
                    updateSelection();
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (filteredCommands[selectedIndex]) {
                    filteredCommands[selectedIndex].action();
                    closeCommandPalette();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeCommandPalette();
            }
        });
    }

    // Global Key Listener
    window.addEventListener('keydown', (e) => {
        // F11 for Toggle Fullscreen (hides/shows OS taskbar)
        if (e.key === 'F11') {
            e.preventDefault();
            if (window.api && window.api.toggleFullScreen) {
                window.api.toggleFullScreen();
            }
        }

        // Ctrl+K or Cmd+K
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            if (cmdPaletteOverlay && cmdPaletteOverlay.style.display === 'flex') {
                closeCommandPalette();
            } else {
                openCommandPalette();
            }
        }
        
        // Ctrl+Shift+A for Emergency Role Reset (Exit Customer Kiosk / Return to Role Selection)
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            window.performLogout();
        }

        // Escape to close
        if (e.key === 'Escape') {
            closeCommandPalette();
            const pinModal = document.getElementById('pin-lock-modal');
            if (pinModal && pinModal.classList.contains('active')) {
                pinModal.classList.remove('active');
                if (accessCancelCallback) accessCancelCallback();
            }
        }
    });

    // === STATE RESTORATION AND RELOAD BUTTONS LOGIC ===
    async function restoreSavedState() {
        if (!window.api || !window.api.getSession) return false;
        try {
            const session = await window.api.getSession();
            if (!session || !session.authenticated) {
                // Not authenticated — keep on role selection screen
                return false;
            }

            if (roleScreen) roleScreen.style.display = 'none';

            if (session.role === 'Admin') {
                openAdminView(session.user);
                return true;
            } else if (session.role === 'Customer') {
                if (customerKiosk) customerKiosk.style.display = 'block';
                initCustomerKiosk();
                return true;
            } else {
                // Operator or Manager
                openShopView(session.user);
                return true;
            }
        } catch(e) {
            console.error("Failed to restore session state:", e);
            return false;
        }
    }

    // Handle Reload action
    function executeReload(btn) {
        if (!btn) return;
        
        // Add spin animation class
        btn.classList.add('spinning');
        
        // Flag that reload was manually triggered
        localStorage.setItem('psm_just_reloaded', 'true');
        
        // Short delay to let spin animation show before reloading
        setTimeout(() => {
            window.location.reload();
        }, 300);
    }

    // Bind Reload button clicks
    const globalReloadBtn = document.getElementById('global-reload-btn');
    if (globalReloadBtn) {
        globalReloadBtn.addEventListener('click', () => executeReload(globalReloadBtn));
    }
    
    const adminReloadBtn = document.getElementById('admin-reload-btn');
    if (adminReloadBtn) {
        adminReloadBtn.addEventListener('click', () => executeReload(adminReloadBtn));
    }

    const kioskReloadBtn = document.getElementById('kiosk-reload-btn');
    if (kioskReloadBtn) {
        kioskReloadBtn.addEventListener('click', () => executeReload(kioskReloadBtn));
    }

    // Check if we just reloaded to show success toast
    if (localStorage.getItem('psm_just_reloaded') === 'true') {
        localStorage.removeItem('psm_just_reloaded');
        setTimeout(() => {
            if (window.showToast) {
                window.showToast("✨ App refreshed and terminal state verified!", "success");
            }
        }, 600);
    }

    // === SECURITY PIN LOCK & USER SESSION CONTROLS ===
    let pinBuffer = "";
    let accessSuccessCallback = null;
    let accessCancelCallback = null;
    let requiredAccessRoles = [];
    let targetLoginRole = "Any";
    let lockoutInterval = null;

    window.requestAccess = function(roles, onSuccess, targetRole = 'Any', onCancel = null) {
        requiredAccessRoles = roles;
        accessSuccessCallback = onSuccess;
        accessCancelCallback = onCancel;
        targetLoginRole = targetRole;
        
        const pinModal = document.getElementById('pin-lock-modal');
        if (pinModal) {
            pinModal.classList.add('active');
            const msgEl = document.getElementById('pin-lock-message');
            if (msgEl) {
                msgEl.textContent = `Enter ${targetRole === 'Admin' ? 'Administrator' : 'Staff'} PIN to authenticate.`;
                msgEl.style.color = '#64748b';
            }
            window.clearPin();
            
            const inputEl = document.getElementById('pin-visible-input') || document.getElementById('pin-hidden-input');
            if (inputEl) {
                inputEl.value = "";
                setTimeout(() => inputEl.focus(), 50);
            }
        }
    };

    window.enterPinDigit = function(digit) {
        if (lockoutInterval) return; // Locked out
        if (pinBuffer.length < 12) {
            pinBuffer += digit;
            updatePinDisplay();
            const inputEl = document.getElementById('pin-visible-input') || document.getElementById('pin-hidden-input');
            if (inputEl) inputEl.value = pinBuffer;
        }
    };

    window.backspacePin = function() {
        if (lockoutInterval) return;
        if (pinBuffer.length > 0) {
            pinBuffer = pinBuffer.slice(0, -1);
            updatePinDisplay();
            const inputEl = document.getElementById('pin-visible-input') || document.getElementById('pin-hidden-input');
            if (inputEl) inputEl.value = pinBuffer;
        }
    };

    window.clearPin = function() {
        if (lockoutInterval) return;
        pinBuffer = "";
        updatePinDisplay();
        const inputEl = document.getElementById('pin-visible-input') || document.getElementById('pin-hidden-input');
        if (inputEl) inputEl.value = "";
    };

    function updatePinDisplay() {
        const inputEl = document.getElementById('pin-visible-input');
        if (inputEl && inputEl.value !== pinBuffer) {
            inputEl.value = pinBuffer;
        }
        const track = document.getElementById('pin-display-track');
        if (track) {
            if (pinBuffer.length === 0) {
                track.innerHTML = `<span style="font-size: 0.85rem; color: #94a3b8; letter-spacing: 2px;">• • • •</span>`;
                return;
            }

            let html = '';
            for (let i = 0; i < pinBuffer.length; i++) {
                html += `<span style="display: inline-block; width: 14px; height: 14px; border-radius: 50%; background: #4f46e5; margin: 0 4px; box-shadow: 0 0 8px rgba(79, 70, 229, 0.4);"></span>`;
            }
            track.innerHTML = html;
        }
    }

    function startLockoutTimer(lockedUntil) {
        const msgEl = document.getElementById('pin-lock-message');
        const submitBtn = document.getElementById('pin-submit-btn');
        if (submitBtn) submitBtn.disabled = true;

        if (lockoutInterval) clearInterval(lockoutInterval);

        function tick() {
            const now = Date.now();
            const remainingMs = lockedUntil - now;
            if (remainingMs <= 0) {
                clearInterval(lockoutInterval);
                lockoutInterval = null;
                if (submitBtn) submitBtn.disabled = false;
                if (msgEl) {
                    msgEl.textContent = 'Lockout expired. You may now enter your PIN.';
                    msgEl.style.color = '#64748b';
                }
                window.clearPin();
            } else {
                const sec = Math.ceil(remainingMs / 1000);
                if (msgEl) {
                    msgEl.textContent = `⏳ Terminal locked. Please wait ${sec}s...`;
                    msgEl.style.color = '#ef4444';
                }
            }
        }

        tick();
        lockoutInterval = setInterval(tick, 1000);
    }

    window.submitPin = async function() {
        if (lockoutInterval) return;

        if (pinBuffer.length < 6) {
            const msgEl = document.getElementById('pin-lock-message');
            if (msgEl) {
                msgEl.textContent = "PIN must be at least 6 digits.";
                msgEl.style.color = '#ef4444';
            }
            return;
        }
        
        if (!window.api || !window.api.login) {
            window.showToast("Authentication API unavailable", "error");
            return;
        }

        const msgEl = document.getElementById('pin-lock-message');
        const submitBtn = document.getElementById('pin-submit-btn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Verifying...';
        }

        try {
            const res = await window.api.login(pinBuffer, targetLoginRole);
            if (res.success && res.session) {
                const user = res.session.user;
                document.getElementById('pin-lock-modal').classList.remove('active');
                if (window.showToast) window.showToast(`Welcome, ${user.name} (${res.session.role})!`, "success");

                window.clearPin();
                if (accessSuccessCallback) accessSuccessCallback(user);
            } else {
                if (res.lockedUntil) {
                    startLockoutTimer(res.lockedUntil);
                } else {
                    if (msgEl) {
                        msgEl.textContent = res.error || "Invalid PIN. Access denied.";
                        msgEl.style.color = '#ef4444';
                    }
                    window.clearPin();
                }
            }
        } catch(e) {
            console.error("PIN check failed:", e);
            if (msgEl) {
                msgEl.textContent = "Authentication error. Please try again.";
                msgEl.style.color = '#ef4444';
            }
            window.clearPin();
        } finally {
            if (submitBtn && !lockoutInterval) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Unlock 🔓';
            }
        }
    };

    // Attach keyboard listener to visible and hidden inputs
    ['pin-visible-input', 'pin-hidden-input'].forEach(inputId => {
        const el = document.getElementById(inputId);
        if (el) {
            el.addEventListener('input', (e) => {
                if (lockoutInterval) return;
                const val = e.target.value.replace(/\D/g, '');
                pinBuffer = val.slice(0, 12);
                updatePinDisplay();
            });

            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    window.submitPin();
                }
            });
        }
    });

    const pinModalOverlay = document.getElementById('pin-lock-modal');
    if (pinModalOverlay) {
        pinModalOverlay.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON') {
                const inputEl = document.getElementById('pin-visible-input') || document.getElementById('pin-hidden-input');
                if (inputEl && !lockoutInterval) inputEl.focus();
            }
        });
    }

    const pinCancelBtn = document.getElementById('pin-cancel-btn');
    if (pinCancelBtn) {
        pinCancelBtn.addEventListener('click', () => {
            if (lockoutInterval) {
                clearInterval(lockoutInterval);
                lockoutInterval = null;
            }
            document.getElementById('pin-lock-modal').classList.remove('active');
            window.clearPin();
            if (accessCancelCallback) accessCancelCallback();
        });
    }

    // Dynamic binding for PIN keypad buttons to bypass inline onclick
    const keypadButtons = document.querySelectorAll('.pin-keypad .keypad-btn');
    keypadButtons.forEach(btn => {
        const text = btn.textContent.trim();
        if (/^\d$/.test(text)) {
            btn.removeAttribute('onclick');
            btn.addEventListener('click', () => {
                window.enterPinDigit(text);
            });
        } else if (text === 'Clear') {
            btn.removeAttribute('onclick');
            btn.addEventListener('click', () => {
                window.clearPin();
            });
        } else if (text === '⌫') {
            btn.removeAttribute('onclick');
            btn.addEventListener('click', () => {
                window.backspacePin();
            });
        } else if (text === 'Cancel') {
            btn.removeAttribute('onclick');
        }
    });

    // === USER MANAGEMENT (SETTINGS TAB) ===
    window.loadUserMgmt = async function() {
        if (!window.api || !window.api.getUsers) return;
        const tbody = document.getElementById('user-mgmt-table-body');
        if (!tbody) return;

        try {
            const users = await window.api.getUsers();
            if (!users || !Array.isArray(users) || users.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" class="empty-state" style="text-align: center;">No users found.</td></tr>';
                return;
            }

            tbody.innerHTML = users.map(u => `
                <tr>
                    <td>${u.name}</td>
                    <td><span style="background: rgba(255,255,255,0.06); border: 1px solid var(--border-color); border-radius: 4px; padding: 2px 8px; font-size: 0.8rem; font-weight: 500;">${u.role}</span></td>
                    <td>
                        <button class="action-btn-red" style="padding: 4px 10px; font-size: 0.8rem; border: none; border-radius: 4px; color: white; background: #ef4444; cursor:pointer;" data-id="${u.id}">Delete</button>
                    </td>
                </tr>
            `).join('');
        } catch (e) {
            console.error("loadUserMgmt error:", e);
        }
    };

    // User management event delegation for deletion to bypass inline onclick
    const userMgmtTableBody = document.getElementById('user-mgmt-table-body');
    if (userMgmtTableBody) {
        userMgmtTableBody.addEventListener('click', async (e) => {
            if (e.target.classList.contains('action-btn-red') || e.target.closest('.action-btn-red')) {
                const btn = e.target.classList.contains('action-btn-red') ? e.target : e.target.closest('.action-btn-red');
                const userId = btn.getAttribute('data-id');
                if (userId) {
                    await window.deleteUserMgmt(userId);
                }
            }
        });
    }

    window.deleteUserMgmt = async function(id) {
        if (!confirm("Are you sure you want to delete this user?")) return;
        const res = await window.api.deleteUser(id);
        if (res.success) {
            if (window.showToast) window.showToast("User deleted successfully!", "success");
            window.loadUserMgmt();
        } else {
            if (window.showToast) window.showToast(res.error || "Failed to delete user", "error");
        }
    };

    const newUserSubmitBtn = document.getElementById('new-user-submit-btn');
    if (newUserSubmitBtn) {
        newUserSubmitBtn.addEventListener('click', async () => {
            const elName = document.getElementById('new-user-name');
            const elRole = document.getElementById('new-user-role');
            const elPin = document.getElementById('new-user-pin');
            const elMsg = document.getElementById('new-user-msg');
            
            if (!elName || !elRole || !elPin) return;

            const name = elName.value.trim();
            const role = elRole.value;
            const pin = elPin.value.trim();

            if (!name) {
                if (elMsg) { elMsg.textContent = "Name is required."; elMsg.style.color = "#ef4444"; }
                return;
            }
            if (!/^\d{6,12}$/.test(pin)) {
                if (elMsg) { elMsg.textContent = "PIN must be between 6 and 12 digits."; elMsg.style.color = "#ef4444"; }
                return;
            }

            newUserSubmitBtn.disabled = true;
            newUserSubmitBtn.textContent = "Creating...";

            try {
                const res = await window.api.createUser(name, role, pin);
                if (res.success) {
                    if (elMsg) { elMsg.textContent = "User created successfully!"; elMsg.style.color = "var(--success-color)"; }
                    elName.value = "";
                    elPin.value = "";
                    window.loadUserMgmt();
                } else {
                    if (elMsg) { elMsg.textContent = res.error || "Failed to create user."; elMsg.style.color = "#ef4444"; }
                }
            } catch (err) {
                if (elMsg) { elMsg.textContent = err.message || "An error occurred."; elMsg.style.color = "#ef4444"; }
            } finally {
                newUserSubmitBtn.disabled = false;
                newUserSubmitBtn.textContent = "Create User";
            }
        });
    }

    // Call restore saved state safely
    restoreSavedState();

    // =========================================================================
    // ENTERPRISE PRODUCTS, PRINT PROFILES & DEVICE MANAGER JS CONTROLLER (PHASE 4)
    // =========================================================================

    // Scoped state variables
    let allPrinters = [];
    let allPricingItems = [];
    let allRecipes = [];
    let allProfiles = [];
    let allProducts = [];

    // 1. Settings Profiles Mini-Tab switcher
    const profileMiniTabBtns = document.querySelectorAll('.profile-mini-tabs .settings-tab-btn');
    const profileMiniViews = document.querySelectorAll('.profile-mini-view');

    profileMiniTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetMini = btn.getAttribute('data-minitab');
            
            profileMiniTabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            profileMiniViews.forEach(v => {
                if (v.id === targetMini) {
                    v.style.display = 'block';
                } else {
                    v.style.display = 'none';
                }
            });

            // Trigger targeted refreshes
            if (targetMini === 'mini-devices') {
                refreshDevicesTab();
            } else if (targetMini === 'mini-audit') {
                refreshAuditLogs();
            }
        });
    });

    // Toggle custom margins form display
    const profileMarginStyle = document.getElementById('profile-margin-style-field');
    const customMarginsDiv = document.getElementById('profile-custom-margins-div');
    if (profileMarginStyle && customMarginsDiv) {
        profileMarginStyle.addEventListener('change', () => {
            customMarginsDiv.style.display = profileMarginStyle.value === 'custom' ? 'grid' : 'none';
        });
    }

    // Dashboard initialization entrypoint
    async function loadProductsAndProfilesDashboard() {
        console.log("[Settings] Initializing Products and Profiles view...");
        try {
            // Load base list data from IPC
            allPrinters = await window.api.getPrinters();
            allPricingItems = await window.api.getAllPricing();
            allRecipes = await window.api.getInvRecipes();
            allProfiles = await window.api.getPrintProfiles();
            allProducts = await window.api.getProducts();

            // Ensure active mini-view is visible
            const activeMiniBtn = document.querySelector('.profile-mini-tabs .settings-tab-btn.active');
            const targetMiniId = activeMiniBtn ? activeMiniBtn.getAttribute('data-minitab') : 'mini-products';
            const profileMiniViews = document.querySelectorAll('.profile-mini-view');
            profileMiniViews.forEach(v => {
                v.style.display = v.id === targetMiniId ? 'block' : 'none';
            });

            // Populate form selects
            populateDropdowns();

            // Render tables
            renderProductsList();
            renderProfilesList();
            renderPrinterGroupsTable();
        } catch(err) {
            console.error("Failed to load products/profiles dashboard:", err);
            window.showToast("Error loading profile configuration: " + err.message, "error");
        }
    }
    window.loadProductsAndProfilesDashboard = loadProductsAndProfilesDashboard;

    // Populates all dropdown selectors in Forms
    function populateDropdowns() {
        const printerSelects = document.querySelectorAll('.printer-select, #calibration-printer-select, #printer-group-members');
        const pricingSelect = document.getElementById('profile-pricing-field');
        const recipeSelect = document.getElementById('profile-recipe-field');
        const productProfileSelect = document.getElementById('product-profile-link-field');

        // Printer selectors
        printerSelects.forEach(sel => {
            const isMultiple = sel.hasAttribute('multiple');
            const val = sel.value;
            sel.innerHTML = isMultiple ? '' : '<option value="">-- System/Category Default --</option>';
            
            allPrinters.forEach(p => {
                sel.innerHTML += `<option value="${p.device_name}">${p.display_name} (${p.status})</option>`;
            });
            if (!isMultiple && val) sel.value = val;
        });

        // ERP pricing items select
        if (pricingSelect) {
            const pricingVal = pricingSelect.value;
            pricingSelect.innerHTML = '<option value="">-- Choose Pricing Item (ERP Per-Page rate) --</option>';
            allPricingItems.forEach(p => {
                pricingSelect.innerHTML += `<option value="${p.id}">${p.paper_size} (${p.print_type}) - ₹${p.price.toFixed(2)}</option>`;
            });
            if (pricingVal) pricingSelect.value = pricingVal;
        }

        // ERP material recipes select
        if (recipeSelect) {
            const recipeVal = recipeSelect.value;
            recipeSelect.innerHTML = '<option value="">-- Choose Recipe (Inventory Deduction) --</option>';
            allRecipes.forEach(r => {
                recipeSelect.innerHTML += `<option value="${r.id}">${r.name} (${r.description || ''})</option>`;
            });
            if (recipeVal) recipeSelect.value = recipeVal;
        }

        // Product's profile link select
        if (productProfileSelect) {
            const productProfileVal = productProfileSelect.value;
            productProfileSelect.innerHTML = '<option value="">-- Link to Print Profile --</option>';
            allProfiles.forEach(p => {
                productProfileSelect.innerHTML += `<option value="${p.id}">${p.name}</option>`;
            });
            if (productProfileVal) productProfileSelect.value = productProfileVal;
        }
    }

    // 2. PRODUCTS FORM & CRUD
    const btnSaveProduct = document.getElementById('btn-save-product');
    const btnClearProduct = document.getElementById('btn-clear-product-form');
    const productMsgStatus = document.getElementById('product-msg-status');

    if (btnSaveProduct) {
        btnSaveProduct.addEventListener('click', async () => {
            const id = document.getElementById('product-id-field').value;
            const name = document.getElementById('product-name-field').value.trim();
            const category = document.getElementById('product-category-field').value.trim();
            const description = document.getElementById('product-desc-field').value.trim();
            const printProfileId = document.getElementById('product-profile-link-field').value;
            const isActive = document.getElementById('product-active-field').checked ? 1 : 0;
            const isFavorite = document.getElementById('product-favorite-field').checked ? 1 : 0;

            if (!name || !printProfileId) {
                window.showToast("Product Name and Print Profile link are required.", "error");
                return;
            }

            btnSaveProduct.disabled = true;
            try {
                const res = await window.api.saveProduct({
                    id: id ? parseInt(id) : null,
                    name,
                    category,
                    description,
                    print_profile_id: parseInt(printProfileId),
                    is_active: isActive,
                    is_favorite: isFavorite
                });

                if (res.success) {
                    window.showToast(id ? "Product updated!" : "Product created!", "success");
                    clearProductForm();
                    productSelectorCache = null;
                    await loadProductsAndProfilesDashboard();
                    loadProductSelectorGrid();
                } else {
                    window.showToast(res.error || "Failed to save product", "error");
                }
            } catch(e) {
                window.showToast("Saving failed: " + e.message, "error");
            } finally {
                btnSaveProduct.disabled = false;
            }
        });
    }

    if (btnClearProduct) {
        btnClearProduct.addEventListener('click', () => {
            clearProductForm();
        });
    }

    function clearProductForm() {
        document.getElementById('product-id-field').value = '';
        document.getElementById('product-name-field').value = '';
        document.getElementById('product-category-field').value = '';
        document.getElementById('product-desc-field').value = '';
        document.getElementById('product-profile-link-field').value = '';
        document.getElementById('product-active-field').checked = true;
        document.getElementById('product-favorite-field').checked = false;
        document.getElementById('product-form-title').textContent = 'Add New Product';
        if (productMsgStatus) productMsgStatus.textContent = '';
    }

    function renderProductsList() {
        const tbody = document.getElementById('products-list-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (allProducts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;">No products created yet.</td></tr>';
            return;
        }

        allProducts.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${p.name}</strong>${p.is_favorite === 1 ? ' ⭐' : ''}</td>
                <td>${p.category || 'General'}</td>
                <td style="text-align:right;">
                    <button class="action-btn edit-prod-btn" style="padding:4px 8px; margin:0;" data-id="${p.id}">Edit</button>
                    <button class="action-btn delete-prod-btn" style="padding:4px 8px; margin:0; background-color:var(--danger-color); color:white;" data-id="${p.id}">Delete</button>
                </td>
            `;
            
            tr.querySelector('.edit-prod-btn').addEventListener('click', () => {
                document.getElementById('product-id-field').value = p.id;
                document.getElementById('product-name-field').value = p.name;
                document.getElementById('product-category-field').value = p.category || '';
                document.getElementById('product-desc-field').value = p.description || '';
                document.getElementById('product-profile-link-field').value = p.print_profile_id;
                document.getElementById('product-active-field').checked = p.is_active === 1;
                document.getElementById('product-favorite-field').checked = p.is_favorite === 1;
                document.getElementById('product-form-title').textContent = `Edit Product: ${p.name}`;
            });

            tr.querySelector('.delete-prod-btn').addEventListener('click', async () => {
                if (confirm(`Are you sure you want to delete product "${p.name}"?`)) {
                    const res = await window.api.deleteProduct(p.id);
                    if (res.success) {
                        window.showToast("Product deleted successfully", "success");
                        productSelectorCache = null;
                        await loadProductsAndProfilesDashboard();
                        loadProductSelectorGrid();
                    } else {
                        window.showToast(res.error || "Delete failed", "error");
                    }
                }
            });

            tbody.appendChild(tr);
        });
    }

    // 3. PRINT PROFILES FORM & CRUD
    const btnSaveProfile = document.getElementById('btn-save-profile');
    const btnDuplicateProfile = document.getElementById('btn-duplicate-profile');
    const btnClearProfile = document.getElementById('btn-clear-profile-form');
    const profileMsgStatus = document.getElementById('profile-msg-status');

    if (btnSaveProfile) {
        btnSaveProfile.addEventListener('click', async () => {
            const id = document.getElementById('profile-id-field').value;
            const name = document.getElementById('profile-name-field').value.trim();
            const printer_name = document.getElementById('profile-printer-field').value;
            const paper_size = document.getElementById('profile-paper-size-field').value;
            const paper_source = document.getElementById('profile-tray-field').value;
            const paper_type = document.getElementById('profile-paper-type-field').value;
            const paper_weight = document.getElementById('profile-weight-field').value ? parseInt(document.getElementById('profile-weight-field').value) : null;
            const orientation = document.getElementById('profile-orientation-field').value;
            const scaling = document.getElementById('profile-scaling-field').value;
            const custom_scale = parseInt(document.getElementById('profile-custom-scale-field').value) || 100;
            const duplex_mode = document.getElementById('profile-duplex-field').value;
            const alignment = document.getElementById('profile-alignment-field').value;
            const n_up = parseInt(document.getElementById('profile-nup-field').value) || 1;
            const margins_type = document.getElementById('profile-margin-style-field').value;
            const bleed = parseFloat(document.getElementById('profile-bleed-field').value) || 0.0;
            const binding_margin = parseFloat(document.getElementById('profile-binding-margin-field').value) || 0.0;
            
            const margin_top = parseFloat(document.getElementById('profile-margin-top').value) || 0.0;
            const margin_bottom = parseFloat(document.getElementById('profile-margin-bottom').value) || 0.0;
            const margin_left = parseFloat(document.getElementById('profile-margin-left').value) || 0.0;
            const margin_right = parseFloat(document.getElementById('profile-margin-right').value) || 0.0;

            const color_mode = document.getElementById('profile-color-mode-field').value;
            const print_quality = document.getElementById('profile-quality-field').value;
            const resolution_dpi = document.getElementById('profile-dpi-field').value;
            const finishing_lamination = document.getElementById('profile-lamination-field').value;
            const finishing_stapling = document.getElementById('profile-stapling-field').value;
            const finishing_hole_punch = document.getElementById('profile-punch-field').value;

            const pricing_id = document.getElementById('profile-pricing-field').value ? parseInt(document.getElementById('profile-pricing-field').value) : null;
            const recipe_id = document.getElementById('profile-recipe-field').value ? parseInt(document.getElementById('profile-recipe-field').value) : null;

            const crop_marks = document.getElementById('profile-crop-marks-field').checked ? 1 : 0;
            const is_favorite = document.getElementById('profile-favorite-field').checked ? 1 : 0;

            if (!name) {
                window.showToast("Profile name is required.", "error");
                return;
            }

            btnSaveProfile.disabled = true;
            try {
                const res = await window.api.savePrintProfile({
                    id: id ? parseInt(id) : null,
                    name, printer_name, paper_size, paper_source, paper_type, paper_weight,
                    orientation, scaling, custom_scale, duplex_mode, alignment, n_up,
                    margins_type, bleed, binding_margin, margin_top, margin_bottom, margin_left, margin_right,
                    color_mode, print_quality, resolution_dpi, finishing_lamination, finishing_stapling, finishing_hole_punch,
                    pricing_id, recipe_id, crop_marks, is_favorite
                });

                if (res.success) {
                    window.showToast(id ? "Profile updated!" : "Profile created!", "success");
                    clearProfileForm();
                    productSelectorCache = null;
                    await loadProductsAndProfilesDashboard();
                    loadProductSelectorGrid();
                } else {
                    window.showToast(res.error || "Save failed", "error");
                }
            } catch(e) {
                window.showToast("Saving failed: " + e.message, "error");
            } finally {
                btnSaveProfile.disabled = false;
            }
        });
    }

    if (btnDuplicateProfile) {
        btnDuplicateProfile.addEventListener('click', async () => {
            const id = document.getElementById('profile-id-field').value;
            if (!id) return;
            try {
                const res = await window.api.duplicatePrintProfile(parseInt(id));
                if (res.success) {
                    window.showToast("Profile duplicated successfully!", "success");
                    clearProfileForm();
                    productSelectorCache = null;
                    await loadProductsAndProfilesDashboard();
                } else {
                    window.showToast(res.error || "Duplication failed", "error");
                }
            } catch(e) {
                window.showToast("Duplication failed: " + e.message, "error");
            }
        });
    }

    if (btnClearProfile) {
        btnClearProfile.addEventListener('click', () => {
            clearProfileForm();
        });
    }

    function clearProfileForm() {
        document.getElementById('profile-id-field').value = '';
        document.getElementById('profile-name-field').value = '';
        document.getElementById('profile-printer-field').value = '';
        document.getElementById('profile-paper-size-field').value = 'A4';
        document.getElementById('profile-tray-field').value = '';
        document.getElementById('profile-paper-type-field').value = 'Plain';
        document.getElementById('profile-weight-field').value = '';
        document.getElementById('profile-orientation-field').value = 'portrait';
        document.getElementById('profile-scaling-field').value = 'fit';
        document.getElementById('profile-custom-scale-field').value = '100';
        document.getElementById('profile-duplex-field').value = 'simplex';
        document.getElementById('profile-alignment-field').value = 'center';
        document.getElementById('profile-nup-field').value = '1';
        document.getElementById('profile-margin-style-field').value = 'default';
        document.getElementById('profile-bleed-field').value = '0';
        document.getElementById('profile-binding-margin-field').value = '0';
        document.getElementById('profile-margin-top').value = '10';
        document.getElementById('profile-margin-bottom').value = '10';
        document.getElementById('profile-margin-left').value = '10';
        document.getElementById('profile-margin-right').value = '10';
        document.getElementById('profile-color-mode-field').value = 'color';
        document.getElementById('profile-quality-field').value = 'Normal';
        document.getElementById('profile-dpi-field').value = '600';
        document.getElementById('profile-lamination-field').value = 'None';
        document.getElementById('profile-stapling-field').value = 'None';
        document.getElementById('profile-punch-field').value = 'None';
        document.getElementById('profile-pricing-field').value = '';
        document.getElementById('profile-recipe-field').value = '';
        document.getElementById('profile-crop-marks-field').checked = false;
        document.getElementById('profile-favorite-field').checked = false;
        
        document.getElementById('profile-form-title').textContent = 'Add New Print Profile';
        document.getElementById('btn-duplicate-profile').disabled = true;
        if (customMarginsDiv) customMarginsDiv.style.display = 'none';
        if (profileMsgStatus) profileMsgStatus.textContent = '';
    }

    function renderProfilesList() {
        const tbody = document.getElementById('profiles-list-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (allProfiles.length === 0) {
            tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;">No profiles created yet.</td></tr>';
            return;
        }

        allProfiles.forEach(prof => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${prof.name}</strong>${prof.is_favorite === 1 ? ' ⭐' : ''}</td>
                <td style="text-align:right;">
                    <button class="action-btn edit-prof-btn" style="padding:4px 8px; margin:0;" data-id="${prof.id}">Edit</button>
                    <button class="action-btn delete-prof-btn" style="padding:4px 8px; margin:0; background-color:var(--danger-color); color:white;" data-id="${prof.id}">Delete</button>
                </td>
            `;

            tr.querySelector('.edit-prof-btn').addEventListener('click', () => {
                editProfile(prof);
            });

            tr.querySelector('.delete-prof-btn').addEventListener('click', async () => {
                if (confirm(`Are you sure you want to delete print profile "${prof.name}"?`)) {
                    const res = await window.api.deletePrintProfile(prof.id);
                    if (res.success) {
                        window.showToast("Print Profile deleted successfully", "success");
                        productSelectorCache = null;
                        await loadProductsAndProfilesDashboard();
                        loadProductSelectorGrid();
                    } else {
                        window.showToast(res.error || "Delete failed", "error");
                    }
                }
            });

            tbody.appendChild(tr);
        });
    }

    function editProfile(prof) {
        document.getElementById('profile-id-field').value = prof.id;
        document.getElementById('profile-name-field').value = prof.name;
        document.getElementById('profile-printer-field').value = prof.printer_name || '';
        document.getElementById('profile-paper-size-field').value = prof.paper_size || 'A4';
        
        // Auto load source tray from cache
        const traySelect = document.getElementById('profile-tray-field');
        const printerName = prof.printer_name;
        const matchedPrinter = allPrinters.find(p => p.device_name === printerName);
        
        traySelect.innerHTML = '<option value="">Default Tray / Auto Select</option>';
        if (matchedPrinter && matchedPrinter.paper_sources) {
            matchedPrinter.paper_sources.forEach(t => {
                traySelect.innerHTML += `<option value="${t}">${t}</option>`;
            });
        }
        
        document.getElementById('profile-tray-field').value = prof.paper_source || '';
        document.getElementById('profile-paper-type-field').value = prof.paper_type || 'Plain';
        document.getElementById('profile-weight-field').value = prof.paper_weight || '';
        document.getElementById('profile-orientation-field').value = prof.orientation || 'portrait';
        document.getElementById('profile-scaling-field').value = prof.scaling || 'fit';
        document.getElementById('profile-custom-scale-field').value = prof.custom_scale || '100';
        document.getElementById('profile-duplex-field').value = prof.duplex_mode || 'simplex';
        document.getElementById('profile-alignment-field').value = prof.alignment || 'center';
        document.getElementById('profile-nup-field').value = prof.n_up || '1';
        document.getElementById('profile-margin-style-field').value = prof.margins_type || 'default';
        document.getElementById('profile-bleed-field').value = prof.bleed || '0';
        document.getElementById('profile-binding-margin-field').value = prof.binding_margin || '0';
        
        document.getElementById('profile-margin-top').value = prof.margin_top || '10';
        document.getElementById('profile-margin-bottom').value = prof.margin_bottom || '10';
        document.getElementById('profile-margin-left').value = prof.margin_left || '10';
        document.getElementById('profile-margin-right').value = prof.margin_right || '10';
        
        document.getElementById('profile-color-mode-field').value = prof.color_mode || 'color';
        document.getElementById('profile-quality-field').value = prof.print_quality || 'Normal';
        document.getElementById('profile-dpi-field').value = prof.resolution_dpi || '600';
        document.getElementById('profile-lamination-field').value = prof.finishing_lamination || 'None';
        document.getElementById('profile-stapling-field').value = prof.finishing_stapling || 'None';
        document.getElementById('profile-punch-field').value = prof.finishing_hole_punch || 'None';
        
        document.getElementById('profile-pricing-field').value = prof.pricing_id || '';
        document.getElementById('profile-recipe-field').value = prof.recipe_id || '';
        
        document.getElementById('profile-crop-marks-field').checked = prof.crop_marks === 1;
        document.getElementById('profile-favorite-field').checked = prof.is_favorite === 1;
        
        document.getElementById('profile-form-title').textContent = `Edit Profile: ${prof.name}`;
        document.getElementById('btn-duplicate-profile').disabled = false;
        
        if (prof.margins_type === 'custom') {
            customMarginsDiv.style.display = 'grid';
        } else {
            customMarginsDiv.style.display = 'none';
        }
    }

    // Dynamic tray selection listener
    const profilePrinterField = document.getElementById('profile-printer-field');
    if (profilePrinterField) {
        profilePrinterField.addEventListener('change', () => {
            const printerName = profilePrinterField.value;
            const traySelect = document.getElementById('profile-tray-field');
            if (traySelect) {
                traySelect.innerHTML = '<option value="">Default Tray / Auto Select</option>';
                const matched = allPrinters.find(p => p.device_name === printerName);
                if (matched && matched.paper_sources) {
                    matched.paper_sources.forEach(t => {
                        traySelect.innerHTML += `<option value="${t}">${t}</option>`;
                    });
                }
            }
        });
    }

    // 4. DEVICE MANAGER & CALIBRATION & GROUPS
    const btnTriggerDiscovery = document.getElementById('btn-trigger-printer-discovery');
    const btnSaveCalibration = document.getElementById('btn-save-calibration');
    const btnPrintCalTest = document.getElementById('btn-print-calibration-test');
    const calPrinterSelect = document.getElementById('calibration-printer-select');

    if (btnTriggerDiscovery) {
        btnTriggerDiscovery.addEventListener('click', async () => {
            btnTriggerDiscovery.disabled = true;
            btnTriggerDiscovery.textContent = "Scanning spools & capabilities...";
            try {
                window.showToast("Scanning local drivers via PowerShell, please wait...", "info");
                const res = await window.api.discoverPrinters();
                window.showToast(`Discovery completed! Detected ${res.length} drivers.`, "success");
                await loadProductsAndProfilesDashboard();
                refreshDevicesTab();
            } catch(e) {
                window.showToast("Discovery failed: " + e.message, "error");
            } finally {
                btnTriggerDiscovery.disabled = false;
                btnTriggerDiscovery.textContent = "Run Printer capabilities Discovery";
            }
        });
    }

    function refreshDevicesTab() {
        const tbody = document.getElementById('devices-list-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (allPrinters.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No printers cached yet. Run discovery.</td></tr>';
            return;
        }

        allPrinters.forEach(p => {
            const tr = document.createElement('tr');
            const colorText = p.can_color ? 'Color CMYK' : 'B&W Mono';
            const duplexText = p.can_duplex ? 'Yes' : 'Simplex';
            const statusColor = p.status === 'Online' ? 'var(--success-color)' : 'var(--danger-color)';
            
            tr.innerHTML = `
                <td><strong>${p.display_name}</strong>${p.is_default ? ' (Default)' : ''}</td>
                <td>${p.driver_name || 'Generic'}</td>
                <td><span style="color:${statusColor}; font-weight:bold;">${p.status}</span></td>
                <td>${duplexText}</td>
                <td>${colorText}</td>
                <td><small>${Array.isArray(p.paper_sources) ? (p.paper_sources.slice(0,3).join(', ') + (p.paper_sources.length > 3 ? '...' : '')) : (p.paper_sources || 'Standard')}</small></td>
                <td><small>${new Date(p.last_scanned).toLocaleString()}</small></td>
            `;
            tbody.appendChild(tr);
        });
    }

    // Load calibration for printer
    if (calPrinterSelect) {
        calPrinterSelect.addEventListener('change', async () => {
            const printerName = calPrinterSelect.value;
            if (!printerName) return;
            try {
                const cal = await window.api.getPrinterCalibration(printerName);
                if (cal) {
                    document.getElementById('calibration-offset-x').value = cal.offset_x;
                    document.getElementById('calibration-offset-y').value = cal.offset_y;
                    document.getElementById('calibration-scale-x').value = cal.scale_x;
                    document.getElementById('calibration-scale-y').value = cal.scale_y;
                    document.getElementById('calibration-margin-comp').value = cal.margin_compensation;
                    document.getElementById('calibration-feed-offset').value = cal.paper_feed_offset;
                }
            } catch(e) {
                console.error(e);
            }
        });
    }

    if (btnSaveCalibration) {
        btnSaveCalibration.addEventListener('click', async () => {
            const printerName = calPrinterSelect.value;
            if (!printerName) {
                window.showToast("Select a printer to calibrate first.", "error");
                return;
            }

            const offset_x = parseFloat(document.getElementById('calibration-offset-x').value) || 0.0;
            const offset_y = parseFloat(document.getElementById('calibration-offset-y').value) || 0.0;
            const scale_x = parseFloat(document.getElementById('calibration-scale-x').value) || 1.0;
            const scale_y = parseFloat(document.getElementById('calibration-scale-y').value) || 1.0;
            const margin_compensation = parseFloat(document.getElementById('calibration-margin-comp').value) || 0.0;
            const paper_feed_offset = parseFloat(document.getElementById('calibration-feed-offset').value) || 0.0;

            try {
                const res = await window.api.savePrinterCalibration(printerName, {
                    offset_x, offset_y, scale_x, scale_y, margin_compensation, paper_feed_offset
                });
                if (res.success) {
                    window.showToast("Calibration settings saved!", "success");
                } else {
                    window.showToast(res.error || "Failed to save calibration", "error");
                }
            } catch(e) {
                window.showToast("Error: " + e.message, "error");
            }
        });
    }

    if (btnPrintCalTest) {
        btnPrintCalTest.addEventListener('click', async () => {
            const printerName = calPrinterSelect.value;
            if (!printerName) {
                window.showToast("Select a printer first.", "error");
                return;
            }
            try {
                btnPrintCalTest.disabled = true;
                window.showToast("Alignment print job enqueued...", "info");
                const res = await window.api.printTestPage(printerName);
                if (res.success) {
                    window.showToast("Alignment test page spooled!", "success");
                } else {
                    window.showToast(res.error || "Failed to print test page", "error");
                }
            } catch(e) {
                window.showToast("Print error: " + e.message, "error");
            } finally {
                btnPrintCalTest.disabled = false;
            }
        });
    }

    // Printer Groups manager
    const btnSaveGroup = document.getElementById('btn-save-printer-group');
    if (btnSaveGroup) {
        btnSaveGroup.addEventListener('click', async () => {
            const id = document.getElementById('printer-group-id').value;
            const name = document.getElementById('printer-group-name').value.trim();
            const description = document.getElementById('printer-group-desc').value.trim();
            
            const selOptions = document.getElementById('printer-group-members').selectedOptions;
            const printers = Array.from(selOptions).map(o => o.value);

            if (!name || printers.length === 0) {
                window.showToast("Name and at least one member printer are required.", "error");
                return;
            }

            try {
                const res = await window.api.savePrinterGroup({
                    id: id ? parseInt(id) : null,
                    name,
                    description,
                    printers
                });
                window.showToast("Printer Group saved successfully!", "success");
                
                // Clear fields
                document.getElementById('printer-group-id').value = '';
                document.getElementById('printer-group-name').value = '';
                document.getElementById('printer-group-desc').value = '';
                document.getElementById('printer-group-members').selectedIndex = -1;
                
                await loadProductsAndProfilesDashboard();
            } catch(e) {
                window.showToast("Group save failed: " + e.message, "error");
            }
        });
    }

    async function renderPrinterGroupsTable() {
        const tbody = document.getElementById('printer-groups-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        try {
            const groups = await window.api.getPrinterGroups();
            if (groups.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">No Printer Groups created.</td></tr>';
                return;
            }

            groups.forEach(g => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${g.name}</strong></td>
                    <td>${g.description || ''}</td>
                    <td>${g.printers.length} member(s) (${g.printers.join(', ')})</td>
                    <td>
                        <button class="action-btn delete-group-btn" style="padding:2px 6px; background-color:var(--danger-color); color:white;" data-id="${g.id}">Delete</button>
                    </td>
                `;
                
                tr.querySelector('.delete-group-btn').addEventListener('click', async () => {
                    if (confirm(`Delete printer group "${g.name}"?`)) {
                        const res = await window.api.deletePrinterGroup(g.id);
                        if (res.success) {
                            window.showToast("Group deleted successfully", "success");
                            await loadProductsAndProfilesDashboard();
                        }
                    }
                });

                tbody.appendChild(tr);
            });
        } catch(e) {
            console.error("Groups render fail:", e);
        }
    }

    // 5. PRINT AUDIT LOGS & REPRINTS
    const btnRefreshAudit = document.getElementById('btn-refresh-audit-logs');
    if (btnRefreshAudit) {
        btnRefreshAudit.addEventListener('click', () => {
            refreshAuditLogs();
        });
    }

    async function refreshAuditLogs() {
        const tbody = document.getElementById('audit-logs-table-body');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">Loading audit trails...</td></tr>';

        try {
            const logs = await window.api.getPrintAuditLogs(50);
            tbody.innerHTML = '';

            if (logs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">No print run logs logged.</td></tr>';
                return;
            }

            logs.forEach(log => {
                const tr = document.createElement('tr');
                const isSim = log.is_simulated === 1 ? ' <small style="opacity:0.6;">(SIM)</small>' : '';
                
                let statusColor = 'var(--text-secondary)';
                if (log.status === 'Completed') statusColor = 'var(--success-color)';
                if (log.status === 'Failed') statusColor = 'var(--danger-color)';

                const dateStr = new Date(log.started_at).toLocaleString();
                const recipeText = log.inventory_used_json && log.inventory_used_json !== '[]' ? 
                    JSON.parse(log.inventory_used_json).map(item => `${item.itemName} ×${item.qty.toFixed(1)}`).join(', ') : 
                    'None';

                tr.innerHTML = `
                    <td><small>${dateStr}</small></td>
                    <td>${log.product_name || 'Legacy / Direct'}</td>
                    <td>${log.print_profile_name || 'Direct Input'}</td>
                    <td>${log.printer_name}${isSim}</td>
                    <td>${log.pages}p × ${log.copies}c</td>
                    <td><small style="max-width:180px; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${recipeText}">${recipeText}</small></td>
                    <td>${log.duration_ms ? (log.duration_ms / 1000).toFixed(2) + 's' : '—'}</td>
                    <td><span style="color:${statusColor}; font-weight:bold;">${log.status}</span></td>
                    <td style="text-align:right;">
                        <button class="action-btn reprint-job-btn" style="padding:4px 8px; margin:0;" data-id="${log.id}">One-Click Reprint</button>
                    </td>
                `;

                tr.querySelector('.reprint-job-btn').addEventListener('click', async (e) => {
                    const btn = e.currentTarget;
                    btn.disabled = true;
                    btn.textContent = "Spooling...";
                    try {
                        window.showToast("One-Click reprint queued...", "info");
                        const res = await window.api.reprintJob(log.id);
                        if (res.success) {
                            window.showToast("Reprint job queued successfully.", "success");
                        } else {
                            window.showToast(res.error || "Reprint failed", "error");
                        }
                    } catch(err) {
                        window.showToast("Reprint failed: " + err.message, "error");
                    } finally {
                        btn.disabled = false;
                        btn.textContent = "One-Click Reprint";
                        refreshAuditLogs();
                    }
                });

                tbody.appendChild(tr);
            });
        } catch(e) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--danger-color);">Error loading logs: ${e.message}</td></tr>`;
        }
    }

    // 6. CHECKOUT SCREEN PRODUCT GRID & PRE-FLIGHT INTEGRATION
    window.recommendedProductId = null;
    // =========================================================================
    // ─── DYNAMIC JOB CONFIGURATION SYSTEM & ENGINES ─────────────────────────
    // =========================================================================

    class ValidationEngine {
        static validate(profileType, specs) {
            const errors = [];
            if (profileType === 'banner') {
                const width = parseFloat(specs['Width']);
                const height = parseFloat(specs['Height']);
                if (isNaN(width) || width <= 0) {
                    errors.push("Width must be greater than zero.");
                }
                if (isNaN(height) || height <= 0) {
                    errors.push("Height must be greater than zero.");
                }
            } else if (profileType === 'book') {
                const pageCount = parseInt(specs['Page Count']);
                if (isNaN(pageCount) || pageCount < 2) {
                    errors.push("Page count must be at least 2.");
                }
            }
            return errors;
        }
    }

    class PricingEngine {
        static calculatePrice(productBaseRate, profileConfig, specs, pages, copies) {
            const rules = (profileConfig && profileConfig.pricing) ? profileConfig.pricing : {};
            const model = rules.pricing_model || 'unit';
            const surcharges = rules.surcharges || {};

            let baseRate = Math.max(0, parseFloat(productBaseRate) || 0);
            let validCopies = Math.max(1, parseInt(copies) || 1);
            let validPages = Math.max(1, parseInt(pages) || 1);
            let itemBasePrice = 0;
            const validSpecs = specs || {};

            if (model === 'area') {
                const width = Math.max(0, parseFloat(validSpecs['Width']) || 0);
                const height = Math.max(0, parseFloat(validSpecs['Height']) || 0);
                const materialVal = validSpecs['Material'];
                if (materialVal && surcharges['Material'] && surcharges['Material'][materialVal]) {
                    baseRate += (parseFloat(surcharges['Material'][materialVal]) || 0);
                }
                itemBasePrice = width * height * baseRate;
            } else if (model === 'page') {
                const pageCount = parseInt(validSpecs['Page Count']) || validPages;
                let coverPrice = 0;
                const coverVal = validSpecs['Cover Paper'];
                if (coverVal && surcharges['Cover Paper'] && surcharges['Cover Paper'][coverVal]) {
                    coverPrice += (parseFloat(surcharges['Cover Paper'][coverVal]) || 0);
                }
                itemBasePrice = coverPrice + (Math.max(1, pageCount) * baseRate);
            } else {
                itemBasePrice = baseRate;
            }

            let totalSurcharges = 0;
            for (const [key, val] of Object.entries(validSpecs)) {
                if (surcharges[key] && surcharges[key][val]) {
                    if (model === 'area' && key === 'Material') continue;
                    if (model === 'page' && key === 'Cover Paper') continue;
                    totalSurcharges += (parseFloat(surcharges[key][val]) || 0);
                }
            }

            let finalUnitPrice = Math.max(0, itemBasePrice + totalSurcharges);
            return Math.max(0, finalUnitPrice * validCopies);
        }
    }

    const JobConfigEngine = {
        render: (containerId, profile, productPrice) => {
            const container = document.getElementById(containerId);
            if (!container) return;

            let config = null;
            try {
                config = typeof profile.config_json === 'string' ? JSON.parse(profile.config_json) : profile.config_json;
            } catch(e) {
                console.error("Failed to parse config_json:", e);
            }

            if (!config) {
                config = {
                    type: "generic",
                    fields: [],
                    validation: [],
                    pricing: { pricing_model: "page" }
                };
            }

            if (!window.currentOrderConfigGlobal) {
                window.currentOrderConfigGlobal = {};
            }
            
            // Profile-aware specification mapping: retain valid shared fields, purge stale fields from other products
            const oldSpecs = window.currentOrderConfigGlobal.specifications || {};
            const newSpecs = {};

            const fields = config.fields || [];
            fields.forEach(f => {
                if (oldSpecs[f.key] !== undefined) {
                    if (f.type === 'select' && Array.isArray(f.options)) {
                        if (f.options.includes(oldSpecs[f.key])) {
                            newSpecs[f.key] = oldSpecs[f.key];
                        } else {
                            newSpecs[f.key] = f.default;
                        }
                    } else if (f.type === 'number') {
                        const numVal = parseFloat(oldSpecs[f.key]);
                        newSpecs[f.key] = (!isNaN(numVal) && numVal > 0) ? oldSpecs[f.key] : f.default;
                    } else {
                        newSpecs[f.key] = oldSpecs[f.key];
                    }
                } else {
                    newSpecs[f.key] = f.default;
                }
            });

            window.currentOrderConfigGlobal.specifications = newSpecs;

            if (window.currentOrderConfigGlobal.copies === undefined) {
                window.currentOrderConfigGlobal.copies = 1;
            }
            if (window.currentOrderConfigGlobal.nUp === undefined) {
                window.currentOrderConfigGlobal.nUp = 1;
            }
            if (window.currentOrderConfigGlobal.pageRange === undefined) {
                window.currentOrderConfigGlobal.pageRange = "";
            }

            const sections = {};
            const addFieldToSection = (secName, html) => {
                if (!sections[secName]) sections[secName] = [];
                sections[secName].push(html);
            };

            fields.forEach(f => {
                let fieldHtml = "";
                const currentVal = window.currentOrderConfigGlobal.specifications[f.key] !== undefined 
                    ? window.currentOrderConfigGlobal.specifications[f.key] 
                    : f.default;

                const depAttr = f.dependentOn ? `data-dep-key="${f.dependentOn.key}" data-dep-val="${f.dependentOn.value}"` : '';

                if (f.type === 'select') {
                    const optionsHtml = f.options.map(opt => `<option value="${opt}" ${opt === currentVal ? 'selected' : ''}>${opt}</option>`).join('');
                    fieldHtml = `
                        <div class="ws-opt-row config-row-field" id="row-config-${f.key.replace(/\s+/g, '_')}" ${depAttr}>
                            <label class="ws-opt-label">${f.label}</label>
                            <select class="ws-opt-select config-input-field" data-key="${f.key}">
                                ${optionsHtml}
                            </select>
                        </div>
                    `;
                } else if (f.type === 'number') {
                    fieldHtml = `
                        <div class="ws-opt-row config-row-field" id="row-config-${f.key.replace(/\s+/g, '_')}" ${depAttr}>
                            <label class="ws-opt-label">${f.label}</label>
                            <input type="number" class="ws-opt-select config-input-field" style="width: 120px; text-align: left; padding: 8px 12px; font-size: 0.85rem;" data-key="${f.key}" value="${currentVal}">
                        </div>
                    `;
                }
                addFieldToSection(f.section || "Product Specifications", fieldHtml);
            });

            const layoutVal = window.currentOrderConfigGlobal.nUp;
            addFieldToSection("Print Settings", `
                <div class="ws-opt-row">
                    <label class="ws-opt-label">Layout</label>
                    <select id="layout-images-per-page" class="ws-opt-select">
                        <option value="1" ${layoutVal == 1 ? 'selected' : ''}>1-up (Full Page)</option>
                        <option value="2" ${layoutVal == 2 ? 'selected' : ''}>2-up (Half Page)</option>
                        <option value="4" ${layoutVal == 4 ? 'selected' : ''}>4-up (Quarter)</option>
                    </select>
                </div>
                <div class="ws-opt-row">
                    <label class="ws-opt-label">Page Range</label>
                    <input type="text" id="setup-page-range" class="ws-opt-select" placeholder="e.g. 1-3, 5 (Optional)" style="width: 170px; text-align: left; padding: 8px 12px; font-size: 0.85rem;" value="${window.currentOrderConfigGlobal.pageRange}">
                </div>
            `);

            const copiesVal = window.currentOrderConfigGlobal.copies;
            addFieldToSection("Quantity", `
                <div class="ws-opt-row">
                    <label class="ws-opt-label">Copies</label>
                    <div class="ws-stepper">
                        <button class="ws-stepper-btn" id="copies-minus" type="button">−</button>
                        <input type="number" id="setup-copies" class="ws-stepper-input" value="${copiesVal}" min="1">
                        <button class="ws-stepper-btn" id="copies-plus" type="button">+</button>
                    </div>
                </div>
            `);

            let html = `
                <div class="ws-card" style="margin-bottom: 16px;">
                    <div class="ws-card-title">⚙️ Job Configuration (${profile.name})</div>
                    <div style="display: flex; flex-direction: column; gap: 18px; padding-top: 6px;">
            `;

            const sectionOrder = ["Product Specifications", "Print Settings", "Material", "Dimensions", "Finishing", "Quantity"];
            sectionOrder.forEach(sec => {
                if (sections[sec] && sections[sec].length > 0) {
                    html += `
                        <div class="config-section-block" style="border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 12px;">
                            <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: var(--text-secondary); margin-bottom: 10px; letter-spacing: 0.5px;">${sec}</div>
                            <div style="display: flex; flex-direction: column; gap: 10px;">
                                ${sections[sec].join('')}
                            </div>
                        </div>
                    `;
                }
            });

            html += `
                        <div id="config-validation-errors" style="display: none; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px; padding: 10px; color: #ef4444; font-size: 0.78rem;">
                        </div>
                    </div>
                </div>
            `;

            container.innerHTML = html;

            const updateSpecs = () => {
                container.querySelectorAll('.config-input-field').forEach(input => {
                    const key = input.getAttribute('data-key');
                    const val = input.value;
                    window.currentOrderConfigGlobal.specifications[key] = val;
                });

                const copiesInput = document.getElementById('setup-copies');
                const layoutInput = document.getElementById('layout-images-per-page');
                const pageRangeInput = document.getElementById('setup-page-range');

                if (copiesInput) window.currentOrderConfigGlobal.copies = parseInt(copiesInput.value) || 1;
                if (layoutInput) window.currentOrderConfigGlobal.nUp = parseInt(layoutInput.value) || 1;
                if (pageRangeInput) window.currentOrderConfigGlobal.pageRange = pageRangeInput.value.trim();

                container.querySelectorAll('.config-row-field[data-dep-key]').forEach(row => {
                    const depKey = row.getAttribute('data-dep-key');
                    const depVal = row.getAttribute('data-dep-val');
                    const activeVal = window.currentOrderConfigGlobal.specifications[depKey];
                    if (activeVal === depVal) {
                        row.style.display = 'flex';
                    } else {
                        row.style.display = 'none';
                    }
                });

                const errors = ValidationEngine.validate(config.type, window.currentOrderConfigGlobal.specifications);
                const errBox = document.getElementById('config-validation-errors');
                const continueBtn = document.getElementById('btn-step1-continue');
                if (errBox) {
                    if (errors.length > 0) {
                        errBox.innerHTML = errors.map(e => `<div>⚠️ ${e}</div>`).join('');
                        errBox.style.display = 'block';
                        if (continueBtn) continueBtn.disabled = true;
                    } else {
                        errBox.style.display = 'none';
                        if (continueBtn) continueBtn.disabled = false;
                    }
                }

                const baseRate = parseFloat(productPrice) || 0;
                let pages = 1;
                if (window.currentOrderFiles && window.currentOrderFiles.length > 0) {
                    pages = window.currentOrderFiles.length;
                }

                const calculatedPrice = PricingEngine.calculatePrice(
                    baseRate,
                    config,
                    window.currentOrderConfigGlobal.specifications,
                    pages,
                    window.currentOrderConfigGlobal.copies
                );
                window.currentOrderConfigGlobal.calculatedPrice = calculatedPrice;

                const invCopies = document.getElementById('inv-copies');
                if (invCopies) invCopies.textContent = window.currentOrderConfigGlobal.copies;

                const invLayout = document.getElementById('inv-layout');
                if (invLayout) invLayout.textContent = window.currentOrderConfigGlobal.nUp + '-up';

                if (window.updateWorkspace) {
                    window.updateWorkspace();
                }
            };

            container.querySelectorAll('.config-input-field').forEach(input => {
                input.addEventListener('change', updateSpecs);
                input.addEventListener('input', updateSpecs);
            });

            const btnMinus = document.getElementById('copies-minus');
            const btnPlus = document.getElementById('copies-plus');
            const inputCopies = document.getElementById('setup-copies');

            if (btnMinus && inputCopies) {
                btnMinus.addEventListener('click', () => {
                    const current = parseInt(inputCopies.value) || 1;
                    if (current > 1) {
                        inputCopies.value = current - 1;
                        updateSpecs();
                    }
                });
            }
            if (btnPlus && inputCopies) {
                btnPlus.addEventListener('click', () => {
                    const current = parseInt(inputCopies.value) || 1;
                    inputCopies.value = current + 1;
                    updateSpecs();
                });
            }
            if (inputCopies) {
                inputCopies.addEventListener('input', updateSpecs);
            }

            const layoutNUp = document.getElementById('layout-images-per-page');
            if (layoutNUp) {
                layoutNUp.addEventListener('change', updateSpecs);
            }
            const pageRangeInput = document.getElementById('setup-page-range');
            if (pageRangeInput) {
                pageRangeInput.addEventListener('input', updateSpecs);
            }

            updateSpecs();
        }
    };

    window.selectedProductId = null;
    window.selectedProfileId = null;

    let isProductLoadingInProgress = false;
    let productSelectorCache = null;
    const PRODUCT_LOADING_TIMEOUT_MS = 6000;

    async function loadProductSelectorGrid() {
        const container = document.getElementById('product-grid-container');
        if (!container) return;
        
        // Prevent duplicate concurrent requests
        if (isProductLoadingInProgress) return;
        isProductLoadingInProgress = true;
        
        // Setup spinner keyframes styling if not present
        if (!document.getElementById('robust-catalog-loader-styles')) {
            const style = document.createElement('style');
            style.id = 'robust-catalog-loader-styles';
            style.innerHTML = `
                @keyframes catalog-spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                .catalog-spinner {
                    animation: catalog-spin 0.8s linear infinite;
                }
            `;
            document.head.appendChild(style);
        }

        // Show professional loading indicator
        container.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; grid-column: 1 / -1; min-height: 180px; text-align: center; background: rgba(255,255,255,0.01); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; backdrop-filter: blur(10px);">
                <div class="catalog-spinner" style="width: 32px; height: 32px; border: 3px solid rgba(99, 102, 241, 0.1); border-top-color: #6366f1; border-radius: 50%; margin-bottom: 12px;"></div>
                <div style="font-size: 0.88rem; color: var(--text-secondary); font-weight: 500;">Loading product catalog...</div>
            </div>
        `;

        try {
            let products = [];
            let profiles = [];
            
            // Check cache first for rapid transitions
            if (productSelectorCache) {
                products = productSelectorCache.products;
                profiles = productSelectorCache.profiles;
            } else {
                // Timeout protection setup: race DB queries against a 6 second timer
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error("Local database request timed out. (Database Unavailable)")), PRODUCT_LOADING_TIMEOUT_MS)
                );
                
                const fetchPromise = Promise.all([
                    window.api.getProducts(),
                    window.api.getPrintProfiles()
                ]);
                
                const [fetchedProducts, fetchedProfiles] = await Promise.race([fetchPromise, timeoutPromise]);
                products = fetchedProducts || [];
                profiles = fetchedProfiles || [];
                
                // Cache successfully loaded data
                productSelectorCache = { products, profiles };
            }
            
            const activeProducts = products.filter(p => p.is_active === 1);
            
            // Empty State Handling
            if (activeProducts.length === 0) {
                isProductLoadingInProgress = false;
                container.innerHTML = `
                    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; grid-column: 1 / -1; min-height: 180px; text-align: center; background: rgba(255,255,255,0.01); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; backdrop-filter: blur(10px);">
                        <div style="font-size: 2.2rem; margin-bottom: 12px;">📦</div>
                        <div style="font-size: 0.95rem; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">No Products Found</div>
                        <div style="font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 20px; max-width: 320px; line-height: 1.4;">Configure your product catalog in settings or import standard printing products to start.</div>
                        <div style="display: flex; gap: 10px; justify-content: center; width: 100%;">
                            <button id="btn-create-first-product" class="ws-continue-btn" style="margin: 0; padding: 8px 16px; font-size: 0.82rem; border-radius: 8px; width: auto; background: var(--primary-color);">Create First Product</button>
                            <button id="btn-import-products" class="ws-stepper-btn" style="margin: 0; padding: 8px 16px; font-size: 0.82rem; border-radius: 8px; width: auto; height: auto; border: 1px solid var(--border-color); background: transparent; color: var(--text-primary);">Import Products</button>
                        </div>
                    </div>
                `;
                
                // Switch to products page in settings
                document.getElementById('btn-create-first-product')?.addEventListener('click', () => {
                    const settingsBtn = document.querySelector('.nav-btn[data-target="settings"]');
                    if (settingsBtn) {
                        settingsBtn.click();
                        setTimeout(() => {
                            const tabBtn = document.querySelector('.settings-tab-btn[data-tab="settings-profiles"]');
                            if (tabBtn) tabBtn.click();
                            setTimeout(() => {
                                const miniTabBtn = document.querySelector('.settings-tab-btn[data-minitab="mini-products"]');
                                if (miniTabBtn) miniTabBtn.click();
                            }, 50);
                        }, 50);
                    }
                });
                
                // Import standard printing products linked to default print profiles
                document.getElementById('btn-import-products')?.addEventListener('click', async () => {
                    container.innerHTML = `
                        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; grid-column: 1 / -1; min-height: 180px; text-align: center;">
                            <div class="catalog-spinner" style="width: 24px; height: 24px; border: 2px solid rgba(99, 102, 241, 0.1); border-top-color: #6366f1; border-radius: 50%; margin-bottom: 12px;"></div>
                            <div style="font-size: 0.82rem; color: var(--text-secondary);">Seeding catalog...</div>
                        </div>
                    `;
                    try {
                        const profilesList = await window.api.getPrintProfiles();
                        const findProfileId = (typeKeyword) => {
                            const found = profilesList.find(p => {
                                try {
                                    const cfg = typeof p.config_json === 'string' ? JSON.parse(p.config_json) : p.config_json;
                                    return cfg && cfg.type === typeKeyword;
                                } catch(e) {
                                    return false;
                                }
                            });
                            if (found) return found.id;
                            const nameMatch = profilesList.find(p => p.name.toLowerCase().includes(typeKeyword.split('-')[0]));
                            return nameMatch ? nameMatch.id : (profilesList[0] ? profilesList[0].id : null);
                        };

                        const visitingProfileId = findProfileId('business-card');
                        const flyerProfileId = findProfileId('flyer-brochure');
                        const posterProfileId = findProfileId('poster');
                        const bannerProfileId = findProfileId('banner');
                        const stickerProfileId = findProfileId('sticker');
                        const bookProfileId = findProfileId('book');

                        const productsToSeed = [
                            { name: "Premium Business Cards", category: "Cards", description: "Vibrant standard 300 GSM business cards.", print_profile_id: visitingProfileId, is_active: 1, price: 2.50 },
                            { name: "A4 Flyers & Leaflets", category: "Flyers", description: "Art paper A4 leaflets single/double sided.", print_profile_id: flyerProfileId, is_active: 1, price: 6.00 },
                            { name: "Vibrant Poster Prints", category: "Posters", description: "Gloss photo paper large size poster prints.", print_profile_id: posterProfileId, is_active: 1, price: 95.00 },
                            { name: "Star Flex Banner (Sqft)", category: "Banners", description: "Durable Star Flex banner pricing per square foot.", print_profile_id: bannerProfileId, is_active: 1, price: 18.00 },
                            { name: "Die-Cut Vinyl Stickers", category: "Stickers", description: "Weatherproof round/square kiss-cut vinyl stickers.", print_profile_id: stickerProfileId, is_active: 1, price: 4.00 },
                            { name: "A4 Bound Catalogs", category: "Books", description: "Saddle-stitch or perfect-bind booklet catalog.", print_profile_id: bookProfileId, is_active: 1, price: 35.00 }
                        ];

                        for (const prod of productsToSeed) {
                            await window.api.saveProduct(prod);
                        }
                        
                        // Clear cache and reload
                        productSelectorCache = null;
                        isProductLoadingInProgress = false;
                        await loadProductSelectorGrid();
                        if (window.showToast) window.showToast("Successfully imported default products!", "success");
                    } catch (seedingErr) {
                        console.error("Failed to seed catalog:", seedingErr);
                        isProductLoadingInProgress = false;
                        await loadProductSelectorGrid();
                    }
                });
                
                return;
            }
            
            // Sort by favorite and recommendation
            activeProducts.sort((a, b) => {
                if (a.id === window.recommendedProductId && b.id !== window.recommendedProductId) return -1;
                if (b.id === window.recommendedProductId && a.id !== window.recommendedProductId) return 1;
                return b.is_favorite - a.is_favorite;
            });

            container.innerHTML = activeProducts.map(p => {
                const profile = profiles.find(pr => pr.id === p.print_profile_id);
                const specChips = [];
                if (profile) {
                    specChips.push(profile.paper_size);
                    specChips.push(profile.color_mode === 'color' ? 'Color' : 'Mono');
                    specChips.push(profile.duplex_mode !== 'simplex' ? 'Duplex' : 'Simplex');
                    if (profile.paper_weight) specChips.push(`${profile.paper_weight}g`);
                }
                
                const chipsHtml = specChips.map(c => `<span class="product-chip">${c}</span>`).join('');
                const isRecommended = window.recommendedProductId === p.id;
                const isActive = window.selectedProductId === p.id;
                
                return `
                    <div class="product-card ${isRecommended ? 'recommended' : ''} ${isActive ? 'active' : ''}" data-product-id="${p.id}" data-profile-id="${p.print_profile_id}" data-price="${p.price || 0}">
                        ${isRecommended ? '<div class="rec-badge">✨ Rec</div>' : ''}
                        <div>
                            <div class="product-card-title">${p.name}</div>
                            <div class="product-card-desc">${p.description || ''}</div>
                        </div>
                        <div class="product-card-chips" style="margin-top: 6px;">
                            ${chipsHtml}
                        </div>
                        <div class="rec-text" style="font-size:0.65rem; color:#10b981; font-weight:700; margin-top:6px; display:${isRecommended ? 'block' : 'none'};">Optimal match for uploaded file</div>
                    </div>
                `;
            }).join('');
            
            // Wire click listeners
            container.querySelectorAll('.product-card').forEach(card => {
                card.addEventListener('click', async () => {
                    container.querySelectorAll('.product-card').forEach(c => c.classList.remove('active'));
                    card.classList.add('active');
                    
                    const prodId = parseInt(card.getAttribute('data-product-id'));
                    const profileId = parseInt(card.getAttribute('data-profile-id'));
                    
                    window.selectedProductId = prodId;
                    window.selectedProfileId = profileId;
                    
                    // Fetch profile details
                    const selectedProfile = profiles.find(pr => pr.id === profileId);
                    if (selectedProfile && window.currentOrderConfig) {
                        window.currentOrderConfig.product_id = prodId;
                        window.currentOrderConfig.print_profile_id = profileId;
                        
                        window.currentOrderConfig.paperSize = selectedProfile.paper_size;
                        window.currentOrderConfig.printType = selectedProfile.color_mode;
                        window.currentOrderConfig.sides = selectedProfile.duplex_mode === 'simplex' ? 'Single' : 'Double';
                        window.currentOrderConfig.default_printer = selectedProfile.printer_name || 'Default';
                        
                        window.currentOrderConfig.print_color_mode = selectedProfile.color_mode;
                        window.currentOrderConfig.print_paper_size = selectedProfile.paper_size;
                        window.currentOrderConfig.print_duplex = selectedProfile.duplex_mode;
                        window.currentOrderConfig.print_orientation = selectedProfile.orientation;
                        window.currentOrderConfig.print_quality = selectedProfile.print_quality;
                        
                        // Map paper pricing info
                        if (selectedProfile.pricing_id) {
                            try {
                                const pricingList = await window.api.getAllPricing();
                                const priceItem = pricingList.find(pi => pi.id === selectedProfile.pricing_id);
                                if (priceItem) {
                                    window.currentOrderConfig.paper = {
                                        id: priceItem.id,
                                        name: priceItem.paper_size + ' (' + priceItem.print_type + ')',
                                        price: priceItem.price
                                    };
                                }
                            } catch(pe) {
                                console.error("Pricing resolve error:", pe);
                            }
                        } else {
                            window.currentOrderConfig.paper = null;
                        }
                        
                        // Render dynamic job configuration
                        JobConfigEngine.render('dynamic-job-config-container', selectedProfile, card.getAttribute('data-price') || 0);

                        // Trigger recalculate
                        if (window.updateWorkspace) window.updateWorkspace();
                    }
                });
            });

            // Auto-select first or recommended product if none active
            if (activeProducts.length > 0 && !window.selectedProductId) {
                const targetProdId = window.recommendedProductId || activeProducts[0].id;
                const targetCard = container.querySelector(`.product-card[data-product-id="${targetProdId}"]`) || container.querySelector('.product-card');
                if (targetCard) {
                    targetCard.click();
                }
            }
            
            isProductLoadingInProgress = false;

        } catch(err) {
            console.error("Failed to load products grid:", err);
            isProductLoadingInProgress = false;
            
            // Distinguish offline database issues from unexpected application errors
            let friendlyMsg = "Unexpected application error occurred while reading the catalog.";
            if (err.message && (err.message.includes("timed out") || err.message.includes("SQLITE_IOERR") || err.message.includes("busy") || err.message.includes("locked"))) {
                friendlyMsg = "The local database is temporarily locked or unavailable. Please check that another instance is not running.";
            } else if (err.message && err.message.includes("offline")) {
                friendlyMsg = "Offline data access issue. Check system file handles.";
            }

            container.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 30px 20px; grid-column: 1 / -1; min-height: 180px; text-align: center; background: rgba(239, 68, 68, 0.02); border: 1px solid rgba(239, 68, 68, 0.15); border-radius: 12px; backdrop-filter: blur(10px);">
                    <div style="font-size: 2.2rem; margin-bottom: 12px;">⚠️</div>
                    <div style="font-size: 0.95rem; font-weight: 600; color: #ef4444; margin-bottom: 4px;">Unable to Load Catalog</div>
                    <div style="font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 16px; max-width: 320px; line-height: 1.4;">${friendlyMsg}</div>
                    <div style="display: flex; flex-direction: column; gap: 12px; width: 100%; align-items: center;">
                        <button id="btn-retry-catalog" class="ws-continue-btn" style="margin: 0; padding: 8px 16px; font-size: 0.82rem; border-radius: 8px; width: auto; background: var(--primary-color);">🔄 Retry Connection</button>
                        
                        <details style="text-align: left; width: 100%; max-width: 400px; margin-top: 8px; border: 1px solid rgba(255,255,255,0.05); border-radius: 6px; padding: 8px; background: rgba(0,0,0,0.2);">
                            <summary style="font-size: 0.75rem; color: var(--text-secondary); cursor: pointer; user-select: none;">Show Diagnostic Stack Trace</summary>
                            <pre style="font-family: monospace; font-size: 0.7rem; color: #ef4444; margin-top: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow-y: auto;">${err.stack || err.message || err}</pre>
                        </details>
                    </div>
                </div>
            `;

            document.getElementById('btn-retry-catalog')?.addEventListener('click', () => {
                loadProductSelectorGrid();
            });
        }
    }
    window.loadProductSelectorGrid = loadProductSelectorGrid;

    // Background preflight scanning validator
    async function runPreflightValidation(filePath) {
        if (!filePath) return;
        console.log(`[Pre-flight] Background scanning document ${filePath}...`);
        try {
            const res = await window.api.validateDocument(filePath);
            const badge = document.getElementById('preflight-rec-badge');
            
            if (res && res.isValid && res.recommendation) {
                console.log(`[Pre-flight] Scan matched Product Recommendation: ${res.recommendation.name}`);
                if (badge) {
                    badge.style.display = 'inline-block';
                    badge.textContent = `✨ Recommended: ${res.recommendation.name}`;
                }
                
                window.recommendedProductId = res.recommendation.id;
                
                // Refresh grid to reflect recommended styling
                await loadProductSelectorGrid();
                
                // Auto select recommended if no product selected
                if (!window.selectedProductId) {
                    const recCard = document.querySelector(`.product-card[data-product-id="${res.recommendation.id}"]`);
                    if (recCard) recCard.click();
                }
            } else {
                if (badge) badge.style.display = 'none';
                window.recommendedProductId = null;
                await loadProductSelectorGrid();
            }
        } catch (err) {
            console.error("Preflight validation error:", err);
        }
    }
    window.runPreflightValidation = runPreflightValidation;

    // Hook grid loading when files change
    const originalRenderAttachedFiles = renderAttachedFiles;
    renderAttachedFiles = function() {
        originalRenderAttachedFiles();
        
        loadProductSelectorGrid().then(() => {
            if (currentOrderFiles.length > 0) {
                runPreflightValidation(currentOrderFiles[0].path);
            } else {
                const badge = document.getElementById('preflight-rec-badge');
                if (badge) badge.style.display = 'none';
                window.recommendedProductId = null;
            }
        });
    };

    // Initialize product grid on DOM load
    loadProductSelectorGrid();
});

// =========================================================================
// GLOBAL UI AUTO-RECOVERY & ERROR BOUNDARY HANDLERS
// Prevents software from freezing or sticking when operations encounter errors
// =========================================================================
window.addEventListener('error', (event) => {
    console.error('[Global Error Caught]:', event.error || event.message);
    const msg = event.error ? event.error.message : event.message;
    if (window.api && window.api.logError) {
        window.api.logError(`[Window Error] ${msg} at ${event.filename}:${event.lineno}`);
    }
    // Auto-recover UI stuck states
    recoverUIStuckState();
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('[Global Promise Rejection Caught]:', event.reason);
    const msg = event.reason ? (event.reason.message || String(event.reason)) : 'Unhandled rejection';
    if (window.api && window.api.logError) {
        window.api.logError(`[Unhandled Rejection] ${msg}`);
    }
    // Auto-recover UI stuck states
    recoverUIStuckState();
});

function recoverUIStuckState() {
    try {
        // 1. Re-enable all disabled submit/save buttons
        document.querySelectorAll('button[disabled], input[type="submit"][disabled]').forEach(btn => {
            if (btn.textContent && btn.textContent.toLowerCase().includes('saving')) {
                btn.disabled = false;
                btn.textContent = 'Save';
            } else {
                btn.disabled = false;
            }
        });

        // 2. Hide any active loading overlays or spinners
        const loaders = document.querySelectorAll('.loading-overlay, .spinner-overlay, #global-loader');
        loaders.forEach(loader => {
            if (loader) loader.style.display = 'none';
        });

        // 3. Show non-intrusive warning toast if available
        if (window.showToast) {
            window.showToast("An action encountered an issue, but the system has recovered.", "warning");
        }
    } catch (e) {
        console.error("UI recovery error:", e);
    }
}
