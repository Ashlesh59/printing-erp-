let currentOrderConfig = null;
let currentFiles = [];
let fileSettings = [];
let activeSlotIndex = null;
let cropperInstance = null;

document.addEventListener('DOMContentLoaded', () => {
    const layoutImagesPerPage = document.getElementById('layout-images-per-page');
    const layoutPreviewContainer = document.getElementById('layout-preview-container');
    const layoutBackBtn = document.getElementById('layout-back-btn');
    
    const billTotalFiles = document.getElementById('bill-total-files');
    const billPrintedPages = document.getElementById('bill-printed-pages');
    const billCopies = document.getElementById('bill-copies');
    const billTotalCost = document.getElementById('bill-total-cost');
    
    const btnActionSavePrint = document.getElementById('btn-action-save-print');
    const btnActionSaveOnly = document.getElementById('btn-action-save-only');
    const btnActionPrintOnly = document.getElementById('btn-action-print-only');
    const btnActionSaveLater = document.getElementById('btn-action-save-later');

    const toolbar = document.createElement('div');
    toolbar.id = 'floating-toolbar';
    toolbar.style.position = 'absolute';
    toolbar.style.display = 'none';
    toolbar.style.background = 'var(--card-bg)';
    toolbar.style.padding = '8px';
    toolbar.style.borderRadius = '8px';
    toolbar.style.boxShadow = '0 10px 25px rgba(0,0,0,0.3)';
    toolbar.style.zIndex = '100';
    toolbar.style.display = 'flex';
    toolbar.style.gap = '8px';
    
    toolbar.innerHTML = `
        <button id="tool-rotate" class="action-btn" style="padding: 6px 10px; font-size: 0.9rem;">↻ Rotate</button>
        <button id="tool-fit" class="action-btn" style="padding: 6px 10px; font-size: 0.9rem;">⤢ Fit/Fill</button>
        <button id="tool-crop" class="action-btn" style="padding: 6px 10px; font-size: 0.9rem; background: var(--accent-color); color: white;">✂️ Crop</button>
    `;
    document.body.appendChild(toolbar);

    document.getElementById('tool-rotate').addEventListener('click', () => {
        if (activeSlotIndex !== null) {
            fileSettings[activeSlotIndex].rotate = (fileSettings[activeSlotIndex].rotate + 90) % 360;
            renderImageGridPreview();
        }
    });
    
    document.getElementById('tool-fit').addEventListener('click', () => {
        if (activeSlotIndex !== null) {
            fileSettings[activeSlotIndex].fit = fileSettings[activeSlotIndex].fit === 'contain' ? 'cover' : 'contain';
            renderImageGridPreview();
        }
    });

    document.getElementById('tool-crop').addEventListener('click', () => {
        if (activeSlotIndex !== null) {
            openCropModal(activeSlotIndex);
            toolbar.style.display = 'none';
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.preview-slot') && !e.target.closest('#floating-toolbar')) {
            activeSlotIndex = null;
            toolbar.style.display = 'none';
            renderImageGridPreview();
        }
    });

    const cropModal = document.getElementById('crop-modal');
    const closeCropModal = document.getElementById('close-crop-modal');
    const btnCancelCrop = document.getElementById('btn-cancel-crop');
    const btnSaveCrop = document.getElementById('btn-save-crop');
    const cropImageTarget = document.getElementById('crop-image-target');

    function openCropModal(index) {
        const fileData = fileSettings[index];
        cropImageTarget.src = fileData.croppedDataUrl || `app-file:///${fileData.file.path.replace(/\\/g, '/')}`;
        cropModal.style.display = 'flex';
        
        if (cropperInstance) cropperInstance.destroy();
        
        setTimeout(() => {
            cropperInstance = new Cropper(cropImageTarget, {
                viewMode: 1,
                dragMode: 'crop',
                autoCropArea: 0.8,
                restore: false,
                guides: true,
                center: true,
                highlight: false,
                cropBoxMovable: true,
                cropBoxResizable: true,
                toggleDragModeOnDblclick: false,
            });
        }, 100);
    }

    function closeCrop() {
        if (cropperInstance) cropperInstance.destroy();
        cropperInstance = null;
        cropModal.style.display = 'none';
    }

    if (closeCropModal) closeCropModal.addEventListener('click', closeCrop);
    if (btnCancelCrop) btnCancelCrop.addEventListener('click', closeCrop);
    
    if (btnSaveCrop) btnSaveCrop.addEventListener('click', () => {
        if (cropperInstance && activeSlotIndex !== null) {
            const canvas = cropperInstance.getCroppedCanvas();
            fileSettings[activeSlotIndex].croppedDataUrl = canvas.toDataURL('image/jpeg', 0.9);
            closeCrop();
            renderImageGridPreview();
        }
    });

    window.initLayoutEditor = (files, config) => {
        currentOrderConfig = config;
        
        const newFileSettings = files.map(f => {
            const existing = fileSettings.find(fs => fs.file.path === f.path);
            if (existing) return existing;
            return {
                file: f,
                rotate: 0,
                fit: 'contain',
                croppedDataUrl: null
            };
        });
        
        fileSettings = newFileSettings;
        currentFiles = files;
        window.currentOrderFiles = files;

        const layoutImagesPerPageEl = document.getElementById('layout-images-per-page');
        if (layoutImagesPerPageEl) {
            layoutImagesPerPageEl.disabled = false;
        }
        
        renderImageGridPreview();
        updateBill();
    };

    const layoutImagesPerPageEl = document.getElementById('layout-images-per-page');
    if (layoutImagesPerPageEl) {
        layoutImagesPerPageEl.addEventListener('change', () => {
            activeSlotIndex = null;
            toolbar.style.display = 'none';
            renderImageGridPreview();
            updateBill();
        });
    }

    if (layoutBackBtn) {
        layoutBackBtn.addEventListener('click', () => {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('order-setup').classList.add('active');
        });
    }

    function renderImageGridPreview() {
        if (!layoutPreviewContainer) return;
        layoutPreviewContainer.innerHTML = '';
        
        const nUpEl = document.getElementById('layout-images-per-page');
        const nUp = nUpEl ? (parseInt(nUpEl.value) || 1) : 1;
        
        let pageW = 420;
        let pageH = 594;
        if (currentOrderConfig && currentOrderConfig.paperSize === 'A3') {
            pageW = 594;
            pageH = 840;
        }

        let pages = [];
        let currentImageGroup = [];

        fileSettings.forEach((fsData, index) => {
            if (fsData.file.ext === '.pdf') {
                if (currentImageGroup.length > 0) {
                    pages.push({ type: 'images', items: currentImageGroup });
                    currentImageGroup = [];
                }
                pages.push({ type: 'pdf', item: fsData, index: index });
            } else {
                currentImageGroup.push({ fsData, index });
                if (currentImageGroup.length === nUp) {
                    pages.push({ type: 'images', items: currentImageGroup });
                    currentImageGroup = [];
                }
            }
        });
        if (currentImageGroup.length > 0) {
            pages.push({ type: 'images', items: currentImageGroup });
        }

        pages.forEach((pageData, pIdx) => {
            const pageDiv = document.createElement('div');
            pageDiv.style.width = `${pageW}px`; 
            pageDiv.style.height = `${pageH}px`;
            pageDiv.style.backgroundColor = 'white';
            pageDiv.style.margin = '0 auto 24px auto';
            pageDiv.style.boxShadow = '0 10px 20px rgba(0,0,0,0.15)';
            pageDiv.style.display = 'grid';
            pageDiv.style.padding = '10px';
            pageDiv.style.boxSizing = 'border-box';
            pageDiv.style.gap = '10px';
            pageDiv.style.position = 'relative';
            pageDiv.style.transition = 'width 0.3s, height 0.3s';
            
            if (pageData.type === 'pdf') {
                pageDiv.style.display = 'flex';
                pageDiv.style.justifyContent = 'center';
                pageDiv.style.alignItems = 'center';
                pageDiv.style.flexDirection = 'column';
                pageDiv.innerHTML = `
                    <div style="font-size: 3rem;">📄</div>
                    <h3 style="margin-top: 10px; color: var(--accent-color);">${pageData.item.file.name}</h3>
                    <p style="color: #64748b; margin-bottom: 12px;">PDF Document (Will be appended to job)</p>
                    <button class="ws-btn-secondary doc-edit-trigger-btn" style="padding: 6px 12px; font-size: 0.9rem; border-radius: 6px; border: 1.5px solid var(--border-color); background: rgba(255,255,255,0.05); color: var(--text-primary); cursor: pointer; display: flex; align-items: center; gap: 6px;">
                        ✏️ Edit in Doc Studio
                    </button>
                `;
                const editBtn = pageDiv.querySelector('.doc-edit-trigger-btn');
                if (editBtn) {
                    editBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (window.DocWorkspace && window.DocWorkspace.addFiles) {
                            const docStudioBtn = document.querySelector('.nav-btn[data-target="doc-studio"]');
                            if (docStudioBtn) docStudioBtn.click();
                            await window.DocWorkspace.addFiles([pageData.item.file]);
                        } else {
                            if (window.showToast) window.showToast('Doc Studio not initialized', 'error');
                        }
                    });
                }
                layoutPreviewContainer.appendChild(pageDiv);
                return;
            }

            if (nUp === 1) {
                pageDiv.style.gridTemplateColumns = '1fr';
                pageDiv.style.gridTemplateRows = '1fr';
            } else if (nUp === 2) {
                pageDiv.style.gridTemplateColumns = '1fr';
                pageDiv.style.gridTemplateRows = '1fr 1fr';
            } else if (nUp === 4) {
                pageDiv.style.gridTemplateColumns = '1fr 1fr';
                pageDiv.style.gridTemplateRows = '1fr 1fr';
            }

            for (let i = 0; i < nUp; i++) {
                const slot = document.createElement('div');
                slot.className = 'preview-slot';
                slot.style.border = '1px dashed #ccc';
                slot.style.display = 'flex';
                slot.style.justifyContent = 'center';
                slot.style.alignItems = 'center';
                slot.style.overflow = 'hidden';
                slot.style.position = 'relative';
                slot.style.transition = 'all 0.2s';
                slot.style.cursor = 'pointer';
                
                if (i < pageData.items.length) {
                    const itemData = pageData.items[i];
                    const imgData = itemData.fsData;
                    
                    if (activeSlotIndex === itemData.index) {
                        slot.style.border = '3px solid var(--accent-color)';
                        slot.style.boxShadow = 'inset 0 0 0 2px rgba(59,130,246,0.3)';
                    }

                    const img = document.createElement('img');
                    img.src = imgData.croppedDataUrl || `app-file:///${imgData.file.path.replace(/\\/g, '/')}`;
                    img.style.width = '100%';
                    img.style.height = '100%';
                    img.style.objectFit = imgData.fit;
                    img.style.transform = `rotate(${imgData.rotate}deg)`;
                    img.style.transition = 'transform 0.3s ease, object-fit 0.3s ease';
                    slot.appendChild(img);

                    slot.addEventListener('click', (e) => {
                        e.stopPropagation();
                        activeSlotIndex = itemData.index;
                        renderImageGridPreview();
                        
                        const rect = slot.getBoundingClientRect();
                        toolbar.style.display = 'flex';
                        toolbar.style.top = `${rect.top - 50 + window.scrollY}px`;
                        toolbar.style.left = `${rect.left + (rect.width/2) - (toolbar.offsetWidth/2) + window.scrollX}px`;
                    });
                }
                pageDiv.appendChild(slot);
            }
            layoutPreviewContainer.appendChild(pageDiv);
        });
    }

    function updateBill() {
        if (!currentOrderConfig) return;
        
        // If Doc Studio has a compiled output, sync directly from it!
        if (window.currentDocStudioOutput) {
            const printedPages = window.currentDocStudioOutput.totalPages;
            finalizeBill(currentFiles.length, printedPages);
            return;
        }

        let pdfPromises = [];
        const nUpEl = document.getElementById('layout-images-per-page');
        const nUp = nUpEl ? (parseInt(nUpEl.value) || 1) : 1;
        let currentImageCount = 0;

        fileSettings.forEach(fsData => {
            if (fsData.file.ext === '.pdf') {
                if (window.pdfjsLib) {
                    const encodedPath = encodeURI(fsData.file.path.replace(/\\/g, '/')).replace(/#/g, '%23');
                    const task = window.pdfjsLib.getDocument(`app-file:///${encodedPath}`);
                    pdfPromises.push(task.promise.then(pdf => pdf.numPages).catch(() => 1));
                } else {
                    pdfPromises.push(Promise.resolve(1));
                }
            } else {
                currentImageCount++;
            }
        });

        Promise.all(pdfPromises).then(pdfPageCounts => {
            const pdfPagesTotal = pdfPageCounts.reduce((a, b) => a + b, 0);
            const imagePagesTotal = Math.ceil(currentImageCount / nUp);
            const printedPages = pdfPagesTotal + imagePagesTotal;
            
            finalizeBill(fileSettings.length, printedPages);
        });
    }
    
    function finalizeBill(totalFiles, printedPages) {
        if (window.updateInvoiceTable) {
            window.updateInvoiceTable(totalFiles, printedPages);
        }
    }

    function getPrintPayload() {
        const list = getActiveFilesList();
        if (list && list.length > 0) {
            return list.map(fsData => {
                const fileObj = fsData.file || fsData;
                return {
                    path: fileObj.path || fsData.filePath || fsData.path || '',
                    ext: fileObj.ext || fsData.ext || (fileObj.name ? '.' + fileObj.name.split('.').pop() : '.pdf'),
                    rotate: fsData.rotate || 0,
                    fit: fsData.fit || 'contain',
                    croppedDataUrl: fsData.croppedDataUrl || null
                };
            });
        }
        if (typeof fileSettings !== 'undefined' && fileSettings && fileSettings.length > 0) {
            return fileSettings.map(fsData => ({
                path: fsData.file ? fsData.file.path : fsData.path,
                ext: fsData.file ? fsData.file.ext : (fsData.ext || '.pdf'),
                rotate: fsData.rotate || 0,
                fit: fsData.fit || 'contain',
                croppedDataUrl: fsData.croppedDataUrl || null
            }));
        }
        return [];
    }

    function getActiveConfig() {
        let cfg = (typeof currentOrderConfig !== 'undefined' && currentOrderConfig) ? currentOrderConfig : null;
        if (!cfg && window.currentOrderConfig) cfg = window.currentOrderConfig;
        if (!cfg && window.currentOrderConfigGlobal) cfg = window.currentOrderConfigGlobal;
        if (!cfg) cfg = {};

        return {
            name: cfg.name || cfg.customer_name || 'Guest Customer',
            phone: cfg.phone || cfg.customer_phone || '0000000000',
            paperSize: cfg.paperSize || cfg.print_paper_size || (cfg.paper ? cfg.paper.name : 'A4'),
            paper_size: cfg.paper_size || cfg.print_paper_size || cfg.paperSize || 'A4',
            printType: cfg.printType || cfg.print_color_mode || 'B&W',
            print_color_mode: cfg.print_color_mode || cfg.printType || 'B&W',
            sides: cfg.sides || cfg.print_duplex || 'Single',
            print_duplex: cfg.print_duplex || cfg.sides || 'Single',
            copies: parseInt(cfg.copies) || 1,
            default_printer: cfg.default_printer || 'Default',
            calculatedPrice: parseFloat(cfg.calculatedPrice || cfg.price || cfg.total_price || 0),
            product_id: cfg.product_id || null,
            print_profile_id: cfg.print_profile_id || null,
            specifications: cfg.specifications || {},
            extras: cfg.extras || [],
            paper: cfg.paper || null,
            ...cfg
        };
    }

    function getActiveFilesList() {
        if (typeof fileSettings !== 'undefined' && fileSettings && fileSettings.length > 0) return fileSettings;
        if (typeof currentFiles !== 'undefined' && currentFiles && currentFiles.length > 0) return currentFiles;
        if (window.currentOrderFiles && window.currentOrderFiles.length > 0) return window.currentOrderFiles;
        if (window.selectedFiles && window.selectedFiles.length > 0) return window.selectedFiles;
        if (window.currentDocStudioOutput) return [window.currentDocStudioOutput];
        return [];
    }

    async function ensureCustomer() {
        const cfg = getActiveConfig();
        const cName = cfg.name || 'Guest Customer';
        const cPhone = cfg.phone || '0000000000';
        const custResult = await window.api.createCustomer({ 
            name: cName, 
            phone: cPhone 
        });
        if (custResult.success) return custResult.id;
        throw new Error(custResult.error);
    }

    async function executePrint() {
        const cfg = getActiveConfig();
        const printerName = cfg.default_printer || 'Default';
        const printType = cfg.print_color_mode || cfg.printType;
        const paperSize = cfg.print_paper_size || cfg.paperSize;
        const sides = cfg.print_duplex || cfg.sides;
        const orientation = cfg.print_orientation || null;
        const quality = cfg.print_quality || null;

        const payload = window.currentDocStudioOutput ?
            [{ path: window.currentDocStudioOutput.filePath, ext: '.pdf', rotate: 0, fit: 'contain' }] :
            getPrintPayload();

        return await window.api.printFile(payload, {
            printerName,
            printType,
            copies: cfg.copies,
            sides,
            nUp: window.currentDocStudioOutput ? 1 : (document.getElementById('layout-images-per-page') ? (parseInt(document.getElementById('layout-images-per-page').value) || 1) : 1),
            paperSize,
            pageRange: cfg.pageRange || '',
            orientation,
            quality,
            printProfileId: cfg.print_profile_id || null,
            productId: cfg.product_id || null,
            isPdf: true
        });
    }

    async function executeSave(action = 'SAVE', scheduleDetails = null, paymentDetails = null) {
        const cfg = getActiveConfig();
        
        const printType = cfg.print_color_mode || cfg.printType;
        const paperSize = cfg.print_paper_size || cfg.paperSize;
        const sides = cfg.print_duplex || cfg.sides;

        const activeFiles = getActiveFilesList();
        let fileItemsRaw = [];
        if (window.currentDocStudioOutput) {
            fileItemsRaw = [{
                fileName: 'DocStudio_Compiled.pdf',
                filePath: window.currentDocStudioOutput.filePath,
                pages: window.currentDocStudioOutput.totalPages || 1
            }];
        } else {
            const pdfPromises = activeFiles.map(async (fsData) => {
                const fileObj = fsData.file || fsData;
                let pages = fsData.pages || fileObj.pages || fileObj.pageCount || 1;
                const filePath = fileObj.path || fsData.filePath || '';
                const fileName = fileObj.name || fsData.fileName || 'Attached_Document.pdf';
                if (pages === 1 && filePath.endsWith('.pdf')) {
                    if (window.pdfjsLib) {
                        try {
                            const encodedPath = encodeURI(filePath.replace(/\\/g, '/')).replace(/#/g, '%23');
                            const pdf = await window.pdfjsLib.getDocument(`app-file:///${encodedPath}`).promise;
                            pages = pdf.numPages;
                        } catch(e) {
                            pages = 1;
                        }
                    }
                }
                return {
                    fileName: fileName,
                    filePath: filePath,
                    pages: pages
                };
            });
            fileItemsRaw = await Promise.all(pdfPromises);
        }

        if (!fileItemsRaw || fileItemsRaw.length === 0) {
            fileItemsRaw = [{
                fileName: cfg.product_name || (paperSize ? `${paperSize} Print Job.pdf` : 'Print Job.pdf'),
                filePath: '',
                pages: 1
            }];
        }

        const layoutNUpEl = document.getElementById('layout-images-per-page');
        const layoutNUpVal = layoutNUpEl ? (parseInt(layoutNUpEl.value) || 1) : 1;

        const items = fileItemsRaw.map(fileItem => ({
            fileName: fileItem.fileName,
            filePath: fileItem.filePath,
            printType: printType,
            paperSize: paperSize,
            sides: sides,
            sourcePages: fileItem.pages,
            pages: fileItem.pages,
            nUp: layoutNUpVal,
            copies: cfg.copies || 1,
            paperId: cfg.paper ? cfg.paper.id : null,
            product_id: cfg.product_id || null,
            print_profile_id: cfg.print_profile_id || null,
            specifications: cfg.specifications || {},
            extras: cfg.extras ? cfg.extras.map(e => e.id || e) : []
        }));

        const submissionId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('sub_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9));

        const orderData = {
            submissionId: submissionId,
            action: action, // 'SAVE' | 'SAVE_AND_PRINT' | 'SCHEDULE'
            customerName: cfg.name || 'Walk-in Customer',
            customerPhone: cfg.phone || '',
            customerGstin: document.getElementById('setup-gstin')?.value.trim() || '',
            state: document.getElementById('setup-state')?.value || 'Local',
            default_printer: cfg.default_printer || 'Default',
            items: items,
            payment: paymentDetails || { amount: 0, method: 'Cash' },
            scheduleDetails: scheduleDetails,
            notes: cfg.product_id 
                ? Object.entries(cfg.specifications || {}).map(([k, v]) => `${k}: ${v}`).join(', ')
                : `Unified Engine. N-up: ${layoutNUpVal}`
        };

        const result = await (window.api.submitOrder ? window.api.submitOrder(orderData) : window.api.createOrder(orderData));
        if (!result || !result.success) {
            throw new Error(result ? result.error : 'Order submission failed');
        }

        return result;
    }

    let isWorkspaceActionBusy = false;
    let savedOrderIdForRetry = null;

    function setActionsDisabled(disabled) {
        const btnSave = document.getElementById('btn-action-save-only');
        const btnSavePrint = document.getElementById('btn-action-save-print');
        const btnPrintOnly = document.getElementById('btn-action-print-only');
        const btnSchedule = document.getElementById('btn-action-schedule');
        const schedConfirm = document.getElementById('sched-btn-confirm');

        [btnSave, btnSavePrint, btnPrintOnly, btnSchedule, schedConfirm].forEach(btn => {
            if (btn) btn.disabled = disabled;
        });
    }

    window.clearWorkspace = function() {
        savedOrderIdForRetry = null;
        if (typeof window.currentOrderFiles !== 'undefined') window.currentOrderFiles = [];
        if (typeof currentOrderFiles !== 'undefined') currentOrderFiles = [];
        if (typeof fileSettings !== 'undefined') fileSettings = [];
        if (typeof currentFiles !== 'undefined') currentFiles = [];
        window.currentDocStudioOutput = null;
        window.currentJobToSchedule = null;

        const layoutContainer = document.getElementById('preview-layout-container');
        if (layoutContainer) layoutContainer.innerHTML = '';

        const setupPhone = document.getElementById('setup-phone');
        const setupName = document.getElementById('setup-name');
        const setupGstin = document.getElementById('setup-gstin');
        const setupCopies = document.getElementById('setup-copies');
        if (setupPhone) setupPhone.value = '';
        if (setupName) setupName.value = '';
        if (setupGstin) setupGstin.value = '';
        if (setupCopies) setupCopies.value = '1';

        const btnViewHistory = document.getElementById('btn-view-history');
        if (btnViewHistory) btnViewHistory.style.display = 'none';

        const bn = document.getElementById('billing-customer-name');
        const bp = document.getElementById('billing-customer-phone');
        if (bn) bn.textContent = '—';
        if (bp) bp.textContent = '—';

        try {
            localStorage.removeItem('psm_draft_order_backup');
        } catch(e) {}

        const banner = document.getElementById('comp-status-banner');
        if (banner) banner.style.display = 'none';

        if (typeof renderAttachedFiles === 'function') renderAttachedFiles();
        if (typeof window.updateWorkspace === 'function') window.updateWorkspace();
        if (typeof goToStep === 'function') goToStep(1);
    };

    function cleanupAfterSuccess(targetView = 'dashboard') {
        savedOrderIdForRetry = null;
        if (currentOrderConfig && currentOrderConfig.phone) {
            try {
                localStorage.setItem(`prefs_${currentOrderConfig.phone}`, JSON.stringify({
                    paperSize: currentOrderConfig.paperSize,
                    printType: currentOrderConfig.printType
                }));
            } catch(e) {}
        }

        document.querySelectorAll('.file-checkbox').forEach(cb => cb.checked = false);
        const actionBar = document.getElementById('incoming-create-order-btn');
        if (actionBar) actionBar.style.display = 'none';

        window.clearWorkspace();

        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const targetViewEl = document.getElementById(targetView);
        if (targetViewEl) targetViewEl.classList.add('active');
        
        const targetBtn = document.querySelector(`.nav-btn[data-target="${targetView}"]`);
        if (targetBtn) targetBtn.click();
    }

    const btnActionSaveOnly = document.getElementById('btn-action-save-only');
    if (btnActionSaveOnly) {
        btnActionSaveOnly.addEventListener('click', async () => {
            if (isWorkspaceActionBusy) return;
            if (!validateOrderBeforeAction()) return;

            isWorkspaceActionBusy = true;
            setActionsDisabled(true);

            const banner = document.getElementById('comp-status-banner');
            const spinner = document.getElementById('comp-banner-spinner');
            const bannerText = document.getElementById('comp-banner-text');

            if (banner && bannerText) {
                banner.style.display = 'flex';
                banner.className = 'comp-status-banner';
                if (spinner) spinner.style.display = 'inline-block';
                bannerText.textContent = 'Validating order & saving to database...';
            }

            try {
                const res = await executeSave('SAVE');

                if (res && res.success) {
                    if (banner && bannerText) {
                        banner.className = 'comp-status-banner success';
                        if (spinner) spinner.style.display = 'none';
                        bannerText.textContent = `✅ Order #${res.orderId || ''} Saved & Invoiced!`;
                    }
                    if (window.showToast) window.showToast('Order saved to database successfully!', 'success');

                    if (window.refreshAllWorkspaces) window.refreshAllWorkspaces();
                    cleanupAfterSuccess('history');
                } else {
                    throw new Error(res ? res.error : 'Order save failed');
                }
            } catch (e) {
                if (banner && bannerText) {
                    banner.className = 'comp-status-banner error';
                    if (spinner) spinner.style.display = 'none';
                    bannerText.textContent = '❌ Save Failed: ' + (e.message || 'Unknown error');
                }
                if (window.showToast) window.showToast(e.message || 'Failed to save order', 'error');
            } finally {
                isWorkspaceActionBusy = false;
                setActionsDisabled(false);
            }
        });
    }

    const btnActionSavePrint = document.getElementById('btn-action-save-print');
    if (btnActionSavePrint) {
        btnActionSavePrint.addEventListener('click', async () => {
            if (isWorkspaceActionBusy) return;
            if (!validateOrderBeforeAction()) return;

            isWorkspaceActionBusy = true;
            setActionsDisabled(true);

            const banner = document.getElementById('comp-status-banner');
            const spinner = document.getElementById('comp-banner-spinner');
            const bannerText = document.getElementById('comp-banner-text');

            if (banner && bannerText) {
                banner.style.display = 'flex';
                banner.className = 'comp-status-banner';
                if (spinner) spinner.style.display = 'inline-block';
                bannerText.textContent = 'Saving order & spooling print job...';
            }

            try {
                let saveRes;
                if (!savedOrderIdForRetry) {
                    saveRes = await executeSave('SAVE_AND_PRINT');
                    if (!saveRes || !saveRes.success) {
                        throw new Error(saveRes ? saveRes.error : 'Order save failed');
                    }
                    savedOrderIdForRetry = saveRes.orderId;
                }

                const printResult = await executePrint();

                if (printResult && printResult.success) {
                    savedOrderIdForRetry = null;
                    if (banner && bannerText) {
                        banner.className = 'comp-status-banner success';
                        if (spinner) spinner.style.display = 'none';
                        bannerText.textContent = '✅ Order Saved, Invoiced & Print Queued!';
                    }
                    if (window.showToast) window.showToast('Order saved to database & print job queued!', 'success');

                    if (window.refreshAllWorkspaces) window.refreshAllWorkspaces();
                    cleanupAfterSuccess();
                } else {
                    const err = printResult ? printResult.error : 'Printer offline or failed to respond';
                    if (banner && bannerText) {
                        banner.className = 'comp-status-banner error';
                        if (spinner) spinner.style.display = 'none';
                        bannerText.textContent = `⚠️ Order #${savedOrderIdForRetry} saved, but Printer Failed: ${err}`;
                    }
                    if (window.showToast) window.showToast(`Order #${savedOrderIdForRetry} saved. Printer error: ${err}`, 'warning');
                    const cfg = getActiveConfig();
                    window.showPrinterErrorModal(err, getPrintPayload(), {
                        printerName: cfg.default_printer || 'Default',
                        printType: cfg.print_color_mode || cfg.printType,
                        paperSize: cfg.print_paper_size || cfg.paperSize,
                        sides: cfg.print_duplex || cfg.sides,
                        copies: cfg.copies || 1
                    });
                }
            } catch (e) {
                const isCancelled = e.message && (
                    e.message.toLowerCase().includes('cancel') ||
                    e.message.toLowerCase().includes('abort')
                );
                if (banner && bannerText) {
                    if (isCancelled) {
                        banner.className = 'comp-status-banner info';
                        if (spinner) spinner.style.display = 'none';
                        bannerText.textContent = 'ℹ️ Print job cancelled by user.';
                    } else {
                        banner.className = 'comp-status-banner error';
                        if (spinner) spinner.style.display = 'none';
                        bannerText.textContent = '❌ Failed: ' + (e.message || 'Unknown error');
                    }
                }
                if (window.showToast) {
                    window.showToast(isCancelled ? 'Print cancelled by user.' : (e.message || 'Error occurred'), isCancelled ? 'info' : 'error');
                }
            } finally {
                isWorkspaceActionBusy = false;
                setActionsDisabled(false);
            }
        });
    }

    const elBtnPrintOnly = document.getElementById('btn-action-print-only');
    if (elBtnPrintOnly) {
        elBtnPrintOnly.addEventListener('click', async () => {
            if (isWorkspaceActionBusy) return;
            if (!validateOrderBeforeAction()) return;

            isWorkspaceActionBusy = true;
            setActionsDisabled(true);

            const banner = document.getElementById('comp-status-banner');
            const spinner = document.getElementById('comp-banner-spinner');
            const bannerText = document.getElementById('comp-banner-text');

            if (banner && bannerText) {
                banner.style.display = 'flex';
                banner.className = 'comp-status-banner';
                if (spinner) spinner.style.display = 'inline-block';
                bannerText.textContent = 'Spooling document to printer (Direct Print Bypass)...';
            }

            try {
                const printResult = await executePrint();

                if (printResult && printResult.success) {
                    if (banner && bannerText) {
                        banner.className = 'comp-status-banner success';
                        if (spinner) spinner.style.display = 'none';
                        bannerText.textContent = '⚡ Direct Print Completed! No DB record saved.';
                    }
                    if (window.showToast) window.showToast('Direct print completed cleanly!', 'success');

                    window.clearWorkspace();
                } else {
                    const err = printResult ? printResult.error : 'Printer offline';
                    if (banner && bannerText) {
                        banner.className = 'comp-status-banner error';
                        if (spinner) spinner.style.display = 'none';
                        bannerText.textContent = '⚠️ Printer Offline. Opening Diagnostic Modal...';
                    }
                    const cfg = getActiveConfig();
                    window.showPrinterErrorModal(err, getPrintPayload(), {
                        printerName: cfg.default_printer || 'Default',
                        printType: cfg.print_color_mode || cfg.printType,
                        paperSize: cfg.print_paper_size || cfg.paperSize,
                        sides: cfg.print_duplex || cfg.sides,
                        copies: cfg.copies || 1
                    });
                }
            } catch (e) {
                const isCancelled = e.message && (
                    e.message.toLowerCase().includes('cancel') ||
                    e.message.toLowerCase().includes('abort')
                );
                if (banner && bannerText) {
                    if (isCancelled) {
                        banner.className = 'comp-status-banner info';
                        if (spinner) spinner.style.display = 'none';
                        bannerText.textContent = 'ℹ️ Print job cancelled by user.';
                    } else {
                        banner.className = 'comp-status-banner error';
                        if (spinner) spinner.style.display = 'none';
                        bannerText.textContent = '❌ Failed: ' + (e.message || 'Unknown error');
                    }
                }
                if (window.showToast) {
                    window.showToast(isCancelled ? 'Print cancelled by user.' : (e.message || 'Error occurred'), isCancelled ? 'info' : 'error');
                }
            } finally {
                isWorkspaceActionBusy = false;
                setActionsDisabled(false);
            }
        });
    }

    const elBtnSchedule = document.getElementById('btn-action-schedule');
    if (elBtnSchedule) {
        elBtnSchedule.addEventListener('click', () => {
            if (isWorkspaceActionBusy) return;
            if (!validateOrderBeforeAction()) return;

            const cfg = getActiveConfig();
            if (typeof window.openScheduleProductionModal === 'function') {
                window.openScheduleProductionModal(cfg);
            } else {
                const modal = document.getElementById('schedule-production-modal');
                if (modal) {
                    const titleEl = document.getElementById('sched-modal-order-title');
                    const custEl = document.getElementById('sched-modal-customer-name');
                    const activeFilesList = getActiveFilesList();
                    
                    if (titleEl) {
                        const first = activeFilesList[0];
                        const fname = first ? (first.name || first.fileName || (first.file ? first.file.name : null) || 'Print Job') : 'Print Job';
                        titleEl.textContent = fname;
                    }
                    if (custEl) custEl.textContent = 'Customer: ' + (cfg.name || cfg.phone || 'Walk-in Customer');
                    modal.style.setProperty('display', 'flex', 'important');
                    if (typeof window.renderMiniCalendar === 'function') window.renderMiniCalendar();
                }
            }
        });
    }

    const schedConfirmBtn = document.getElementById('sched-btn-confirm');
    if (schedConfirmBtn) {
        schedConfirmBtn.addEventListener('click', async () => {
            if (isWorkspaceActionBusy) return;
            isWorkspaceActionBusy = true;
            setActionsDisabled(true);

            const modal = document.getElementById('schedule-production-modal');
            const schedDate = document.getElementById('sched-input-date')?.value || new Date().toISOString().split('T')[0];
            const schedTime = document.getElementById('sched-input-time')?.value || '10:00';
            const operator = document.getElementById('sched-input-operator')?.value || 'Production Team';
            const priority = document.getElementById('sched-input-priority')?.value || 'Normal';

            const assignedPrinter = document.getElementById('sched-select-printer')?.value || '';
            const notes = document.getElementById('sched-input-notes')?.value || '';

            if (modal) modal.style.setProperty('display', 'none', 'important');

            const banner = document.getElementById('comp-status-banner');
            const spinner = document.getElementById('comp-banner-spinner');
            const bannerText = document.getElementById('comp-banner-text');

            if (banner && bannerText) {
                banner.style.display = 'flex';
                banner.className = 'comp-status-banner';
                if (spinner) spinner.style.display = 'inline-block';
                bannerText.textContent = 'Saving & scheduling job in Production Queue...';
            }

            try {
                const scheduledDateTime = `${schedDate} ${schedTime}:00`;
                const scheduleData = {
                    status: 'Waiting',
                    scheduledDate: schedDate,
                    scheduledTime: schedTime,
                    scheduledStart: scheduledDateTime,
                    dueTime: scheduledDateTime,
                    assignedPrinter: assignedPrinter,
                    operator: operator,
                    priority: priority,
                    notes: notes
                };

                if (window.currentJobToSchedule && (window.currentJobToSchedule.id || window.currentJobToSchedule.jobId)) {
                    const targetId = window.currentJobToSchedule.id || window.currentJobToSchedule.jobId;
                    if (window.api && window.api.productionScheduleJob) {
                        await window.api.productionScheduleJob(targetId, scheduleData);
                    } else {
                        throw new Error('productionScheduleJob API is not available');
                    }
                    window.currentJobToSchedule = null;
                } else {
                    if (typeof executeSave !== 'function') throw new Error('executeSave function is missing');
                    await executeSave('SCHEDULE', scheduleData);
                }

                if (typeof window.refreshAllWorkspaces === 'function') window.refreshAllWorkspaces();

                if (banner && bannerText) {
                    banner.className = 'comp-status-banner success';
                    if (spinner) spinner.style.display = 'none';
                    bannerText.textContent = `📅 Job Scheduled for ${schedDate} ${schedTime} (${operator}) & Synced to Production Queue!`;
                }
                if (window.showToast) window.showToast(`Job scheduled for ${schedDate} at ${schedTime} & synced to Production Queue!`, 'success');

                if (typeof cleanupAfterSuccess === 'function') {
                    cleanupAfterSuccess('production');
                }
            } catch(e) {
                console.error('[Schedule] Failed to schedule job:', e);
                if (banner && bannerText) {
                    banner.className = 'comp-status-banner error';
                    if (spinner) spinner.style.display = 'none';
                    bannerText.textContent = '❌ Scheduling Failed: ' + (e.message || 'Unknown error occurred');
                }
                if (window.showToast) window.showToast('Scheduling Failed: ' + (e.message || 'Unknown error'), 'error');
            } finally {
                isWorkspaceActionBusy = false;
                setActionsDisabled(false);
            }
        });
    }

    const schedCancelBtn = document.getElementById('sched-btn-cancel');
    const schedCloseBtn = document.getElementById('sched-modal-close-btn');
    [schedCancelBtn, schedCloseBtn].forEach(btn => {
        btn?.addEventListener('click', () => {
            const modal = document.getElementById('schedule-production-modal');
            if (modal) modal.style.setProperty('display', 'none', 'important');
        });
    });
});
