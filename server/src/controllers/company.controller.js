const db = require('../config/database');
const wsHandler = require('../websocket/ws.handler');
const marketService = require('../services/market.service');

const resolvePlayerId = async (database, userId, worldId, session = null) => {
    const player = await database.collection('world_players').findOne(
        { user_id: userId, world_id: worldId },
        { session }
    );

    if (!player) {
        throw new Error('Player not in this world');
    }

    return player.id;
};

const resolveCompanyAndController = async (database, companyId, worldId, { session = null } = {}) => {
    const company = await database.collection('companies').findOne(
        { id: companyId, world_id: worldId },
        { session }
    );

    if (!company) {
        throw new Error('Company not found in this world');
    }

    let controllerPlayerId = Number(company.owner_player_id);

    if (company.asset_id) {
        const holders = await database.collection('portfolio').find(
            { asset_type: "share", asset_id: Number(company.asset_id), quantity: { $gt: 0 } },
            { session }
        ).sort({ quantity: -1, player_id: 1 }).limit(1).toArray();

        if (holders.length > 0) {
            controllerPlayerId = Number(holders[0].player_id);
        }
    }

    return {
        company,
        controllerPlayerId
    };
};

const listSectors = async (req, res) => {
    try {
        const database = db.getDb();
        const sectors = await database.collection('sectors').find({}, { projection: { _id: 0, id: 1, name: 1, description: 1 } }).toArray();
        res.json({ sectors });
    } catch(err) {
        res.status(500).json({ error: 'Server error' });
    }
};

const createCompany = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            worldId,
            sectorId,
            stockMarketId,
            name,
            ticker,
            description,
            totalShares,
            startingCapital,
            riskLevel,
            growthStrategy,
            dividendPolicy
        } = req.body;

        if (!worldId || !sectorId || !name || !ticker) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const parsedShares = Number(totalShares || 1000);
        const parsedStartingCapital = Number(startingCapital);

        if (!Number.isFinite(parsedShares) || parsedShares <= 0 || !Number.isInteger(parsedShares)) {
            throw new Error('totalShares must be a positive integer');
        }

        if (!Number.isFinite(parsedStartingCapital) || parsedStartingCapital <= 0) {
            throw new Error('startingCapital must be a positive number');
        }

        // stockMarketId is optional — if provided, validate it
        const parsedStockMarketId = stockMarketId ? Number(stockMarketId) : null;
        if (parsedStockMarketId !== null && (!Number.isInteger(parsedStockMarketId) || parsedStockMarketId <= 0)) {
            throw new Error('stockMarketId must be a positive integer');
        }

        const database = db.getDb();

        const result = await db.withTransaction(async (session) => {
            const player = await database.collection('world_players').findOne(
                { user_id: userId, world_id: worldId },
                { session }
            );
            if (!player) throw new Error('Player not in this world');

            let selectedMarket = null;
            let isListed = false;

            if (parsedStockMarketId) {
                selectedMarket = await database.collection('stock_markets').findOne(
                    { id: parsedStockMarketId, world_id: worldId, is_active: true },
                    { session }
                );
                if (!selectedMarket) throw new Error('Selected stock market is not available in this world');

                const minimumListingCapital = Number(selectedMarket.min_listing_capital || 0);
                if (parsedStartingCapital < minimumListingCapital) {
                    throw new Error(`Starting capital is below ${selectedMarket.code} minimum listing capital ($${minimumListingCapital.toLocaleString()})`);
                }
                isListed = true;
            }

            const intrinsicSharePrice = Math.max(parsedStartingCapital / parsedShares, 0.01);
            const CREATION_COST = parsedStartingCapital;

            if (Number(player.cash_balance) < CREATION_COST) {
                throw new Error(`Insufficient funds. You need $${CREATION_COST} to start a company.`);
            }

            await database.collection('world_players').updateOne(
                { id: player.id },
                { $inc: { cash_balance: -CREATION_COST } },
                { session }
            );

            const initialTreasury = CREATION_COST;
            const normalizedRisk = riskLevel || 'moderate';
            const normalizedStrategy = growthStrategy || 'organic';
            const normalizedDividend = dividendPolicy || 'none';

            const companyId = await db.getNextId('companies', session);
            const shareAssetId = await db.getNextId('assets', session);

            await database.collection('assets').insertOne({
                id: shareAssetId,
                world_id: worldId,
                asset_type: "share",
                name,
                symbol: ticker.toUpperCase(),
                current_price: intrinsicSharePrice,
                available_quantity: 0,
                is_active: true
            }, { session });

            await database.collection('companies').insertOne({
                id: companyId,
                world_id: worldId,
                owner_player_id: player.id,
                sector_id: sectorId,
                stock_market_id: parsedStockMarketId || null,
                asset_id: shareAssetId,
                name,
                ticker: ticker.toUpperCase(),
                description,
                total_shares: parsedShares,
                shares_in_market: 0,
                treasury: initialTreasury,
                share_price: intrinsicSharePrice,
                risk_level: normalizedRisk,
                growth_strategy: normalizedStrategy,
                dividend_policy: normalizedDividend,
                is_listed: isListed,
                is_active: true,
                created_at: new Date().toISOString()
            }, { session });

            const portfolioId = await db.getNextId('portfolio', session);
            await database.collection('portfolio').insertOne({
                id: portfolioId,
                player_id: player.id,
                asset_type: "share",
                asset_id: shareAssetId,
                quantity: parsedShares,
                avg_buy_price: intrinsicSharePrice
            }, { session });

            return {
                companyId,
                assetId: shareAssetId,
                impliedSharePrice: intrinsicSharePrice,
                stockMarketId: parsedStockMarketId || null,
                stockMarketCode: selectedMarket ? selectedMarket.code : null,
                is_listed: isListed
            };
        });

        res.status(201).json({
            message: 'Company created successfully',
            ...result
        });
    } catch (err) {
        console.error(err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const listCompanyOnMarket = async (req, res) => {
    try {
        const userId = req.user.id;
        const companyId = Number(req.params.id);
        const { worldId, stockMarketId } = req.body;

        const targetWorldId = Number(worldId);
        const parsedStockMarketId = Number(stockMarketId);

        if (!Number.isInteger(companyId) || !Number.isInteger(targetWorldId) || !Number.isInteger(parsedStockMarketId) || parsedStockMarketId <= 0) {
            return res.status(400).json({ error: 'companyId, worldId, and stockMarketId are required' });
        }

        const database = db.getDb();

        await db.withTransaction(async (session) => {
            const playerId = await resolvePlayerId(database, userId, targetWorldId, session);
            const { company, controllerPlayerId } = await resolveCompanyAndController(database, companyId, targetWorldId, { session });

            if (!company.is_active) throw new Error('Company is inactive');
            if (controllerPlayerId !== playerId) throw new Error('Only the largest shareholder can list this company');
            if (company.is_listed) throw new Error('Company is already listed on a stock market');

            const selectedMarket = await database.collection('stock_markets').findOne(
                { id: parsedStockMarketId, world_id: targetWorldId, is_active: true },
                { session }
            );
            if (!selectedMarket) throw new Error('Selected stock market is not available in this world');

            const minimumListingCapital = Number(selectedMarket.min_listing_capital || 0);
            const treasury = Number(company.treasury || 0);
            if (treasury < minimumListingCapital) {
                throw new Error(`Company treasury ($${treasury.toLocaleString()}) is below ${selectedMarket.code} minimum listing capital ($${minimumListingCapital.toLocaleString()})`);
            }

            await database.collection('companies').updateOne(
                { id: companyId },
                { $set: { is_listed: true, stock_market_id: parsedStockMarketId } },
                { session }
            );

            const eventId = await db.getNextId('world_events', session);
            await database.collection('world_events').insertOne({
                id: eventId,
                world_id: targetWorldId,
                event_type: 'company_listed',
                title: `IPO: ${company.name} (${company.ticker})`,
                description: `${company.name} has listed on ${selectedMarket.name} (${selectedMarket.code}).`,
                severity: 'minor',
                effects_json: JSON.stringify({ company_id: companyId, stock_market_id: parsedStockMarketId }),
                event_tick: 0,
                created_at: new Date().toISOString()
            }, { session });
        });

        wsHandler.broadcastToWorld(targetWorldId, {
            type: 'news',
            title: `Company Listed`,
            description: `A company has listed on the stock market.`,
            severity: 'minor'
        });

        res.json({ message: 'Company listed on market successfully' });
    } catch (err) {
        console.error('List company on market error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const updateCompanySettings = async (req, res) => {
    try {
        const userId = req.user.id;
        const companyId = Number(req.params.id);
        const { worldId, risk_level, growth_strategy, dividend_policy } = req.body;

        const targetWorldId = Number(worldId);
        if (!Number.isInteger(targetWorldId) || !Number.isInteger(companyId)) {
            return res.status(400).json({ error: 'companyId and worldId are required' });
        }

        const database = db.getDb();
        await db.withTransaction(async (session) => {
            const playerId = await resolvePlayerId(database, userId, targetWorldId, session);
            const { company, controllerPlayerId } = await resolveCompanyAndController(database, companyId, targetWorldId, { session });
            
            if (!company.is_active) throw new Error('Company is inactive');
            if (controllerPlayerId !== playerId) throw new Error('Only the largest shareholder can manage this company');

            const updates = {};
            if (risk_level) updates.risk_level = risk_level;
            if (growth_strategy) updates.growth_strategy = growth_strategy;
            if (dividend_policy) updates.dividend_policy = dividend_policy;

            if (Object.keys(updates).length > 0) {
                await database.collection('companies').updateOne(
                    { id: companyId },
                    { $set: updates },
                    { session }
                );
            }
        });

        res.json({ message: 'Company settings updated' });
    } catch (err) {
        console.error(err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const listMyCompanies = async (req, res) => {
    try {
        const userId = req.user.id;
        const worldId = Number(req.query.worldId);

        if (!Number.isInteger(worldId)) {
            return res.status(400).json({ error: 'worldId is required' });
        }

        const database = db.getDb();
        const player = await database.collection('world_players').findOne({ user_id: userId, world_id: worldId });
        if (!player) return res.status(400).json({ error: 'Player not found in world' });
        const playerId = player.id;

        const companies = await database.collection('companies').find({ world_id: worldId }).toArray();
        if (companies.length === 0) return res.json({ companies: [] });

        const assetIds = companies.map(c => c.asset_id).filter(Boolean);

        const sectors = await database.collection('sectors').find().toArray();
        const sectorMap = new Map(sectors.map(s => [s.id, s]));

        const stockMarkets = await database.collection('stock_markets').find({ world_id: worldId }).toArray();
        const stockMarketMap = new Map(stockMarkets.map(sm => [sm.id, sm]));

        const countries = await database.collection('countries').find().toArray();
        const countryMap = new Map(countries.map(c => [c.id, c]));

        const portfolioRows = await database.collection('portfolio').find({ 
            player_id: playerId, 
            asset_type: "share", 
            asset_id: { $in: assetIds } 
        }).toArray();
        const mySharesMap = new Map(portfolioRows.map(p => [p.asset_id, p.quantity]));

        const orderRows = await database.collection('order_book').find({
            world_id: worldId,
            player_id: playerId,
            order_type: "sell",
            asset_type: "share",
            asset_id: { $in: assetIds },
            status: { $in: ["open", "partial"] }
        }).toArray();
        const listedSharesMap = new Map();
        for (const o of orderRows) {
            const qty = Number(o.quantity || 0) - Number(o.filled_quantity || 0);
            listedSharesMap.set(o.asset_id, (listedSharesMap.get(o.asset_id) || 0) + qty);
        }

        // top holders
        const topHoldersByAsset = new Map();
        if (assetIds.length > 0) {
            const allHolders = await database.collection('portfolio').aggregate([
                { $match: { asset_type: "share", asset_id: { $in: assetIds }, quantity: { $gt: 0 } } },
                { $sort: { asset_id: 1, quantity: -1, player_id: 1 } },
                { $group: { _id: "$asset_id", topHolder: { $first: "$$ROOT" } } }
            ]).toArray();

            for (const h of allHolders) {
                topHoldersByAsset.set(h._id, { player_id: h.topHolder.player_id, quantity: h.topHolder.quantity });
            }
        }

        const enrichedCompanies = companies.map(c => {
            const s = sectorMap.get(c.sector_id) || {};
            const sm = stockMarketMap.get(c.stock_market_id) || {};
            const ct = countryMap.get(sm.country_id) || {};

            const assetId = c.asset_id;
            const fallbackController = c.owner_player_id;
            const topHolder = topHoldersByAsset.get(assetId);
            const controllerPlayerId = topHolder ? topHolder.player_id : fallbackController;

            return {
                id: c.id,
                asset_id: c.asset_id,
                name: c.name,
                ticker: c.ticker,
                share_price: c.share_price,
                total_shares: c.total_shares,
                shares_in_market: c.shares_in_market,
                treasury: c.treasury,
                is_active: c.is_active,
                risk_level: c.risk_level,
                growth_strategy: c.growth_strategy,
                dividend_policy: c.dividend_policy,
                created_at: c.created_at,
                owner_player_id: c.owner_player_id,
                stock_market_id: c.stock_market_id,
                
                sector_name: s.name,
                stock_market_code: sm.code,
                stock_market_name: sm.name,
                stock_market_city: sm.city,
                stock_market_currency: sm.currency,
                benchmark_name: sm.benchmark_name,
                benchmark_level: sm.benchmark_level,
                min_listing_capital: sm.min_listing_capital,
                listing_tier: sm.listing_tier,
                country_code: ct.code,
                country_name: ct.name,
                
                shares_owned: mySharesMap.get(assetId) || 0,
                shares_listed: listedSharesMap.get(assetId) || 0,
                is_listed: c.is_listed !== undefined ? c.is_listed : (c.stock_market_id ? true : false),
                
                controller_player_id: controllerPlayerId,
                controller_source: topHolder ? 'largest_shareholder' : 'owner_fallback',
                is_controller: controllerPlayerId === playerId
            };
        });

        const controllableCompanies = enrichedCompanies.filter(c => c.is_controller).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json({ companies: controllableCompanies });
    } catch (err) {
        console.error('List companies error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

const listCompanyShares = async (req, res) => {
    try {
        const userId = req.user.id;
        const companyId = Number(req.params.id);
        const worldId = Number(req.body.worldId);
        const stockMarketId = Number(req.body.stockMarketId);
        const quantity = Number(req.body.quantity);
        const preferredPrice = Number(req.body.pricePerUnit);

        if (!Number.isInteger(companyId) || !Number.isInteger(worldId) || !Number.isInteger(stockMarketId) || !Number.isInteger(quantity) || quantity <= 0) {
            return res.status(400).json({ error: 'companyId, worldId, stockMarketId and positive integer quantity are required' });
        }

        const database = db.getDb();
        const result = await db.withTransaction(async (session) => {
            const playerId = await resolvePlayerId(database, userId, worldId, session);
            const { company, controllerPlayerId } = await resolveCompanyAndController(database, companyId, worldId, { session });
            
            if (!company.is_active) throw new Error('Company is inactive');
            if (controllerPlayerId !== playerId) throw new Error('Only the largest shareholder can list shares for this company');

            const companyMarketId = Number(company.stock_market_id || 0);
            if (!companyMarketId) throw new Error('Company is not attached to a stock market');
            if (stockMarketId !== companyMarketId) throw new Error('Shares must be listed on the company\'s assigned stock market');

            let shareAssetId = Number(company.asset_id || 0);
            if (!shareAssetId) {
                shareAssetId = await db.getNextId('assets', session);
                await database.collection('assets').insertOne({
                    id: shareAssetId,
                    world_id: worldId,
                    asset_type: "share",
                    name: company.name,
                    symbol: String(company.ticker || '').toUpperCase(),
                    current_price: Number(company.share_price || 0),
                    available_quantity: 0,
                    is_active: true
                }, { session });
                await database.collection('companies').updateOne({ id: company.id }, { $set: { asset_id: shareAssetId } }, { session });
            }

            const portfolioDoc = await database.collection('portfolio').findOne(
                { player_id: playerId, asset_type: "share", asset_id: shareAssetId },
                { session }
            );

            const ownedQty = Number(portfolioDoc?.quantity || 0);
            const lockedDocs = await database.collection('order_book').find(
                { world_id: worldId, player_id: playerId, order_type: "sell", asset_type: "share", asset_id: shareAssetId, status: { $in: ["open", "partial"] } },
                { session }
            ).toArray();
            
            const lockedQty = lockedDocs.reduce((acc, order) => acc + (Number(order.quantity) - Number(order.filled_quantity || 0)), 0);
            const availableQty = ownedQty - lockedQty;

            if (availableQty < quantity) {
                throw new Error('Not enough available shares to list');
            }

            const price = Number.isFinite(preferredPrice) && preferredPrice > 0 ? preferredPrice : Number(company.share_price);
            
            const orderId = await db.getNextId('order_book', session);
            await database.collection('order_book').insertOne({
                id: orderId,
                world_id: worldId,
                player_id: playerId,
                order_type: "sell",
                asset_type: "share",
                asset_id: shareAssetId,
                stock_market_id: companyMarketId,
                quantity: quantity,
                price_per_unit: price,
                filled_quantity: 0,
                status: "open",
                created_at: new Date().toISOString()
            }, { session });

            return { orderId, shareAssetId };
        });

        // Outside transaction
        try {
            await marketService.matchOrders(worldId, 'share', result.shareAssetId);
        } catch (matchError) {
            console.error('Post-listing match error:', matchError);
        }

        res.status(201).json({ message: 'Shares listed successfully', orderId: result.orderId });
    } catch (err) {
        console.error('List shares error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const listPrivateDeals = async (req, res) => {
    try {
        const userId = req.user.id;
        const worldId = Number(req.query.worldId);
        const withUserId = Number(req.query.withUserId);
        const limit = Math.min(Math.max(Number(req.query.limit || 80), 1), 200);

        if (!Number.isInteger(worldId) || !Number.isInteger(withUserId) || withUserId <= 0) {
            return res.status(400).json({ error: 'worldId and withUserId are required' });
        }
        if (withUserId === userId) return res.status(400).json({ error: 'Cannot load private deals with yourself' });

        const database = db.getDb();
        await resolvePlayerId(database, userId, worldId);
        await resolvePlayerId(database, withUserId, worldId);

        const deals = await database.collection('private_deals').aggregate([
            {
                $match: {
                    world_id: worldId,
                    $or: [
                        { proposer_user_id: userId, recipient_user_id: withUserId },
                        { proposer_user_id: withUserId, recipient_user_id: userId }
                    ]
                }
            },
            { $sort: { id: -1 } },
            { $limit: limit },
            { $lookup: { from: "companies", localField: "company_id", foreignField: "id", as: "company" } },
            { $lookup: { from: "users", localField: "proposer_user_id", foreignField: "id", as: "proposer" } },
            { $lookup: { from: "users", localField: "recipient_user_id", foreignField: "id", as: "recipient" } },
            { $unwind: { path: "$company", preserveNullAndEmptyArrays: true } },
            { $unwind: { path: "$proposer", preserveNullAndEmptyArrays: true } },
            { $unwind: { path: "$recipient", preserveNullAndEmptyArrays: true } }
        ]).toArray();

        const formatted = deals.map(d => ({
            id: d.id,
            world_id: d.world_id,
            company_id: d.company_id,
            company_name: d.company?.name,
            ticker: d.company?.ticker,
            proposer_user_id: d.proposer_user_id,
            proposer_username: d.proposer?.username,
            recipient_user_id: d.recipient_user_id,
            recipient_username: d.recipient?.username,
            quantity: d.quantity,
            price_per_share: d.price_per_share,
            total_amount: d.total_amount,
            note: d.note,
            status: d.status,
            responded_at: d.responded_at,
            created_at: d.created_at,
            is_mine: d.proposer_user_id === userId,
            is_actionable: d.recipient_user_id === userId
        }));

        res.json({ deals: formatted.reverse() });
    } catch (err) {
        console.error('List private deals error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const executePrivateDeal = async (req, res) => {
    try {
        const sellerUserId = req.user.id;
        const sellerUsername = req.user.username;
        const companyId = Number(req.params.id);
        const worldId = Number(req.body.worldId);
        const recipientUserId = Number(req.body.recipientUserId);
        const quantity = Number(req.body.quantity);
        const pricePerShare = Number(req.body.pricePerShare);
        const note = String(req.body.note || '').trim();

        if (!Number.isInteger(companyId) || !Number.isInteger(worldId) || !Number.isInteger(recipientUserId)) {
            return res.status(400).json({ error: 'companyId, worldId and recipientUserId are required' });
        }
        if (recipientUserId === sellerUserId) return res.status(400).json({ error: 'Cannot execute a private deal with yourself' });
        if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'quantity must be a positive number' });
        if (!Number.isFinite(pricePerShare) || pricePerShare <= 0) return res.status(400).json({ error: 'pricePerShare must be a positive number' });
        if (note.length > 180) return res.status(400).json({ error: 'Deal note cannot exceed 180 characters' });

        const database = db.getDb();

        const result = await db.withTransaction(async (session) => {
            const sellerPlayerId = await resolvePlayerId(database, sellerUserId, worldId, session);
            await resolvePlayerId(database, recipientUserId, worldId, session);

            const { company, controllerPlayerId } = await resolveCompanyAndController(database, companyId, worldId, { session });
            if (!company.is_active) throw new Error('Company is inactive');
            if (controllerPlayerId !== sellerPlayerId) throw new Error('Only the controlling shareholder can execute private company deals');

            const shareAssetId = Number(company.asset_id || 0);
            if (shareAssetId <= 0) throw new Error('Company share asset is unavailable');

            const sellerPortfolio = await database.collection('portfolio').findOne(
                { player_id: sellerPlayerId, asset_type: "share", asset_id: shareAssetId },
                { session }
            );
            if (!sellerPortfolio) throw new Error('You do not own shares for this company');

            const ownedQuantity = Number(sellerPortfolio.quantity || 0);
            const lockedDocs = await database.collection('order_book').find(
                { world_id: worldId, player_id: sellerPlayerId, order_type: "sell", asset_type: "share", asset_id: shareAssetId, status: { $in: ["open", "partial"] } },
                { session }
            ).toArray();
            const lockedQuantity = lockedDocs.reduce((acc, order) => acc + (Number(order.quantity) - Number(order.filled_quantity || 0)), 0);
            const availableQuantity = ownedQuantity - lockedQuantity;

            if (availableQuantity < quantity) throw new Error('Not enough unlocked shares to propose this private deal');

            const totalAmount = quantity * pricePerShare;
            const dealId = await db.getNextId('private_deals', session);

            await database.collection('private_deals').insertOne({
                id: dealId,
                world_id: worldId,
                company_id: company.id,
                share_asset_id: shareAssetId,
                proposer_user_id: sellerUserId,
                recipient_user_id: recipientUserId,
                quantity,
                price_per_share: pricePerShare,
                total_amount: totalAmount,
                note: note || null,
                status: "pending",
                created_at: new Date().toISOString()
            }, { session });

            const recipientUser = await database.collection('users').findOne({ id: recipientUserId }, { session });
            const recipientUsername = recipientUser?.username || `User ${recipientUserId}`;

            const quantityText = Number(quantity).toLocaleString(undefined, { maximumFractionDigits: 4 });
            const priceText = Number(pricePerShare).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
            const totalText = Number(totalAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const noteSuffix = note ? ` Note: ${note}` : '';
            const dealMessage = `[Private Deal Proposal #${dealId}] ${sellerUsername} offers ${quantityText} shares of ${company.name} (${company.ticker}) at $${priceText}/share (total $${totalText}). Accept or reject in Private Deal panel.${noteSuffix}`;

            const dmId = await db.getNextId('direct_messages', session);
            const now = new Date().toISOString();
            await database.collection('direct_messages').insertOne({
                id: dmId,
                world_id: worldId,
                sender_user_id: sellerUserId,
                recipient_user_id: recipientUserId,
                message: dealMessage,
                is_read: false,
                created_at: now
            }, { session });

            return { dealId, company, totalAmount, recipientUsername, dmId, dealMessage, now };
        });

        const messagePayload = {
            id: result.dmId,
            world_id: worldId,
            sender_user_id: sellerUserId,
            sender_username: sellerUsername,
            recipient_user_id: recipientUserId,
            recipient_username: result.recipientUsername,
            message: result.dealMessage,
            is_read: false,
            created_at: result.now
        };

        wsHandler.broadcastToWorld(worldId, {
            type: 'chat_direct_message',
            message: messagePayload
        });

        res.status(201).json({
            message: 'Private deal proposal sent',
            deal: {
                id: result.dealId,
                company_id: result.company.id,
                company_name: result.company.name,
                ticker: result.company.ticker,
                quantity: Number(quantity),
                price_per_share: Number(pricePerShare),
                total_amount: Number(result.totalAmount),
                status: 'pending',
                seller_user_id: sellerUserId,
                recipient_user_id: recipientUserId
            },
            directMessage: messagePayload
        });
    } catch (err) {
        console.error('Private deal error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const acceptPrivateDeal = async (req, res) => {
    try {
        const userId = req.user.id;
        const username = req.user.username;
        const dealId = Number(req.params.dealId);

        if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'dealId is required' });

        const database = db.getDb();
        const result = await db.withTransaction(async (session) => {
            const deal = await database.collection('private_deals').findOne({ id: dealId }, { session });
            if (!deal) throw new Error('Private deal not found');
            if (deal.status !== 'pending') throw new Error('Only pending private deals can be accepted');

            const worldId = Number(deal.world_id);
            const sellerUserId = Number(deal.proposer_user_id);
            const recipientUserId = Number(deal.recipient_user_id);

            if (recipientUserId !== Number(userId)) throw new Error('Only the deal recipient can accept this proposal');

            const sellerPlayerId = await resolvePlayerId(database, sellerUserId, worldId, session);
            const recipientPlayerId = await resolvePlayerId(database, recipientUserId, worldId, session);

            const { company, controllerPlayerId } = await resolveCompanyAndController(database, Number(deal.company_id), worldId, { session });
            if (!company.is_active) throw new Error('Company is inactive');
            if (controllerPlayerId !== sellerPlayerId) throw new Error('Seller no longer controls this company');

            const shareAssetId = Number(deal.share_asset_id || company.asset_id || 0);
            if (shareAssetId <= 0) throw new Error('Company share asset is unavailable');

            const quantity = Number(deal.quantity || 0);
            const pricePerShare = Number(deal.price_per_share || 0);
            const totalAmount = Number(deal.total_amount || (quantity * pricePerShare));

            if (quantity <= 0 || pricePerShare <= 0) throw new Error('Private deal values are invalid');

            const sellerPortfolio = await database.collection('portfolio').findOne(
                { player_id: sellerPlayerId, asset_type: "share", asset_id: shareAssetId },
                { session }
            );
            if (!sellerPortfolio) throw new Error('Seller no longer owns shares for this company');

            const ownedQuantity = Number(sellerPortfolio.quantity || 0);
            const lockedDocs = await database.collection('order_book').find(
                { world_id: worldId, player_id: sellerPlayerId, order_type: "sell", asset_type: "share", asset_id: shareAssetId, status: { $in: ["open", "partial"] } },
                { session }
            ).toArray();
            const lockedQuantity = lockedDocs.reduce((acc, order) => acc + (Number(order.quantity) - Number(order.filled_quantity || 0)), 0);
            const availableQuantity = ownedQuantity - lockedQuantity;

            if (availableQuantity < quantity) throw new Error('Seller does not have enough unlocked shares anymore');

            const recipientPlayer = await database.collection('world_players').findOne({ id: recipientPlayerId }, { session });
            const recipientCash = Number(recipientPlayer?.cash_balance || 0);

            if (recipientCash < totalAmount) throw new Error('You do not have enough cash to accept this private deal');

            const sellerNextQuantity = ownedQuantity - quantity;
            if (sellerNextQuantity > 0) {
                await database.collection('portfolio').updateOne({ id: sellerPortfolio.id }, { $set: { quantity: sellerNextQuantity } }, { session });
            } else {
                await database.collection('portfolio').deleteOne({ id: sellerPortfolio.id }, { session });
            }

            const recipientPortfolio = await database.collection('portfolio').findOne(
                { player_id: recipientPlayerId, asset_type: "share", asset_id: shareAssetId },
                { session }
            );

            if (recipientPortfolio) {
                const recipientOldQty = Number(recipientPortfolio.quantity || 0);
                const recipientOldAvg = Number(recipientPortfolio.avg_buy_price || 0);
                const recipientNextQty = recipientOldQty + quantity;
                const recipientNextAvg = recipientNextQty > 0
                    ? (((recipientOldQty * recipientOldAvg) + (quantity * pricePerShare)) / recipientNextQty)
                    : pricePerShare;
                
                await database.collection('portfolio').updateOne(
                    { id: recipientPortfolio.id },
                    { $set: { quantity: recipientNextQty, avg_buy_price: recipientNextAvg } },
                    { session }
                );
            } else {
                const portfolioId = await db.getNextId('portfolio', session);
                await database.collection('portfolio').insertOne({
                    id: portfolioId,
                    player_id: recipientPlayerId,
                    asset_type: "share",
                    asset_id: shareAssetId,
                    quantity: quantity,
                    avg_buy_price: pricePerShare
                }, { session });
            }

            await database.collection('world_players').updateOne({ id: recipientPlayerId }, { $inc: { cash_balance: -totalAmount } }, { session });
            await database.collection('world_players').updateOne({ id: sellerPlayerId }, { $inc: { cash_balance: totalAmount } }, { session });

            const txId = await db.getNextId('transactions', session);
            const now = new Date().toISOString();
            await database.collection('transactions').insertOne({
                id: txId,
                world_id: worldId,
                buyer_id: recipientPlayerId,
                seller_id: sellerPlayerId,
                asset_type: "share",
                asset_id: shareAssetId,
                quantity,
                price_per_unit: pricePerShare,
                total_amount: totalAmount,
                created_at: now
            }, { session });

            const world = await database.collection('worlds').findOne({ id: worldId }, { session });
            const worldTick = Number(world?.current_tick || 0);

            const phId = await db.getNextId('price_history', session);
            await database.collection('price_history').insertOne({
                id: phId,
                world_id: worldId,
                asset_type: "share",
                asset_id: shareAssetId,
                price: pricePerShare,
                volume: quantity,
                world_tick: worldTick,
                recorded_at: now
            }, { session });

            await database.collection('assets').updateOne({ id: shareAssetId }, { $set: { current_price: pricePerShare } }, { session });
            await database.collection('companies').updateOne({ id: company.id }, { $set: { share_price: pricePerShare } }, { session });

            const topHolders = await database.collection('portfolio').find(
                { asset_type: "share", asset_id: shareAssetId, quantity: { $gt: 0 } },
                { session }
            ).sort({ quantity: -1, player_id: 1 }).limit(1).toArray();

            if (topHolders.length > 0) {
                await database.collection('companies').updateOne({ id: company.id }, { $set: { owner_player_id: topHolders[0].player_id } }, { session });
            }

            await database.collection('private_deals').updateOne(
                { id: dealId },
                { $set: { status: "accepted", responded_at: now, accepted_transaction_id: txId } },
                { session }
            );

            const sellerUser = await database.collection('users').findOne({ id: sellerUserId }, { session });
            const sellerUsername = sellerUser?.username || `User ${sellerUserId}`;

            const quantityText = Number(quantity).toLocaleString(undefined, { maximumFractionDigits: 4 });
            const priceText = Number(pricePerShare).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
            const totalText = Number(totalAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const confirmMessage = `[Private Deal Accepted #${dealId}] ${username} accepted ${sellerUsername}'s offer for ${quantityText} shares of ${company.name} (${company.ticker}) at $${priceText}/share (total $${totalText}).`;

            const dmId = await db.getNextId('direct_messages', session);
            await database.collection('direct_messages').insertOne({
                id: dmId,
                world_id: worldId,
                sender_user_id: userId,
                recipient_user_id: sellerUserId,
                message: confirmMessage,
                is_read: false,
                created_at: now
            }, { session });

            return {
                company, sellerUserId, sellerUsername, confirmMessage, dmId, now, quantity, pricePerShare, totalAmount, txId, worldId
            };
        });

        const messagePayload = {
            id: result.dmId,
            world_id: result.worldId,
            sender_user_id: userId,
            sender_username: username,
            recipient_user_id: result.sellerUserId,
            recipient_username: result.sellerUsername,
            message: result.confirmMessage,
            is_read: false,
            created_at: result.now
        };

        wsHandler.broadcastToWorld(result.worldId, {
            type: 'chat_direct_message',
            message: messagePayload
        });

        res.json({
            message: 'Private deal accepted and executed',
            deal: {
                id: dealId,
                status: 'accepted',
                company_id: result.company.id,
                quantity: result.quantity,
                price_per_share: result.pricePerShare,
                total_amount: result.totalAmount,
                transaction_id: result.txId
            },
            directMessage: messagePayload
        });
    } catch (err) {
        console.error('Accept private deal error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const rejectPrivateDeal = async (req, res) => {
    try {
        const userId = req.user.id;
        const username = req.user.username;
        const dealId = Number(req.params.dealId);

        if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'dealId is required' });

        const database = db.getDb();
        const result = await db.withTransaction(async (session) => {
            const deal = await database.collection('private_deals').findOne({ id: dealId }, { session });
            if (!deal) throw new Error('Private deal not found');
            if (deal.status !== 'pending') throw new Error('Only pending private deals can be rejected');

            const worldId = Number(deal.world_id);
            const sellerUserId = Number(deal.proposer_user_id);
            const recipientUserId = Number(deal.recipient_user_id);

            if (recipientUserId !== Number(userId)) throw new Error('Only the deal recipient can reject this proposal');

            await resolvePlayerId(database, userId, worldId, session);
            await resolvePlayerId(database, sellerUserId, worldId, session);

            const company = await database.collection('companies').findOne({ id: deal.company_id }, { session });
            const companyName = company?.name || `Company ${deal.company_id}`;
            const ticker = company?.ticker || 'N/A';

            const now = new Date().toISOString();
            await database.collection('private_deals').updateOne(
                { id: dealId },
                { $set: { status: "rejected", responded_at: now } },
                { session }
            );

            const quantityText = Number(deal.quantity || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });
            const priceText = Number(deal.price_per_share || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
            const totalText = Number(deal.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const rejectMessage = `[Private Deal Rejected #${dealId}] ${username} rejected the offer for ${quantityText} shares of ${companyName} (${ticker}) at $${priceText}/share (total $${totalText}).`;

            const dmId = await db.getNextId('direct_messages', session);
            await database.collection('direct_messages').insertOne({
                id: dmId,
                world_id: worldId,
                sender_user_id: userId,
                recipient_user_id: sellerUserId,
                message: rejectMessage,
                is_read: false,
                created_at: now
            }, { session });

            const sellerUser = await database.collection('users').findOne({ id: sellerUserId }, { session });
            return { worldId, sellerUserId, sellerUsername: sellerUser?.username || `User ${sellerUserId}`, rejectMessage, dmId, now };
        });

        const messagePayload = {
            id: result.dmId,
            world_id: result.worldId,
            sender_user_id: userId,
            sender_username: username,
            recipient_user_id: result.sellerUserId,
            recipient_username: result.sellerUsername,
            message: result.rejectMessage,
            is_read: false,
            created_at: result.now
        };

        wsHandler.broadcastToWorld(result.worldId, {
            type: 'chat_direct_message',
            message: messagePayload
        });

        res.json({
            message: 'Private deal rejected',
            deal: { id: dealId, status: 'rejected' },
            directMessage: messagePayload
        });
    } catch (err) {
        console.error('Reject private deal error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const liquidateCompany = async (req, res) => {
    try {
        const userId = req.user.id;
        const companyId = Number(req.params.id);
        const worldId = Number(req.body.worldId);

        if (!Number.isInteger(companyId) || !Number.isInteger(worldId)) {
            return res.status(400).json({ error: 'companyId and worldId are required' });
        }

        const database = db.getDb();
        const result = await db.withTransaction(async (session) => {
            const playerId = await resolvePlayerId(database, userId, worldId, session);
            const { company, controllerPlayerId } = await resolveCompanyAndController(database, companyId, worldId, { session });
            
            if (!company.is_active) throw new Error('Company is inactive');
            if (controllerPlayerId !== playerId) throw new Error('Only the largest shareholder can liquidate this company');

            let shareAssetId = Number(company.asset_id || 0);
            if (!shareAssetId) {
                shareAssetId = await db.getNextId('assets', session);
                await database.collection('assets').insertOne({
                    id: shareAssetId,
                    world_id: worldId,
                    asset_type: "share",
                    name: company.name,
                    symbol: String(company.ticker || '').toUpperCase(),
                    current_price: Number(company.share_price || 0),
                    available_quantity: 0,
                    is_active: true
                }, { session });
                await database.collection('companies').updateOne({ id: company.id }, { $set: { asset_id: shareAssetId } }, { session });
            }

            const liquidationPrice = Number(company.share_price || 0);

            const holders = await database.collection('portfolio').find(
                { asset_type: "share", asset_id: shareAssetId },
                { session }
            ).toArray();

            let totalPayout = 0;
            for (const holder of holders) {
                const qty = Number(holder.quantity || 0);
                if (qty <= 0) continue;
                const payout = qty * liquidationPrice;
                totalPayout += payout;
                await database.collection('world_players').updateOne(
                    { id: holder.player_id },
                    { $inc: { cash_balance: payout } },
                    { session }
                );
            }

            await database.collection('portfolio').deleteMany({ asset_type: "share", asset_id: shareAssetId }, { session });

            const openOrders = await database.collection('order_book').find(
                { world_id: worldId, asset_type: "share", asset_id: shareAssetId, status: { $in: ["open", "partial"] } },
                { session }
            ).toArray();

            for (const order of openOrders) {
                if (order.order_type === 'buy') {
                    const unfilledQty = Number(order.quantity) - Number(order.filled_quantity || 0);
                    if (unfilledQty > 0) {
                        const refund = unfilledQty * Number(order.price_per_unit);
                        await database.collection('world_players').updateOne(
                            { id: order.player_id },
                            { $inc: { cash_balance: refund } },
                            { session }
                        );
                    }
                }
                await database.collection('order_book').updateOne({ id: order.id }, { $set: { status: "cancelled" } }, { session });
            }

            await database.collection('companies').updateOne(
                { id: companyId },
                { $set: { is_active: false, share_price: 0, shares_in_market: 0 } },
                { session }
            );

            await database.collection('assets').updateOne(
                { id: shareAssetId },
                { $set: { is_active: false, current_price: 0, available_quantity: 0 } },
                { session }
            );

            const eventId = await db.getNextId('world_events', session);
            await database.collection('world_events').insertOne({
                id: eventId,
                world_id: worldId,
                event_type: "company_liquidation",
                title: `Company Liquidation: ${company.name}`,
                description: `${company.name} was liquidated. Total payout distributed to shareholders: $${totalPayout.toFixed(2)}.`,
                severity: "major",
                effects_json: JSON.stringify({ companyId, liquidationPrice, totalPayout }),
                created_at: new Date().toISOString()
            }, { session });

            return { totalPayout, company };
        });

        wsHandler.broadcastToWorld(worldId, {
            type: 'news',
            title: `Company Liquidation: ${result.company.name}`,
            description: `${result.company.name} was liquidated. Total payout distributed: $${result.totalPayout.toFixed(2)}.`,
            severity: 'major'
        });

        res.json({ message: 'Company liquidated successfully', totalPayout: result.totalPayout });
    } catch (err) {
        console.error('Liquidate company error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

module.exports = {
    listSectors,
    createCompany,
    listCompanyOnMarket,
    updateCompanySettings,
    listMyCompanies,
    listCompanyShares,
    listPrivateDeals,
    executePrivateDeal,
    acceptPrivateDeal,
    rejectPrivateDeal,
    liquidateCompany
};
