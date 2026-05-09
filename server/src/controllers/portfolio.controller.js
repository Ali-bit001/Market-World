const db = require('../config/database');

const getPortfolio = async (req, res) => {
    try {
        const userId = req.user.id;
        const worldId = Number(req.query.worldId);

        if(!worldId) return res.status(400).json({ error: 'worldId is required' });

        const database = db.getDb();
        const player = await database.collection('world_players').findOne({ user_id: userId, world_id: worldId });
        
        if (!player) {
            return res.status(400).json({ error: 'You are not in this world' });
        }

        const rawHoldings = await database.collection('portfolio').aggregate([
            { $match: { player_id: player.id, quantity: { $gt: 0 } } },
            { $lookup: { from: 'assets', localField: 'asset_id', foreignField: 'id', as: 'asset' } },
            { $unwind: { path: '$asset', preserveNullAndEmptyArrays: true } },
            { $lookup: { from: 'bonds', localField: 'asset_id', foreignField: 'asset_id', as: 'bond' } },
            { $unwind: { path: '$bond', preserveNullAndEmptyArrays: true } }
        ]).toArray();

        const holdings = rawHoldings.map(h => {
            const isBond = h.asset_type === 'bond';
            const b = isBond ? (h.bond || {}) : {};
            const a = h.asset || {};
            
            return {
                asset_type: h.asset_type,
                asset_id: h.asset_id,
                quantity: h.quantity,
                avg_buy_price: h.avg_buy_price,
                metadata: {
                    name: a.name || null,
                    symbol: a.symbol || null,
                    ticker: h.asset_type === 'share' ? a.symbol : null,
                    current_price: a.current_price || 0,
                    face_value: isBond ? b.face_value : null,
                    interest_rate: isBond ? b.interest_rate : null,
                    maturity_ticks: isBond ? b.maturity_ticks : null,
                    ticks_remaining: isBond ? b.ticks_remaining : null,
                    promised_unit_value: isBond ? (Number(b.face_value || 0) + (Number(b.face_value || 0) * Number(b.interest_rate || 0))) : null
                }
            };
        });

        res.json({
            cash_balance: player.cash_balance,
            net_worth: player.net_worth,
            holdings
        });
    } catch(err) {
        console.error('Portfolio error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

module.exports = { getPortfolio };
