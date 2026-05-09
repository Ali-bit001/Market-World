const db = require('../config/database');
const commodityService = require('./commodity.service');
const companyService = require('./company.service');
const governmentService = require('./government.service');
const cryptoService = require('./crypto.service');
const eventService = require('./event.service');
const marketService = require('./market.service');
const wsHandler = require('../websocket/ws.handler');
const { resolveAnchorPrices } = require('./market-data.service');
const {
    setAchievementProgressMax,
    unlockThresholdAchievementsForMetric
} = require('./achievement.service');

const activeSimulations = new Map(); // worldId => intervalId

// Bot trade pace probabilities (chance per tick to attempt a trade)
const BOT_TRADE_CHANCE = { fast: 0.38, medium: 0.22, slow: 0.12, default: 0.20 };
const BOT_STARTING_CAPITAL = 150000.00;
const STOCK_TENURE_WINDOW_TICKS = 100;
// Stronger floor: stocks must be ~1.5% higher over 100 ticks (long-term upward bias)
const STOCK_TENURE_MIN_GROWTH_MULTIPLIER = 1.015;
let lastAnchorRemoteFetchDate = '';

// Guaranteed inflation targets over 50 ticks (days).
const GUARANTEED_INFLATION_WINDOW_TICKS = 50;
const USER_COMPANY_GROWTH_50_TICKS = 0.03; // +3%
const COMMODITY_FLOOR_GROWTH_50_TICKS = 0.06; // +6%
const USER_COMPANY_TICK_MULTIPLIER = Math.pow(1 + USER_COMPANY_GROWTH_50_TICKS, 1 / GUARANTEED_INFLATION_WINDOW_TICKS);
const COMMODITY_FLOOR_TICK_MULTIPLIER = Math.pow(1 + COMMODITY_FLOOR_GROWTH_50_TICKS, 1 / GUARANTEED_INFLATION_WINDOW_TICKS);

const getTodayKey = () => new Date().toISOString().slice(0, 10);

const safeParseJson = (value) => {
    if (!value) return {};
    if (typeof value === 'object') return value;

    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runBotTradingTick = async (worldId) => {
    try {
        const database = db.getDb();
        const bots = await database.collection('world_players').find({
            world_id: worldId,
            is_bot: true,
            bot_role: "trader",
            cash_balance: { $gte: 200 }
        }).toArray();

        if (bots.length === 0) return;

        const allSellOrders = await database.collection('order_book').find({
            world_id: worldId,
            order_type: "sell",
            status: { $in: ["open", "partial"] }
        }).toArray();

        // Get asset prices to filter sell orders
        const assetIds = [...new Set(allSellOrders.map(o => o.asset_id))];
        const assets = await database.collection('assets').find({ id: { $in: assetIds }, world_id: worldId }).toArray();
        const assetMap = new Map(assets.map(a => [a.id, a.current_price]));

        let sellOrders = allSellOrders.filter(o => {
            const marketPrice = assetMap.get(o.asset_id) || 0;
            return o.price_per_unit <= marketPrice * 1.03;
        });

        // shuffle sellOrders
        sellOrders = sellOrders.sort(() => Math.random() - 0.5).slice(0, 40);

        for (const bot of bots) {
            const profile = typeof bot.bot_profile_json === 'string'
                ? JSON.parse(bot.bot_profile_json || '{}')
                : (bot.bot_profile_json || {});
            const pace = String(profile?.trade_pace || 'medium');
            const tradeChance = BOT_TRADE_CHANCE[pace] || BOT_TRADE_CHANCE.default;

            if (Math.random() >= tradeChance) continue;

            const cashBalance = Number(bot.cash_balance || 0);

            if (sellOrders.length > 0 && Math.random() < 0.62) {
                const target = sellOrders[Math.floor(Math.random() * sellOrders.length)];
                const maxSpend = cashBalance * (0.06 + Math.random() * 0.10);
                const pricePerUnit = Number(target.price_per_unit || 0);
                if (pricePerUnit <= 0) continue;

                const affordableQty = maxSpend / pricePerUnit;
                const remainingQty = Number(target.quantity || 0) - Number(target.filled_quantity || 0);
                const qty = Math.min(remainingQty, affordableQty);
                if (qty < 0.00000001) continue;

                try {
                    await marketService.placeOrderForPlayer(
                        bot.id, worldId,
                        'buy', target.asset_type, target.asset_id,
                        parseFloat(qty.toFixed(8)), pricePerUnit
                    );
                } catch (_) {}
            } else if (Math.random() < 0.55) {
                const holdings = await database.collection('portfolio').aggregate([
                    { $match: { player_id: bot.id, quantity: { $gt: 0 }, asset_type: { $ne: "bond" } } },
                    { $lookup: { from: 'assets', localField: 'asset_id', foreignField: 'id', as: 'asset_info' } },
                    { $unwind: '$asset_info' },
                    { $sample: { size: 1 } }
                ]).toArray();

                if (holdings.length > 0) {
                    const h = holdings[0];
                    const sellQty = Number(h.quantity) * (0.18 + Math.random() * 0.62);
                    const sellPrice = Number(h.asset_info.current_price) * (0.998 + Math.random() * 0.02);
                    if (sellQty >= 0.00000001 && sellPrice > 0) {
                        try {
                            await marketService.placeOrderForPlayer(
                                bot.id, worldId,
                                'sell', h.asset_type, h.asset_id,
                                parseFloat(sellQty.toFixed(8)), parseFloat(sellPrice.toFixed(8))
                            );
                        } catch (_) {}
                    }
                }
            }
        }
    } catch (err) {
        console.error(`Bot trading tick error (World ${worldId}):`, err);
    }
};

const insertCurrentPriceSnapshots = async (session, worldId, worldTick) => {
    const database = db.getDb();
    const operationOptions = session ? { session } : undefined;
    const assets = await database.collection('assets').find(
        { world_id: worldId, is_active: true },
        operationOptions
    ).toArray();
    
    if (assets.length === 0) return;

    const priceHistories = [];
    for (const a of assets) {
        priceHistories.push({
            world_id: a.world_id,
            asset_type: a.asset_type,
            asset_id: a.id,
            price: a.current_price,
            volume: 0,
            world_tick: worldTick,
            recorded_at: new Date().toISOString()
        });
    }

    if (priceHistories.length > 0) {
        for (const doc of priceHistories) {
            doc.id = await db.getNextId('price_history');
        }
        await database.collection('price_history').insertMany(
            priceHistories,
            operationOptions
        );
    }
};

const advanceWorldTickAndSnapshot = async (worldId) => {
    const database = db.getDb();
    const MAX_RETRIES = 5;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
        try {
            // Keep this path out of a multi-document transaction to avoid
            // lock contention with order/deal writes.
            const world = await database.collection('worlds').findOneAndUpdate(
                { id: worldId },
                { $inc: { current_tick: 1 } },
                { returnDocument: 'after' }
            );

            if (world) {
                await insertCurrentPriceSnapshots(null, worldId, world.current_tick);
            }

            // Broadcast a single tick_snapshot message — this is the only message
            // that triggers a full data refetch in the frontend. All per-service
            // broadcasts (companies, commodities, cryptos) are ignored by the client.
            wsHandler.broadcastToWorld(worldId, { type: 'tick_snapshot' });
            return;
        } catch (err) {
            const labels = Array.isArray(err?.errorLabels) ? err.errorLabels : [];
            const isTransient = labels.includes('TransientTransactionError');
            const isWriteConflict = err?.code === 112;
            if (attempt < MAX_RETRIES - 1 && (isTransient || isWriteConflict)) {
                await wait(25 * Math.pow(2, attempt));
                continue;
            }
            console.error(`Tick snapshot error (World ${worldId}):`, err);
            return;
        }
    }
};

const ensureInitialPriceHistory = async (worldId) => {
    try {
        await db.withTransaction(async (session) => {
            const database = db.getDb();
            const count = await database.collection('price_history').countDocuments({ world_id: worldId }, { session });
            if (count > 0) return;

            const world = await database.collection('worlds').findOne({ id: worldId }, { session });
            if (world) {
                await insertCurrentPriceSnapshots(session, worldId, world.current_tick);
            }
        });
    } catch (err) {
        console.error(`Failed to seed initial price history (World ${worldId}):`, err);
    }
};

const enforceStockTenureFloor = async (worldId) => {
    // Run WITHOUT a transaction — this function does many individual reads+writes
    // across assets and companies which conflicts with other concurrent transactions.
    // Using no-transaction reads + individual writes is safe here since this is
    // a soft floor correction, not a financial operation.
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const database = db.getDb();
            const world = await database.collection('worlds').findOne({ id: worldId });
            const currentTick = Number(world?.current_tick || 0);

            if (currentTick < STOCK_TENURE_WINDOW_TICKS) return;

            const referenceTick = currentTick - STOCK_TENURE_WINDOW_TICKS;

            // Read shares without a transaction to avoid write conflicts
            const shares = await database.collection('assets').aggregate([
                { $match: { world_id: worldId, asset_type: "share", is_active: true } },
                { $lookup: { from: "companies", localField: "id", foreignField: "asset_id", as: "company" } },
                { $unwind: "$company" },
                { $match: { "company.is_active": true } }
            ]).toArray();

            const bulkAssets = [];
            const bulkCompanies = [];

            for (const share of shares) {
                const refHist = await database.collection('price_history')
                    .find({ world_id: worldId, asset_type: "share", asset_id: share.id, world_tick: { $lte: referenceTick } })
                    .sort({ world_tick: -1 })
                    .limit(1)
                    .toArray();

                if (refHist.length === 0) continue;

                const referencePrice = Number(refHist[0].price || 0);
                if (!Number.isFinite(referencePrice) || referencePrice <= 0) continue;

                const floorPrice = referencePrice * STOCK_TENURE_MIN_GROWTH_MULTIPLIER;
                const currentPrice = Number(share.current_price || share.company.share_price || 0);

                if (!Number.isFinite(currentPrice) || currentPrice >= floorPrice) continue;

                bulkAssets.push({ updateOne: { filter: { id: share.id }, update: { $set: { current_price: floorPrice } } } });
                bulkCompanies.push({ updateOne: { filter: { id: share.company.id }, update: { $set: { share_price: floorPrice } } } });
            }

            if (bulkAssets.length > 0) await database.collection('assets').bulkWrite(bulkAssets);
            if (bulkCompanies.length > 0) await database.collection('companies').bulkWrite(bulkCompanies);

            return; // success
        } catch (err) {
            if (attempt < MAX_RETRIES - 1 && err?.code === 112) {
                // WriteConflict — wait briefly and retry
                await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
                continue;
            }
            console.error(`Stock tenure floor error (World ${worldId}):`, err);
            return;
        }
    }
};

const updatePlayerNetWorth = async (worldId) => {
    // No transaction — reads portfolio/assets and writes net_worth.
    // Individual updateOne per player inside a transaction conflicts with
    // market trades that also write to world_players concurrently.
    const unlockedNotifications = [];
    try {
        const database = db.getDb();
        const world = await database.collection('worlds').findOne({ id: worldId });

        const players = await database.collection('world_players').aggregate([
            { $match: { world_id: worldId } },
            { $lookup: { from: 'users', localField: 'user_id', foreignField: 'id', as: 'user' } },
            { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } }
        ]).toArray();

        const bulkPlayers = [];

        for (const p of players) {
            const cashBalance = Number(p.cash_balance || 0);

            const holdings = await database.collection('portfolio').aggregate([
                { $match: { player_id: p.id } },
                { $lookup: { from: 'assets', localField: 'asset_id', foreignField: 'id', as: 'asset' } },
                { $unwind: '$asset' }
            ]).toArray();

            let assetValue = 0;
            for (const h of holdings) {
                assetValue += (Number(h.quantity) * Number(h.asset?.current_price || 0));
            }

            const netWorth = cashBalance + assetValue;
            bulkPlayers.push({ updateOne: { filter: { id: p.id }, update: { $set: { net_worth: netWorth } } } });

            if (!p.is_bot && p.user_id && p.user) {
                // Achievement checks still need a session for atomicity
                try {
                    await db.withTransaction(async (session) => {
                        const peakNetWorth = await setAchievementProgressMax(session, p.user_id, 'net_worth_peak', netWorth);
                        const netWorthUnlocks = await unlockThresholdAchievementsForMetric(session, {
                            userId: p.user_id,
                            worldId,
                            metricKey: 'net_worth_peak',
                            metricValue: peakNetWorth,
                            username: p.user.username
                        });
                        unlockedNotifications.push(...netWorthUnlocks);
                    });
                } catch (_) {}
            }
        }

        if (bulkPlayers.length > 0) {
            await database.collection('world_players').bulkWrite(bulkPlayers);
        }

        for (const notification of unlockedNotifications) {
            wsHandler.broadcastToWorld(worldId, notification);
        }
    } catch(err) {
        console.error('Net worth calc error:', err);
    }
};

const applyMarketPressure = async (worldId) => {
    // No transaction — reads order book aggregates and writes share prices.
    // Running inside a transaction conflicts with processCompanies which also
    // writes to assets and companies concurrently.
    try {
        const database = db.getDb();
        const companies = await database.collection('companies').find({ world_id: worldId, is_active: true, asset_id: { $ne: null } }).toArray();

        // Filter out anchor companies (owned by market_corporate bots)
        const botPlayers = await database.collection('world_players').find(
            { world_id: worldId, is_bot: true, bot_role: 'market_corporate' }
        ).toArray();
        const botPlayerIds = new Set(botPlayers.map(p => p.id));
        const userCompanies = companies.filter(c => !botPlayerIds.has(Number(c.owner_player_id)));

        const bulkCompanies = [];
        const bulkAssets = [];

        for (const company of userCompanies) {
            const bids = await database.collection('order_book').aggregate([
                { $match: { world_id: worldId, asset_type: "share", asset_id: company.asset_id, order_type: "buy", status: { $in: ["open", "partial"] } } },
                { $group: { _id: null, vol: { $sum: { $subtract: ['$quantity', '$filled_quantity'] } } } }
            ]).toArray();

            const asks = await database.collection('order_book').aggregate([
                { $match: { world_id: worldId, asset_type: "share", asset_id: company.asset_id, order_type: "sell", status: { $in: ["open", "partial"] } } },
                { $group: { _id: null, vol: { $sum: { $subtract: ['$quantity', '$filled_quantity'] } } } }
            ]).toArray();

            const buyVol = Number(bids[0]?.vol || 0);
            const sellVol = Number(asks[0]?.vol || 0);
            const totalVol = buyVol + sellVol;

            if (totalVol >= 25) {
                const imbalance = (buyVol - sellVol) / totalVol;
                const shiftPerc = imbalance * 0.0015;
                let newPrice = Number(company.share_price) * (1 + shiftPerc);
                if (newPrice < 0.01) newPrice = 0.01;

                if (newPrice !== Number(company.share_price)) {
                    bulkCompanies.push({ updateOne: { filter: { id: company.id }, update: { $set: { share_price: newPrice } } } });
                    bulkAssets.push({ updateOne: { filter: { id: company.asset_id }, update: { $set: { current_price: newPrice } } } });
                }
            }
        }

        if (bulkCompanies.length > 0) await database.collection('companies').bulkWrite(bulkCompanies);
        if (bulkAssets.length > 0) await database.collection('assets').bulkWrite(bulkAssets);
    } catch(err) {
        console.error('Market pressure error:', err);
    }
};

const applyInflationToNonShareAssets = async (worldId) => {
    // No transaction needed — inflation is a small independent step per asset.
    // Crypto inflation is intentionally disabled (user request).
    try {
        const database = db.getDb();
        const inflationStep = 0.00022;

        const assets = await database.collection('assets').find({
            world_id: worldId,
            is_active: true,
            asset_type: { $in: ['bond'] }
        }).toArray();

        if (assets.length === 0) return;

        const bulkAssets = [];
        const bulkCommodities = [];
        const bulkBonds = [];

        for (const asset of assets) {
            const current = Number(asset.current_price || 0);
            if (!Number.isFinite(current) || current <= 0) continue;
            const next = Math.max(0.00000001, current * (1 + inflationStep));

            bulkAssets.push({ updateOne: { filter: { id: asset.id }, update: { $set: { current_price: next } } } });

            if (asset.asset_type === 'commodity') {
                bulkCommodities.push({ updateOne: { filter: { asset_id: asset.id }, update: { $set: { current_price: next } } } });
            } else if (asset.asset_type === 'bond') {
                bulkBonds.push({ updateOne: { filter: { asset_id: asset.id }, update: { $set: { current_value: next } } } });
            }
        }

        if (bulkAssets.length > 0) await database.collection('assets').bulkWrite(bulkAssets);
        if (bulkCommodities.length > 0) await database.collection('commodities').bulkWrite(bulkCommodities);
        if (bulkBonds.length > 0) await database.collection('bonds').bulkWrite(bulkBonds);

    } catch (err) {
        console.error(`Inflation step error (World ${worldId}):`, err);
    }
};

const applyGuaranteedInflation = async (worldId) => {
    try {
        const database = db.getDb();
        const botPlayers = await database.collection('world_players').find({
            world_id: worldId,
            is_bot: true,
            bot_role: 'market_corporate'
        }).toArray();
        const botPlayerIds = new Set(botPlayers.map(p => p.id));

        // 1) Guaranteed +3% over 50 ticks for user-created companies only.
        const userCompanies = await database.collection('companies').find({
            world_id: worldId,
            is_active: true
        }).toArray();
        const bulkCompanies = [];
        const bulkCompanyAssets = [];

        for (const company of userCompanies) {
            if (botPlayerIds.has(Number(company.owner_player_id))) continue; // skip API-anchor companies
            const nextSharePrice = Math.max(Number(company.share_price || 0) * USER_COMPANY_TICK_MULTIPLIER, 0.01);
            bulkCompanies.push({
                updateOne: { filter: { id: company.id }, update: { $set: { share_price: nextSharePrice } } }
            });
            if (company.asset_id) {
                bulkCompanyAssets.push({
                    updateOne: { filter: { id: company.asset_id }, update: { $set: { current_price: nextSharePrice } } }
                });
            }
        }

        if (bulkCompanies.length > 0) await database.collection('companies').bulkWrite(bulkCompanies);
        if (bulkCompanyAssets.length > 0) await database.collection('assets').bulkWrite(bulkCompanyAssets);

        // 2) Guaranteed +6% over 50 ticks for commodities by raising the floor gradually.
        const commodities = await database.collection('commodities').find({ world_id: worldId }).toArray();
        const bulkCommodities = [];
        const bulkCommodityAssets = [];

        for (const commodity of commodities) {
            const currentBase = Math.max(Number(commodity.base_price ?? commodity.min_price ?? commodity.current_price ?? 0.01), 0.01);
            const nextBase = currentBase * COMMODITY_FLOOR_TICK_MULTIPLIER;
            const configuredMax = Number(commodity.max_price);
            const nextMax = Number.isFinite(configuredMax)
                ? Math.max(configuredMax, nextBase)
                : Math.max(nextBase * 5, nextBase + 1);
            const currentPrice = Math.max(Number(commodity.current_price || 0), 0.01);
            const nextPrice = Math.min(nextMax, Math.max(nextBase, currentPrice));

            bulkCommodities.push({
                updateOne: {
                    filter: { id: commodity.id },
                    update: { $set: { base_price: nextBase, min_price: nextBase, max_price: nextMax, current_price: nextPrice } }
                }
            });

            if (commodity.asset_id) {
                bulkCommodityAssets.push({
                    updateOne: {
                        filter: { id: commodity.asset_id },
                        update: { $set: { current_price: nextPrice, available_quantity: Number(commodity.total_supply || 0), is_active: true } }
                    }
                });
            }
        }

        if (bulkCommodities.length > 0) await database.collection('commodities').bulkWrite(bulkCommodities);
        if (bulkCommodityAssets.length > 0) await database.collection('assets').bulkWrite(bulkCommodityAssets);
    } catch (err) {
        console.error('Guaranteed inflation step error:', err);
    }
};

/**
 * Sync anchor (global) company prices from real-world API data.
 * Called every tick, but market-data.service only refreshes API snapshots once
 * per day and reuses cached daily data for in-between tick pricing.
 * Anchor companies are those owned by market_corporate bot players.
 * Their prices are updated to reflect cached real-world daily data.
 */
const syncAnchorCompanyPrices = async (worldId) => {
    try {
        const database = db.getDb();

        // Find all market_corporate bot players for this world
        const botPlayers = await database.collection('world_players').find({
            world_id: worldId,
            is_bot: true,
            bot_role: 'market_corporate'
        }).toArray();
        if (botPlayers.length === 0) return;

        const botPlayerIds = new Set(botPlayers.map(p => p.id));

        // Get all anchor companies with their tickers
        const anchorCompanies = await database.collection('companies').find({
            world_id: worldId,
            is_active: true,
            owner_player_id: { $in: Array.from(botPlayerIds) }
        }).toArray();

        if (anchorCompanies.length === 0) return;

        const tickers = anchorCompanies.map(c => c.ticker).filter(Boolean);
        if (tickers.length === 0) return;

        // Fetch prices (uses daily cache; remote refresh is attempted once per day)
        const todayKey = getTodayKey();
        const allowRemote = lastAnchorRemoteFetchDate !== todayKey;
        const priceMap = await resolveAnchorPrices(tickers, { allowRemote });
        if (allowRemote && priceMap.size > 0) {
            lastAnchorRemoteFetchDate = todayKey;
        }

        if (priceMap.size === 0) return;

        const bulkCompanies = [];
        const bulkAssets = [];

        for (const company of anchorCompanies) {
            const ticker = String(company.ticker || '').toUpperCase();
            const newPrice = priceMap.get(ticker);
            if (!newPrice || !Number.isFinite(newPrice) || newPrice <= 0) continue;

            bulkCompanies.push({
                updateOne: {
                    filter: { id: company.id },
                    update: { $set: { share_price: newPrice } }
                }
            });

            if (company.asset_id) {
                bulkAssets.push({
                    updateOne: {
                        filter: { id: company.asset_id },
                        update: { $set: { current_price: newPrice } }
                    }
                });
            }
        }

        if (bulkCompanies.length > 0) {
            await database.collection('companies').bulkWrite(bulkCompanies);
        }
        if (bulkAssets.length > 0) {
            await database.collection('assets').bulkWrite(bulkAssets);
        }

    } catch (err) {
        console.error(`[anchor-sync] Error syncing anchor prices for world ${worldId}:`, err);
    }
};

const runTick = async (worldId) => {
    try {
        await commodityService.processCommodities(worldId);
        await cryptoService.processCryptos(worldId);
        await companyService.processCompanies(worldId);
        await governmentService.processGovernments(worldId);
        await eventService.processEvents(worldId);
        await applyInflationToNonShareAssets(worldId);

        await applyMarketPressure(worldId);
        await runBotTradingTick(worldId);
        await marketService.processOpenOrderMatches(worldId);
        await enforceStockTenureFloor(worldId);
        await applyGuaranteedInflation(worldId);
        // Sync anchor company prices from real-world daily cache (non-blocking)
        syncAnchorCompanyPrices(worldId).catch(err => console.error('Anchor sync error:', err));
        await advanceWorldTickAndSnapshot(worldId);
        await updatePlayerNetWorth(worldId);
    } catch (err) {
        console.error(`Simulation Error (World ${worldId}):`, err);
    }
};

const startSimulation = async () => {
    try {
        const database = db.getDb();
        const worlds = await database.collection('worlds').find({ status: "active" }).toArray();

        for (const world of worlds) {
            await ensureInitialPriceHistory(world.id);

            await database.collection('world_players').updateMany(
                { world_id: world.id, is_bot: true, cash_balance: { $lt: BOT_STARTING_CAPITAL } },
                { $set: { cash_balance: BOT_STARTING_CAPITAL } }
            );

            if (!activeSimulations.has(world.id)) {
                const intervalMs = (world.tick_rate_seconds || 60) * 1000;
                console.log(`Starting simulation for World ${world.id} (Tick: ${intervalMs}ms)`);
                const intervalId = setInterval(() => runTick(world.id), intervalMs);
                activeSimulations.set(world.id, intervalId);
            }
        }
    } catch(err) {
        console.error('Failed to start simulations:', err);
    }
};

module.exports = {
    startSimulation
};
