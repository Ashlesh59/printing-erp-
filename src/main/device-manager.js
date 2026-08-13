const { exec } = require('child_process');
const { BrowserWindow } = require('electron');
const db = require('./database/db');

// Cached list of discovered capabilities
let capabilityCache = [];

const DeviceManager = {
    // 1. Discovery & Enumeration
    discoverPrinters: () => {
        return new Promise(async (resolve) => {
            console.log("[DeviceManager] Starting printer auto-discovery...");
            
            // Try Windows PowerShell scanner if on Windows
            if (process.platform === 'win32') {
                const psCommand = `
                    [System.Reflection.Assembly]::LoadWithPartialName("System.Drawing") | Out-Null;
                    [System.Drawing.Printing.PrinterSettings]::InstalledPrinters | ForEach-Object {
                        $ps = New-Object System.Drawing.Printing.PrinterSettings;
                        $ps.PrinterName = $_;
                        
                        $paperSizes = @();
                        try {
                            $paperSizes = $ps.PaperSizes | ForEach-Object { $_.PaperName };
                        } catch {}

                        $trays = @();
                        try {
                            $trays = $ps.PaperSources | ForEach-Object { $_.SourceName };
                        } catch {}

                        [PSCustomObject]@{
                            Name = $_;
                            CanDuplex = $ps.CanDuplex;
                            PaperSizes = $paperSizes;
                            PaperSources = $trays;
                        }
                    } | ConvertTo-Json;
                `;

                // We run powershell directly without intermediate file
                exec(`powershell -NoProfile -Command "${psCommand.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`, async (err, stdout, stderr) => {
                    if (err) {
                        console.error("[DeviceManager] PowerShell discovery failed. Falling back to Electron APIs. Error:", err);
                        await DeviceManager.runElectronFallback();
                        resolve(capabilityCache);
                    } else {
                        try {
                            const parsed = JSON.parse(stdout);
                            const printersList = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
                            
                            // Get Electron basic printer list to merge drivers and defaults
                            let electronPrinters = [];
                            try {
                                const activeWin = BrowserWindow.getAllWindows()[0];
                                if (activeWin && activeWin.webContents) {
                                    electronPrinters = await activeWin.webContents.getPrintersAsync();
                                }
                            } catch(elErr) {
                                console.error("[DeviceManager] Could not query Electron printers for details:", elErr);
                            }

                            db.transaction(() => {
                                for (const p of printersList) {
                                    const ep = electronPrinters.find(x => x.name === p.Name || x.displayName === p.Name);
                                    
                                    const driverName = ep && ep.options ? ep.options.system_driverinfo || 'Unknown' : 'Unknown';
                                    const isDefault = ep ? (ep.isDefault ? 1 : 0) : 0;
                                    
                                    // Infer color support from driver name or options (standard fallback)
                                    const lowerName = p.Name.toLowerCase();
                                    const isColor = lowerName.includes('color') || lowerName.includes('rgb') || lowerName.includes('inkjet') || lowerName.includes('pdf') || lowerName.includes('xps') ? 1 : 0;

                                    db.prepare(`
                                        INSERT INTO device_capabilities (
                                            device_name, display_name, driver_name, port_name, is_default,
                                            can_duplex, can_color, paper_sizes_json, paper_sources_json, resolutions_json, status, last_scanned
                                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Online', CURRENT_TIMESTAMP)
                                        ON CONFLICT(device_name) DO UPDATE SET
                                            display_name = excluded.display_name,
                                            driver_name = excluded.driver_name,
                                            is_default = excluded.is_default,
                                            can_duplex = excluded.can_duplex,
                                            can_color = excluded.can_color,
                                            paper_sizes_json = excluded.paper_sizes_json,
                                            paper_sources_json = excluded.paper_sources_json,
                                            status = 'Online',
                                            last_scanned = CURRENT_TIMESTAMP
                                    `).run(
                                        p.Name,
                                        p.Name,
                                        driverName,
                                        ep ? ep.portName || null : null,
                                        isDefault,
                                        p.CanDuplex ? 1 : 0,
                                        isColor,
                                        JSON.stringify(p.PaperSizes || []),
                                        JSON.stringify(p.PaperSources || []),
                                        JSON.stringify(['300 DPI', '600 DPI'])
                                    );
                                }

                                // Mark printers not found in the scan as Offline
                                const scannedNames = printersList.map(x => x.Name);
                                if (scannedNames.length > 0) {
                                    const placeholders = scannedNames.map(() => '?').join(',');
                                    db.prepare(`UPDATE device_capabilities SET status = 'Offline' WHERE device_name NOT IN (${placeholders})`).run(...scannedNames);
                                }
                            })();

                            DeviceManager.loadCacheFromDb();
                            console.log(`[DeviceManager] Discovered and cached ${capabilityCache.length} printers.`);
                            resolve(capabilityCache);
                        } catch (parseErr) {
                            console.error("[DeviceManager] Failed to parse PowerShell stdout. Content:", stdout, parseErr);
                            await DeviceManager.runElectronFallback();
                            resolve(capabilityCache);
                        }
                    }
                });
            } else {
                // Non-Windows platform
                await DeviceManager.runElectronFallback();
                resolve(capabilityCache);
            }
        });
    },

    runElectronFallback: async () => {
        try {
            let printers = [];
            const activeWin = BrowserWindow.getAllWindows()[0];
            if (activeWin && activeWin.webContents) {
                printers = await activeWin.webContents.getPrintersAsync();
            } else {
                const tempWin = new BrowserWindow({ show: false });
                printers = await tempWin.webContents.getPrintersAsync();
                tempWin.close();
            }

            db.transaction(() => {
                for (const p of printers) {
                    const nameLower = p.name.toLowerCase();
                    const descLower = (p.description || '').toLowerCase();
                    const isOffline = p.status === 6 || p.status === 7 || p.status === 128 || descLower.includes('offline');
                    const status = isOffline ? 'Offline' : 'Online';
                    
                    const isColor = nameLower.includes('color') || nameLower.includes('rgb') || descLower.includes('color') || nameLower.includes('pdf') ? 1 : 0;
                    const isDuplex = nameLower.includes('duplex') || nameLower.includes('dn') || nameLower.includes('double') || nameLower.includes('pdf') ? 1 : 0;
                    
                    const driverName = p.options ? p.options.system_driverinfo || 'Unknown' : 'Unknown';

                    const paperSizes = ['A4', 'A3', 'Letter', 'Legal'];
                    const trays = ['Default Tray', 'Tray 1', 'Tray 2'];

                    db.prepare(`
                        INSERT INTO device_capabilities (
                            device_name, display_name, driver_name, port_name, is_default,
                            can_duplex, can_color, paper_sizes_json, paper_sources_json, resolutions_json, status, last_scanned
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(device_name) DO UPDATE SET
                            display_name = excluded.display_name,
                            driver_name = excluded.driver_name,
                            is_default = excluded.is_default,
                            can_duplex = excluded.can_duplex,
                            can_color = excluded.can_color,
                            status = excluded.status,
                            last_scanned = CURRENT_TIMESTAMP
                    `).run(
                        p.name,
                        p.displayName || p.name,
                        driverName,
                        p.portName || null,
                        p.isDefault ? 1 : 0,
                        isDuplex,
                        isColor,
                        JSON.stringify(paperSizes),
                        JSON.stringify(trays),
                        JSON.stringify(['300 DPI', '600 DPI']),
                        status
                    );
                }
            })();

            DeviceManager.loadCacheFromDb();
        } catch(err) {
            console.error("[DeviceManager] Electron capability fallback failed:", err);
        }
    },

    loadCacheFromDb: () => {
        try {
            const rows = db.prepare('SELECT * FROM device_capabilities').all();
            capabilityCache = rows.map(r => ({
                ...r,
                can_duplex: r.can_duplex === 1,
                can_color: r.can_color === 1,
                is_default: r.is_default === 1,
                paper_sizes: JSON.parse(r.paper_sizes_json || '[]'),
                paper_sources: JSON.parse(r.paper_sources_json || '[]'),
                resolutions: JSON.parse(r.resolutions_json || '[]')
            }));
        } catch(e) {
            console.error("[DeviceManager] Failed to load capabilities cache from DB:", e);
            capabilityCache = [];
        }
    },

    getPrinters: () => {
        if (capabilityCache.length === 0) {
            DeviceManager.loadCacheFromDb();
        }
        return capabilityCache;
    },

    // 2. Failover & Groups
    getGroups: () => {
        try {
            const groups = db.prepare('SELECT * FROM printer_groups ORDER BY name').all();
            for (const g of groups) {
                const members = db.prepare('SELECT printer_name FROM printer_group_members WHERE group_id = ?').all(g.id);
                g.printers = members.map(m => m.printer_name);
            }
            return groups;
        } catch(e) {
            console.error("Failed to get printer groups:", e);
            return [];
        }
    },

    saveGroup: (data) => {
        const transaction = db.transaction(() => {
            let groupId = data.id;
            if (groupId) {
                db.prepare('UPDATE printer_groups SET name = ?, description = ? WHERE id = ?').run(data.name, data.description || '', groupId);
                db.prepare('DELETE FROM printer_group_members WHERE group_id = ?').run(groupId);
            } else {
                const res = db.prepare('INSERT INTO printer_groups (name, description) VALUES (?, ?)').run(data.name, data.description || '');
                groupId = res.lastInsertRowid;
            }

            if (data.printers && Array.isArray(data.printers)) {
                const stmt = db.prepare('INSERT INTO printer_group_members (group_id, printer_name) VALUES (?, ?)');
                for (const p of data.printers) {
                    stmt.run(groupId, p);
                }
            }
            return groupId;
        });
        return transaction();
    },

    deleteGroup: (id) => {
        try {
            db.prepare('DELETE FROM printer_groups WHERE id = ?').run(id);
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },

    getCompatiblePrintersInGroup: (printerName) => {
        try {
            const parentGroups = db.prepare(`
                SELECT group_id FROM printer_group_members WHERE printer_name = ?
            `).all(printerName);
            
            if (parentGroups.length === 0) return [];
            
            const groupIds = parentGroups.map(g => g.group_id);
            const placeholders = groupIds.map(() => '?').join(',');
            
            const siblingPrinters = db.prepare(`
                SELECT DISTINCT printer_name FROM printer_group_members
                WHERE group_id IN (${placeholders}) AND printer_name != ?
            `).all(...groupIds, printerName);
            
            const siblingNames = siblingPrinters.map(p => p.printer_name);
            if (siblingNames.length === 0) return [];
            
            // Query capability status of siblings
            const queryPlaceholders = siblingNames.map(() => '?').join(',');
            const activePrinters = db.prepare(`
                SELECT device_name as name, driver_name, status, can_duplex, can_color
                FROM device_capabilities
                WHERE device_name IN (${queryPlaceholders}) AND status = 'Online'
            `).all(...siblingNames);
            
            return activePrinters;
        } catch(e) {
            console.error("Failed to query failover printers:", e);
            return [];
        }
    },

    // 3. Calibration
    getCalibrations: () => {
        try {
            return db.prepare('SELECT * FROM calibration_profiles').all();
        } catch(e) {
            return [];
        }
    },

    getCalibration: (printerName) => {
        try {
            const cal = db.prepare('SELECT * FROM calibration_profiles WHERE printer_name = ?').get(printerName);
            if (cal) return cal;
            // Return defaults
            return {
                printer_name: printerName,
                offset_x: 0.0,
                offset_y: 0.0,
                scale_x: 1.0,
                scale_y: 1.0,
                margin_compensation: 0.0,
                paper_feed_offset: 0.0
            };
        } catch(e) {
            console.error("Failed to load calibration profile:", e);
            return null;
        }
    },

    saveCalibration: (printerName, data) => {
        try {
            db.prepare(`
                INSERT INTO calibration_profiles (
                    printer_name, offset_x, offset_y, scale_x, scale_y, margin_compensation, paper_feed_offset, calibration_test_results
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(printer_name) DO UPDATE SET
                    offset_x = excluded.offset_x,
                    offset_y = excluded.offset_y,
                    scale_x = excluded.scale_x,
                    scale_y = excluded.scale_y,
                    margin_compensation = excluded.margin_compensation,
                    paper_feed_offset = excluded.paper_feed_offset,
                    calibration_test_results = excluded.calibration_test_results
            `).run(
                printerName,
                parseFloat(data.offset_x) || 0.0,
                parseFloat(data.offset_y) || 0.0,
                parseFloat(data.scale_x) || 1.0,
                parseFloat(data.scale_y) || 1.0,
                parseFloat(data.margin_compensation) || 0.0,
                parseFloat(data.paper_feed_offset) || 0.0,
                data.calibration_test_results || null
            );
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    }
};

module.exports = DeviceManager;
