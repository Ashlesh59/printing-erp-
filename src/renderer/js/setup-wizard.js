window.SetupWizard = (function () {
    let currentStep = 1;
    const totalSteps = 11;
    const wizardData = {
        businessName: '',
        ownerName: '',
        phone: '',
        email: '',
        address: '',
        gstin: '',
        currency: '₹',
        defaultPrinter: '',
        photoPrinter: '',
        receiptPrinter: '',
        papers: ['A4', 'A3', 'Photo'],
        services: ['bw_print', 'color_print', 'lamination', 'binding', 'photo', 'scanning'],
        bwPrice: 2.0,
        colorPrice: 10.0,
        laminationPrice: 20.0,
        bindingPrice: 30.0,
        photoPrice: 50.0,
        scanPrice: 5.0,
        adminPin: '',
        confirmAdminPin: '',
        managerPin: '',
        confirmManagerPin: '',
        backupFreq: 'daily'
    };

    function init() {
        bindEvents();
        checkFirstLaunch();
    }

    async function checkFirstLaunch() {
        if (!window.api || !window.api.getSettings) return;
        try {
            const settings = await window.api.getSettings();
            if (settings && settings.has_setup === 0) {
                openWizard();
            }
        } catch (e) {
            console.error("Failed to check first launch setup status:", e);
        }
    }

    function openWizard() {
        currentStep = 1;
        updateStepUI();
        const el = document.getElementById('setup-wizard-screen');
        if (el) el.style.display = 'flex';
    }

    function closeWizard() {
        const el = document.getElementById('setup-wizard-screen');
        if (el) el.style.display = 'none';
    }

    function updateStepUI() {
        const panes = document.querySelectorAll('.wizard-step-pane');
        panes.forEach(p => p.classList.remove('active'));

        const activePane = document.querySelector(`.wizard-step-pane[data-step="${currentStep}"]`);
        if (activePane) activePane.classList.add('active');

        // Update progress track
        const indicator = document.getElementById('wizard-step-indicator');
        const progressBar = document.getElementById('wizard-progress-bar');
        if (indicator) indicator.textContent = `Step ${currentStep} of ${totalSteps}: ${getStepTitle(currentStep)}`;
        if (progressBar) progressBar.style.width = `${Math.round((currentStep / totalSteps) * 100)}%`;

        // Update footer buttons
        const btnBack = document.getElementById('wz-btn-back');
        const btnNext = document.getElementById('wz-btn-next');
        const btnSkip = document.getElementById('wz-btn-skip');

        if (btnBack) btnBack.style.display = currentStep > 1 && currentStep < 11 ? 'inline-block' : 'none';
        if (btnSkip) btnSkip.style.display = [5, 6, 9].includes(currentStep) ? 'inline-block' : 'none';

        if (btnNext) {
            if (currentStep === 10) {
                btnNext.textContent = '⚡ Generate Workspace';
                btnNext.className = 'btn primary';
                btnNext.style.display = 'inline-block';
            } else if (currentStep === 11) {
                btnNext.style.display = 'none';
            } else {
                btnNext.textContent = 'Continue ›';
                btnNext.style.display = 'inline-block';
            }
        }

        // Action per step enter
        if (currentStep === 4) {
            scanPrinters();
        } else if (currentStep === 10) {
            renderReviewSummary();
        }
    }

    function getStepTitle(step) {
        const titles = [
            "Welcome",
            "License Activation",
            "Business Details",
            "Printer Detection",
            "Paper Configuration",
            "Services Offered",
            "Pricing Configuration",
            "Staff Security PINs",
            "Backup Schedule",
            "Review & Confirm",
            "Workspace Generation"
        ];
        return titles[step - 1] || "Setup";
    }

    async function scanPrinters() {
        const listContainer = document.getElementById('wz-printer-list');
        const selMain = document.getElementById('wz-sel-main-printer');
        const selPhoto = document.getElementById('wz-sel-photo-printer');
        const selReceipt = document.getElementById('wz-sel-receipt-printer');

        if (!window.api || !window.api.getPrinters) return;

        try {
            const printers = await window.api.getPrinters();
            if (listContainer) {
                if (!printers || printers.length === 0) {
                    listContainer.innerHTML = `<div class="wz-info-box" style="text-align: center;">No physical printers detected. Virtual PDF drivers will be used as default.</div>`;
                } else {
                    listContainer.innerHTML = printers.map(p => `
                        <div class="wz-info-box" style="display: flex; align-items: center; justify-content: space-between;">
                            <div>
                                <div style="font-weight: 600;">🖨️ ${p.displayName || p.name}</div>
                                <div style="font-size: 0.8rem; color: var(--text-secondary);">${p.isDefault ? 'Default System Printer' : 'Local Print Driver'}</div>
                            </div>
                            <span class="badge" style="background: rgba(34, 197, 94, 0.15); color: #22c55e;">Ready</span>
                        </div>
                    `).join('');
                }
            }

            const options = (printers || []).map(p => `<option value="${p.name}">${p.displayName || p.name}</option>`).join('');
            const defaultOpt = `<option value="">Default System Driver</option>` + options;

            if (selMain) selMain.innerHTML = defaultOpt;
            if (selPhoto) selPhoto.innerHTML = defaultOpt;
            if (selReceipt) selReceipt.innerHTML = defaultOpt;
        } catch (e) {
            console.error("Printer scan error:", e);
        }
    }

    function collectCurrentStepData() {
        if (currentStep === 2) {
            const key = document.getElementById('wz-license-key').value.trim();
            if (key) wizardData.licenseKey = key;
        } else if (currentStep === 3) {
            wizardData.businessName = document.getElementById('wz-biz-name').value.trim() || 'My Print Shop';
            wizardData.ownerName = document.getElementById('wz-owner-name').value.trim();
            wizardData.phone = document.getElementById('wz-phone').value.trim() || '+91 98765 43210';
            wizardData.email = document.getElementById('wz-email').value.trim();
            wizardData.address = document.getElementById('wz-address').value.trim();
            wizardData.gstin = document.getElementById('wz-gstin').value.trim();
            wizardData.currency = document.getElementById('wz-currency').value;
        } else if (currentStep === 4) {
            wizardData.defaultPrinter = document.getElementById('wz-sel-main-printer').value;
            wizardData.photoPrinter = document.getElementById('wz-sel-photo-printer').value;
            wizardData.receiptPrinter = document.getElementById('wz-sel-receipt-printer').value;
        } else if (currentStep === 5) {
            const checked = Array.from(document.querySelectorAll('.wizard-step-pane[data-step="5"] input:checked')).map(el => el.value);
            wizardData.papers = checked;
        } else if (currentStep === 6) {
            const checked = Array.from(document.querySelectorAll('.wizard-step-pane[data-step="6"] input:checked')).map(el => el.value);
            wizardData.services = checked;
        } else if (currentStep === 7) {
            wizardData.bwPrice = parseFloat(document.getElementById('wz-price-bw').value) || 2.0;
            wizardData.colorPrice = parseFloat(document.getElementById('wz-price-color').value) || 10.0;
            wizardData.laminationPrice = parseFloat(document.getElementById('wz-price-lamination').value) || 20.0;
            wizardData.bindingPrice = parseFloat(document.getElementById('wz-price-binding').value) || 30.0;
            wizardData.photoPrice = parseFloat(document.getElementById('wz-price-photo').value) || 50.0;
            wizardData.scanPrice = parseFloat(document.getElementById('wz-price-scan').value) || 5.0;
        } else if (currentStep === 8) {
            wizardData.adminPin = (document.getElementById('wz-pin-admin') ? document.getElementById('wz-pin-admin').value : '').trim();
            wizardData.confirmAdminPin = (document.getElementById('wz-pin-admin-confirm') ? document.getElementById('wz-pin-admin-confirm').value : '').trim();
            wizardData.managerPin = (document.getElementById('wz-pin-manager') ? document.getElementById('wz-pin-manager').value : '').trim();
            wizardData.confirmManagerPin = (document.getElementById('wz-pin-manager-confirm') ? document.getElementById('wz-pin-manager-confirm').value : '').trim();
        } else if (currentStep === 9) {
            wizardData.backupFreq = document.getElementById('wz-backup-freq').value;
        }
    }

    function isWeakPin(pin) {
        if (!pin || pin.length < 6 || pin.length > 12 || !/^\d+$/.test(pin)) return true;
        if (/^(\d)\1+$/.test(pin)) return true;
        let asc = true, desc = true;
        for (let i = 1; i < pin.length; i++) {
            if (parseInt(pin[i], 10) !== (parseInt(pin[i-1], 10) + 1) % 10) asc = false;
            if (parseInt(pin[i], 10) !== (parseInt(pin[i-1], 10) - 1 + 10) % 10) desc = false;
        }
        return asc || desc;
    }

    function validateStep() {
        if (currentStep === 3) {
            const biz = document.getElementById('wz-biz-name').value.trim();
            if (!biz) {
                if (window.showToast) window.showToast('Please enter your Shop / Brand Name', 'warning');
                return false;
            }
        } else if (currentStep === 8) {
            const adminPin = (document.getElementById('wz-pin-admin') ? document.getElementById('wz-pin-admin').value : '').trim();
            const confirmAdmin = (document.getElementById('wz-pin-admin-confirm') ? document.getElementById('wz-pin-admin-confirm').value : '').trim();
            const opPin = (document.getElementById('wz-pin-manager') ? document.getElementById('wz-pin-manager').value : '').trim();
            const confirmOp = (document.getElementById('wz-pin-manager-confirm') ? document.getElementById('wz-pin-manager-confirm').value : '').trim();

            if (!/^\d{6,12}$/.test(adminPin)) {
                if (window.showToast) window.showToast('Administrator PIN must be between 6 and 12 digits', 'warning');
                return false;
            }
            if (isWeakPin(adminPin)) {
                if (window.showToast) window.showToast('Administrator PIN cannot be sequential (123456) or repeating (111111)', 'warning');
                return false;
            }
            if (adminPin !== confirmAdmin) {
                if (window.showToast) window.showToast('Administrator PIN confirmation does not match', 'warning');
                return false;
            }

            if (!/^\d{6,12}$/.test(opPin)) {
                if (window.showToast) window.showToast('Shop Operator PIN must be between 6 and 12 digits', 'warning');
                return false;
            }
            if (isWeakPin(opPin)) {
                if (window.showToast) window.showToast('Shop Operator PIN cannot be sequential (123456) or repeating (111111)', 'warning');
                return false;
            }
            if (opPin !== confirmOp) {
                if (window.showToast) window.showToast('Shop Operator PIN confirmation does not match', 'warning');
                return false;
            }

            if (adminPin === opPin) {
                if (window.showToast) window.showToast('Administrator PIN and Shop Operator PIN must be different', 'warning');
                return false;
            }
        }
        return true;
    }

    function renderReviewSummary() {
        collectCurrentStepData();
        const container = document.getElementById('wz-review-summary');
        if (!container) return;

        container.innerHTML = `
            <div class="wz-review-card">
                <h4>Business Info</h4>
                <p>${wizardData.businessName || 'My Print Shop'}</p>
                <div style="font-size: 0.82rem; color: var(--text-secondary); margin-top: 4px;">${wizardData.phone} • ${wizardData.currency}</div>
            </div>
            <div class="wz-review-card">
                <h4>Primary Printer</h4>
                <p>${wizardData.defaultPrinter || 'System Default Driver'}</p>
            </div>
            <div class="wz-review-card">
                <h4>Standard Rates</h4>
                <p>B&W: ${wizardData.currency}${wizardData.bwPrice} | Color: ${wizardData.currency}${wizardData.colorPrice}</p>
            </div>
            <div class="wz-review-card">
                <h4>Active Services</h4>
                <p>${(wizardData.services || []).length} Services Configured</p>
            </div>
        `;
    }

    async function generateWorkspace() {
        currentStep = 11;
        updateStepUI();

        const genState = document.getElementById('wz-generating-state');
        const celebState = document.getElementById('wz-celebration-state');
        if (genState) genState.style.display = 'block';
        if (celebState) celebState.style.display = 'none';

        try {
            if (window.api && window.api.completeWizardSetup) {
                const res = await window.api.completeWizardSetup(wizardData);
                if (!res.success) {
                    throw new Error(res.error || 'Failed to complete workspace generation');
                }
            }

            setTimeout(() => {
                if (genState) genState.style.display = 'none';
                if (celebState) celebState.style.display = 'block';
            }, 1200);
        } catch (err) {
            console.error("Workspace generation error:", err);
            if (window.showToast) window.showToast('Setup error: ' + err.message, 'error');
            currentStep = 10;
            updateStepUI();
        }
    }

    function bindEvents() {
        const btnNext = document.getElementById('wz-btn-next');
        const btnBack = document.getElementById('wz-btn-back');
        const btnSkip = document.getElementById('wz-btn-skip');
        const btnClose = document.getElementById('wizard-close-btn');

        if (btnNext) {
            btnNext.addEventListener('click', () => {
                if (!validateStep()) return;
                collectCurrentStepData();
                if (currentStep === 10) {
                    generateWorkspace();
                } else if (currentStep < 10) {
                    currentStep++;
                    updateStepUI();
                }
            });
        }

        if (btnBack) {
            btnBack.addEventListener('click', () => {
                if (currentStep > 1) {
                    currentStep--;
                    updateStepUI();
                }
            });
        }

        if (btnSkip) {
            btnSkip.addEventListener('click', () => {
                if (currentStep < 10) {
                    currentStep++;
                    updateStepUI();
                }
            });
        }

        if (btnClose) btnClose.addEventListener('click', closeWizard);

        // Step 1 Option Cards
        const optStart = document.getElementById('wz-opt-start');
        const optRestore = document.getElementById('wz-opt-restore');
        const optExit = document.getElementById('wz-opt-exit');

        if (optStart) optStart.addEventListener('click', () => { currentStep = 2; updateStepUI(); });
        if (optRestore) optRestore.addEventListener('click', () => {
            closeWizard();
            const dashBtn = document.querySelector('.nav-btn[data-target="settings"]');
            if (dashBtn) dashBtn.click();
        });
        if (optExit) optExit.addEventListener('click', closeWizard);

        // Selectable cards toggle
        document.querySelectorAll('.wz-selectable-card').forEach(card => {
            card.addEventListener('click', (e) => {
                const cb = card.querySelector('input[type="checkbox"]');
                if (cb && e.target !== cb) {
                    cb.checked = !cb.checked;
                }
                if (cb.checked) card.classList.add('active');
                else card.classList.remove('active');
            });
        });

        // Celebration screen buttons
        const btnFirstOrder = document.getElementById('wz-btn-create-first-order');
        const btnOpenDash = document.getElementById('wz-btn-open-dashboard');

        if (btnFirstOrder) {
            btnFirstOrder.addEventListener('click', () => {
                closeWizard();
                const shopBtn = document.querySelector('.role-btn[data-role="shop"]');
                if (shopBtn) shopBtn.click();
            });
        }

        if (btnOpenDash) {
            btnOpenDash.addEventListener('click', () => {
                closeWizard();
                const adminBtn = document.querySelector('.role-btn[data-role="admin"]');
                if (adminBtn) adminBtn.click();
            });
        }

        // Settings launcher button binding
        const runWizardSettingsBtn = document.getElementById('run-setup-wizard-btn');
        if (runWizardSettingsBtn) {
            runWizardSettingsBtn.addEventListener('click', openWizard);
        }
    }

    return {
        init,
        openWizard,
        closeWizard
    };
})();

document.addEventListener('DOMContentLoaded', () => {
    window.SetupWizard.init();
});
