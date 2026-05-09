const db = require('../config/database');

const getMarketAssets = async (req, res) => {
    try {
        const { worldId: rawWorldId, type } = req.query;
        const worldId = Number(rawWorldId);
        if (!worldId || !type) return res.status(400).json({ error: 'worldId and type required' });

        const validTypes = ['share', 'commodity', 'crypto', 'bond'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({ error: 'Invalid asset type' });
        }

        const database = db.getDb();
        const pipeline = [
            { $match: { world_id: worldId, asset_type: type, is_active: true } },
            { $sort: { id: 1 } },
            { $lookup: { from: 'companies', localField: 'id', foreignField: 'asset_id', as: 'company' } },
            { $lookup: { from: 'bonds', localField: 'id', foreignField: 'asset_id', as: 'bond' } },
            { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
            { $unwind: { path: '$bond', preserveNullAndEmptyArrays: true } }
        ];

        const rawAssets = await database.collection('assets').aggregate(pipeline).toArray();
        
        const assets = rawAssets.map(a => ({
            id: a.id,
            name: a.name,
            symbol: a.symbol,
            current_price: a.current_price,
            total_supply: a.available_quantity,
            description: a.company ? a.company.description : null,
            interest_rate: a.bond ? a.bond.interest_rate : null
        }));

        res.json({ assets });
    } catch(err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
};

const getWorldSnapshot = async (req, res) => {
    try {
        const worldId = Number(req.query.worldId);
        if (!Number.isInteger(worldId)) {
            return res.status(400).json({ error: 'worldId required' });
        }

        const database = db.getDb();
        const world = await database.collection('worlds').findOne({ id: worldId });
        if (!world) return res.status(404).json({ error: 'World not found' });

        const assets = await database.collection('assets').find({ world_id: worldId, is_active: true }).sort({ asset_type: 1, id: 1 }).toArray();
        const assetIds = assets.map(a => a.id);

        const currentTick = Number(world.current_tick || 0);
        const prevTick = currentTick > 0 ? currentTick - 1 : null;

        const prevPriceMap = new Map();
        if (assetIds.length > 0 && prevTick !== null) {
            // Only fetch the latest two ticks to avoid scanning all history.
            const recentHistories = await database.collection('price_history').find(
                {
                    world_id: worldId,
                    asset_id: { $in: assetIds },
                    world_tick: { $in: [currentTick, prevTick] }
                },
                { projection: { asset_id: 1, price: 1, world_tick: 1, id: 1 } }
            ).sort({ world_tick: -1, id: -1 }).toArray();

            for (const row of recentHistories) {
                if (row.world_tick !== prevTick) continue;
                if (!prevPriceMap.has(row.asset_id)) {
                    prevPriceMap.set(row.asset_id, Number(row.price));
                }
            }
        }

        const shareOrders = await database.collection('order_book').find({
            world_id: worldId, asset_type: 'share', order_type: 'sell', status: { $in: ['open', 'partial'] }
        }).toArray();
        const shareAvailableMap = new Map();
        for (const o of shareOrders) {
            const qty = Number(o.quantity || 0) - Number(o.filled_quantity || 0);
            shareAvailableMap.set(o.asset_id, (shareAvailableMap.get(o.asset_id) || 0) + qty);
        }

        // Use $ne: false so companies without the is_listed field (legacy) are also included
        const companies = await database.collection('companies').find({ world_id: worldId, is_listed: { $ne: false } }).toArray();
        const bonds = await database.collection('bonds').find({ world_id: worldId }).toArray();
        const commodities = await database.collection('commodities').find({ world_id: worldId }).toArray();
        const cryptos = await database.collection('cryptos').find({ world_id: worldId }).toArray();
        const stockMarkets = await database.collection('stock_markets').find({ world_id: worldId }).toArray();
        const countries = await database.collection('countries').find().toArray();
        const governments = await database.collection('country_states').find({ world_id: worldId }).toArray();

        const getOrg = (asset) => {
            if (asset.asset_type === 'share') {
                const c = companies.find(c => c.asset_id === asset.id);
                if (!c) return "Company";
                const sm = stockMarkets.find(s => s.id === c.stock_market_id);
                return `${c.name} @ ${sm ? sm.code : "MKT"}`;
            }
            if (asset.asset_type === 'bond') {
                const b = bonds.find(b => b.asset_id === asset.id);
                if (!b) return "Sovereign Issuer";
                const cn = countries.find(c => c.id === b.country_id);
                const g = governments.find(g => g.id === b.government_id);
                return cn ? cn.name : (g ? g.name : "Sovereign Issuer");
            }
            if (asset.asset_type === 'commodity') return "Global Commodity Market";
            if (asset.asset_type === 'crypto') return "Crypto Network";
            return "Market";
        };

        const getAvailable = (asset) => {
            if (asset.asset_type === 'share') return shareAvailableMap.get(asset.id) || 0;
            if (asset.asset_type === 'commodity') {
                const c = commodities.find(c => c.asset_id === asset.id);
                return c ? c.total_supply : 0;
            }
            if (asset.asset_type === 'crypto') {
                const c = cryptos.find(c => c.asset_id === asset.id);
                return c ? c.circulating_supply : 0;
            }
            if (asset.asset_type === 'bond') {
                const b = bonds.find(b => b.asset_id === asset.id);
                return b ? b.total_issued : 0;
            }
            return asset.available_quantity || 0;
        };

        const normalized = assets.map((asset) => {
            const currentPrice = Number(asset.current_price || 0);
            const prevPriceRaw = prevPriceMap.get(asset.id);
            const prevPrice = prevPriceRaw === undefined ? null : Number(prevPriceRaw);
            const percentChange = (prevPrice !== null && prevPrice !== 0)
                ? ((currentPrice - prevPrice) / prevPrice) * 100
                : null;

            return {
                asset_type: asset.asset_type,
                asset_id: asset.id,
                name: asset.name,
                symbol: asset.symbol,
                current_price: currentPrice,
                prev_price: prevPrice,
                available_quantity: Number(getAvailable(asset)),
                associated_organization: getOrg(asset),
                percent_change: percentChange
            };
        });

        res.json({
            world: {
                id: world.id,
                name: world.name,
                current_tick: world.current_tick,
                tick_rate_seconds: world.tick_rate_seconds
            },
            assets: normalized
        });
    } catch (err) {
        console.error('World snapshot error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

const getAssetHistory = async (req, res) => {
    try {
        const worldId = Number(req.query.worldId);
        const assetType = String(req.query.assetType || '').trim();
        const assetId = Number(req.query.assetId);
        const limit = Math.min(Math.max(Number(req.query.limit || 120), 1), 500);

        if (!Number.isInteger(worldId) || !Number.isInteger(assetId)) {
            return res.status(400).json({ error: 'worldId and assetId are required' });
        }

        const database = db.getDb();
        const asset = await database.collection('assets').findOne({ world_id: worldId, id: assetId });
        
        if (!asset) {
            return res.status(404).json({ error: 'Asset not found in this world' });
        }

        const canonicalType = String(asset.asset_type);
        if (assetType && assetType !== canonicalType) {
            return res.status(400).json({ error: 'assetType does not match assetId' });
        }

        const rows = await database.collection('price_history').find({ 
            world_id: worldId, asset_type: canonicalType, asset_id: assetId 
        }).sort({ world_tick: -1, id: -1 }).limit(limit).toArray();

        const world = await database.collection('worlds').findOne({ id: worldId });
        const worldTick = Number(world?.current_tick || 0);
        const ascendingRows = rows.slice().reverse();

        // Deduplicate by world_tick — keep only the last entry per tick (highest id)
        // This prevents multiple lines on the chart when both tick snapshots and trades
        // create separate price_history entries for the same world_tick.
        const tickMap = new Map();
        for (const row of ascendingRows) {
            const tick = row.world_tick ?? row.recorded_at;
            const existing = tickMap.get(tick);
            if (!existing || Number(row.id || 0) > Number(existing.id || 0)) {
                tickMap.set(tick, row);
            }
        }
        const dedupedRows = Array.from(tickMap.values()).sort((a, b) => {
            const aVal = a.world_tick ?? 0;
            const bVal = b.world_tick ?? 0;
            return Number(aVal) - Number(bVal);
        });

        const history = dedupedRows.map((row, index) => {
            const fallbackDay = Math.max(0, worldTick - (dedupedRows.length - 1 - index));
            return {
                id: row.id,
                price: Number(row.price),
                volume: Number(row.volume || 0),
                recorded_at: row.recorded_at,
                game_day: Number(row.world_tick ?? fallbackDay)
            };
        });

        if (history.length === 0) {
            history.push({
                id: `bootstrap-${assetId}`,
                price: Number(asset.current_price || 0),
                volume: 0,
                recorded_at: null,
                game_day: worldTick
            });
        }

        res.json({ history });
    } catch (err) {
        console.error('Asset history error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

const getOrderBookAggregated = async (req, res) => {
    try {
        const { worldId, assetType, assetId } = req.query;
        const parsedWorldId = Number(worldId);
        const parsedAssetId = Number(assetId);

        if (!Number.isInteger(parsedWorldId) || !Number.isInteger(parsedAssetId)) {
            return res.status(400).json({ error: 'worldId and assetId required' });
        }

        const database = db.getDb();
        const asset = await database.collection('assets').findOne({ world_id: parsedWorldId, id: parsedAssetId });
        if (!asset) {
            return res.status(404).json({ error: 'Asset not found in this world' });
        }

        const canonicalType = String(asset.asset_type);
        if (assetType && assetType !== canonicalType) {
            return res.status(400).json({ error: 'assetType does not match assetId' });
        }

        const bidsPipeline = [
            { $match: { world_id: parsedWorldId, asset_type: canonicalType, asset_id: parsedAssetId, order_type: 'buy', status: { $in: ['open', 'partial'] } } },
            { $group: { _id: "$price_per_unit", total_quantity: { $sum: { $subtract: ["$quantity", { $ifNull: ["$filled_quantity", 0] }] } } } },
            { $sort: { _id: -1 } },
            { $limit: 15 },
            { $project: { _id: 0, price: "$_id", total_quantity: 1 } }
        ];

        const asksPipeline = [
            { $match: { world_id: parsedWorldId, asset_type: canonicalType, asset_id: parsedAssetId, order_type: 'sell', status: { $in: ['open', 'partial'] } } },
            { $group: { _id: "$price_per_unit", total_quantity: { $sum: { $subtract: ["$quantity", { $ifNull: ["$filled_quantity", 0] }] } } } },
            { $sort: { _id: 1 } },
            { $limit: 15 },
            { $project: { _id: 0, price: "$_id", total_quantity: 1 } }
        ];

        const bids = await database.collection('order_book').aggregate(bidsPipeline).toArray();
        const asks = await database.collection('order_book').aggregate(asksPipeline).toArray();

        res.json({ asset_type: canonicalType, bids, asks });
    } catch(err) {
        res.status(500).json({ error: 'Server error' });
    }
};

module.exports = {
    getMarketAssets,
    getOrderBookAggregated,
    getWorldSnapshot,
    getAssetHistory
};
