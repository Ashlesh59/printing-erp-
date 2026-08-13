const db = require('../db');
const ReservationRepository = require('../repositories/reservation-repository');
const InventoryRepository = require('../repositories/inventory-repository');
const RecipeService = require('./recipe-service');
const EventRepository = require('../repositories/event-repository');
const InventoryService = require('./inventory-service');

const ReservationService = {
    // 1. Reserves stock for an order
    reserve: (orderId, orderData, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
            const itemsToDeduct = [];
            
            if (items.length > 0) {
                for (const item of items) {
                    const itemData = {
                        pages: item.pages,
                        copies: item.copies,
                        paperId: item.paper_id,
                        paperSize: item.paper_size,
                        printType: item.print_type,
                        sides: item.sides,
                        extras: item.extras_json ? JSON.parse(item.extras_json) : []
                    };
                    const deducted = ReservationService.resolveOrderRequirements(itemData);
                    itemsToDeduct.push(...deducted);
                }
            } else {
                const deducted = ReservationService.resolveOrderRequirements(orderData);
                itemsToDeduct.push(...deducted);
            }

            if (itemsToDeduct.length === 0) return { success: true };

            const locationId = parseInt(orderData.locationId) || 1;

            // Check stock availability
            const settings = db.prepare('SELECT allow_negative_stock FROM inventory_settings WHERE id = 1').get();
            const allowNegative = settings ? settings.allow_negative_stock === 1 : false;

            for (const req of itemsToDeduct) {
                const item = InventoryRepository.getItemById(req.itemId);
                if (!item) continue;

                const available = item.current_stock - item.reserved_stock;
                if (available < req.qty && !allowNegative) {
                    throw new Error(`Insufficient stock for "${item.name}". Required: ${req.qty}, Available: ${available}`);
                }
            }

            // Perform reservations
            for (const req of itemsToDeduct) {
                const item = InventoryRepository.getItemById(req.itemId);
                const locStock = InventoryRepository.getLocationStock(req.itemId, locationId);

                // Update global item reserved stock
                InventoryRepository.updateItemReservation(req.itemId, item.reserved_stock + req.qty);

                // Update location stock level reserved stock
                InventoryRepository.updateLocationReservation(req.itemId, locationId, locStock.reserved_stock + req.qty);

                // Record reservation record
                ReservationRepository.createReservation(orderId, req.itemId, locationId, req.qty);
            }

            EventRepository.logEvent('ReservationCreated', orderId, { orderData, items: itemsToDeduct }, operator, role, 'Stock reserved');
            return { success: true };
        });
        return transaction();
    },

    // 2. Fulfills (consumes) the reservation when the order finishes
    fulfill: (orderId, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const reservations = ReservationRepository.getReservationsByOrder(orderId);
            if (reservations.length === 0) return { success: true };

            for (const res of reservations) {
                if (res.status !== 'Active') continue;

                const item = InventoryRepository.getItemByIdRaw(res.item_id);
                const locStock = InventoryRepository.getLocationStock(res.item_id, res.location_id);

                // Compute updated stock levels
                const newCurrentGlobal = item.current_stock - res.qty_reserved;
                const newReservedGlobal = Math.max(0, item.reserved_stock - res.qty_reserved);

                const newCurrentLoc = locStock.current_stock - res.qty_reserved;
                const newReservedLoc = Math.max(0, locStock.reserved_stock - res.qty_reserved);

                // Write to database
                InventoryRepository.updateItemStock(res.item_id, newCurrentGlobal);
                InventoryRepository.updateItemReservation(res.item_id, newReservedGlobal);

                InventoryRepository.updateLocationStock(res.item_id, res.location_id, newCurrentLoc);
                InventoryRepository.updateLocationReservation(res.item_id, res.location_id, newReservedLoc);

                // Log Transaction audit
                InventoryRepository.addTransaction(
                    res.item_id, 'order', -res.qty_reserved, item.average_cost,
                    'order', orderId, `Stock consumed for completed Order #${orderId}`, operator, role
                );

                InventoryService.checkStockAlerts(res.item_id);
            }

            ReservationRepository.updateReservationStatus(orderId, 'Fulfilled');
            EventRepository.logEvent('ReservationFulfilled', orderId, {}, operator, role, 'Stock consumed successfully');
            return { success: true };
        });
        return transaction();
    },

    // 3. Releases reservation (e.g. order cancelled before completion)
    release: (orderId, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const reservations = ReservationRepository.getReservationsByOrder(orderId);
            if (reservations.length === 0) return { success: true };

            for (const res of reservations) {
                if (res.status !== 'Active') continue;

                const item = InventoryRepository.getItemByIdRaw(res.item_id);
                const locStock = InventoryRepository.getLocationStock(res.item_id, res.location_id);

                const newReservedGlobal = Math.max(0, item.reserved_stock - res.qty_reserved);
                const newReservedLoc = Math.max(0, locStock.reserved_stock - res.qty_reserved);

                InventoryRepository.updateItemReservation(res.item_id, newReservedGlobal);
                InventoryRepository.updateLocationReservation(res.item_id, res.location_id, newReservedLoc);
            }

            ReservationRepository.updateReservationStatus(orderId, 'Released');
            EventRepository.logEvent('ReservationReleased', orderId, {}, operator, role, 'Stock reservation cancelled');
            return { success: true };
        });
        return transaction();
    },

    // 4. Undoes completed stock deductions (e.g. order cancelled *after* completion)
    undoDeduction: (orderId, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            // Find all order transactions for this order
            const txs = db.prepare("SELECT * FROM stock_transactions WHERE reference_type = 'order' AND reference_id = ?").all(orderId);
            if (txs.length === 0) return { success: true };

            for (const tx of txs) {
                const item = InventoryRepository.getItemByIdRaw(tx.item_id);
                if (!item) continue;

                const qtyToRestock = Math.abs(tx.qty);
                const defaultLocId = item.storage_location_id || 1;
                const locStock = InventoryRepository.getLocationStock(tx.item_id, defaultLocId);

                // Add back to stocks
                InventoryRepository.updateItemStock(tx.item_id, item.current_stock + qtyToRestock);
                InventoryRepository.updateLocationStock(tx.item_id, defaultLocId, locStock.current_stock + qtyToRestock);

                // Log Offset Transaction
                InventoryRepository.addTransaction(
                    tx.item_id, 'manual_in', qtyToRestock, tx.cost,
                    'order', orderId, `Restocked voided Order #${orderId}`, operator, role
                );

                InventoryService.checkStockAlerts(tx.item_id);
            }

            // Remove/Clear PO log references
            db.prepare("DELETE FROM stock_transactions WHERE reference_type = 'order' AND reference_id = ? AND qty < 0").run(orderId);
            
            EventRepository.logEvent('StockRestored', orderId, {}, operator, role, 'Order cancelled, stock restored');
            return { success: true };
        });
        return transaction();
    },

    resolveOrderRequirements: (orderData) => {
        const itemsToDeduct = [];
        const context = {
            pages: parseInt(orderData.pages) || 1,
            copies: parseInt(orderData.copies) || 1
        };

        let resolvedFromProfile = false;
        const profileId = orderData.print_profile_id || orderData.printProfileId;
        if (profileId) {
            try {
                const profile = db.prepare('SELECT recipe_id, pricing_id, paper_size FROM print_profiles WHERE id = ?').get(profileId);
                if (profile) {
                    if (profile.recipe_id) {
                        const recipeItems = RecipeService.calculateRecipeConsumptionDirect(profile.recipe_id, context);
                        if (recipeItems.length > 0) {
                            itemsToDeduct.push(...recipeItems);
                            resolvedFromProfile = true;
                        }
                    }
                    if (!resolvedFromProfile && profile.pricing_id) {
                        const recipeItems = RecipeService.calculateRecipeConsumption(profile.pricing_id, context);
                        if (recipeItems.length > 0) {
                            itemsToDeduct.push(...recipeItems);
                            resolvedFromProfile = true;
                        } else {
                            const pricingRecord = db.prepare('SELECT inventory_item_id FROM pricing WHERE id = ?').get(profile.pricing_id);
                            if (pricingRecord && pricingRecord.inventory_item_id) {
                                const sides = (orderData.sides || '').toLowerCase();
                                const isDouble = sides.includes('double') || sides.includes('duplex') || sides.includes('2-sided') || sides.includes('two');
                                const sheetsCount = isDouble ? Math.ceil(context.pages / 2) * context.copies : context.pages * context.copies;
                                itemsToDeduct.push({
                                    itemId: pricingRecord.inventory_item_id,
                                    qty: sheetsCount
                                });
                                resolvedFromProfile = true;
                            }
                        }
                    }
                }
            } catch(profileErr) {
                console.error("Error resolving stock requirements from print profile:", profileErr);
            }
        }

        // 1. Resolve Paper stock requirement (Fallback)
        if (!resolvedFromProfile && orderData.paperId) {
            // Check if recipe is configured
            const recipeItems = RecipeService.calculateRecipeConsumption(orderData.paperId, context);
            if (recipeItems.length > 0) {
                itemsToDeduct.push(...recipeItems);
            } else {
                // Check direct link fallback
                const pricingRecord = db.prepare('SELECT inventory_item_id FROM pricing WHERE id = ?').get(orderData.paperId);
                if (pricingRecord && pricingRecord.inventory_item_id) {
                    // Standard sheets calculation logic
                    const sides = (orderData.sides || '').toLowerCase();
                    const isDouble = sides.includes('double') || sides.includes('duplex') || sides.includes('2-sided') || sides.includes('two');
                    const sheetsCount = isDouble ? Math.ceil(context.pages / 2) * context.copies : context.pages * context.copies;
                    
                    itemsToDeduct.push({
                        itemId: pricingRecord.inventory_item_id,
                        qty: sheetsCount
                    });
                } else {
                    // Smart String Match legacy fallback
                    const size = orderData.paperSize || 'A4';
                    const pType = orderData.printType || 'bw';
                    const fallbackItem = db.prepare(`
                        SELECT i.id FROM inventory_items i
                        JOIN inventory_categories c ON i.category_id = c.id
                        WHERE c.name = 'Paper' AND i.status = 'Active'
                          AND i.size LIKE ? AND (i.color_type = ? OR i.name LIKE ?)
                        LIMIT 1
                    `).get(`%${size}%`, pType, `%${pType === 'color' ? 'color' : 'bw'}%`);

                    if (fallbackItem) {
                        const sides = (orderData.sides || '').toLowerCase();
                        const isDouble = sides.includes('double') || sides.includes('duplex') || sides.includes('2-sided') || sides.includes('two');
                        const sheetsCount = isDouble ? Math.ceil(context.pages / 2) * context.copies : context.pages * context.copies;
                        
                        itemsToDeduct.push({
                            itemId: fallbackItem.id,
                            qty: sheetsCount
                        });
                    }
                }
            }
        }

        // 2. Resolve Extra item stock requirements
        if (orderData.extras && Array.isArray(orderData.extras)) {
            for (const extraId of orderData.extras) {
                const recipeItems = RecipeService.calculateRecipeConsumption(extraId, context);
                if (recipeItems.length > 0) {
                    itemsToDeduct.push(...recipeItems);
                } else {
                    const pricingRecord = db.prepare('SELECT inventory_item_id FROM pricing WHERE id = ?').get(extraId);
                    if (pricingRecord && pricingRecord.inventory_item_id) {
                        itemsToDeduct.push({
                            itemId: pricingRecord.inventory_item_id,
                            qty: context.copies // default consumption factor for Extras
                        });
                    }
                }
            }
        }

        return itemsToDeduct;
    }
};

module.exports = ReservationService;
