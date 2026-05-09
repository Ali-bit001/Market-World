const db = require('../config/database');
const wsHandler = require('../websocket/ws.handler');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const processCryptos = async (worldId) => {
    try {
        const database = db.getDb();
        const cryptos = await database.collection('cryptos').find({ world_id: worldId }).toArray();

        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
        const anchorRows = await database.collection('price_history').aggregate([
            { $match: { world_id: worldId, asset_type: "crypto", recorded_at: { $gte: sixHoursAgo } } },
            { $group: { _id: "$asset_id", anchor_price: { $avg: "$price" } } }
        ]).toArray();

        const anchorByAssetId = new Map();
        for (const row of anchorRows) {
            const assetId = Number(row._id || 0);
            if (!Number.isInteger(assetId) || assetId <= 0) {
                continue;
            }
            anchorByAssetId.set(assetId, Number(row.anchor_price || 0));
        }
        
        const bulkCryptos = [];
        const bulkAssets = [];

        for (let c of cryptos) {
            // Use bounded noise + soft reversion to a recent anchor to avoid repeated near-zero cascades.
            let u1 = Math.random();
            let u2 = Math.random();
            let randStdNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2); 

            const currentPrice = Math.max(Number(c.current_price || 0), 0.000001);
            const baseVolatility = clamp(Number(c.volatility || 0.22), 0.02, 0.60);
            const scaledVolatility = baseVolatility * 0.035;

            const randomShock = randStdNormal * scaledVolatility;
            const tailShock = Math.random() < 0.02
                ? (Math.random() < 0.5 ? -1 : 1) * (0.025 + (Math.random() * 0.05))
                : 0;

            const anchorPrice = Math.max(
                Number(anchorByAssetId.get(Number(c.asset_id || 0)) || currentPrice),
                0.000001
            );
            const meanReversion = clamp(((anchorPrice - currentPrice) / currentPrice) * 0.08, -0.02, 0.02);
            const rawChangePercent = randomShock + tailShock + meanReversion;
            const boundedChangePercent = clamp(rawChangePercent, -0.18, 0.22);

            const floorPrice = Math.max(0.000001, anchorPrice * 0.08);
            const capPrice = Math.max(anchorPrice * 5, currentPrice * 1.8, floorPrice + 0.000001);
            let newPrice = currentPrice * (1 + boundedChangePercent);
            newPrice = clamp(newPrice, floorPrice, capPrice);

            bulkCryptos.push({
                updateOne: {
                    filter: { id: c.id },
                    update: { $set: { current_price: newPrice } }
                }
            });

            if (c.asset_id) {
                bulkAssets.push({
                    updateOne: {
                        filter: { id: c.asset_id },
                        update: { $set: { current_price: newPrice, available_quantity: Number(c.circulating_supply || 0), is_active: true } }
                    }
                });
            }
        }

        if (bulkCryptos.length > 0) {
            await database.collection('cryptos').bulkWrite(bulkCryptos);
        }

        if (bulkAssets.length > 0) {
            await database.collection('assets').bulkWrite(bulkAssets);
        }

        wsHandler.broadcastToWorld(worldId, { type: 'cryptos', message: 'Crypto tick completed' });
    } catch(err) {
        console.error('Crypto error:', err);
    }
};

module.exports = { processCryptos };
