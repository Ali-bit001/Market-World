const marketService = require('../services/market.service');
const db = require('../config/database');

const placeOrder = async (req, res) => {
    try {
        const userId = req.user.id;
        const { worldId, orderType, assetType, quantity, pricePerUnit } = req.body;
        let { assetId, assetSymbol } = req.body;

        if (!worldId || !orderType || !assetType || !quantity || !pricePerUnit) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const database = db.getDb();
        const numericAssetId = Number(assetId);
        
        if ((!Number.isInteger(numericAssetId) || numericAssetId <= 0) && assetSymbol) {
            const asset = await database.collection('assets').findOne({
                world_id: Number(worldId),
                symbol: new RegExp(`^${String(assetSymbol).trim()}$`, 'i'),
                asset_type: assetType,
                is_active: true
            });
            
            if (!asset) {
                return res.status(400).json({ error: `Asset symbol "${assetSymbol}" not found for type "${assetType}" in this world.` });
            }
            assetId = asset.id;
        } else {
            assetId = numericAssetId;
        }

        if (!assetId || assetId <= 0) {
            return res.status(400).json({ error: 'Provide a valid assetId or assetSymbol.' });
        }

        const result = await marketService.placeOrder(
            userId,
            worldId,
            orderType,
            assetType,
            assetId,
            quantity,
            pricePerUnit
        );

        res.json(result);
    } catch(err) {
        console.error('Place order error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const cancelOrder = async (req, res) => {
    try {
        const userId = req.user.id;
        const { worldId } = req.body;
        const orderId = req.params.id;

        if(!worldId) return res.status(400).json({ error: 'World ID required' });

        const result = await marketService.cancelOrder(userId, worldId, orderId);
        res.json(result);
    } catch(err) {
        console.error('Cancel order error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const listUserOrders = async (req, res) => {
    try {
        const userId = req.user.id;
        const worldId = Number(req.query.worldId);

        if(!worldId) return res.status(400).json({ error: 'worldId query parameter required' });

        const database = db.getDb();
        const player = await database.collection('world_players').findOne({ user_id: userId, world_id: worldId });
        if(!player) return res.status(400).json({ error: 'Not in this world' });
        
        const playerId = player.id;

        const rawOrders = await database.collection('order_book').aggregate([
            { $match: { player_id: playerId, status: { $in: ["open", "partial"] } } },
            { $sort: { created_at: -1 } },
            { $lookup: { from: 'assets', localField: 'asset_id', foreignField: 'id', as: 'asset' } },
            { $unwind: { path: '$asset', preserveNullAndEmptyArrays: true } }
        ]).toArray();

        const orders = rawOrders.map(order => ({
            id: order.id,
            world_id: order.world_id,
            player_id: order.player_id,
            order_type: order.order_type,
            asset_type: order.asset_type,
            asset_id: order.asset_id,
            stock_market_id: order.stock_market_id,
            quantity: order.quantity,
            price_per_unit: order.price_per_unit,
            filled_quantity: order.filled_quantity,
            status: order.status,
            created_at: order.created_at,
            remaining_quantity: Number(order.quantity || 0) - Number(order.filled_quantity || 0),
            asset_meta: order.asset ? { name: order.asset.name, symbol: order.asset.symbol } : null
        }));

        res.json({ orders });
    } catch(err) {
        console.error('List user orders error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

module.exports = {
    placeOrder,
    cancelOrder,
    listUserOrders
};
