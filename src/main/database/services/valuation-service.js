const InventoryRepository = require('../repositories/inventory-repository');
const PORepository = require('../repositories/po-repository');

class WeightedAverageStrategy {
    calculateValue(itemId) {
        const item = InventoryRepository.getItemByIdRaw(itemId);
        if (!item) return 0;
        return item.current_stock * item.average_cost;
    }
}

class FIFOStrategy {
    calculateValue(itemId) {
        const item = InventoryRepository.getItemByIdRaw(itemId);
        if (!item) return 0;
        
        // Fetch remaining batches sorted by date ASC
        const batches = PORepository.getBatchesByItem(itemId);
        let totalVal = 0;
        let countedStock = 0;
        
        // Sum valuation of batches
        for (const batch of batches) {
            totalVal += batch.qty_remaining * item.purchase_price; // Or batch specific cost if added later
            countedStock += batch.qty_remaining;
        }
        
        // If batch quantities do not match current stock (e.g. legacy items), value remaining using base cost
        const diff = item.current_stock - countedStock;
        if (diff > 0) {
            totalVal += diff * item.purchase_price;
        }
        
        return totalVal;
    }
}

class LIFOStrategy {
    calculateValue(itemId) {
        // In simple batch storage LIFO and FIFO values are computed similarly from batch pools,
        // but here we demonstrate the strategy distinction by reversing the order of batches
        const item = InventoryRepository.getItemByIdRaw(itemId);
        if (!item) return 0;

        const batches = PORepository.getBatchesByItem(itemId).reverse();
        let totalVal = 0;
        let countedStock = 0;
        
        for (const batch of batches) {
            totalVal += batch.qty_remaining * item.purchase_price;
            countedStock += batch.qty_remaining;
        }
        
        const diff = item.current_stock - countedStock;
        if (diff > 0) {
            totalVal += diff * item.purchase_price;
        }
        
        return totalVal;
    }
}

const ValuationService = {
    strategies: {
        'AVERAGE': new WeightedAverageStrategy(),
        'FIFO': new FIFOStrategy(),
        'LIFO': new LIFOStrategy()
    },
    calculateItemValuation: (itemId, method = 'AVERAGE') => {
        const strategy = ValuationService.strategies[method.toUpperCase()] || ValuationService.strategies['AVERAGE'];
        return strategy.calculateValue(itemId);
    },
    calculateTotalValuation: (method = 'AVERAGE') => {
        const items = InventoryRepository.getItems();
        let total = 0;
        for (const item of items) {
            total += ValuationService.calculateItemValuation(item.id, method);
        }
        return total;
    }
};

module.exports = ValuationService;
