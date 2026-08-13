const db = require('../db');
const RecipeRepository = require('../repositories/recipe-repository');
const EventRepository = require('../repositories/event-repository');
const FormulaEngine = require('./formula-engine');

const RecipeService = {
    getRecipes: () => {
        return RecipeRepository.getRecipes();
    },
    getRecipeById: (id) => {
        return RecipeRepository.getRecipeById(id);
    },
    saveRecipe: (data, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            let recipeId = data.id;
            if (recipeId) {
                // Update
                RecipeRepository.updateRecipe(recipeId, data);
                RecipeRepository.clearRecipeItems(recipeId);
            } else {
                // Create
                recipeId = RecipeRepository.createRecipe(data);
            }

            // Save items
            if (data.items && Array.isArray(data.items)) {
                data.items.forEach((item, index) => {
                    RecipeRepository.addRecipeItem(
                        recipeId,
                        parseInt(item.inventory_item_id),
                        item.formula || 'copies',
                        parseFloat(item.quantity) || 1.0,
                        item.optional ? 1 : 0,
                        index
                    );
                });
            }

            EventRepository.logEvent('RecipeSaved', recipeId, data, operator, role, 'Recipe configured');
            return recipeId;
        });
        return transaction();
    },
    softDeleteRecipe: (id, operator = 'System', role = 'System') => {
        const transaction = db.transaction(() => {
            RecipeRepository.softDeleteRecipe(id);
            EventRepository.logEvent('RecipeDeleted', id, {}, operator, role, 'Soft deleted recipe');
        });
        transaction();
        return { success: true };
    },

    // Resolves what items and quantities a pricing option consumes based on print parameters
    calculateRecipeConsumption: (pricingId, context = { pages: 1, copies: 1 }) => {
        const recipe = RecipeRepository.getRecipeByPricingId(pricingId);
        if (!recipe) return [];

        return recipe.items.map(item => {
            // Evaluate formula string to count actual units consumed
            const rawQty = FormulaEngine.evaluate(item.formula, context);
            const qtyConsumed = rawQty * item.quantity;
            
            return {
                itemId: item.inventory_item_id,
                itemName: item.item_name,
                qty: qtyConsumed,
                unit: item.unit,
                optional: item.optional === 1,
                purchasePrice: item.purchase_price
            };
        });
    },

    calculateRecipeConsumptionDirect: (recipeId, context = { pages: 1, copies: 1 }) => {
        const recipe = RecipeRepository.getRecipeById(recipeId);
        if (!recipe) return [];

        return recipe.items.map(item => {
            const rawQty = FormulaEngine.evaluate(item.formula, context);
            const qtyConsumed = rawQty * item.quantity;
            
            return {
                itemId: item.inventory_item_id,
                itemName: item.item_name,
                qty: qtyConsumed,
                unit: item.unit,
                optional: item.optional === 1,
                purchasePrice: item.purchase_price
            };
        });
    }
};

module.exports = RecipeService;
