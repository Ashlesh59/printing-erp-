const { app, ipcMain } = require('electron');
const fs   = require('fs');
const path = require('path');
const { CustomerModel, OrderModel, SettingsModel } = require('./database/models');

// ──────────────────────────────────────────────────────────────
//  Runtime state
// ──────────────────────────────────────────────────────────────
let supabaseUrl  = '';
let supabaseKey  = '';
let shopId       = '';
let vercelUrl    = '';
let isSyncing    = false;
let syncInterval = null;
let mainWindowRef = null;

const POLL_INTERVAL_MS = 30_000;   // every 30 s
const BUCKET = 'order-files';

// ──────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────
const getIncomingPath = () => {
    const p = path.join(app.getPath('documents'), 'PrintShop', 'IncomingFiles');
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    return p;
};

/** Minimal Supabase REST helper — no SDK needed */
async function sbFetch(endpoint, options = {}) {
    const res = await fetch(`${supabaseUrl}/rest/v1/${endpoint}`, {
        ...options,
        headers: {
            apikey:        supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            Prefer:        options.prefer || '',
            ...(options.headers || {})
        }
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Supabase ${res.status}: ${body}`);
    }
    // 204 No Content → return null
    if (res.status === 204) return null;
    return res.json();
}

/** Download a file from Supabase Storage and return a Buffer */
async function downloadFile(fileUrl) {
    const res = await fetch(fileUrl, {
        headers: {
            apikey:        supabaseKey,
            Authorization: `Bearer ${supabaseKey}`
        }
    });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
}

// ──────────────────────────────────────────────────────────────
//  Init / Update
// ──────────────────────────────────────────────────────────────
function initCloudSync(mainWindow) {
    mainWindowRef = mainWindow;
    const s = SettingsModel.getSettings();
    if (s && s.cloud_url && s.shop_id) {
        supabaseUrl = s.cloud_url;
        supabaseKey = s.supabase_key || '';
        shopId      = s.shop_id;
        vercelUrl   = s.vercel_url  || '';
        if (supabaseUrl && supabaseKey && shopId) startPolling();
    }
}

function updateCloudSettings(url, key, id, vUrl) {
    supabaseUrl = url;
    supabaseKey = key;
    shopId      = id;
    vercelUrl   = vUrl || '';

    SettingsModel.updateSettings({ cloud_url: url, supabase_key: key, shop_id: id, vercel_url: vercelUrl });

    if (supabaseUrl && supabaseKey && shopId) {
        startPolling();
    } else {
        stopPolling();
    }
}

function getCloudSettings() {
    return { supabaseUrl, supabaseKey, shopId, vercelUrl, isRunning: syncInterval !== null };
}

// ──────────────────────────────────────────────────────────────
//  Polling
// ──────────────────────────────────────────────────────────────
function startPolling() {
    stopPolling();
    syncInterval = setInterval(pollOrders, POLL_INTERVAL_MS);
    setTimeout(pollOrders, 1000);   // immediate first poll
    console.log(`[Cloud Sync] Polling Supabase for shop "${shopId}" every ${POLL_INTERVAL_MS / 1000}s`);
}

function stopPolling() {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
        console.log('[Cloud Sync] Stopped.');
    }
}

// ──────────────────────────────────────────────────────────────
//  Core poll
// ──────────────────────────────────────────────────────────────
async function pollOrders() {
    if (isSyncing || !supabaseUrl || !supabaseKey || !shopId) return;
    isSyncing = true;

    try {
        // Fetch all pending orders for this shop
        const orders = await sbFetch(
            `pending_orders?shop_id=eq.${encodeURIComponent(shopId)}&status=eq.pending&order=created_at.asc`
        );

        if (!orders || orders.length === 0) return;

        console.log(`[Cloud Sync] Found ${orders.length} new order(s)`);

        for (const order of orders) {
            await processOrder(order);
        }
    } catch (err) {
        console.error('[Cloud Sync] Poll error:', err.message);
    } finally {
        isSyncing = false;
    }
}

// ──────────────────────────────────────────────────────────────
//  Process a single order
// ──────────────────────────────────────────────────────────────
async function processOrder(order) {
    try {
        // 1. Download file from Supabase Storage
        let filePath = null;
        let savedFileName = null;

        if (order.file_url) {
            const buffer = await downloadFile(order.file_url);
            const ext = path.extname(order.file_name || '.pdf') || '.pdf';
            const base = path.basename(order.file_name || 'order', ext)
                .replace(/[^a-z0-9]/gi, '_').toLowerCase();
            savedFileName = `${Date.now()}-cloud-${base}${ext}`;
            filePath = path.join(getIncomingPath(), savedFileName);
            fs.writeFileSync(filePath, buffer);
        }

        // 2. Upsert customer
        const custResult = CustomerModel.createCustomer(
            order.customer_name,
            order.customer_phone
        );
        if (!custResult.success) throw new Error(custResult.error);

        // 3. Insert Pending Order into local SQLite
        const orderResult = OrderModel.createOrder({
            customerId: custResult.id,
            fileName:   savedFileName  || order.file_name || 'Cloud Order',
            filePath:   filePath       || '',
            printType:  order.print_type  || 'bw',
            paperSize:  order.paper_size  || 'A4',
            sides:      'Single',
            pages:      1,
            copies:     order.copies || 1,
            price:      0,
            notes:      order.notes || '',
            status:     'Pending'
        });

        if (!orderResult.success) throw new Error(orderResult.error);

        // 4. Mark as processed in Supabase so we don't re-import it
        await sbFetch(`pending_orders?id=eq.${order.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'processed' }),
            prefer: 'return=minimal'
        });

        console.log(`[Cloud Sync] ✓ Imported order from ${order.customer_name} (${order.customer_phone})`);

        // 5. Notify renderer
        if (mainWindowRef) {
            mainWindowRef.webContents.send('new-mobile-order', {
                id:       orderResult.id,
                name:     order.customer_name,
                phone:    order.customer_phone,
                fileName: savedFileName || order.file_name
            });
        }

    } catch (err) {
        console.error(`[Cloud Sync] Failed to process order ${order.id}:`, err.message);
        // Don't mark as processed — will retry next poll
    }
}

// ──────────────────────────────────────────────────────────────
//  IPC Handlers
// ──────────────────────────────────────────────────────────────
function setupCloudIPC() {
    const { ROLES, registerGuardedHandler } = require('./security/ipc-guard');

    registerGuardedHandler('get-cloud-settings', ROLES.ADMIN, () => getCloudSettings());

    // Renderer sends { url, key, id, vercel }
    registerGuardedHandler('update-cloud-settings', ROLES.ADMIN, (event, { url, key, id, vercel }) => {
        updateCloudSettings(url, key, id, vercel);
        return { success: true };
    });
}

module.exports = { initCloudSync, setupCloudIPC };
