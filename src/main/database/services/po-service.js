const db = require('../db');
const PORepository = require('../repositories/po-repository');
const InventoryRepository = require('../repositories/inventory-repository');
const EventRepository = require('../repositories/event-repository');
const InventoryService = require('./inventory-service');

const POService = {
    getPOs: () => {
        return PORepository.getPOs();
    },
    getPOById: (id) => {
        return PORepository.getPOById(id);
    },
    createPO: (data, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const poNumber = data.po_number || `PO-${Date.now()}`;
            
            const poId = PORepository.createPO({
                po_number: poNumber,
                supplier_id: parseInt(data.supplier_id),
                order_date: data.order_date || new Date().toISOString().split('T')[0],
                subtotal: parseFloat(data.subtotal) || 0,
                gst_amount: parseFloat(data.gst_amount) || 0,
                transport_cost: parseFloat(data.transport_cost) || 0,
                discount: parseFloat(data.discount) || 0,
                grand_total: parseFloat(data.grand_total) || 0,
                payment_status: data.payment_status || 'Unpaid',
                status: 'Ordered', // Set status directly to Ordered (or Draft if specified)
                invoice_number: data.invoice_number || '',
                notes: data.notes || ''
            });

            // Add line items
            if (data.items && Array.isArray(data.items)) {
                data.items.forEach(item => {
                    PORepository.createPOItem(
                        poId,
                        parseInt(item.item_id),
                        parseFloat(item.qty),
                        parseFloat(item.cost),
                        parseFloat(item.gst_rate) || 18,
                        parseFloat(item.total)
                    );
                });
            }

            // Update supplier outstanding balance
            if (data.payment_status !== 'Paid') {
                const unpaid = parseFloat(data.grand_total) - (data.payment_status === 'Partially Paid' ? parseFloat(data.amount_paid || 0) : 0);
                PORepository.updateSupplierBalance(parseInt(data.supplier_id), unpaid);
            }

            EventRepository.logEvent('PurchaseOrderCreated', poId, { poNumber, total: data.grand_total }, operator, role, 'Raised PO');
            return poId;
        });
        return transaction();
    },
    receivePO: (poId, data, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const po = PORepository.getPOById(poId);
            if (!po) throw new Error("Purchase Order not found");
            if (po.status === 'Received') throw new Error("PO already completely received");

            const receivedDate = data.received_date || new Date().toISOString().split('T')[0];
            const locationId = parseInt(data.location_id) || 1;

            po.items.forEach(poItem => {
                const item = InventoryRepository.getItemByIdRaw(poItem.item_id);
                if (!item) return;

                // Handle partial receipt or full receipt
                const qtyIn = parseFloat(poItem.qty); // In this setup we receive the full PO item quantity
                const cost = parseFloat(poItem.cost);

                // 1. Recalculate average cost using Weighted Moving Average
                const oldTotalCost = item.current_stock * item.average_cost;
                const newTotalCost = oldTotalCost + (qtyIn * cost);
                const newStock = item.current_stock + qtyIn;
                const newAverageCost = newStock > 0 ? (newTotalCost / newStock) : cost;

                InventoryRepository.updateItemStock(poItem.item_id, newStock);
                InventoryRepository.updateItemAverageCost(poItem.item_id, newAverageCost, cost);

                // Update location stock level
                const locStock = InventoryRepository.getLocationStock(poItem.item_id, locationId);
                InventoryRepository.updateLocationStock(poItem.item_id, locationId, locStock.current_stock + qtyIn);

                // 2. Create tracking batch record
                const batchNum = data.batch_number || `BATCH-${Date.now()}-${poItem.item_id}`;
                PORepository.createBatch(
                    poItem.item_id,
                    batchNum,
                    data.supplier_batch || po.po_number,
                    qtyIn,
                    data.manufacturing_date || null,
                    data.expiry_date || null
                );

                // 3. Log Stock Transaction
                InventoryRepository.addTransaction(
                    poItem.item_id, 'purchase', qtyIn, cost,
                    'purchase_order', poId, `Received PO #${po.po_number} - Batch: ${batchNum}`, operator, role
                );

                InventoryService.checkStockAlerts(poItem.item_id);
            });

            // Update PO Status to Received
            PORepository.updatePOStatus(poId, 'Received', receivedDate);
            EventRepository.logEvent('PurchaseOrderReceived', poId, { poNumber: po.po_number }, operator, role, 'Received PO stock');
            return { success: true };
        });
        return transaction();
    },
    cancelPO: (poId, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const po = PORepository.getPOById(poId);
            if (!po) throw new Error("Purchase Order not found");
            if (po.status === 'Received') throw new Error("Cannot cancel received PO");

            PORepository.updatePOStatus(poId, 'Cancelled');

            // Revert supplier outstanding balance if unpaid
            if (po.payment_status !== 'Paid') {
                const unpaid = parseFloat(po.grand_total);
                PORepository.updateSupplierBalance(po.supplier_id, -unpaid);
            }

            EventRepository.logEvent('PurchaseOrderCancelled', poId, { poNumber: po.po_number }, operator, role, 'Cancelled PO');
            return { success: true };
        });
        return transaction();
    },

    // Purchase Returns
    createPurchaseReturn: (data, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            const itemId = parseInt(data.item_id);
            const qty = parseFloat(data.qty);
            const refund = parseFloat(data.refund_amount) || 0;
            const supplierId = parseInt(data.supplier_id);
            const poId = data.po_id ? parseInt(data.po_id) : null;
            const locationId = parseInt(data.location_id) || 1;

            const item = InventoryRepository.getItemByIdRaw(itemId);
            if (!item) throw new Error("Item not found");

            const locStock = InventoryRepository.getLocationStock(itemId, locationId);
            if (locStock.current_stock < qty) {
                throw new Error(`Insufficient stock for return. Available in location: ${locStock.current_stock}`);
            }

            // Deduct stock levels
            InventoryRepository.updateItemStock(itemId, item.current_stock - qty);
            InventoryRepository.updateLocationStock(itemId, locationId, locStock.current_stock - qty);

            // Create return record
            const returnId = PORepository.createReturn(poId, supplierId, itemId, qty, refund);

            // Revert/Credit supplier balance
            if (refund > 0) {
                PORepository.updateSupplierBalance(supplierId, -refund);
            }

            // Log Transaction
            InventoryRepository.addTransaction(
                itemId, 'return', -qty, item.average_cost,
                'purchase_return', returnId, `Returned stock to supplier - Refund: ${refund}`, operator, role
            );

            EventRepository.logEvent('PurchaseReturned', returnId, { itemId, qty, refund }, operator, role, 'Returned stock');
            return returnId;
        });
        return transaction();
    }
};

module.exports = POService;
