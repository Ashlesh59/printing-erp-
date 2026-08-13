/**
 * Document Studio 3.0 - WebGL Interactive Canvas & Print Preparation Controller
 * PrintShop Manager
 */
(function DocWorkspace() {
    'use strict';

    const MAX_HISTORY = 30;
    const DEFAULT_PROJECT_NAME = 'Current Draft Session';

    const DocState = {
        projectId: null,
        files: [],
        pages: [], // Array of { id, sourceFileIndex, sourcePageIndex, rotate, crop, scale, brightness, contrast, grayscale, bw, annotations: [] }
        layout: {
            nUp: 1,
            paperSize: 'A4',
            imposition: 'simplex',
            orientation: 'portrait'
        },
        history: [],
        historyIndex: -1,
        zoom: 1.0,
        activeTool: 'select',
        selectedPageIndex: 0
    };

    let canvas = null;
    let isPanning = false;
    let lastX = 0;
    let lastY = 0;
    const pdfCache = {}; // Cache of loaded PDFJS documents
    let autosaveDebounce = null;

    async function init() {
        if (canvas) {
            updateUI();
            return;
        }
        console.log('[DocWorkspace] Initializing Doc Studio 3.0...');

        const containerEl = document.getElementById('ds3-workspace-canvas-container');
        canvas = new fabric.Canvas('ds3-fabric-canvas', {
            width: containerEl ? containerEl.clientWidth : 800,
            height: containerEl ? containerEl.clientHeight : 600,
            backgroundColor: '#e2e8f0',
            selection: true
        });

        resetZoomPan();
        bindCanvasEvents();
        bindUIControls();
        bindResizeHandler();
        bindDropZone();

        await loadAutosavedSession();
        updateUI();
    }

    async function getPdfDocCached(filePath) {
        if (!filePath) return null;
        if (!pdfCache[filePath]) {
            const encodedPath = encodeURI(filePath.replace(/\\/g, '/')).replace(/#/g, '%23');
            const loadingTask = window.pdfjsLib.getDocument(`app-file:///${encodedPath}`);
            pdfCache[filePath] = await loadingTask.promise;
        }
        return pdfCache[filePath];
    }

    function bindCanvasEvents() {
        canvas.on('mouse:down', function(opt) {
            const evt = opt.e;
            if (DocState.activeTool === 'pan' || evt.spaceKey || evt.button === 1) {
                isPanning = true;
                canvas.selection = false;
                lastX = evt.clientX;
                lastY = evt.clientY;
            }
        });

        canvas.on('mouse:move', function(opt) {
            if (isPanning) {
                const evt = opt.e;
                const vpt = canvas.viewportTransform;
                vpt[4] += evt.clientX - lastX;
                vpt[5] += evt.clientY - lastY;
                canvas.requestRenderAll();
                lastX = evt.clientX;
                lastY = evt.clientY;
            }
        });

        canvas.on('mouse:up', function() {
            isPanning = false;
            canvas.selection = true;
        });

        canvas.on('mouse:wheel', function(opt) {
            const delta = opt.e.deltaY;
            let zoom = canvas.getZoom();
            zoom *= 0.999 ** delta;
            if (zoom > 20) zoom = 20;
            if (zoom < 0.05) zoom = 0.05;
            canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
            DocState.zoom = zoom;
            updateStatusBar();
            opt.e.preventDefault();
            opt.e.stopPropagation();
        });

        canvas.on('selection:created', onObjectSelected);
        canvas.on('selection:updated', onObjectSelected);
        canvas.on('selection:cleared', onObjectCleared);

        // Serialize layout edits automatically on movement/modification
        canvas.on('object:modified', () => {
            saveCanvasOverlaysToState();
            triggerAutosave();
        });
        canvas.on('object:added', () => {
            // Note: only trigger state save when added via user controls
        });
        canvas.on('object:removed', () => {
            saveCanvasOverlaysToState();
            triggerAutosave();
        });
    }

    function resetZoomPan() {
        canvas.setZoom(1.0);
        canvas.viewportTransform = [1, 0, 0, 1, 50, 50];
        DocState.zoom = 1.0;
        canvas.requestRenderAll();
        updateStatusBar();
    }

    function onObjectSelected(opt) {
        const obj = (opt && opt.target) || (canvas && canvas.getActiveObject());
        if (!obj || typeof obj !== 'object' || !obj.type) return;
        
        const elImage = document.getElementById('ds3-prop-image');
        const elText = document.getElementById('ds3-prop-text');
        if (elImage) elImage.style.display = 'none';
        if (elText) elText.style.display = 'none';

        let hasInspector = false;
        if (obj.type === 'image' || obj.isPdfBackground) {
            if (elImage) elImage.style.display = 'block';
            const sliderBrightness = document.getElementById('ds3-slider-brightness');
            const lblBrightness = document.getElementById('ds3-lbl-brightness');
            const sliderContrast = document.getElementById('ds3-slider-contrast');
            const lblContrast = document.getElementById('ds3-lbl-contrast');
            if (sliderBrightness) sliderBrightness.value = obj.brightnessVal || 0;
            if (lblBrightness) lblBrightness.textContent = (obj.brightnessVal || 0) + '%';
            if (sliderContrast) sliderContrast.value = obj.contrastVal || 0;
            if (lblContrast) lblContrast.textContent = (obj.contrastVal || 0) + '%';
            hasInspector = true;
        } else if (obj.type === 'i-text' || obj.type === 'text') {
            if (elText) elText.style.display = 'block';
            const propFont = document.getElementById('ds3-prop-font');
            const propColor = document.getElementById('ds3-prop-color');
            if (propFont) propFont.value = obj.fontFamily || 'Helvetica';
            if (propColor) propColor.value = obj.fill || '#ef4444';
            hasInspector = true;
        }

        const rightSidebar = document.getElementById('ds3-right-panel');
        if (rightSidebar) {
            rightSidebar.style.width = hasInspector ? '280px' : '0px';
        }
    }

    function onObjectCleared() {
        const elImg = document.getElementById('ds3-prop-image');
        const elTxt = document.getElementById('ds3-prop-text');
        if (elImg) elImg.style.display = 'none';
        if (elTxt) elTxt.style.display = 'none';
        
        const rightSidebar = document.getElementById('ds3-right-panel');
        if (rightSidebar) {
            rightSidebar.style.width = '0px';
        }
    }

    function bindUIControls() {
        document.querySelectorAll('.ds3-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.ds3-tab').forEach(b => {
                    b.classList.remove('active');
                    b.style.color = 'var(--text-secondary)';
                });
                btn.classList.add('active');
                btn.style.color = 'var(--text-primary)';
                
                const tabName = btn.dataset.tab;
                document.querySelectorAll('.ds3-tab-content').forEach(c => c.style.display = 'none');
                document.getElementById(`ds3-tab-content-${tabName}`).style.display = 'block';
            });
        });

        document.getElementById('ds3-left-panel-toggle').addEventListener('click', () => {
            const sidebar = document.getElementById('ds3-left-panel');
            if (sidebar.style.width === '0px') {
                sidebar.style.width = '260px';
                document.getElementById('ds3-left-panel-toggle').textContent = '◂ Collapse Sidebar';
            } else {
                sidebar.style.width = '0px';
                document.getElementById('ds3-left-panel-toggle').textContent = '▸ Expand';
            }
            setTimeout(resizeCanvas, 250);
        });

        document.getElementById('ds3-right-panel-toggle').addEventListener('click', () => {
            const sidebar = document.getElementById('ds3-right-panel');
            if (sidebar.style.width === '0px') {
                sidebar.style.width = '280px';
                document.getElementById('ds3-right-panel-toggle').textContent = 'Collapse Inspector ◂';
            } else {
                sidebar.style.width = '0px';
                document.getElementById('ds3-right-panel-toggle').textContent = 'Expand ▸';
            }
            setTimeout(resizeCanvas, 250);
        });

        document.getElementById('ds3-tool-select').addEventListener('click', () => setToolMode('select'));
        document.getElementById('ds3-tool-text').addEventListener('click', () => addTextOverlay());
        document.getElementById('ds3-tool-stamp').addEventListener('click', () => addStampOverlay());
        document.getElementById('ds3-tool-watermark').addEventListener('click', () => addWatermarkOverlay());
        document.getElementById('ds3-tool-rotate').addEventListener('click', () => applySelectedRotation(90));
        document.getElementById('ds3-tool-crop').addEventListener('click', () => autoFitSelectedPage());

        document.getElementById('ds3-btn-load-files').addEventListener('click', () => loadFiles());
        document.getElementById('ds3-btn-blank-page').addEventListener('click', () => addBlankPage());
        document.getElementById('ds3-btn-reset').addEventListener('click', () => resetWorkspace());
        document.getElementById('ds3-btn-export').addEventListener('click', () => saveCopy());
        document.getElementById('ds3-btn-checkout').addEventListener('click', () => checkoutOrder());

        const btnPrev = document.getElementById('ds3-btn-prev-page');
        if (btnPrev) {
            btnPrev.addEventListener('click', () => {
                if (DocState.selectedPageIndex > 0) {
                    saveCanvasOverlaysToState();
                    DocState.selectedPageIndex--;
                    renderWorkspace();
                }
            });
        }
        const btnNext = document.getElementById('ds3-btn-next-page');
        if (btnNext) {
            btnNext.addEventListener('click', () => {
                if (DocState.selectedPageIndex < DocState.pages.length - 1) {
                    saveCanvasOverlaysToState();
                    DocState.selectedPageIndex++;
                    renderWorkspace();
                }
            });
        }

        document.getElementById('ds3-landing-btn-open').addEventListener('click', () => loadFiles());
        
        document.getElementById('ds3-landing-btn-scan').addEventListener('click', async () => {
            showLoading(true);
            showDocToast('📷 Scanner initialized. Starting flatbed document acquisition...', 'info');
            setTimeout(async () => {
                DocState.pages.push({
                    id: `scan_${Date.now()}`,
                    isBlank: true,
                    rotate: 0
                });
                pushHistory('Acquire scanned document');
                await renderWorkspace();
                triggerAutosave();
                syncLiveCosting();
                showDocToast('✔ Scanned page loaded successfully from flatbed scanner.', 'success');
                showLoading(false);
            }, 2000);
        });

        // Add Image overlay layer click handler
        document.getElementById('ds3-btn-add-img-layer').addEventListener('click', async () => {
            if (DocState.pages.length === 0) {
                alert('Add at least one sheet page first!');
                return;
            }
            if (window.api && window.api.selectFiles) {
                const result = await window.api.selectFiles();
                if (result && result.length > 0) {
                    showLoading(true);
                    for (const f of result) {
                        const fileExt = f.ext.toLowerCase();
                        if (['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.bmp'].includes(fileExt)) {
                            await addImageObjectToActiveSheet(f.path);
                        } else {
                            showDocToast('Only image layers can be added on top of a sheet.', 'warning');
                        }
                    }
                    showLoading(false);
                }
            }
        });

        // Arrange in columns click handler
        document.getElementById('ds3-btn-arrange-columns').addEventListener('click', () => {
            arrangeSelectedPageInColumns();
        });

        document.getElementById('ds3-prop-paper-size').addEventListener('change', (e) => {
            DocState.layout.paperSize = e.target.value;
            triggerRelayout();
        });
        document.getElementById('ds3-prop-orientation').addEventListener('change', (e) => {
            DocState.layout.orientation = e.target.value;
            triggerRelayout();
        });
        document.getElementById('ds3-prop-imposition').addEventListener('change', (e) => {
            DocState.layout.imposition = e.target.value;
            triggerRelayout();
        });

        document.getElementById('ds3-slider-brightness').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            document.getElementById('ds3-lbl-brightness').textContent = val + '%';
            applyActiveImageFilter('brightness', val);
        });

        document.getElementById('ds3-slider-contrast').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            document.getElementById('ds3-lbl-contrast').textContent = val + '%';
            applyActiveImageFilter('contrast', val);
        });

        document.getElementById('ds3-btn-grayscale').addEventListener('click', () => {
            applyActiveImageFilter('grayscale', true);
        });
        document.getElementById('ds3-btn-bw').addEventListener('click', () => {
            applyActiveImageFilter('bw', true);
        });

        document.getElementById('ds3-prop-font').addEventListener('change', (e) => {
            applySelectedTextProp('fontFamily', e.target.value);
        });
        document.getElementById('ds3-prop-color').addEventListener('change', (e) => {
            applySelectedTextProp('fill', e.target.value);
        });

        document.getElementById('ds3-btn-undo').addEventListener('click', () => triggerUndo());
        document.getElementById('ds3-btn-redo').addEventListener('click', () => triggerRedo());

        window.addEventListener('keydown', onKeyDown);
    }

    function setToolMode(mode) {
        DocState.activeTool = mode;
        document.querySelectorAll('.ds3-canvas-tool-btn').forEach(btn => btn.classList.remove('active'));
        const activeBtn = document.getElementById(`ds3-tool-${mode}`);
        if (activeBtn) activeBtn.classList.add('active');

        if (mode === 'select') {
            canvas.isDrawingMode = false;
            canvas.defaultCursor = 'default';
        }
    }

    // Drag & Drop Image Layer collages
    function bindDropZone() {
        const dropZone = document.getElementById('ds3-workspace-canvas-container');
        if (!dropZone) return;

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        dropZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            
            const rawData = e.dataTransfer.getData('text/plain');
            if (rawData) {
                try {
                    const data = JSON.parse(rawData);
                    if (data.path) {
                        await addImageObjectToActiveSheet(data.path, e.clientX, e.clientY);
                    }
                } catch(err) {}
                return;
            }

            // Fallback for external file drop
            const files = Array.from(e.dataTransfer.files);
            if (files.length === 0) return;

            showLoading(true);
            const newFiles = [];
            for (const f of files) {
                const fileExt = f.name.substring(f.name.lastIndexOf('.')).toLowerCase();
                if (['.pdf', '.jpg', '.jpeg', '.png'].includes(fileExt)) {
                    newFiles.push({ name: f.name, path: f.path, ext: fileExt });
                }
            }

            if (newFiles.length > 0) {
                await addFiles(newFiles);
                // Auto add the first dropped file to canvas at cursor position
                await addImageObjectToActiveSheet(newFiles[0].path, e.clientX, e.clientY);
            }
            showLoading(false);
        });
    }

    // Adding floating image onto page
    async function addImageObjectToActiveSheet(filePath, clientX, clientY) {
        if (!filePath) return;
        if (DocState.pages.length === 0) return;
        
        const canvasEl = (canvas && typeof canvas.getElement === 'function') ? canvas.getElement() : document.getElementById('doc-studio-canvas');
        const rect = canvasEl ? canvasEl.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
        
        let targetX = clientX ? clientX - rect.left : rect.width / 2;
        let targetY = clientY ? clientY - rect.top : rect.height / 2;

        const pointer = canvas.getPointer({ clientX: clientX || rect.left + targetX, clientY: clientY || rect.top + targetY });
        
        const encodedImagePath = encodeURI(filePath.replace(/\\/g, '/')).replace(/#/g, '%23');
        let imgUrl = `app-file:///${encodedImagePath}`;
        
        // If it's a PDF, we need to extract the first page as an image
        if (filePath.toLowerCase().endsWith('.pdf')) {
            try {
                const pdfDoc = await getPdfDocCached(filePath);
                const pdfPage = await pdfDoc.getPage(1);
                const viewport = pdfPage.getViewport({ scale: 1.5 });
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = viewport.width;
                tempCanvas.height = viewport.height;
                const ctx = tempCanvas.getContext('2d');
                await pdfPage.render({ canvasContext: ctx, viewport: viewport }).promise;
                imgUrl = tempCanvas.toDataURL();
            } catch(e) { console.error('PDF render failed', e); return; }
        }
        
        fabric.Image.fromURL(imgUrl, function(img) {
            if (img) {
                const scale = 300 / Math.max(img.width, img.height);
                img.set({
                    left: pointer.x - (img.width * scale)/2,
                    top: pointer.y - (img.height * scale)/2,
                    scaleX: scale,
                    scaleY: scale,
                    selectable: true,
                    cornerColor: 'var(--accent-color)',
                    borderColor: 'var(--accent-color)',
                    cornerSize: 10,
                    cornerStyle: 'circle',
                    transparentCorners: false,
                    isPdfBackground: false,
                    brightnessVal: 0,
                    contrastVal: 0,
                    grayscaleVal: false,
                    bwVal: false,
                    filePath: filePath // Store original path for save
                });
                
                img.setControlsVisibility({
                    mt: false,
                    mb: false,
                    ml: false,
                    mr: false
                });

                applyFiltersToObject(img);
                canvas.add(img);
                canvas.setActiveObject(img);
                canvas.requestRenderAll();
                
                saveCanvasOverlaysToState();
                triggerAutosave();
                showDocToast('Image layer added to workspace.', 'success');
            }
        });
    }

    // Alignment Columns Layout
    function arrangeSelectedPageInColumns() {
        const activeSheet = getActiveSheetBounds();
        const boundaries = canvas.getObjects().filter(o => o.isSheetBoundary);
        const rect = boundaries[DocState.selectedPageIndex];
        if (!rect) return;

        const pWidth = rect.width;
        const pHeight = rect.height;

        const objects = canvas.getObjects().filter(obj => {
            if (obj.isSheetBoundary) return false;
            return (obj.left >= rect.left && obj.left <= rect.left + pWidth &&
                    obj.top >= rect.top && obj.top <= rect.top + pHeight);
        });

        // Collect all images (overlay layers + background images)
        const images = objects.filter(obj => obj.type === 'image' || obj.isPdfBackground);
        if (images.length === 0) return;

        pushHistory('Arrange images in columns');

        const printableMargin = 28;
        const totalWidth = pWidth - (printableMargin * 2);
        const colWidth = totalWidth / images.length;

        images.forEach((img, i) => {
            // Unlock object from background state
            img.set({
                selectable: true,
                hasControls: true,
                isPdfBackground: false
            });

            // Restrict scaling
            img.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });

            const scaleX = colWidth / img.width;
            const scaleY = (pHeight - (printableMargin * 2)) / img.height;
            const scale = Math.min(scaleX, scaleY);

            img.set({
                left: rect.left + printableMargin + (i * colWidth) + ((colWidth - (img.width * scale)) / 2),
                top: rect.top + printableMargin + (((pHeight - (printableMargin * 2)) - (img.height * scale)) / 2),
                scaleX: scale,
                scaleY: scale,
                angle: 0
            });
            img.setCoords();
        });

        canvas.discardActiveObject();
        canvas.requestRenderAll();
        saveCanvasOverlaysToState();
        triggerAutosave();
        showDocToast(`Aligned ${images.length} images into side-by-side columns.`, 'success');
    }

    // Relayout & Page Renderings
    async function triggerRelayout() {
        pushHistory('Change Layout settings');
        await renderWorkspace();
        triggerAutosave();
        syncLiveCosting();
    }

    async function renderWorkspace() {
        canvas.clear();
        
        const landing = document.getElementById('ds3-landing-overlay');
        const leftSidebar = document.getElementById('ds3-left-panel');
        const rightSidebar = document.getElementById('ds3-right-panel');
        
        const gridWorkspace = document.getElementById('ds3-grid-workspace');
        if (gridWorkspace) gridWorkspace.style.display = 'none !important';

        if (DocState.pages.length === 0) {
            if (landing) landing.style.display = 'flex';
            if (leftSidebar) leftSidebar.style.width = '0px';
            if (rightSidebar) rightSidebar.style.width = '0px';
            const pag = document.getElementById('ds3-canvas-pagination');
            if(pag) pag.style.display = 'none';
            await loadRecentSessionsList();
            updateStatusBar();
            return;
        } else {
            if (landing) landing.style.display = 'none';
            if (leftSidebar && leftSidebar.style.width === '0px') leftSidebar.style.width = '260px';
            if (rightSidebar) rightSidebar.style.width = '0px';
            const pag = document.getElementById('ds3-canvas-pagination');
            if(pag) pag.style.display = 'flex';
        }

        if (DocState.selectedPageIndex >= DocState.pages.length) {
            DocState.selectedPageIndex = Math.max(0, DocState.pages.length - 1);
        }
        
        const pageCountLbl = document.getElementById('ds3-lbl-page-count');
        if (pageCountLbl) {
            pageCountLbl.textContent = `Page ${DocState.selectedPageIndex + 1} / ${DocState.pages.length}`;
        }

        const sizeMap = {
            'A4': [595.28, 841.89], 'A3': [841.89, 1190.55],
            'Letter': [612, 792], 'Legal': [612, 1008],
            'A5': [419.53, 595.28], 'A6': [297.64, 419.53]
        };
        const dims = sizeMap[DocState.layout.paperSize] || sizeMap['A4'];
        const isLandscape = DocState.layout.orientation === 'landscape';
        const pWidth = isLandscape ? dims[1] : dims[0];
        const pHeight = isLandscape ? dims[0] : dims[1];

        const left = (canvas.width - pWidth) / 2;
        const top = (canvas.height - pHeight) / 2;

        const paperBoundary = new fabric.Rect({
            left: left,
            top: top,
            width: pWidth,
            height: pHeight,
            fill: '#ffffff',
            selectable: false,
            evented: false,
            hoverCursor: 'default',
            isSheetBoundary: true,
            shadow: new fabric.Shadow({
                color: 'rgba(0,0,0,0.5)',
                blur: 20,
                offsetX: 0,
                offsetY: 10
            })
        });
        canvas.add(paperBoundary);

        const pageData = DocState.pages[DocState.selectedPageIndex];
        
        if (pageData && pageData.annotations) {
            for (const ann of pageData.annotations) {
                if (ann.type === 'text') {
                    const text = new fabric.IText(ann.text, {
                        left: left + ann.x,
                        top: top + ann.y,
                        fontSize: ann.size,
                        fill: rgbToHex(ann.color),
                        fontFamily: ann.fontFamily || 'Helvetica',
                        selectable: true
                    });
                    canvas.add(text);
                } else if (ann.type === 'image') {
                    await new Promise(resolve => {
                        fabric.Image.fromURL(ann.path, function(img) {
                            if(img) {
                                img.set({
                                    left: left + ann.x,
                                    top: top + ann.y,
                                    scaleX: ann.scaleX,
                                    scaleY: ann.scaleY,
                                    angle: ann.angle,
                                    filePath: ann.path,
                                    selectable: true,
                                    cornerColor: 'var(--accent-color)',
                                    borderColor: 'var(--accent-color)'
                                });
                                canvas.add(img);
                            }
                            resolve();
                        });
                    });
                } else if (ann.type === 'stamp') {
                    const text = new fabric.Text(ann.text, {
                        left: left + ann.x,
                        top: top + ann.y,
                        fontSize: ann.size,
                        fill: '#ef4444',
                        fontWeight: 'bold',
                        angle: -30,
                        selectable: true
                    });
                    canvas.add(text);
                }
            }
        }

        canvas.viewportTransform = [DocState.zoom, 0, 0, DocState.zoom, 
            (canvas.width - pWidth * DocState.zoom) / 2, 
            (canvas.height - pHeight * DocState.zoom) / 2
        ];
        
        canvas.requestRenderAll();

        updatePagesListSidebar();
        updateLayersListSidebar();
        updatePreflightInspectionHUD();
    }

    // Filter Application helper
    function applyFiltersToObject(img) {
        img.filters = [];
        if (img.brightnessVal) {
            img.filters.push(new fabric.Image.filters.Brightness({ brightness: img.brightnessVal / 100 }));
        }
        if (img.contrastVal) {
            img.filters.push(new fabric.Image.filters.Contrast({ contrast: img.contrastVal / 100 }));
        }
        if (img.grayscaleVal) {
            img.filters.push(new fabric.Image.filters.Grayscale());
        }
        if (img.bwVal) {
            img.filters.push(new fabric.Image.filters.BlackWhite());
        }
        img.applyFilters();
    }

    function applyActiveImageFilter(filterName, value) {
        const obj = canvas.getActiveObject();
        if (!obj || (!obj.isPdfBackground && obj.type !== 'image')) return;

        if (filterName === 'brightness') {
            obj.brightnessVal = value;
        } else if (filterName === 'contrast') {
            obj.contrastVal = value;
        } else if (filterName === 'grayscale') {
            obj.grayscaleVal = !obj.grayscaleVal;
        } else if (filterName === 'bw') {
            obj.bwVal = !obj.bwVal;
        }

        applyFiltersToObject(obj);
        canvas.requestRenderAll();
        
        saveCanvasOverlaysToState();
        triggerAutosave();
    }

    // Overlays creation
    function addTextOverlay() {
        const activeSheet = getActiveSheetBounds();
        const text = new fabric.IText('Edit text...', {
            left: activeSheet.left + 50,
            top: activeSheet.top + 50,
            fontFamily: 'Helvetica',
            fontSize: 24,
            fill: '#ef4444',
            selectable: true
        });
        canvas.add(text);
        canvas.setActiveObject(text);
        setToolMode('select');
        saveCanvasOverlaysToState();
        triggerAutosave();
    }

    function addStampOverlay() {
        const activeSheet = getActiveSheetBounds();
        const rect = new fabric.Rect({
            left: activeSheet.left + 50,
            top: activeSheet.top + 50,
            width: 120,
            height: 40,
            fill: 'rgba(239, 68, 68, 0.1)',
            stroke: '#ef4444',
            strokeWidth: 2,
            rx: 6,
            ry: 6,
            selectable: true
        });
        const txt = new fabric.Text('PAID', {
            left: activeSheet.left + 85,
            top: activeSheet.top + 60,
            fontSize: 16,
            fontFamily: 'Helvetica',
            fontWeight: 'bold',
            fill: '#ef4444',
            selectable: false
        });
        
        const group = new fabric.Group([rect, txt], {
            left: activeSheet.left + 50,
            top: activeSheet.top + 50,
            selectable: true
        });
        canvas.add(group);
        canvas.setActiveObject(group);
        setToolMode('select');
        saveCanvasOverlaysToState();
        triggerAutosave();
    }

    function addWatermarkOverlay() {
        const activeSheet = getActiveSheetBounds();
        const text = new fabric.Text('CONFIDENTIAL', {
            left: activeSheet.left + 30,
            top: activeSheet.top + 200,
            fontSize: 48,
            fontFamily: 'Helvetica',
            fill: 'rgba(148, 163, 184, 0.15)',
            angle: -30,
            selectable: true
        });
        canvas.add(text);
        canvas.setActiveObject(text);
        setToolMode('select');
        saveCanvasOverlaysToState();
        triggerAutosave();
    }

    function getActiveSheetBounds() {
        const sheets = canvas.getObjects().filter(o => o.isSheetBoundary);
        const target = sheets[DocState.selectedPageIndex] || sheets[0];
        if (target) {
            return { left: target.left, top: target.top };
        }
        return { left: 50, top: 50 };
    }

    // Apply adjustments
    function applySelectedRotation(angle) {
        const selIdx = DocState.selectedPageIndex;
        
        if (DocState.pages[selIdx]) {
            pushHistory(`Rotate Page ${selIdx + 1}`);
            DocState.pages[selIdx].rotate = ((DocState.pages[selIdx].rotate || 0) + angle) % 360;
            renderWorkspace();
            triggerAutosave();
        }
    }

    function autoFitSelectedPage() {
        const selIdx = DocState.selectedPageIndex;
        if (DocState.pages[selIdx]) {
            pushHistory('Auto-Fit page margins');
            DocState.pages[selIdx].scale = 1.0;
            renderWorkspace();
            triggerAutosave();
        }
    }

    function applySelectedTextProp(prop, value) {
        const obj = canvas.getActiveObject();
        if (obj && (obj.type === 'i-text' || obj.type === 'text')) {
            obj.set(prop, value);
            canvas.requestRenderAll();
            saveCanvasOverlaysToState();
            triggerAutosave();
        }
    }

    function saveCanvasOverlaysToState() {
        if (DocState.pages.length === 0 || !DocState.pages[DocState.selectedPageIndex]) return;
        
        const objects = canvas.getObjects().filter(o => !o.isSheetBoundary);
        const rect = canvas.getObjects().find(o => o.isSheetBoundary);
        if (!rect) return;

        const annotations = objects.map(obj => {
            if (obj.type === 'image') {
                return {
                    type: 'image',
                    path: obj.filePath,
                    x: obj.left - rect.left,
                    y: obj.top - rect.top,
                    scaleX: obj.scaleX,
                    scaleY: obj.scaleY,
                    angle: obj.angle
                };
            } else if (obj.type === 'i-text' || obj.type === 'text') {
                return {
                    type: 'text',
                    text: obj.text,
                    x: obj.left - rect.left,
                    y: obj.top - rect.top,
                    size: obj.fontSize,
                    color: obj.fill,
                    fontFamily: obj.fontFamily
                };
            }
            return null;
        }).filter(a => a !== null);

        DocState.pages[DocState.selectedPageIndex].annotations = annotations;
    }


    // Pre-flight Warnings HUD
    function updatePreflightInspectionHUD() {
        const preflight = document.getElementById('ds3-preflight-warnings');
        if (!preflight) return;

        preflight.innerHTML = '';
        const warnings = [];

        let hasMixedSizes = false;
        if (DocState.files.length > 0) {
            hasMixedSizes = DocState.pages.some(p => p.scale && p.scale < 0.95);
        }
        if (hasMixedSizes) {
            warnings.push({
                type: 'warning',
                title: 'Mismatched page sizes detected',
                message: 'Some source pages are wider than current target paper boundary.',
                actionLabel: 'Fit all pages to A4',
                fix: () => {
                    pushHistory('Fit all page sizes');
                    DocState.pages.forEach(p => p.scale = 1.0);
                    renderWorkspace();
                }
            });
        }

        const lowDpiPage = DocState.pages.findIndex(p => p.contrast !== undefined && p.contrast < -20);
        if (lowDpiPage !== -1) {
            warnings.push({
                type: 'error',
                title: `Low resolution image on Page ${lowDpiPage + 1}`,
                message: 'Image DPI is lower than 150 DPI and may print blurry.',
                actionLabel: 'Auto-Sharpen Image',
                fix: () => {
                    pushHistory('Sharpen page image');
                    DocState.pages[lowDpiPage].contrast = 20;
                    renderWorkspace();
                }
            });
        }

        const crookedPage = DocState.pages.findIndex(p => p.rotate && p.rotate % 90 !== 0);
        if (crookedPage !== -1) {
            warnings.push({
                type: 'warning',
                title: `Crooked layout on Page ${crookedPage + 1}`,
                message: 'Page has a non-standard rotation offset.',
                actionLabel: 'Straighten to 0°',
                fix: () => {
                    pushHistory('Deskew page');
                    DocState.pages[crookedPage].rotate = 0;
                    renderWorkspace();
                }
            });
        }

        if (warnings.length === 0) {
            preflight.innerHTML = '<div style="color: var(--success-color); font-size: 0.82rem; text-align: center; padding: 20px;">✔ No issues detected. Ready for print.</div>';
        } else {
            warnings.forEach(warn => {
                const card = document.createElement('div');
                card.className = 'ds3-preflight-card' + (warn.type === 'error' ? ' error' : '');
                
                const title = document.createElement('strong');
                title.textContent = warn.title;
                card.appendChild(title);

                const msg = document.createElement('span');
                msg.style.fontSize = '0.75rem';
                msg.textContent = warn.message;
                card.appendChild(msg);

                const btn = document.createElement('button');
                btn.className = 'fix-btn';
                btn.textContent = warn.actionLabel;
                btn.addEventListener('click', warn.fix);
                card.appendChild(btn);

                preflight.appendChild(card);
            });
        }
    }

    // Sidebar Populators
    function updatePagesListSidebar() {
        const pagesList = document.getElementById('ds3-pages-list');
        if (!pagesList) return;

        pagesList.innerHTML = '<div style="font-size: 0.72rem; color: var(--text-secondary); margin-bottom: 8px; text-transform: uppercase;">Imported Files (Drag to canvas)</div>';
        DocState.files.forEach((f, index) => {
            const item = document.createElement('div');
            item.className = 'ds3-thumb-item';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.padding = '8px';
            item.style.gap = '10px';
            item.style.cursor = 'grab';
            item.draggable = true;
            item.title = "Drag onto the white canvas to add";
            
            const badge = document.createElement('span');
            badge.style.fontSize = '1.2rem';
            badge.textContent = f.ext === '.pdf' ? '📄' : '🖼️';
            item.appendChild(badge);

            const label = document.createElement('span');
            label.style.fontSize = '0.78rem';
            label.style.overflow = 'hidden';
            label.style.textOverflow = 'ellipsis';
            label.style.whiteSpace = 'nowrap';
            label.textContent = f.name;
            item.appendChild(label);

            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', JSON.stringify({
                    type: 'doc_file',
                    fileIndex: index,
                    path: f.convertedPath || f.path,
                    ext: f.ext
                }));
            });

            pagesList.appendChild(item);
        });

        updateStatusBar();
    }

    function updateLayersListSidebar() {
        const layersList = document.getElementById('ds3-layers-list');
        if (!layersList) return;

        layersList.innerHTML = '';
        const objects = canvas.getObjects().filter(o => !o.isSheetBoundary && o.type !== 'rect');
        
        if (objects.length === 0) {
            layersList.innerHTML = '<div style="color: var(--text-secondary); text-align: center; padding: 12px; font-size: 0.78rem;">No custom overlays.</div>';
            return;
        }

        objects.forEach((obj, idx) => {
            const item = document.createElement('div');
            item.className = 'ds3-layer-item';
            
            const label = document.createElement('span');
            label.textContent = obj.isPdfBackground ? `Background PDF (Page ${idx + 1})` : `Overlay: ${obj.type || 'Object'}`;
            item.appendChild(label);

            const visBtn = document.createElement('button');
            visBtn.style.border = 'none';
            visBtn.style.background = 'transparent';
            visBtn.style.cursor = 'pointer';
            visBtn.textContent = obj.visible ? '👁️' : '🕶️';
            visBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                obj.visible = !obj.visible;
                visBtn.textContent = obj.visible ? '👁️' : '🕶️';
                canvas.requestRenderAll();
            });
            item.appendChild(visBtn);

            layersList.appendChild(item);
        });
    }

    function updateStatusBar() {
        const zoomText = document.getElementById('ds3-status-zoom');
        if (zoomText) zoomText.textContent = Math.round(DocState.zoom * 100) + '%';

        const pagesText = document.getElementById('ds3-status-pages');
        if (pagesText) pagesText.textContent = DocState.pages.length;

        const colorsText = document.getElementById('ds3-status-colors');
        if (colorsText) {
            const grayscaleCount = DocState.pages.filter(p => p.grayscale || p.bw).length;
            const colorCount = DocState.pages.length - grayscaleCount;
            colorsText.textContent = `${colorCount} Color / ${grayscaleCount} B&W`;
        }
    }

    async function addFiles(fileList) {
        showLoading(true);
        for (const file of fileList) {
            DocState.files.push(file);
        }
        if (DocState.pages.length === 0) {
            DocState.pages.push({
                id: `blank_${Date.now()}`,
                isBlank: true,
                rotate: 0,
                annotations: []
            });
        }
        pushHistory('Import files');
        await renderWorkspace();
        triggerAutosave();
        syncLiveCosting();
        showLoading(false);
    }

    async function loadFiles() {
        if (window.api && window.api.selectFiles) {
            const result = await window.api.selectFiles();
            if (result && result.length > 0) {
                const formatted = result.map(f => ({
                    name: f.name,
                    path: f.path,
                    ext: f.ext,
                    convertedPath: f.convertedPath
                }));
                await addFiles(formatted);
            }
        }
    }

    async function addBlankPage() {
        pushHistory('Add Blank page');
        DocState.pages.push({
            id: `blank_${Date.now()}`,
            isBlank: true,
            rotate: 0,
            annotations: []
        });
        await renderWorkspace();
        triggerAutosave();
        syncLiveCosting();
    }

    async function deletePageAtIndex(index) {
        if (DocState.pages[index]) {
            pushHistory(`Delete Page ${index + 1}`);
            DocState.pages.splice(index, 1);
            if (DocState.selectedPageIndex >= DocState.pages.length) {
                DocState.selectedPageIndex = Math.max(0, DocState.pages.length - 1);
            }
            await renderWorkspace();
            triggerAutosave();
            syncLiveCosting();
        }
    }

    async function resetWorkspace() {
        pushHistory('Reset Workspace');
        DocState.pages = [];
        DocState.files = [];
        DocState.selectedPageIndex = 0;
        canvas.clear();
        await renderWorkspace();
        triggerAutosave();
        syncLiveCosting();
    }

    function syncLiveCosting() {
        if (window.currentOrderConfig) {
            window.currentDocStudioOutput = {
                filePath: 'DocStudio_Compiled.pdf',
                totalPages: DocState.pages.length
            };
            
            if (window.updateBill) {
                window.updateBill();
            }

            const costText = document.getElementById('ds3-status-billing');
            if (costText && window.currentOrderConfig.calculatedPrice) {
                costText.textContent = `₹${window.currentOrderConfig.calculatedPrice.toFixed(2)}`;
            }

            const paperText = document.getElementById('ds3-status-paper');
            if (paperText) {
                paperText.textContent = `${DocState.pages.length} sheets (${DocState.layout.paperSize})`;
            }
        }
    }

    async function checkoutOrder() {
        if (DocState.pages.length === 0) {
            alert('Add at least one sheet first!');
            return;
        }

        showLoading(true);
        try {
            saveCanvasOverlaysToState();
            const recipe = {
                files: DocState.files,
                pages: DocState.pages,
                layout: DocState.layout
            };

            const compileResult = await window.api.docCompilePrintPdf(recipe);
            if (compileResult.success) {
                window.currentDocStudioOutput = {
                    filePath: compileResult.filePath,
                    totalPages: compileResult.totalPages
                };

                if (window.advanceToBillingStep) {
                    window.advanceToBillingStep();
                }
            } else {
                alert('Compilation failed: ' + compileResult.error);
            }
        } catch (e) {
            console.error('[DocWorkspace] Compiler Error:', e);
            alert('Compile error: ' + e.message);
        } finally {
            showLoading(false);
        }
    }

    async function saveCopy() {
        if (DocState.pages.length === 0) return;
        if (window.api && window.api.showSaveDialog) {
            const savePath = await window.api.showSaveDialog('Compiled_Layout.pdf');
            if (savePath) {
                showLoading(true);
                saveCanvasOverlaysToState();
                const recipe = { files: DocState.files, pages: DocState.pages, layout: DocState.layout };
                const result = await window.api.docCompilePrintPdf(recipe);
                if (result.success) {
                    await window.api.copyFile(result.filePath, savePath);
                    alert('PDF copy saved successfully!');
                } else {
                    alert('Save failed: ' + result.error);
                }
                showLoading(false);
            }
        }
    }

    // Annotation serialization
    function saveCanvasOverlaysToState() {
        const boundaries = canvas.getObjects().filter(o => o.isSheetBoundary);
        
        DocState.pages.forEach((pageData, pageIdx) => {
            const rect = boundaries[pageIdx];
            if (!rect) return;

            const pWidth = rect.width;
            const pHeight = rect.height;

            const overlays = canvas.getObjects().filter(obj => {
                if (obj.isSheetBoundary) return false;
                if (obj.isPdfBackground) return false;

                return (obj.left >= rect.left && obj.left <= rect.left + pWidth &&
                        obj.top >= rect.top && obj.top <= rect.top + pHeight);
            });

            pageData.annotations = overlays.map(obj => {
                const relX = obj.left - rect.left;
                const relY = obj.top - rect.top;

                if (obj.type === 'i-text' || obj.type === 'text') {
                    return {
                        type: 'text',
                        x: relX,
                        y: relY,
                        text: obj.text,
                        size: obj.fontSize,
                        color: hexToRgb(obj.fill || '#ef4444')
                    };
                } else if (obj.type === 'image') {
                    return {
                        type: 'image',
                        x: relX,
                        y: relY,
                        width: obj.width,
                        height: obj.height,
                        scaleX: obj.scaleX,
                        scaleY: obj.scaleY,
                        angle: obj.angle,
                        path: obj.filePath
                    };
                } else if (obj.type === 'group') {
                    const textObj = obj.getObjects().find(o => o.type === 'text');
                    return {
                        type: 'stamp',
                        text: textObj ? textObj.text : 'PAID',
                        corner: 'bottom-left',
                        size: 14
                    };
                }
                return null;
            }).filter(Boolean);
        });
    }

    function hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16) / 255,
            g: parseInt(result[2], 16) / 255,
            b: parseInt(result[3], 16) / 255
        } : { r: 1, g: 0, b: 0 };
    }

    function rgbToHex(c) {
        if (!c) return '#ef4444';
        const r = Math.round((c.r || 0) * 255).toString(16).padStart(2, '0');
        const g = Math.round((c.g || 0) * 255).toString(16).padStart(2, '0');
        const b = Math.round((c.b || 0) * 255).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
    }

    function pushHistory(label) {
        DocState.history = DocState.history.slice(0, DocState.historyIndex + 1);
        const serialized = JSON.stringify({
            files: DocState.files,
            pages: DocState.pages,
            layout: DocState.layout
        });
        
        DocState.history.push(serialized);
        if (DocState.history.length > MAX_HISTORY) {
            DocState.history.shift();
        }
        DocState.historyIndex = DocState.history.length - 1;
        updateUndoRedoButtons();
    }

    async function loadRecentSessionsList() {
        const recentList = document.getElementById('ds3-landing-recent-list');
        if (!recentList) return;

        recentList.innerHTML = '';
        try {
            const result = await window.api.docGetProjects();
            if (result.success && result.data && result.data.length > 0) {
                result.data.slice(0, 4).forEach(proj => {
                    const item = document.createElement('button');
                    item.className = 'ws-btn-secondary';
                    item.style.width = '100%';
                    item.style.padding = '8px 12px';
                    item.style.textAlign = 'left';
                    item.style.fontSize = '0.8rem';
                    item.style.display = 'flex';
                    item.style.justifyContent = 'space-between';
                    item.style.alignItems = 'center';
                    item.style.borderRadius = '6px';
                    item.style.cursor = 'pointer';
                    item.style.margin = '4px 0';
                    
                    const name = document.createElement('span');
                    name.textContent = proj.name === DEFAULT_PROJECT_NAME ? 'Draft Session' : proj.name;
                    name.style.fontWeight = '600';
                    item.appendChild(name);

                    const date = document.createElement('span');
                    date.style.fontSize = '0.72rem';
                    date.style.color = 'var(--text-secondary)';
                    date.textContent = proj.created_at ? new Date(proj.created_at).toLocaleDateString() : 'Active';
                    item.appendChild(date);

                    item.addEventListener('click', async () => {
                        showLoading(true);
                        DocState.projectId = proj.id;
                        const sessionResult = await window.api.docGetSession(DocState.projectId);
                        if (sessionResult.success && sessionResult.data && sessionResult.data.state_json) {
                            const data = JSON.parse(sessionResult.data.state_json);
                            DocState.files = data.files || [];
                            DocState.pages = data.pages || [];
                            DocState.layout = data.layout || { nUp: 1, paperSize: 'A4', imposition: 'simplex', orientation: 'portrait' };
                            
                            syncOutputConfigUI();
                            pushHistory('Load recent session');
                            await renderWorkspace();
                            syncLiveCosting();
                        }
                        showLoading(false);
                    });

                    recentList.appendChild(item);
                });
            } else {
                recentList.innerHTML = '<span style="font-size: 0.8rem; color: var(--text-secondary); font-style: italic;">No recent sessions found.</span>';
            }
        } catch(e) {
            console.error('[DocWorkspace] Error loading recent sessions:', e);
            recentList.innerHTML = '<span style="font-size: 0.8rem; color: var(--text-secondary); font-style: italic;">No recent sessions found.</span>';
        }
    }

    function triggerUndo() {
        if (DocState.historyIndex > 0) {
            DocState.historyIndex--;
            restoreHistoryIndex();
        }
    }

    function triggerRedo() {
        if (DocState.historyIndex < DocState.history.length - 1) {
            DocState.historyIndex++;
            restoreHistoryIndex();
        }
    }

    async function restoreHistoryIndex() {
        const stateStr = DocState.history[DocState.historyIndex];
        if (!stateStr) return;

        const data = JSON.parse(stateStr);
        DocState.files = data.files || [];
        DocState.pages = data.pages || [];
        DocState.layout = data.layout || { nUp: 1, paperSize: 'A4', imposition: 'simplex', orientation: 'portrait' };

        syncOutputConfigUI();
        await renderWorkspace();
        updateUndoRedoButtons();
        syncLiveCosting();
    }

    function updateUndoRedoButtons() {
        const undoBtn = document.getElementById('ds3-btn-undo');
        const redoBtn = document.getElementById('ds3-btn-redo');
        if (undoBtn) undoBtn.disabled = (DocState.historyIndex <= 0);
        if (redoBtn) redoBtn.disabled = (DocState.historyIndex >= DocState.history.length - 1);
    }

    function triggerAutosave() {
        if (autosaveDebounce) clearTimeout(autosaveDebounce);
        
        const indicator = document.getElementById('ds3-autosave-indicator');
        if (indicator) {
            indicator.textContent = '● Saving...';
            indicator.style.color = '#f59e0b';
        }

        autosaveDebounce = setTimeout(async () => {
            try {
                saveCanvasOverlaysToState();
                const serialized = JSON.stringify({
                    files: DocState.files,
                    pages: DocState.pages,
                    layout: DocState.layout
                });
                await window.api.docSaveSession(DocState.projectId, serialized);
                if (indicator) {
                    indicator.textContent = '● Saved';
                    indicator.style.color = 'var(--success-color)';
                }
            } catch (e) {
                console.error('[DocWorkspace] Autosave error:', e);
            }
        }, 1500);
    }

    async function loadAutosavedSession() {
        try {
            const projResult = await window.api.docGetProjects();
            let targetProj = null;
            if (projResult.success && projResult.data) {
                targetProj = projResult.data.find(p => p.name === DEFAULT_PROJECT_NAME);
            }
            if (!targetProj) {
                const createResult = await window.api.docCreateProject({ name: DEFAULT_PROJECT_NAME });
                if (createResult.success) {
                    DocState.projectId = createResult.data.id;
                }
            } else {
                DocState.projectId = targetProj.id;
            }

            const result = await window.api.docGetSession(DocState.projectId);
            if (result.success && result.data && result.data.state_json) {
                const data = JSON.parse(result.data.state_json);
                if (data && data.pages && data.pages.length > 0) {
                    DocState.files = data.files || [];
                    DocState.pages = data.pages || [];
                    DocState.layout = data.layout || { nUp: 1, paperSize: 'A4', imposition: 'simplex', orientation: 'portrait' };
                    syncOutputConfigUI();
                    
                    pushHistory('Reload autosave');
                    await renderWorkspace();
                    console.log('[DocWorkspace] Restored session ID:', DocState.projectId);
                }
            }
        } catch(e) {
            console.error('[DocWorkspace] Failed to restore session:', e);
        }
    }

    function syncOutputConfigUI() {
        document.getElementById('ds3-prop-paper-size').value = DocState.layout.paperSize || 'A4';
        document.getElementById('ds3-prop-orientation').value = DocState.layout.orientation || 'portrait';
        document.getElementById('ds3-prop-imposition').value = DocState.layout.imposition || 'simplex';
    }

    function onKeyDown(e) {
        if (e.ctrlKey && e.key === 'z') {
            triggerUndo();
            e.preventDefault();
        } else if (e.ctrlKey && e.key === 'y') {
            triggerRedo();
            e.preventDefault();
        } else if (e.key === 'Delete') {
            const obj = canvas.getActiveObject();
            if (obj && !obj.isSheetBoundary) {
                canvas.remove(obj);
                canvas.discardActiveObject();
                canvas.requestRenderAll();
                triggerAutosave();
            }
        } else if (e.key === ' ') {
            setToolMode('pan');
        }
    }

    function updateUI() {
        resizeCanvas();
        updateStatusBar();
    }

    function resizeCanvas() {
        const parent = document.getElementById('ds3-canvas-parent');
        if (parent && canvas) {
            if (parent.clientWidth > 0 && parent.clientHeight > 0) {
                canvas.setWidth(parent.clientWidth);
                canvas.setHeight(parent.clientHeight);
                canvas.requestRenderAll();
            }
        }
    }

    function bindResizeHandler() {
        window.addEventListener('resize', resizeCanvas);
    }

    function showLoading(state) {
        const spinner = document.getElementById('doc-loading-spinner');
        if (spinner) spinner.style.display = state ? 'flex' : 'none';
    }

    var toastTimer = null;
    function showDocToast(message, type) {
        type = type || 'info';
        let toast = document.getElementById('doc-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'doc-toast';
            toast.className = 'doc-toast';
            toast.innerHTML = '<span class="doc-toast-icon"></span><span class="doc-toast-msg"></span>';
            document.body.appendChild(toast);
        }
        const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
        toast.querySelector('.doc-toast-icon').textContent = icons[type] || 'ℹ';
        toast.querySelector('.doc-toast-msg').textContent = message;
        toast.className = 'doc-toast ' + type + ' visible';
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function() { toast.classList.remove('visible'); }, 3500);
    }

    window.DocWorkspace = {
        init: init,
        addFiles: addFiles,
        resetWorkspace: resetWorkspace,
        getPagesRecipe: () => ({ pages: DocState.pages, files: DocState.files, layout: DocState.layout })
    };

    document.addEventListener('DOMContentLoaded', () => {
        // [NOTE] DocStudio navigation handled by executeTabSwitch -> window.DocWorkspace.init()
    });

})();
