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
            // Guard against duplicate active reservations for same order
            if (orderId) {
                const existing = db.prepare("SELECT COUNT(*) as count FROM inventory_reservations WHERE order_id = ? AND status = 'Active'").get(orderId);
                if (existing && existing.count > 0) {
                    return { success: true, message: 'Active reservations already exist for order' };
                }
            }

            const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
            const itemsToDeduct = [];
            
            if (items.length > 0) {
                for (const item of items) {
                    const itemData = {
                        pages: item.pages || item.physical_sheets || 1,
                        copies: item.copies || 1,
                        paperId: item.paper_id,
                        paperSize: item.paper_size,
                        printType: item.print_type,
                        sides: item.sides,
                        extras: item.extras_json ? JSON.parse(item.extras_json) : []
                    };
                    const deducted = ReservationService.resolveOrderRequirements(itemData);
                    itemsToDeduct.push(...deducted);
                }
            } else if (orderData) {
                const deducted = ReservationService.resolveOrderRequirements(orderData);
                itemsToDeduct.push(...deducted);
            }

            if (itemsToDeduct.length === 0) return { success: true };

            const locationId = parseInt(orderData?.locationId) || 1;

            // Check stock availability
            const settings = db.prepare('SELECT allow_negative_stock FROM inventory_settings WHERE id = 1').get();
            const allowNegative = settings ? settings.allow_negative_stock === 1 : false;

            for (const req of itemsToDeduct) {
                const item = InventoryRepository.getItemById(req.itemId);
                if (!item) {
                    throw new Error(`Inventory item #${req.itemId} not found during reservation.`);
                }

                const available = item.current_stock - (item.reserved_stock || 0);
                if (available < req.qty && !allowNegative) {
                    throw new Error(`Insufficient available stock for "${item.name}". Required: ${req.qty}, Available: ${available}`);
                }
            }

            // Perform reservations
            for (const req of itemsToDeduct) {
                const item = InventoryRepository.getItemById(req.itemId);
                const locStock = InventoryRepository.getLocationStock(req.itemId, locationId);

                const newReservedGlobal = (item.reserved_stock || 0) + req.qty;
                const newReservedLoc = (locStock.reserved_stock || 0) + req.qty;

                // Update global item reserved stock
                InventoryRepository.updateItemReservation(req.itemId, newReservedGlobal);

                // Update location stock level reserved stock
                InventoryRepository.updateLocationReservation(req.itemId, locationId, newReservedLoc);

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
                if (!item) continue;
                const locStock = InventoryRepository.getLocationStock(res.item_id, res.location_id);

                // Compute updated stock levels
                const newCurrentGlobal = item.current_stock - res.qty_reserved;
                const newReservedGlobal = Math.max(0, (item.reserved_stock || 0) - res.qty_reserved);

                const newCurrentLoc = locStock.current_stock - res.qty_reserved;
                const newReservedLoc = Math.max(0, (locStock.reserved_stock || 0) - res.qty_reserved);

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

            // Update reservation status to Consumed
            try {
                db.prepare("UPDATE inventory_reservations SET status = 'Consumed', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status = 'Active'").run(orderId);
            } catch (e) {
                ReservationRepository.updateReservationStatus(orderId, 'Consumed');
            }

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
                if (!item) continue;
                const locStock = InventoryRepository.getLocationStock(res.item_id, res.location_id);

                const newReservedGlobal = Math.max(0, (item.reserved_stock || 0) - res.qty_reserved);
                const newReservedLoc = Math.max(0, (locStock.reserved_stock || 0) - res.qty_reserved);

                InventoryRepository.updateItemReservation(res.item_id, newReservedGlobal);
                InventoryRepository.updateLocationReservation(res.item_id, res.location_id, newReservedLoc);
            }

            try {
                db.prepare("UPDATE inventory_reservations SET status = 'Released', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status = 'Active'").run(orderId);
            } catch (e) {
                ReservationRepository.updateReservationStatus(orderId, 'Released');
            }

            EventRepository.logEvent('ReservationReleased', orderId, {}, operator, role, 'Stock reservation cancelled');
            return { success: true };
        });
        return transaction();
    },

    // Alias for cancel
    cancel: (orderId, operator = 'System', role = 'System') => {
        return ReservationService.release(orderId, operator, role);
    },

    // 4. Undoes completed stock deductions safely using exact reversals
    undoDeduction: (orderId, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const txs = db.prepare("SELECT * FROM stock_transactions WHERE reference_type = 'order' AND reference_id = ? AND (is_reversed = 0 OR is_reversed IS NULL) AND qty < 0").all(orderId);
            if (txs.length === 0) return { success: true };

            for (const tx of txs) {
                InventoryService.reverseTransaction(tx.id, `Reversal of Order #${orderId} deduction`, operator, role);
            }
            
            EventRepository.logEvent('StockRestored', orderId, {}, operator, role, 'Order cancelled, stock restored via exact reversals');
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
                const profile = db.prepare('SELECT * FROM print_profiles WHERE id = ?').get(profileId);
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
                            try {
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
                            } catch(e) {}
                        }
                    }
                }
            } catch(profileErr) {
                console.error("Error resolving stock requirements from print profile:", profileErr);
            }
        }

        // 1. Resolve Paper stock requirement (Fallback)
        if (!resolvedFromProfile && orderData.paperId) {
            // Direct inventory item link
            const directItem = db.prepare("SELECT id FROM inventory_items WHERE id = ? AND status != 'Deleted'").get(orderData.paperId);
            if (directItem) {
                const sides = (orderData.sides || '').toLowerCase();
                const isDouble = sides.includes('double') || sides.includes('duplex') || sides.includes('2-sided') || sides.includes('two');
                const sheetsCount = isDouble ? Math.ceil(context.pages / 2) * context.copies : context.pages * context.copies;
                itemsToDeduct.push({
                    itemId: directItem.id,
                    qty: sheetsCount
                });
                resolvedFromProfile = true;
            } else {
                // Check if pricing recipe or direct link
                try {
                    const recipeItems = RecipeService.calculateRecipeConsumption(orderData.paperId, context);
                    if (recipeItems.length > 0) {
                        itemsToDeduct.push(...recipeItems);
                        resolvedFromProfile = true;
                    } else {
                        const pricingRecord = db.prepare('SELECT inventory_item_id FROM pricing WHERE id = ?').get(orderData.paperId);
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
                } catch (e) {}
            }
        }

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
