const express = require('express');
const multer = require('multer');
const os = require('os');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { app } = require('electron');
const { CustomerModel, OrderModel } = require('./database/models');

let serverInstance = null;
let currentPort = null;
let currentIp = null;
let qrCodeDataUrl = null;

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        // Ignore VirtualBox, VMware, WSL, Loopback, etc.
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
    return '127.0.0.1'; // Fallback
}

// Multer Config
const getIncomingPath = () => {
    const p = path.join(app.getPath('documents'), 'PrintShop', 'IncomingFiles');
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    return p;
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, getIncomingPath());
    },
    filename: (req, file, cb) => {
        // Sanitize: remove non-alphanumeric chars (except dots/dashes) and add timestamp
        const ext = path.extname(file.originalname);
        const base = path.basename(file.originalname, ext);
        const safeBase = base.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        cb(null, `${Date.now()}-${safeBase}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.pdf', '.jpg', '.jpeg', '.png'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only PDF, JPG, and PNG are allowed.'));
        }
    }
});

async function startServer(mainWindow) {
    if (serverInstance) return { success: true, ip: currentIp, port: currentPort, qr: qrCodeDataUrl };

    const serverApp = express();
    serverApp.use(express.json());
    serverApp.use(express.urlencoded({ extended: true }));

    // Serve mobile HTML
    serverApp.get('/', (req, res) => {
        try {
            const htmlPath = path.join(__dirname, 'mobile-order.html');
            const htmlContent = fs.readFileSync(htmlPath, 'utf8');
            res.send(htmlContent);
        } catch (error) {
            console.error("Failed to load mobile-order.html:", error);
            res.status(500).send("Error loading ordering page. Path: " + path.join(__dirname, 'mobile-order.html'));
        }
    });

    serverApp.get('/health', (req, res) => {
        res.status(200).json({ status: 'ok', time: new Date() });
    });

    serverApp.post('/create-order', (req, res) => {
        upload.single('file')(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ success: false, message: err.message });
            }

            try {
                if (!req.file) {
                    return res.status(400).json({ success: false, message: 'No file uploaded.' });
                }

                const { name, phone, printType, paperSize } = req.body;
                
                if (!name || !phone) {
                    // Cleanup file if missing details
                    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                    return res.status(400).json({ success: false, message: 'Name and phone are required.' });
                }

                // 1. Create or get customer
                const custResult = CustomerModel.createCustomer(name, phone);
                if (!custResult.success) throw new Error(custResult.error);

                // 2. Insert Pending Order
                const orderData = {
                    customerId: custResult.id,
                    fileName: req.file.filename,
                    filePath: req.file.path,
                    printType: printType || 'color',
                    paperSize: paperSize || 'A4',
                    sides: 'Single',
                    pages: 1,
                    copies: 1,
                    price: 0,
                    notes: '',
                    status: 'Pending'
                };

                const orderResult = OrderModel.createOrder(orderData);
                if (!orderResult.success) throw new Error(orderResult.error);

                // 3. Notify Renderer
                if (mainWindow) {
                    mainWindow.webContents.send('new-mobile-order', {
                        id: orderResult.id,
                        name: name,
                        phone: phone,
                        fileName: req.file.filename
                    });
                }

                res.status(200).json({ success: true, message: 'Order submitted successfully!' });
            } catch (e) {
                if (req.file && fs.existsSync(req.file.path)) {
                    fs.unlinkSync(req.file.path);
                }
                res.status(500).json({ success: false, message: e.message });
            }
        });
    });

    // Fallback logic
    currentIp = getLocalIp();
    let portToTry = 3000;
    const maxPort = 3010;

    return new Promise((resolve, reject) => {
        function tryListen(port) {
            serverInstance = serverApp.listen(port, '0.0.0.0', async () => {
                currentPort = port;
                const serverUrl = `http://${currentIp}:${currentPort}`;
                
                try {
                    qrCodeDataUrl = await qrcode.toDataURL(serverUrl);
                } catch(e) {
                    console.error("Failed to generate QR code", e);
                }

                console.log(`Mobile Order Server running at ${serverUrl}`);
                resolve({ success: true, ip: currentIp, port: currentPort, qr: qrCodeDataUrl });
            }).on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.log(`Port ${port} in use, trying next...`);
                    if (port < maxPort) {
                        tryListen(port + 1);
                    } else {
                        serverInstance = null;
                        reject(new Error(`Could not find an open port between 3000 and ${maxPort}`));
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

async function getServerInfo() {
    const { SettingsModel } = require('./database/models');
    const settings = SettingsModel.getSettings();
    
    // If Vercel portal URL + Supabase are configured, point QR at the portal
    if (settings && settings.vercel_url && settings.shop_id) {
        const portalUrl = `${settings.vercel_url.replace(/\/$/, '')}?shop=${encodeURIComponent(settings.shop_id)}`;
        try {
            const qr = await qrcode.toDataURL(portalUrl);
            return { status: 'online', isCloud: true, url: portalUrl, qr };
        } catch(e) {
            console.error('Failed to generate portal QR:', e);
        }
    }

    if (!serverInstance) return { status: 'offline' };
    return {
        status:  'online',
        isCloud: false,
        ip:      currentIp,
        port:    currentPort,
        url:     `http://${currentIp}:${currentPort}`,
        qr:      qrCodeDataUrl
    };
}

module.exports = { startServer, getServerInfo };
