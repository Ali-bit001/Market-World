const db = require('../config/database');
const wsHandler = require('../websocket/ws.handler');
const {
    getAchievementProgress,
    incrementAchievementProgress,
    setAchievementProgressMax,
    unlockThresholdAchievementsForMetric
} = require('./achievement.service');

const activeMatchKeys = new Set();
const ANCHOR_SHARE_MAX_SLIPPAGE = 0.10;
const ORDER_TXN_RETRY_OPTIONS = { maxRetries: 10 };

const normalizeSymbol = (symbol) => String(symbol || '').trim().toUpperCase();

const isAnchorCompanyOwner = async (database, worldId, ownerPlayerId, session) => {
    const normalizedPlayerId = Number(ownerPlayerId || 0);
    if (!Number.isInteger(normalizedPlayerId) || normalizedPlayerId <= 0) {
        return false;
    }

    const ownerPlayer = await database.collection('world_players').findOne(
        { id: normalizedPlayerId, world_id: Number(worldId) },
        { session }
    );

    return Boolean(ownerPlayer?.is_bot) && String(ownerPlayer?.bot_role || '') === 'market_corporate';
};

const getWorldTick = async (session, worldId) => {
    const database = db.getDb();
    const world = await database.collection('worlds').findOne({ id: worldId }, { session });
    return Number(world?.current_tick || 0);
};

const trackCommodityProfitAchievements = async (session, { userId, worldId, username, commoditySymbol, realizedProfit }) => {
    const notifications = [];
    const normalizedProfit = Number(realizedProfit || 0);
    const symbol = normalizeSymbol(commoditySymbol);

    if (!userId || !symbol || normalizedProfit <= 0) return notifications;

    const metricKey = `commodity_profit_${symbol}`;
    const previousProfit = await getAchievementProgress(session, userId, metricKey);
    const updatedProfit = await incrementAchievementProgress(session, userId, metricKey, normalizedProfit);

    const symbolUnlocks = await unlockThresholdAchievementsForMetric(session, {
        userId, worldId, metricKey, metricValue: updatedProfit, username
    });
    notifications.push(...symbolUnlocks);

    if (previousProfit <= 0 && updatedProfit > 0) {
        const diversifiedCount = await incrementAchievementProgress(session, userId, 'commodity_distinct_profitable_count', 1);
        const diversifiedUnlocks = await unlockThresholdAchievementsForMetric(session, {
            userId, worldId, metricKey: 'commodity_distinct_profitable_count', metricValue: diversifiedCount, username
        });
        notifications.push(...diversifiedUnlocks);
    }

    return notifications;
};

const upsertPortfolioBuy = async (session, playerId, assetType, assetId, quantity, executionPrice) => {
    const database = db.getDb();
    const existing = await database.collection('portfolio').findOne(
        { player_id: playerId, asset_type: assetType, asset_id: assetId },
        { session }
    );

    if (existing) {
        const oldQty = Number(existing.quantity || 0);
        const oldAvg = Number(existing.avg_buy_price || 0);
        const nextQty = oldQty + quantity;
        const nextAvg = nextQty > 0 ? ((oldQty * oldAvg) + (quantity * executionPrice)) / nextQty : executionPrice;

        await database.collection('portfolio').updateOne(
            { id: existing.id },
            { $set: { quantity: nextQty, avg_buy_price: nextAvg } },
            { session }
        );
    } else {
        const portId = await db.getNextId('portfolio');
        await database.collection('portfolio').insertOne({
            id: portId,
            player_id: playerId,
            asset_type: assetType,
            asset_id: assetId,
            quantity,
            avg_buy_price: executionPrice
        }, { session });
    }
};

const applyPortfolioSell = async (session, playerId, assetType, assetId, quantity) => {
    const database = db.getDb();
    const existing = await database.collection('portfolio').findOne(
        { player_id: playerId, asset_type: assetType, asset_id: assetId },
        { session }
    );

    if (!existing || Number(existing.quantity || 0) < quantity) {
        throw new Error('Insufficient assets to sell');
    }

    const avgBuyPrice = Number(existing.avg_buy_price || 0);
    const nextQty = Number(existing.quantity) - quantity;
    if (nextQty > 0) {
        await database.collection('portfolio').updateOne(
            { id: existing.id },
            { $set: { quantity: nextQty } },
            { session }
        );
    } else {
        await database.collection('portfolio').deleteOne({ id: existing.id }, { session });
    }

    return { avgBuyPrice, soldQuantity: Number(quantity) };
};

const syncSubtypeForInstantTrade = async (session, assetType, assetId, executionPrice, quantityDelta) => {
    const database = db.getDb();
    if (assetType === 'commodity') {
        const commodity = await database.collection('commodities').findOne({ asset_id: assetId }, { session });
        if (commodity) {
            await database.collection('commodities').updateOne(
                { asset_id: assetId },
                { $set: { current_price: executionPrice, total_supply: Math.max(commodity.total_supply + quantityDelta, 0) } },
                { session }
            );
        }
    } else if (assetType === 'crypto') {
        const crypto = await database.collection('cryptos').findOne({ asset_id: assetId }, { session });
        if (crypto) {
            await database.collection('cryptos').updateOne(
                { asset_id: assetId },
                { $set: { current_price: executionPrice, circulating_supply: Math.max(crypto.circulating_supply + quantityDelta, 0) } },
                { session }
            );
        }
    } else if (assetType === 'bond') {
        const bond = await database.collection('bonds').findOne({ asset_id: assetId }, { session });
        if (bond) {
            await database.collection('bonds').updateOne(
                { asset_id: assetId },
                { $set: { current_value: bond.face_value, total_issued: Math.max(bond.total_issued + quantityDelta, 0) } },
                { session }
            );
        }
    }
};

const executeImmediateSpotOrder = async (session, { userId, username, playerId, worldId, orderType, assetType, assetId, quantity, marketPrice, availableQuantity, assetSymbol }) => {
    const database = db.getDb();
    if (!Number.isFinite(marketPrice) || marketPrice <= 0) throw new Error('Asset has no tradable market price');

    const totalTradeValue = quantity * marketPrice;
    let quantityDelta = 0;
    const achievementNotifications = [];

    if (orderType === 'buy') {
        const player = await database.collection('world_players').findOne({ id: playerId }, { session });
        const currentCash = Number(player?.cash_balance || 0);
        if (currentCash < totalTradeValue) throw new Error('Insufficient cash balance');
        if (Number(availableQuantity || 0) < quantity) throw new Error('Not enough market supply available for this asset');

        await database.collection('world_players').updateOne({ id: playerId }, { $inc: { cash_balance: -totalTradeValue } }, { session });
        await upsertPortfolioBuy(session, playerId, assetType, assetId, quantity, marketPrice);
        quantityDelta = -quantity;
    } else if (orderType === 'sell') {
        const sellResult = await applyPortfolioSell(session, playerId, assetType, assetId, quantity);
        await database.collection('world_players').updateOne({ id: playerId }, { $inc: { cash_balance: totalTradeValue } }, { session });
        quantityDelta = quantity;

        if (assetType === 'commodity') {
            const realizedProfit = (marketPrice - Number(sellResult.avgBuyPrice || 0)) * Number(quantity);
            const commodityNotifications = await trackCommodityProfitAchievements(session, {
                userId, worldId, username, commoditySymbol: assetSymbol, realizedProfit
            });
            achievementNotifications.push(...commodityNotifications);
        }
    } else {
        throw new Error('Invalid order type');
    }

    const asset = await database.collection('assets').findOne({ id: assetId }, { session });
    await database.collection('assets').updateOne(
        { id: assetId },
        { $set: { current_price: marketPrice, available_quantity: Math.max((asset?.available_quantity || 0) + quantityDelta, 0) } },
        { session }
    );

    await syncSubtypeForInstantTrade(session, assetType, assetId, marketPrice, quantityDelta);

    const txId = await db.getNextId('transactions');
    await database.collection('transactions').insertOne({
        id: txId,
        world_id: worldId,
        buyer_id: playerId,
        seller_id: playerId,
        asset_type: assetType,
        asset_id: assetId,
        quantity,
        price_per_unit: marketPrice,
        total_amount: totalTradeValue,
        created_at: new Date().toISOString()
    }, { session });

    const worldTick = await getWorldTick(session, worldId);
    const phId = await db.getNextId('price_history');
    await database.collection('price_history').insertOne({
        id: phId,
        world_id: worldId,
        asset_type: assetType,
        asset_id: assetId,
        price: marketPrice,
        volume: quantity,
        world_tick: worldTick
    }, { session });

    return { executed: true, orderType, assetType, assetId, quantity, executionPrice: marketPrice, message: `${assetType} ${orderType} executed instantly (first come, first served).`, achievementNotifications };
};

const executeAnchorShareOrder = async (session, { userId, username, playerId, worldId, orderType, asset, company, quantity, limitPrice }) => {
    const database = db.getDb();
    const marketPrice = Number(asset.current_price || company.share_price || 0);
    if (!Number.isFinite(marketPrice) || marketPrice <= 0) throw new Error('Asset has no tradable market price');

    const normalizedLimit = Number.isFinite(limitPrice) && limitPrice > 0 ? limitPrice : marketPrice;

    if (orderType === 'buy') {
        const minAcceptable = marketPrice * (1 - ANCHOR_SHARE_MAX_SLIPPAGE);
        if (normalizedLimit < minAcceptable) {
            throw new Error('Price moved more than 10% above your limit. Please resubmit.');
        }
    }

    const totalTradeValue = quantity * marketPrice;
    const availableQty = Number(asset.available_quantity || 0);
    const trackSupply = Number.isFinite(availableQty) && availableQty > 0;

    if (orderType === 'buy') {
        const player = await database.collection('world_players').findOne({ id: playerId }, { session });
        const currentCash = Number(player?.cash_balance || 0);
        if (currentCash < totalTradeValue) throw new Error('Insufficient cash balance');
        if (trackSupply && availableQty < quantity) throw new Error('Not enough shares available for this stock');

        await database.collection('world_players').updateOne({ id: playerId }, { $inc: { cash_balance: -totalTradeValue } }, { session });
        await upsertPortfolioBuy(session, playerId, 'share', asset.id, quantity, marketPrice);

        if (trackSupply) {
            await database.collection('assets').updateOne(
                { id: asset.id },
                { $inc: { available_quantity: -quantity } },
                { session }
            );
            await database.collection('companies').updateOne(
                { id: company.id },
                { $inc: { shares_in_market: -quantity } },
                { session }
            );
        }
    } else if (orderType === 'sell') {
        await applyPortfolioSell(session, playerId, 'share', asset.id, quantity);
        await database.collection('world_players').updateOne({ id: playerId }, { $inc: { cash_balance: totalTradeValue } }, { session });

        if (trackSupply) {
            await database.collection('assets').updateOne(
                { id: asset.id },
                { $inc: { available_quantity: quantity } },
                { session }
            );
            await database.collection('companies').updateOne(
                { id: company.id },
                { $inc: { shares_in_market: quantity } },
                { session }
            );
        }
    } else {
        throw new Error('Invalid order type');
    }

    const txId = await db.getNextId('transactions');
    await database.collection('transactions').insertOne({
        id: txId,
        world_id: worldId,
        buyer_id: orderType === 'buy' ? playerId : Number(company.owner_player_id || 0),
        seller_id: orderType === 'sell' ? playerId : Number(company.owner_player_id || 0),
        asset_type: 'share',
        asset_id: asset.id,
        quantity,
        price_per_unit: marketPrice,
        total_amount: totalTradeValue,
        created_at: new Date().toISOString()
    }, { session });

    return {
        executed: true,
        orderType,
        assetType: 'share',
        assetId: asset.id,
        quantity,
        executionPrice: marketPrice,
        message: `${orderType === 'buy' ? 'Bought' : 'Sold'} ${quantity} share(s) of ${company.name} at ${marketPrice.toFixed(4)} each.`,
        achievementNotifications: []
    };
};

const tryFastAnchorShareOrder = async ({ userId, worldId, orderType, assetType, assetId, quantity, pricePerUnit }) => {
    const normalizedAssetType = String(assetType || '').trim();
    if (normalizedAssetType !== 'share') return null;

    const database = db.getDb();
    const asset = await database.collection('assets').findOne({ id: assetId, world_id: worldId, is_active: true });
    if (!asset) return null;

    const company = await database.collection('companies').findOne({ world_id: worldId, asset_id: assetId });
    if (!company) return null;

    const isAnchor = await isAnchorCompanyOwner(database, worldId, company.owner_player_id, null);
    if (!isAnchor) return null;

    const player = await database.collection('world_players').findOne({ user_id: userId, world_id: worldId });
    if (!player) throw new Error('You have not joined this world');

    const user = await database.collection('users').findOne({ id: userId });
    const normalizedQty = Number(quantity);
    const normalizedPrice = Number(pricePerUnit);

    return executeAnchorShareOrder(null, {
        userId,
        username: user?.username,
        playerId: player.id,
        worldId,
        orderType,
        asset,
        company,
        quantity: normalizedQty,
        limitPrice: normalizedPrice
    });
};

const placeOrder = async (userId, worldId, orderType, assetType, assetId, quantity, pricePerUnit) => {
    let executionResult = null;
    let newOrderId = null;
    let canonicalType = null;
    let normalizedAssetId = Number(assetId);

    const normalizedAssetType = String(assetType || '').trim();
    const normalizedQty = Number(quantity);
    const normalizedPrice = Number(pricePerUnit);

    if (!['share', 'commodity', 'bond', 'crypto'].includes(normalizedAssetType)) throw new Error('Invalid asset type');
    if (!['buy', 'sell'].includes(orderType)) throw new Error('Invalid order type');
    if (!Number.isFinite(normalizedAssetId) || normalizedAssetId <= 0) throw new Error('Invalid asset id');
    if (!Number.isFinite(normalizedQty) || normalizedQty <= 0) throw new Error('Invalid quantity');
    if (normalizedAssetType === 'share' && (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0)) {
        throw new Error('Invalid price');
    }

    executionResult = await tryFastAnchorShareOrder({
        userId,
        worldId,
        orderType,
        assetType: normalizedAssetType,
        assetId: normalizedAssetId,
        quantity: normalizedQty,
        pricePerUnit: normalizedPrice
    });
    if (executionResult) {
        return executionResult;
    }

    await db.withTransaction(async (session) => {
        const database = db.getDb();
        const providedPrice = normalizedPrice;

        const asset = await database.collection('assets').findOne({ id: normalizedAssetId, world_id: worldId }, { session });
        if (!asset) throw new Error('Asset not found in this world');

        canonicalType = String(asset.asset_type);
        if (canonicalType !== normalizedAssetType) throw new Error('Asset type does not match selected asset');
        if (canonicalType === 'bond' && orderType === 'sell') throw new Error('Bonds are locked until maturity and cannot be sold.');
        if (!asset.is_active) {
            // For bonds: check if the underlying bond record is still active
            // (the asset may have been deactivated by a sync while the bond is still valid)
            if (canonicalType === 'bond') {
                const bondRecord = await database.collection('bonds').findOne({ asset_id: normalizedAssetId, world_id: worldId }, { session });
                if (bondRecord && bondRecord.is_active) {
                    // Re-activate the asset — it was incorrectly deactivated
                    await database.collection('assets').updateOne(
                        { id: normalizedAssetId },
                        { $set: { is_active: true, current_price: bondRecord.current_value, available_quantity: bondRecord.total_issued } },
                        { session }
                    );
                    asset.is_active = true;
                    asset.current_price = bondRecord.current_value;
                    asset.available_quantity = bondRecord.total_issued;
                } else {
                    throw new Error('This bond has already matured or defaulted and is no longer available for purchase.');
                }
            } else {
                throw new Error('Asset is inactive');
            }
        }

        const marketPrice = Number(asset.current_price || 0);
        const resolvedPrice = Number.isFinite(providedPrice) && providedPrice > 0 ? providedPrice : marketPrice;
        if (!Number.isFinite(resolvedPrice) || resolvedPrice <= 0) throw new Error('Invalid price');

        let stockMarketId = null;
        let company = null;
        if (canonicalType === 'share') {
            company = await database.collection('companies').findOne({ world_id: worldId, asset_id: normalizedAssetId }, { session });
            const resolvedStockMarketId = Number(company?.stock_market_id || 0);
            if (!Number.isInteger(resolvedStockMarketId) || resolvedStockMarketId <= 0) throw new Error('Share asset is not assigned to an active stock market');
            stockMarketId = resolvedStockMarketId;
        }

        const player = await database.collection('world_players').findOne({ user_id: userId, world_id: worldId }, { session });
        if (!player) throw new Error('You have not joined this world');
        const user = await database.collection('users').findOne({ id: userId }, { session });

        const playerId = player.id;
        const totalAmount = normalizedQty * resolvedPrice;

        if (canonicalType !== 'share') {
            executionResult = await executeImmediateSpotOrder(session, {
                userId, username: user?.username, playerId, worldId, orderType, assetType: canonicalType, assetId: normalizedAssetId, quantity: normalizedQty, marketPrice: marketPrice > 0 ? marketPrice : resolvedPrice, availableQuantity: Number(asset.available_quantity || 0), assetSymbol: asset.symbol
            });
            return;
        }

        if (canonicalType === 'share' && company) {
            const isAnchor = await isAnchorCompanyOwner(database, worldId, company.owner_player_id, session);
            if (isAnchor) {
                executionResult = await executeAnchorShareOrder(session, {
                    userId,
                    username: user?.username,
                    playerId,
                    worldId,
                    orderType,
                    asset,
                    company,
                    quantity: normalizedQty,
                    limitPrice: resolvedPrice
                });
                return;
            }
        }

        if (orderType === 'buy') {
            if (player.cash_balance < totalAmount) throw new Error('Insufficient cash balance');
            await database.collection('world_players').updateOne({ id: playerId }, { $inc: { cash_balance: -totalAmount } }, { session });
        } else if (orderType === 'sell') {
            const portfolio = await database.collection('portfolio').findOne({ player_id: playerId, asset_type: canonicalType, asset_id: normalizedAssetId }, { session });
            const pendingSells = await database.collection('order_book').aggregate([
                { $match: { player_id: playerId, asset_type: canonicalType, asset_id: normalizedAssetId, order_type: 'sell', status: { $in: ['open', 'partial'] } } },
                { $group: { _id: null, locked_qty: { $sum: { $subtract: ['$quantity', '$filled_quantity'] } } } }
            ], { session }).toArray();

            const ownedQty = portfolio ? Number(portfolio.quantity) : 0;
            const lockedQty = pendingSells[0]?.locked_qty || 0;
            const availableQty = ownedQty - lockedQty;

            if (availableQty < normalizedQty) throw new Error('Insufficient assets to sell');
        } else {
            throw new Error('Invalid order type');
        }

        newOrderId = await db.getNextId('order_book');
        await database.collection('order_book').insertOne({
            id: newOrderId,
            world_id: worldId,
            player_id: playerId,
            order_type: orderType,
            asset_type: canonicalType,
            asset_id: normalizedAssetId,
            stock_market_id: stockMarketId,
            quantity: normalizedQty,
            price_per_unit: resolvedPrice,
            filled_quantity: 0,
            status: 'open',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }, { session });
    }, ORDER_TXN_RETRY_OPTIONS);

    if (executionResult) {
        for (const notification of executionResult.achievementNotifications || []) {
            wsHandler.broadcastToWorld(worldId, notification);
        }
        return executionResult;
    }

    matchOrders(worldId, canonicalType, normalizedAssetId)
        .catch((matchError) => console.error('Post-place matching error:', matchError));

    return { orderId: newOrderId, message: 'Order placed successfully' };
};

const matchOrders = async (worldId, assetType, assetId) => {
    const matchKey = `${worldId}:${assetType}:${assetId}`;
    if (activeMatchKeys.has(matchKey)) return;

    activeMatchKeys.add(matchKey);
    try {
        if (assetType === 'share') {
            const database = db.getDb();
            const company = await database.collection('companies').findOne(
                { world_id: worldId, asset_id: assetId },
                { projection: { owner_player_id: 1 } }
            );
            if (company) {
                const isAnchor = await isAnchorCompanyOwner(database, worldId, company.owner_player_id, null);
                if (isAnchor) {
                    return;
                }
            }
        }

        let hasMatch = true;
        while (hasMatch) {
            await db.withTransaction(async (session) => {
                const database = db.getDb();
                const worldTick = await getWorldTick(session, worldId);

                const sells = await database.collection('order_book')
                    .find({ world_id: worldId, asset_type: assetType, asset_id: assetId, order_type: "sell", status: { $in: ["open", "partial"] } }, { session })
                    .sort({ price_per_unit: 1, created_at: 1, id: 1 })
                    .limit(1)
                    .toArray();

                const buys = await database.collection('order_book')
                    .find({ world_id: worldId, asset_type: assetType, asset_id: assetId, order_type: "buy", status: { $in: ["open", "partial"] } }, { session })
                    .sort({ price_per_unit: -1, created_at: 1, id: 1 })
                    .limit(1)
                    .toArray();

                if (sells.length === 0 || buys.length === 0) {
                    hasMatch = false;
                    return;
                }

                const sellOrder = sells[0];
                const buyOrder = buys[0];
                const sellLimitPrice = Number(sellOrder.price_per_unit || 0);
                const buyLimitPrice = Number(buyOrder.price_per_unit || 0);

                // Match if buy price >= sell price, OR if buy is within 10% below sell price.
                // The tolerance handles the case where a user bids at market price but
                // the sell order is listed above (e.g. anchor bot lists at price * 1.05).
                // Execution always happens at the sell (ask) price — buyer pays the ask.
                const priceOverlapOrClose = buyLimitPrice >= sellLimitPrice ||
                    (sellLimitPrice > 0 && buyLimitPrice >= sellLimitPrice * 0.90);

                if (priceOverlapOrClose) {
                    // Always execute at the sell price (ask) — buyer pays what seller asks
                    const executionPrice = sellLimitPrice;
                    const sellRemaining = Number(sellOrder.quantity || 0) - Number(sellOrder.filled_quantity || 0);
                    const buyRemaining = Number(buyOrder.quantity || 0) - Number(buyOrder.filled_quantity || 0);

                    if (sellRemaining <= 0 || buyRemaining <= 0) {
                        if (sellRemaining <= 0 && sellOrder.status !== 'filled') {
                            await database.collection('order_book').updateOne({ id: sellOrder.id }, { $set: { status: "filled", updated_at: new Date().toISOString() } }, { session });
                        }
                        if (buyRemaining <= 0 && buyOrder.status !== 'filled') {
                            await database.collection('order_book').updateOne({ id: buyOrder.id }, { $set: { status: "filled", updated_at: new Date().toISOString() } }, { session });
                        }
                        return; // proceed to next loop iteration
                    }

                    const matchQuantity = Math.min(sellRemaining, buyRemaining);
                    const totalTradeValue = matchQuantity * executionPrice;

                    const nextSellFilled = Number(sellOrder.filled_quantity || 0) + matchQuantity;
                    const nextBuyFilled = Number(buyOrder.filled_quantity || 0) + matchQuantity;
                    const sellStatus = nextSellFilled >= Number(sellOrder.quantity || 0) ? 'filled' : 'partial';
                    const buyStatus = nextBuyFilled >= Number(buyOrder.quantity || 0) ? 'filled' : 'partial';

                    await database.collection('order_book').updateOne({ id: sellOrder.id }, { $set: { filled_quantity: nextSellFilled, status: sellStatus, updated_at: new Date().toISOString() } }, { session });
                    await database.collection('order_book').updateOne({ id: buyOrder.id }, { $set: { filled_quantity: nextBuyFilled, status: buyStatus, updated_at: new Date().toISOString() } }, { session });

                    await database.collection('world_players').updateOne({ id: sellOrder.player_id }, { $inc: { cash_balance: totalTradeValue } }, { session });

                    // If buyer bid less than execution price (tolerance match), deduct the difference.
                    // If buyer bid more than execution price (normal match), refund the difference.
                    const priceDifference = buyLimitPrice - executionPrice;
                    if (priceDifference > 0) {
                        // Buyer bid higher than ask — refund the surplus
                        const refund = priceDifference * matchQuantity;
                        await database.collection('world_players').updateOne({ id: buyOrder.player_id }, { $inc: { cash_balance: refund } }, { session });
                    } else if (priceDifference < 0) {
                        // Buyer bid lower than ask (tolerance match) — deduct the extra cost
                        // First verify buyer has enough cash
                        const extraCost = Math.abs(priceDifference) * matchQuantity;
                        const buyerPlayer = await database.collection('world_players').findOne({ id: buyOrder.player_id }, { session });
                        const buyerCash = Number(buyerPlayer?.cash_balance || 0);
                        if (buyerCash >= extraCost) {
                            await database.collection('world_players').updateOne({ id: buyOrder.player_id }, { $inc: { cash_balance: -extraCost } }, { session });
                        }
                        // If buyer can't cover the extra, the trade still goes through — the small
                        // difference (max 1%) is absorbed as a market-maker spread
                    }

                    await database.collection('portfolio').updateOne(
                        { player_id: sellOrder.player_id, asset_type: assetType, asset_id: assetId },
                        { $inc: { quantity: -matchQuantity } },
                        { session }
                    );

                    const buyerPort = await database.collection('portfolio').findOne({ player_id: buyOrder.player_id, asset_type: assetType, asset_id: assetId }, { session });
                    if (buyerPort) {
                        const oldQty = buyerPort.quantity;
                        const oldAvg = buyerPort.avg_buy_price;
                        const newTotalQty = oldQty + matchQuantity;
                        const newAvgPrice = ((oldQty * oldAvg) + (matchQuantity * executionPrice)) / newTotalQty;
                        await database.collection('portfolio').updateOne({ id: buyerPort.id }, { $set: { quantity: newTotalQty, avg_buy_price: newAvgPrice } }, { session });
                    } else {
                        const newPortId = await db.getNextId('portfolio');
                        await database.collection('portfolio').insertOne({
                            id: newPortId, player_id: buyOrder.player_id, asset_type: assetType, asset_id: assetId, quantity: matchQuantity, avg_buy_price: executionPrice
                        }, { session });
                    }

                    const txId = await db.getNextId('transactions');
                    await database.collection('transactions').insertOne({
                        id: txId, world_id: worldId, buyer_id: buyOrder.player_id, seller_id: sellOrder.player_id, buy_order_id: buyOrder.id, sell_order_id: sellOrder.id, asset_type: assetType, asset_id: assetId, quantity: matchQuantity, price_per_unit: executionPrice, total_amount: totalTradeValue, created_at: new Date().toISOString()
                    }, { session });

                    const buyerPlayer = await database.collection('world_players').findOne({ id: buyOrder.player_id }, { session });
                    const sellerPlayer = await database.collection('world_players').findOne({ id: sellOrder.player_id }, { session });
                    const buyerUser = buyerPlayer ? await database.collection('users').findOne({ id: buyerPlayer.user_id }, { session }) : null;
                    const sellerUser = sellerPlayer ? await database.collection('users').findOne({ id: sellerPlayer.user_id }, { session }) : null;

                    const achievementNotifications = [];
                    let companyMeta = null;
                    let isAnchorShare = false;

                    if (assetType === 'share') {
                        companyMeta = await database.collection('companies').findOne({ world_id: worldId, asset_id: assetId }, { session });
                        if (companyMeta) {
                            isAnchorShare = await isAnchorCompanyOwner(database, worldId, companyMeta.owner_player_id, session);
                        }
                    }

                    if (companyMeta && sellerPlayer && Number(companyMeta.owner_player_id) === Number(sellOrder.player_id) && sellerUser) {
                        const founderSharesSold = await incrementAchievementProgress(session, Number(sellerUser.id), 'founder_shares_sold', Number(matchQuantity));
                        const founderUnlocks = await unlockThresholdAchievementsForMetric(session, { userId: Number(sellerUser.id), worldId, metricKey: 'founder_shares_sold', metricValue: founderSharesSold, username: sellerUser.username });
                        achievementNotifications.push(...founderUnlocks);
                    }

                    if (companyMeta && buyerPlayer && Number(companyMeta.owner_player_id) !== Number(buyOrder.player_id) && buyerUser) {
                        const buyerHoldings = await database.collection('portfolio').findOne({ player_id: buyOrder.player_id, asset_type: "share", asset_id: assetId }, { session });
                        const buyerHoldingQty = Number(buyerHoldings?.quantity || 0);
                        const totalShares = Number(companyMeta.total_shares || 0);

                        if (totalShares > 0 && buyerHoldingQty >= (totalShares * 0.51)) {
                            const takeoverFlagKey = `company_takeover_company_${Number(companyMeta.id)}`;
                            const takeoverFlag = await getAchievementProgress(session, Number(buyerUser.id), takeoverFlagKey);

                            if (takeoverFlag < 1) {
                                await setAchievementProgressMax(session, Number(buyerUser.id), takeoverFlagKey, 1);
                                const takeoverCount = await incrementAchievementProgress(session, Number(buyerUser.id), 'company_takeover_count', 1);
                                const takeoverUnlocks = await unlockThresholdAchievementsForMetric(session, { userId: Number(buyerUser.id), worldId, metricKey: 'company_takeover_count', metricValue: takeoverCount, username: buyerUser.username });
                                achievementNotifications.push(...takeoverUnlocks);
                            }
                        }
                    }

                    if (!(assetType === 'share' && isAnchorShare)) {
                        await database.collection('assets').updateOne({ id: assetId }, { $set: { current_price: executionPrice } }, { session });
                        if (assetType === 'share') {
                            await database.collection('companies').updateOne({ asset_id: assetId }, { $set: { share_price: executionPrice } }, { session });
                        } else if (assetType === 'commodity') {
                            await database.collection('commodities').updateOne({ asset_id: assetId }, { $set: { current_price: executionPrice } }, { session });
                        } else if (assetType === 'crypto') {
                            await database.collection('cryptos').updateOne({ asset_id: assetId }, { $set: { current_price: executionPrice } }, { session });
                        } else if (assetType === 'bond') {
                            const b = await database.collection('bonds').findOne({ asset_id: assetId }, { session });
                            if (b) await database.collection('bonds').updateOne({ asset_id: assetId }, { $set: { current_value: b.face_value } }, { session });
                        }
                    }

                    if (!(assetType === 'share' && isAnchorShare)) {
                        const phId = await db.getNextId('price_history');
                        await database.collection('price_history').insertOne({
                            id: phId, world_id: worldId, asset_type: assetType, asset_id: assetId, price: executionPrice, volume: matchQuantity, world_tick: worldTick
                        }, { session });
                    }

                    wsHandler.broadcastToWorld(worldId, {
                        type: 'trade_fill', worldId, assetType, assetId, quantity: Number(matchQuantity), pricePerUnit: Number(executionPrice), buyerUserId: Number(buyerUser?.id || 0), sellerUserId: Number(sellerUser?.id || 0), buyerUsername: buyerUser?.username || null, sellerUsername: sellerUser?.username || null, title: 'Order Filled', description: `${Number(matchQuantity).toLocaleString(undefined, { maximumFractionDigits: 8 })} units filled at $${Number(executionPrice).toLocaleString(undefined, { maximumFractionDigits: 6 })}`, severity: 'minor'
                    });

                    for (const notification of achievementNotifications) {
                        wsHandler.broadcastToWorld(worldId, notification);
                    }
                } else {
                    hasMatch = false; // No more overlaps
                }
            }).catch(err => {
                console.error('Match engine error:', err);
                hasMatch = false;
            });
        }
    } finally {
        activeMatchKeys.delete(matchKey);
    }
};

const processOpenOrderMatches = async (worldId) => {
    const database = db.getDb();
    const openAssets = await database.collection('order_book').aggregate([
        { $match: { world_id: worldId, status: { $in: ["open", "partial"] } } },
        { $group: { _id: { asset_type: '$asset_type', asset_id: '$asset_id' } } }
    ]).toArray();

    for (const entry of openAssets) {
        await matchOrders(worldId, entry._id.asset_type, entry._id.asset_id);
    }
};

const cancelOrder = async (userId, worldId, orderId) => {
    let msg = '';
    await db.withTransaction(async (session) => {
        const database = db.getDb();
        const player = await database.collection('world_players').findOne({ user_id: userId, world_id: worldId }, { session });
        if (!player) throw new Error('Player not found in this world');

        const order = await database.collection('order_book').findOne({ id: orderId, player_id: player.id, status: { $in: ["open", "partial"] } }, { session });
        if (!order) throw new Error('Order not found or already processed');

        if (order.order_type === 'buy') {
            const unfilledQty = order.quantity - (order.filled_quantity || 0);
            const refund = unfilledQty * order.price_per_unit;
            await database.collection('world_players').updateOne({ id: player.id }, { $inc: { cash_balance: refund } }, { session });
        }

        await database.collection('order_book').updateOne({ id: orderId }, { $set: { status: "cancelled", updated_at: new Date().toISOString() } }, { session });
        msg = 'Order cancelled successfully';
    }, ORDER_TXN_RETRY_OPTIONS);
    return { message: msg };
};

const placeOrderForPlayer = async (playerId, worldId, orderType, assetType, assetId, quantity, pricePerUnit) => {
    let executionResult = null;
    let newOrderId = null;
    let canonicalType = null;
    let normalizedAssetId = Number(assetId);

    await db.withTransaction(async (session) => {
        const database = db.getDb();
        const normalizedAssetType = String(assetType || '').trim();
        const normalizedQty = Number(quantity);
        const providedPrice = Number(pricePerUnit);

        if (!['share', 'commodity', 'bond', 'crypto'].includes(normalizedAssetType)) throw new Error('Invalid asset type');
        if (!['buy', 'sell'].includes(orderType)) throw new Error('Invalid order type');
        if (!Number.isFinite(normalizedAssetId) || normalizedAssetId <= 0) throw new Error('Invalid asset id');
        if (!Number.isFinite(normalizedQty) || normalizedQty <= 0) throw new Error('Invalid quantity');

        const asset = await database.collection('assets').findOne({ id: normalizedAssetId, world_id: worldId }, { session });
        if (!asset) throw new Error('Asset not found');

        canonicalType = String(asset.asset_type);
        if (canonicalType !== normalizedAssetType) throw new Error('Asset type mismatch');
        if (canonicalType === 'bond' && orderType === 'sell') throw new Error('Bonds cannot be sold');
        if (!asset.is_active) throw new Error('Asset inactive');

        const marketPrice = Number(asset.current_price || 0);
        const normalizedPrice = Number.isFinite(providedPrice) && providedPrice > 0 ? providedPrice : marketPrice;

        const player = await database.collection('world_players').findOne({ id: playerId, world_id: worldId }, { session });
        if (!player) throw new Error('Bot player not found in world');

        const totalAmount = normalizedQty * normalizedPrice;

        if (canonicalType !== 'share') {
            executionResult = await executeImmediateSpotOrder(session, {
                userId: null, username: 'bot', playerId, worldId, orderType, assetType: canonicalType, assetId: normalizedAssetId, quantity: normalizedQty, marketPrice: marketPrice > 0 ? marketPrice : normalizedPrice, availableQuantity: Number(asset.available_quantity || 0), assetSymbol: asset.symbol
            });
            return;
        }

        if (orderType === 'buy') {
            if (Number(player.cash_balance) < totalAmount) throw new Error('Bot insufficient cash');
            await database.collection('world_players').updateOne({ id: playerId }, { $inc: { cash_balance: -totalAmount } }, { session });
        } else {
            const portfolio = await database.collection('portfolio').findOne({ player_id: playerId, asset_type: canonicalType, asset_id: normalizedAssetId }, { session });
            const pendingSells = await database.collection('order_book').aggregate([
                { $match: { player_id: playerId, asset_type: canonicalType, asset_id: normalizedAssetId, order_type: 'sell', status: { $in: ['open', 'partial'] } } },
                { $group: { _id: null, locked_qty: { $sum: { $subtract: ['$quantity', '$filled_quantity'] } } } }
            ], { session }).toArray();

            const ownedQty = portfolio ? Number(portfolio.quantity) : 0;
            const lockedQty = pendingSells[0]?.locked_qty || 0;
            if (ownedQty - lockedQty < normalizedQty) throw new Error('Bot insufficient assets');
        }

        let stockMarketId = null;
        const company = await database.collection('companies').findOne({ world_id: worldId, asset_id: normalizedAssetId }, { session });
        stockMarketId = Number(company?.stock_market_id || 0) || null;

        if (canonicalType === 'share' && company) {
            const isAnchor = await isAnchorCompanyOwner(database, worldId, company.owner_player_id, session);
            if (isAnchor) {
                executionResult = await executeAnchorShareOrder(session, {
                    userId: null,
                    username: 'bot',
                    playerId,
                    worldId,
                    orderType,
                    asset,
                    company,
                    quantity: normalizedQty,
                    limitPrice: normalizedPrice
                });
                return;
            }
        }

        newOrderId = await db.getNextId('order_book');
        await database.collection('order_book').insertOne({
            id: newOrderId,
            world_id: worldId,
            player_id: playerId,
            order_type: orderType,
            asset_type: canonicalType,
            asset_id: normalizedAssetId,
            stock_market_id: stockMarketId,
            quantity: normalizedQty,
            price_per_unit: normalizedPrice,
            status: "open",
            filled_quantity: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }, { session });
    });

    if (executionResult) return executionResult;

    matchOrders(worldId, canonicalType, normalizedAssetId).catch(() => {});
    return { message: 'Bot order placed' };
};

module.exports = {
    placeOrder,
    placeOrderForPlayer,
    cancelOrder,
    matchOrders,
    processOpenOrderMatches
};
