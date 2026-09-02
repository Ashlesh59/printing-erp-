const express = require('express');
const multer = require('multer');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const qrcode = require('qrcode');
const { app } = require('electron');
const db = require('./database/db');

let serverInstance = null;
let currentPort = null;
let currentIp = null;
let qrCodeDataUrl = null;
let activePairingToken = null;
let tokenExpiryTime = 0;

// Rate limiting store (In-memory per IP)
const ipRateLimits = new Map();

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        if (name.toLowerCase().includes('vmware') || 
            name.toLowerCase().includes('virtual') || 
            name.toLowerCase().includes('wsl') || 
            name.toLowerCase().includes('veth') ||
            name.toLowerCase().includes('loopback')) {
            continue;
        }

        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const getIncomingPath = () => {
    const docs = (app && typeof app.getPath === 'function') 
        ? app.getPath('documents') 
        : path.join(os.homedir(), 'Documents');
    const p = path.join(docs, 'PrintShopManager', 'IncomingFiles');
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    return p;
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, getIncomingPath());
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const safeUuid = crypto.randomUUID();
        cb(null, `mobile_${Date.now()}_${safeUuid}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { 
        fileSize: 25 * 1024 * 1024, // 25 MB business safe limit
        files: 1,
        fields: 10
    },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.pdf', '.jpg', '.jpeg', '.png'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only PDF, JPG, and PNG are allowed.'));
        }
    }
});

function verifyMagicBytes(filePath, expectedExt) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(8);
        fs.readSync(fd, buffer, 0, 8, 0);
        fs.closeSync(fd);

        const ext = expectedExt.toLowerCase();
        if (ext === '.pdf') {
            // PDF starts with %PDF- (0x25 0x50 0x44 0x46)
            return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
        } else if (ext === '.png') {
            // PNG starts with 0x89 0x50 0x4E 0x47
            return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
        } else if (ext === '.jpg' || ext === '.jpeg') {
            // JPEG starts with 0xFF 0xD8 0xFF
            return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
        }
        return false;
    } catch (e) {
        return false;
    }
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
    if (token !== activePairingToken) {
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
    const maxRequests = 10;

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

async function startServer(mainWindow, force = false) {
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
        const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
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
                    if (fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath);
                    return res.status(400).json({ success: false, message: 'File format mismatch or corrupted file header.' });
                }

                const name = req.body.name ? String(req.body.name).trim().substring(0, 100) : '';
                const phone = req.body.phone ? String(req.body.phone).trim().substring(0, 20) : '';
                const printType = (req.body.printType === 'color' || req.body.printType === 'bw') ? req.body.printType : 'color';
                const paperSize = req.body.paperSize ? String(req.body.paperSize).trim().substring(0, 10) : 'A4';
                const notes = req.body.notes ? String(req.body.notes).trim().substring(0, 500) : '';

                if (!name || !phone) {
                    if (fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath);
                    return res.status(400).json({ success: false, message: 'Name and phone are required.' });
                }

                // Route through transactional OrderService
                const OrderService = require('./services/order-service');
                const orderPayload = {
                    customer: {
                        name: name,
                        phone: phone,
                        is_walk_in: false
                    },
                    items: [
                        {
                            file_name: req.file.originalname,
                            file_path: uploadedFilePath,
                            paper_size: paperSize,
                            print_type: printType,
                            sides: 'Single',
                            copies: 1,
                            pages: 1,
                            unit_price: printType === 'color' ? 10 : 2,
                            total_price: printType === 'color' ? 10 : 2
                        }
                    ],
                    status: 'Confirmed',
                    payment_status: 'Unpaid',
                    source: 'Mobile Order',
                    notes: notes
                };

                const orderResult = OrderService.submitOrder(orderPayload, {
                    user: { name: 'Mobile Customer', role: 'Customer' }
                });

                if (!orderResult.success) {
                    throw new Error(orderResult.error || 'Failed to record mobile order.');
                }

                // Notify renderer via webContents
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('new-mobile-order', {
                        id: orderResult.orderId,
                        name: name,
                        phone: phone,
                        fileName: req.file.originalname
                    });
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
    let portToTry = settings.mobile_server_port || 3000;
    const maxPort = portToTry + 10;

    return new Promise((resolve, reject) => {
        function tryListen(port) {
            serverInstance = serverApp.listen(port, '0.0.0.0', async () => {
                currentPort = port;
                const serverUrl = `http://${currentIp}:${currentPort}?token=${activePairingToken}`;
                
                try {
                    qrCodeDataUrl = await qrcode.toDataURL(serverUrl);
                } catch(e) {
                    console.error('Failed to generate QR code', e);
                }

                console.log(`[Mobile Server] Running securely at ${serverUrl}`);
                resolve({
                    success: true,
                    status: 'online',
                    ip: currentIp,
                    port: currentPort,
                    token: activePairingToken,
                    qr: qrCodeDataUrl
                });
            }).on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
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
        serverInstance.close();
        serverInstance = null;
        activePairingToken = null;
        qrCodeDataUrl = null;
        console.log('[Mobile Server] Server stopped cleanly.');
    }
    return { success: true, status: 'offline' };
}

async function getServerInfo() {
    if (!serverInstance) {
        return { status: 'offline', enabled: false };
    }
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

module.exports = { startServer, stopServer, getServerInfo, rotatePairingToken, validateToken };
