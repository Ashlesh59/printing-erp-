const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// In-memory data store for the prototype. In production, use Redis or Postgres.
const shops = {}; // shopId -> { registeredAt }
const pendingOrders = [];

// Multer storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const safeBase = file.originalname.replace(/[^a-z0-9.]/gi, '_').toLowerCase();
        cb(null, `${Date.now()}-${safeBase}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// --- Endpoints ---

// 1. Shop Registration
app.post('/api/register', (req, res) => {
    const shopId = uuidv4().split('-')[0].toUpperCase(); // E.g., A1B2C3D4
    shops[shopId] = { registeredAt: Date.now() };
    res.json({ success: true, shopId });
});

// 2. Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'online', shops: Object.keys(shops).length, pendingOrders: pendingOrders.length });
});

// 3. Serve the Mobile Ordering Page
// For the cloud server, we'll embed the HTML directly or serve a static file.
app.get('/:shopId', (req, res) => {
    const { shopId } = req.params;
    if (!shops[shopId] && shopId !== 'TEST') {
        return res.status(404).send("<h2>Shop not found or offline.</h2>");
    }
    
    // Serve the mobile-order.html
    const htmlPath = path.join(__dirname, 'mobile-order.html');
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.status(404).send("Ordering page not deployed on cloud server.");
    }
});

// 4. Mobile Upload Endpoint (Customer -> Cloud)
app.post('/api/order/:shopId', upload.single('file'), (req, res) => {
    const { shopId } = req.params;
    
    // We allow TEST shop for testing purposes
    if (!shops[shopId] && shopId !== 'TEST') {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ success: false, message: 'Invalid Shop ID.' });
    }

    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    const { name, phone, printType, paperSize } = req.body;
    if (!name || !phone) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ success: false, message: 'Name and phone are required.' });
    }

    const orderId = uuidv4();
    const newOrder = {
        id: orderId,
        shopId,
        name,
        phone,
        printType: printType || 'color',
        paperSize: paperSize || 'A4',
        fileName: req.file.filename,
        originalName: req.file.originalname,
        filePath: req.file.path,
        timestamp: Date.now()
    };

    pendingOrders.push(newOrder);
    res.status(200).json({ success: true, message: 'Order submitted to cloud!', orderId });
});

// 5. Desktop Sync Endpoint (Electron -> Cloud)
// Returns list of pending orders for a specific shop. Does NOT delete them yet.
app.get('/api/sync/:shopId', (req, res) => {
    const { shopId } = req.params;
    const shopOrders = pendingOrders.filter(o => o.shopId === shopId);
    
    // Return order metadata (excluding internal paths)
    const safeOrders = shopOrders.map(o => ({
        id: o.id,
        name: o.name,
        phone: o.phone,
        printType: o.printType,
        paperSize: o.paperSize,
        originalName: o.originalName,
        timestamp: o.timestamp
    }));

    res.json({ success: true, orders: safeOrders });
});

// 6. Download File Endpoint (Electron -> Cloud)
app.get('/api/download/:shopId/:orderId', (req, res) => {
    const { shopId, orderId } = req.params;
    const order = pendingOrders.find(o => o.id === orderId && o.shopId === shopId);
    
    if (!order || !fs.existsSync(order.filePath)) {
        return res.status(404).json({ success: false, message: 'File not found on cloud server.' });
    }

    res.download(order.filePath, order.originalName);
});

// 7. Acknowledge and Delete Endpoint (Electron -> Cloud)
app.post('/api/ack/:shopId/:orderId', (req, res) => {
    const { shopId, orderId } = req.params;
    const index = pendingOrders.findIndex(o => o.id === orderId && o.shopId === shopId);
    
    if (index === -1) {
        return res.status(404).json({ success: false, message: 'Order not found or already acknowledged.' });
    }

    const order = pendingOrders[index];
    
    // Delete file
    if (fs.existsSync(order.filePath)) {
        fs.unlinkSync(order.filePath);
    }

    // Remove from array
    pendingOrders.splice(index, 1);
    
    res.json({ success: true, message: 'Acknowledged and deleted from cloud.' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cloud Relay Server running on port ${PORT}`);
});
