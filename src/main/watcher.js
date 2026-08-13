const chokidar = require('chokidar');
const path = require('path');
const os = require('os');
const fs = require('fs');

function startWatcher(webContents) {
    // Determine path: Documents/PrintShop/IncomingFiles
    const documentsPath = path.join(os.homedir(), 'Documents');
    const incomingPath = path.join(documentsPath, 'PrintShop', 'IncomingFiles');

    // Create if not exists
    if (!fs.existsSync(incomingPath)) {
        fs.mkdirSync(incomingPath, { recursive: true });
        console.log(`Created IncomingFiles directory at: ${incomingPath}`);
    }

    const watcher = chokidar.watch(incomingPath, {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true,
        ignoreInitial: true // Only emit 'add' events for newly added files while running
    });

    watcher.on('add', (filePath) => {
        const parsed = path.parse(filePath);
        // Only emit supported files
        const supportedExts = ['.pdf', '.jpg', '.jpeg', '.png'];
        if (supportedExts.includes(parsed.ext.toLowerCase())) {
            const stats = fs.statSync(filePath);
            const fileInfo = {
                name: parsed.base,
                path: filePath,
                size: stats.size,
                ext: parsed.ext.toLowerCase(),
                addedAt: new Date().toISOString()
            };
            // Send to renderer
            webContents.send('new-file-detected', fileInfo);
        }
    });

    console.log(`Watching for new files in: ${incomingPath}`);
}

module.exports = { startWatcher };
