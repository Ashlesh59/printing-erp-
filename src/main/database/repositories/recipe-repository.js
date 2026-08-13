const db = require('../db');

const RecipeRepository = {
    getRecipes: () => {
        return db.prepare(`
            SELECT r.*, p.name as pricing_name, p.category as pricing_category
            FROM recipes r
            JOIN pricing p ON r.pricing_id = p.id
            WHERE r.status != 'Deleted'
            ORDER BY r.name
        `).all();
    },
    getRecipeById: (id) => {
        const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND status != 'Deleted'`).get(id);
        if (recipe) {
            recipe.items = db.prepare(`
                SELECT ri.*, i.name as item_name, i.sku, i.unit, i.purchase_price
                FROM recipe_items ri
                JOIN inventory_items i ON ri.inventory_item_id = i.id
                WHERE ri.recipe_id = ?
                ORDER BY ri.sort_order, ri.id
            `).all(id);
        }
        return recipe;
    },
    getRecipeByPricingId: (pricingId) => {
        const recipe = db.prepare(`
            SELECT * FROM recipes 
            WHERE pricing_id = ? AND status = 'Active' 
            ORDER BY version DESC LIMIT 1
        `).get(pricingId);
        
        if (recipe) {
            recipe.items = db.prepare(`
                SELECT ri.*, i.name as item_name, i.sku, i.unit, i.purchase_price
                FROM recipe_items ri
                JOIN inventory_items i ON ri.inventory_item_id = i.id
                WHERE ri.recipe_id = ?
                ORDER BY ri.sort_order, ri.id
            `).all(recipe.id);
        }
        return recipe;
    },
    createRecipe: (data) => {
        const stmt = db.prepare(`
            INSERT INTO recipes (name, pricing_id, version, status, description)
            VALUES (?, ?, ?, 'Active', ?)
        `);
        const res = stmt.run(data.name.trim(), parseInt(data.pricing_id), parseInt(data.version) || 1, data.description || '');
        return res.lastInsertRowid;
    },
    updateRecipe: (id, data) => {
        const stmt = db.prepare(`
            UPDATE recipes 
            SET name = ?, version = ?, status = ?, description = ?
            WHERE id = ?
        `);
        stmt.run(data.name.trim(), parseInt(data.version) || 1, data.status || 'Active', data.description || '', id);
    },
    softDeleteRecipe: (id) => {
        db.prepare(`UPDATE recipes SET status = 'Deleted' WHERE id = ?`).run(id);
    },
    
    // Recipe Items
    clearRecipeItems: (recipeId) => {
        db.prepare('DELETE FROM recipe_items WHERE recipe_id = ?').run(recipeId);
    },
    addRecipeItem: (recipeId, itemId, formula, qty, optional = 0, sortOrder = 0) => {
        const stmt = db.prepare(`
            INSERT INTO recipe_items (recipe_id, inventory_item_id, formula, quantity, optional, sort_order)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(recipeId, itemId, formula, qty, optional, sortOrder);
    }
};

module.exports = RecipeRepository;
