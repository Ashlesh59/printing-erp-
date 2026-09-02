const PurchasingService = require('../../services/purchasing/purchasing-service');

const POService = {
    getPOs: (filters) => {
        return PurchasingService.getPurchaseOrders(filters);
    },
    getPOById: (id) => {
        return PurchasingService.getPurchaseOrderById(id);
    },
    createPO: (data, operator = 'System', role = 'System') => {
        const res = PurchasingService.createPurchaseOrder(data, { user: { name: operator, role } });
        return res.poId;
    },
    receivePO: (poId, data, operator = 'System', role = 'System') => {
        const po = PurchasingService.getPurchaseOrderById(poId);
        if (!po) throw new Error("Purchase Order not found");

        const receiveData = {
            po_id: poId,
            received_date: data.received_date,
            location_id: data.location_id,
            notes: data.notes,
            supplier_doc_ref: data.supplier_batch || data.invoice_number,
            items: data.items || po.items.map(it => ({
                po_item_id: it.id,
                qty_received: it.ordered_qty - it.received_qty - it.cancelled_qty,
                location_id: data.location_id
            }))
        };

        return PurchasingService.receivePurchaseOrderItems(receiveData, { user: { name: operator, role } });
    },
    cancelPO: (poId, operator = 'System', role = 'System') => {
        return PurchasingService.cancelPurchaseOrder(poId, 'Cancelled by user', { user: { name: operator, role } });
    },
    createPurchaseReturn: (data, operator = 'System', role = 'System') => {
        const res = PurchasingService.createPurchaseReturn(data, { user: { name: operator, role } });
        return res.returnId;
    }
};

module.exports = POService;

