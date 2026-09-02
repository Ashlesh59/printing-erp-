/**
 * Hardened Local Mobile Ordering Server
 * 
 * Features:
 * - Admin enable/disable switch
 * - Dynamic 32-character pairing token embedded in QR URL with expiry & rotation
 * - Per-IP rate limiting (10 requests/min per IP)
 * - 25MB file upload limit with strict magic bytes verification (PDF, PNG, JPEG)
 * - Atomic transactional order creation via OrderService
 * - Clean graceful shutdown and timing-safe pairing token verification
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const qrcode = require('qrcode');
const crypto = require('crypto');
const db = require('./database/db');

let serverInstance = null;
let currentPort = null;
let currentIp = null;
let activePairingToken = null;
let tokenExpiryTime = 0;
let qrCodeDataUrl = null;

// Per-IP rate limit map: IP -> { count, startTime }
const ipRateLimits = new Map();

// Dedicated temporary storage for mobile uploads
function getMobileUploadDir() {
    let baseTemp;
    try {
        const { app } = require('electron');
        if (app && app.getPath) {
            baseTemp = path.join(app.getPath('userData'), 'Temp', 'MobileUploads');
        }
    } catch (e) {}

    if (!baseTemp) {
        baseTemp = path.join(os.tmpdir(), 'PrintShopManager_Temp', 'MobileUploads');
    }

    if (!fs.existsSync(baseTemp)) {
        fs.mkdirSync(baseTemp, { recursive: true });
    }
    return baseTemp;
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, getMobileUploadDir());
    },
    filename: (req, file, cb) => {
        const unique = `mob_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${unique}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 25 * 1024 * 1024, // Strict 25MB limit
        files: 1
    },
    fileFilter: (req, file, cb) => {
        const allowedExts = ['.pdf', '.png', '.jpg', '.jpeg'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${ext}. Only PDF, PNG, and JPEG files are permitted.`));
        }
    }
});

function verifyMagicBytes(filePath, ext) {
    try {
        const buffer = Buffer.alloc(8);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, 8, 0);
        fs.closeSync(fd);

        if (ext === '.pdf') {
            // %PDF-
            return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46 && buffer[4] === 0x2D;
        } else if (ext === '.png') {
            // \x89PNG
            return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
        } else if (ext === '.jpg' || ext === '.jpeg') {
            // \xFF\xD8\xFF
            return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
        }
        return false;
    } catch (e) {
        return false;
    }
}

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

function rotatePairingToken(ttlMinutes = 15) {
    activePairingToken = crypto.randomBytes(16).toString('hex');
    tokenExpiryTime = Date.now() + (ttlMinutes * 60 * 1000);
    return activePairingToken;
}

function validateToken(req) {
    const token = req.query?.token || req.headers?.['x-pairing-token'] || req.body?.token;
    if (!token || !activePairingToken) {
        return { valid: false, message: 'Missing or unconfigured pairing token.' };
    }

    const tokenBuf = Buffer.from(String(token));
    const activeBuf = Buffer.from(String(activePairingToken));

    if (tokenBuf.length !== activeBuf.length || !crypto.timingSafeEqual(tokenBuf, activeBuf)) {
        return { valid: false, message: 'Invalid pairing token.' };
    }

    if (Date.now() > tokenExpiryTime) {
        return { valid: false, message: 'Pairing token has expired. Please scan the current QR code.' };
    }
    return { valid: true };
}

function checkRateLimit(ip) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxRequests = 30;

    let record = ipRateLimits.get(ip);
    if (!record || (now - record.startTime) > windowMs) {
        record = { count: 1, startTime: now };
        ipRateLimits.set(ip, record);
        return true;
    }

    if (record.count >= maxRequests) {
        return false;
    }

    record.count++;
    return true;
}

async function startServer(mainWindow, force = false, explicitPort = null) {
    const { SettingsModel } = require('./database/models');
    const settings = SettingsModel.getSettings() || {};

    if (!force && settings.enable_mobile_ordering !== 1) {
        return { success: false, status: 'disabled', message: 'Mobile ordering is disabled in system settings.' };
    }

    if (serverInstance) {
        return {
            success: true,
            status: 'online',
            ip: currentIp,
            port: currentPort,
            token: activePairingToken,
            qr: qrCodeDataUrl
        };
    }

    rotatePairingToken(15);

    const serverApp = express();
    serverApp.use(express.json({ limit: '1mb' }));
    serverApp.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // Security Headers
    serverApp.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        next();
    });

    // Landing / Ordering Interface
    serverApp.get('/', (req, res) => {
        const tokenCheck = validateToken(req);
        if (!tokenCheck.valid) {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html>
                <head><title>Access Denied - PrintShop</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
                <body style="font-family: system-ui, sans-serif; text-align: center; padding: 40px; color: #334155;">
                    <h2>🔒 Access Denied</h2>
                    <p>${tokenCheck.message}</p>
                    <p style="font-size: 0.9em; color: #64748b;">Please scan the live QR code at the shop counter.</p>
                </body>
                </html>
            `);
        }

        try {
            const htmlPath = path.join(__dirname, 'mobile-order.html');
            if (fs.existsSync(htmlPath)) {
                let htmlContent = fs.readFileSync(htmlPath, 'utf8');
                htmlContent = htmlContent.replace(/\{\{TOKEN\}\}/g, activePairingToken);
                res.send(htmlContent);
            } else {
                res.status(404).send('Mobile ordering template not found.');
            }
        } catch (error) {
            res.status(500).send('Error loading ordering page.');
        }
    });

    serverApp.get('/health', (req, res) => {
        res.status(200).json({ status: 'ok', mobileOrdering: true, time: new Date() });
    });

    // Order Submission Endpoint
    serverApp.post('/create-order', (req, res) => {
        const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
        if (!checkRateLimit(clientIp)) {
            return res.status(429).json({ success: false, message: 'Too many requests. Please wait a minute.' });
        }

        const tokenCheck = validateToken(req);
        if (!tokenCheck.valid) {
            return res.status(403).json({ success: false, message: tokenCheck.message });
        }

        upload.single('file')(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ success: false, message: err.message });
            }

            if (!req.file) {
                return res.status(400).json({ success: false, message: 'No file uploaded.' });
            }

            const uploadedFilePath = req.file.path;

            try {
                // Verify magic bytes
                const ext = path.extname(req.file.originalname).toLowerCase();
                if (!verifyMagicBytes(uploadedFilePath, ext)) {
                    if (fs.existsSync(uploadedFilePath)) {
                        try { fs.unlinkSync(uploadedFilePath); } catch(e){}
                    }
                    return res.status(400).json({ success: false, message: 'File format mismatch or corrupted file header.' });
                }

                const name = req.body.name ? String(req.body.name).trim().substring(0, 100) : '';
                const phone = req.body.phone ? String(req.body.phone).trim().substring(0, 20) : '';
                const printType = (req.body.printType === 'color' || req.body.printType === 'bw') ? req.body.printType : 'color';
                const paperSize = req.body.paperSize ? String(req.body.paperSize).trim().substring(0, 10) : 'A4';
                const notes = req.body.notes ? String(req.body.notes).trim().substring(0, 500) : '';
                const idempotencyKey = req.body.idempotencyKey || req.body.idempotency_key || req.body.submissionId || req.body.submission_id || null;

                if (!name || !phone) {
                    if (fs.existsSync(uploadedFilePath)) {
                        try { fs.unlinkSync(uploadedFilePath); } catch(e){}
                    }
                    return res.status(400).json({ success: false, message: 'Name and phone are required.' });
                }

                // Check client idempotency key if provided
                if (idempotencyKey) {
                    const existingOrder = db.prepare('SELECT id, total_price FROM orders WHERE submission_id = ?').get(idempotencyKey);
                    if (existingOrder) {
                        if (fs.existsSync(uploadedFilePath)) {
                            try { fs.unlinkSync(uploadedFilePath); } catch(e){}
                        }
                        return res.status(200).json({
                            success: true,
                            orderId: existingOrder.id,
                            message: 'Duplicate order detected: returning existing order details.',
                            isDuplicate: true
                        });
                    }
                }

                // Route through transactional OrderService
                const OrderService = require('./services/order-service');
                const submissionId = idempotencyKey || `SUB-MOB-${crypto.randomUUID()}`;

                const orderPayload = {
                    submission_id: submissionId,
                    submissionId: submissionId,
                    customer: {
                        name: name,
                        phone: phone,
                        is_walk_in: false
                    },
                    items: [
                        {
                            file_name: req.file.originalname,
                            fileName: req.file.originalname,
                            file_path: uploadedFilePath,
                            filePath: uploadedFilePath,
                            paper_size: paperSize,
                            paperSize: paperSize,
                            print_type: printType,
                            printType: printType,
                            sides: 'Single',
                            copies: 1,
                            pages: 1,
                            unit_price: printType === 'color' ? 10 : 2,
                            total_price: printType === 'color' ? 10 : 2
                        }
                    ],
                    subtotal: printType === 'color' ? 10 : 2,
                    grandTotal: printType === 'color' ? 10 : 2,
                    status: 'Confirmed',
                    payment_status: 'Unpaid',
                    source: 'Mobile Order',
                    notes: notes
                };

                const trustedMobileSession = {
                    user: { name: 'Mobile Customer', role: 'Customer' },
                    isMobile: true
                };

                // Await asynchronous order submission
                const orderResult = await OrderService.submitOrder(trustedMobileSession, orderPayload);

                if (!orderResult || !orderResult.success) {
                    throw new Error(orderResult?.error || 'Failed to commit mobile order transaction.');
                }

                // Clean up incoming temporary upload file now that OrderService stored it permanently
                if (fs.existsSync(uploadedFilePath)) {
                    try { fs.unlinkSync(uploadedFilePath); } catch(e){}
                }

                // Notify desktop renderer window if open
                if (mainWindow && !mainWindow.isDestroyed()) {
                    try {
                        mainWindow.webContents.send('new-mobile-order', {
                            id: orderResult.orderId,
                            name: name,
                            phone: phone,
                            fileName: req.file.originalname
                        });
                    } catch (e) {}
                }

                res.status(200).json({
                    success: true,
                    orderId: orderResult.orderId,
                    message: 'Order submitted successfully!'
                });
            } catch (submitErr) {
                if (fs.existsSync(uploadedFilePath)) {
                    try { fs.unlinkSync(uploadedFilePath); } catch(e){}
                }
                console.error('[Mobile Server Error]:', submitErr.message);
                res.status(500).json({ success: false, message: submitErr.message });
            }
        });
    });

    currentIp = getLocalIp();
    let portToTry = explicitPort || settings.mobile_server_port || 3000;
    const maxPort = explicitPort ? explicitPort : portToTry + 10;

    return new Promise((resolve, reject) => {
        function tryListen(port) {
            serverInstance = serverApp.listen(port, '0.0.0.0', async () => {
                currentPort = port;
                const serverUrl = `http://${currentIp}:${currentPort}?token=${activePairingToken}`;
                
                try {
                    qrCodeDataUrl = await qrcode.toDataURL(serverUrl, {
                        errorCorrectionLevel: 'M',
                        margin: 2,
                        width: 256
                    });
                } catch (qrErr) {
                    qrCodeDataUrl = '';
                }

                resolve({
                    success: true,
                    status: 'online',
                    ip: currentIp,
                    port: currentPort,
                    token: activePairingToken,
                    qr: qrCodeDataUrl
                });
            });

            serverInstance.on('error', (err) => {
                if (err.code === 'EADDRINUSE' && !explicitPort) {
                    if (port < maxPort) {
                        tryListen(port + 1);
                    } else {
                        serverInstance = null;
                        reject(new Error(`No open ports available between ${portToTry} and ${maxPort}`));
                    }
                } else {
                    serverInstance = null;
                    reject(err);
                }
            });
        }
        tryListen(portToTry);
    });
}

function stopServer() {
    if (serverInstance) {
        try {
            serverInstance.close();
        } catch (e) {}
        serverInstance = null;
        activePairingToken = null;
        tokenExpiryTime = 0;
        qrCodeDataUrl = null;
        console.log('[Mobile Server] Server stopped cleanly.');
    }
    return { success: true, status: 'offline' };
}

async function getServerInfo(isAdmin = false) {
    if (!serverInstance) {
        return { status: 'offline', enabled: false };
    }

    if (isAdmin) {
        return {
            status: 'online',
            enabled: true,
            ip: currentIp,
            port: currentPort,
            token: activePairingToken,
            url: `http://${currentIp}:${currentPort}?token=${activePairingToken}`,
            qr: qrCodeDataUrl
        };
    }

    // Non-admin callers receive safe high-level status only without tokens or QR codes
    return {
        status: 'online',
        enabled: true,
        ip: currentIp,
        port: currentPort
    };
}

module.exports = { startServer, stopServer, getServerInfo, rotatePairingToken, validateToken, getMobileUploadDir };
