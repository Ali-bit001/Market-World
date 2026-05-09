const db = require('../config/database');
const wsHandler = require('../websocket/ws.handler');

// Long-term inflation drift: ~0.007% per tick gives ~100-tick doubling via compounding.
// Events can temporarily counteract this but the drift re-asserts over time.
const COMMODITY_INFLATION_DRIFT = 0.00007;
const MAX_TICK_CHANGE = 0.15;   // cap single-tick gain at +15%
const MIN_TICK_CHANGE = -0.15;  // cap single-tick loss at -15%

const clampCommodityPrice = (commodity, currentPrice, nextPriceCandidate) => {
    const minPrice = Math.max(Number(commodity.min_price ?? commodity.base_price ?? 0.0001), 0.0001);
    const configuredMax = Number(commodity.max_price);
    const maxPrice = Number.isFinite(configuredMax) && configuredMax > minPrice
        ? configuredMax
        : Math.max(minPrice * 5, minPrice + 1);

    // Hard per-tick movement cap from current price.
    const tickLow = Math.max(minPrice, currentPrice * (1 + MIN_TICK_CHANGE));
    const tickHigh = Math.min(maxPrice, currentPrice * (1 + MAX_TICK_CHANGE));

    return Math.min(tickHigh, Math.max(tickLow, nextPriceCandidate));
};

const processCommodities = async (worldId) => {
    try {
        const database = db.getDb();

        // 1. Update total_supply in commodities collection
        // Unfortunately, MongoDB $inc requires a value, and supply_rate is a field.
        // We can use an aggregation pipeline in updateMany, or fetch and update.
        const commodities = await database.collection('commodities').find({ world_id: worldId }).toArray();
        if (commodities.length === 0) return;

        const bulkCommodities = [];
        const bulkAssets = [];

        for (const c of commodities) {
            const minPrice = Math.max(Number(c.min_price ?? c.base_price ?? 0.0001), 0.0001);
            const currentPrice = Math.max(Number(c.current_price || 0), minPrice);
            const volatility = Math.max(Number(c.volatility || 0.05), 0.001);

            // Biased random walk: inflationary centre ensures long-term growth.
            const rawChange = (Math.random() * 2 - 1) * volatility + COMMODITY_INFLATION_DRIFT;
            const clampedChange = Math.min(MAX_TICK_CHANGE, Math.max(MIN_TICK_CHANGE, rawChange));
            const rawNextPrice = currentPrice * (1 + clampedChange);
            const newPrice = clampCommodityPrice(c, currentPrice, rawNextPrice);
            
            const supplyRate = Number(c.supply_rate || 0);
            const newSupply = Number(c.total_supply || 0) + supplyRate;

            bulkCommodities.push({
                updateOne: {
                    filter: { id: c.id },
                    update: { $set: { current_price: newPrice, total_supply: newSupply } }
                }
            });

            if (c.asset_id) {
                bulkAssets.push({
                    updateOne: {
                        filter: { id: c.asset_id },
                        update: { $set: { current_price: newPrice, available_quantity: newSupply, is_active: true } }
                    }
                });
            }
        }

        if (bulkCommodities.length > 0) {
            await database.collection('commodities').bulkWrite(bulkCommodities);
        }
        
        if (bulkAssets.length > 0) {
            await database.collection('assets').bulkWrite(bulkAssets);
        }

        wsHandler.broadcastToWorld(worldId, { type: 'commodities', message: 'Commodity prices updated' });
    } catch (err) {
        console.error('Commodity simulation error:', err);
    }
};

module.exports = {
    processCommodities
};
