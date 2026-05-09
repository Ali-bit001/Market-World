const db = require('../config/database');
const wsHandler = require('../websocket/ws.handler');
const TXN_RETRY_OPTIONS = { maxRetries: 10 };

const resolvePlayerId = async (database, userId, worldId, session = null) => {
    const player = await database.collection('world_players').findOne(
        { user_id: Number(userId), world_id: Number(worldId) },
        { session }
    );
    if (!player) {
        throw new Error('Player not in this world');
    }
    return Number(player.id);
};

const formatQty = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 6 });
const formatPrice = (value) => Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const formatTotal = (value) => Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const isAnchorCompany = async (database, worldId, company, session = null) => {
    if (!company) return false;
    const ownerPlayerId = Number(company.owner_player_id || 0);
    if (!Number.isInteger(ownerPlayerId) || ownerPlayerId <= 0) return false;

    const ownerPlayer = await database.collection('world_players').findOne(
        { id: ownerPlayerId, world_id: Number(worldId) },
        { session }
    );

    return Boolean(ownerPlayer?.is_bot) && String(ownerPlayer?.bot_role || '') === 'market_corporate';
};

const resolveDealAsset = async (database, deal, session = null) => {
    const rawAssetId = Number(deal.asset_id || deal.share_asset_id || 0);
    if (!Number.isInteger(rawAssetId) || rawAssetId <= 0) {
        throw new Error('Private deal asset is invalid');
    }

    const asset = await database.collection('assets').findOne({ id: rawAssetId }, { session });
    if (!asset) {
        throw new Error('Deal asset not found');
    }

    const assetType = String(deal.asset_type || asset.asset_type || '').trim().toLowerCase();
    const company = assetType === 'share'
        ? await database.collection('companies').findOne({ world_id: Number(deal.world_id), asset_id: rawAssetId }, { session })
        : null;

    return {
        assetId: rawAssetId,
        assetType,
        asset,
        company
    };
};

const listBackdoorDeals = async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const worldId = Number(req.query.worldId);
        const withUserId = Number(req.query.withUserId);
        const limit = Math.min(Math.max(Number(req.query.limit || 80), 1), 200);

        if (!Number.isInteger(worldId) || !Number.isInteger(withUserId) || withUserId <= 0) {
            return res.status(400).json({ error: 'worldId and withUserId are required' });
        }
        if (withUserId === userId) {
            return res.status(400).json({ error: 'Cannot load backdoor deals with yourself' });
        }

        const database = db.getDb();
        await resolvePlayerId(database, userId, worldId);
        await resolvePlayerId(database, withUserId, worldId);

        const rows = await database.collection('private_deals').aggregate([
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
            { $lookup: { from: 'assets', localField: 'asset_id', foreignField: 'id', as: 'asset' } },
            { $lookup: { from: 'companies', localField: 'asset_id', foreignField: 'asset_id', as: 'company' } },
            { $lookup: { from: 'users', localField: 'proposer_user_id', foreignField: 'id', as: 'proposer' } },
            { $lookup: { from: 'users', localField: 'recipient_user_id', foreignField: 'id', as: 'recipient' } },
            { $unwind: { path: '$asset', preserveNullAndEmptyArrays: true } },
            { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
            { $unwind: { path: '$proposer', preserveNullAndEmptyArrays: true } },
            { $unwind: { path: '$recipient', preserveNullAndEmptyArrays: true } }
        ]).toArray();

        const deals = rows.map((row) => {
            const quantity = Number(row.quantity || 0);
            const pricePerUnit = Number(row.price_per_unit || row.price_per_share || 0);
            const totalAmount = Number(row.total_amount || (quantity * pricePerUnit));
            const assetType = String(row.asset_type || row.asset?.asset_type || 'share').toLowerCase();

            return {
                id: row.id,
                world_id: row.world_id,
                proposer_user_id: row.proposer_user_id,
                proposer_username: row.proposer?.username || null,
                recipient_user_id: row.recipient_user_id,
                recipient_username: row.recipient?.username || null,
                asset_type: assetType,
                asset_id: Number(row.asset_id || row.share_asset_id || 0),
                asset_name: row.asset?.name || null,
                asset_symbol: row.asset?.symbol || null,
                company_id: row.company_id || row.company?.id || null,
                company_name: row.company?.name || null,
                ticker: row.company?.ticker || row.asset?.symbol || null,
                quantity,
                price_per_unit: pricePerUnit,
                price_per_share: pricePerUnit,
                total_amount: totalAmount,
                note: row.note || null,
                status: row.status,
                responded_at: row.responded_at || null,
                created_at: row.created_at,
                is_mine: Number(row.proposer_user_id) === userId,
                is_actionable: Number(row.recipient_user_id) === userId
            };
        });

        res.json({ deals: deals.reverse() });
    } catch (err) {
        console.error('List backdoor deals error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const proposeBackdoorDeal = async (req, res) => {
    try {
        const sellerUserId = Number(req.user.id);
        const sellerUsername = req.user.username;
        const worldId = Number(req.body.worldId);
        const recipientUserId = Number(req.body.recipientUserId);
        const assetId = Number(req.body.assetId);
        const assetTypeInput = String(req.body.assetType || '').trim().toLowerCase();
        const quantity = Number(req.body.quantity);
        const pricePerUnit = Number(req.body.pricePerUnit);
        const note = String(req.body.note || '').trim();

        if (!Number.isInteger(worldId) || !Number.isInteger(recipientUserId) || !Number.isInteger(assetId) || assetId <= 0) {
            return res.status(400).json({ error: 'worldId, recipientUserId, and assetId are required' });
        }
        if (recipientUserId === sellerUserId) {
            return res.status(400).json({ error: 'Cannot create backdoor deals with yourself' });
        }
        if (!Number.isFinite(quantity) || quantity <= 0) {
            return res.status(400).json({ error: 'quantity must be a positive number' });
        }
        if (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0) {
            return res.status(400).json({ error: 'pricePerUnit must be a positive number' });
        }
        if (note.length > 180) {
            return res.status(400).json({ error: 'Deal note cannot exceed 180 characters' });
        }

        const database = db.getDb();

        const result = await db.withTransaction(async (session) => {
            const sellerPlayerId = await resolvePlayerId(database, sellerUserId, worldId, session);
            await resolvePlayerId(database, recipientUserId, worldId, session);

            const asset = await database.collection('assets').findOne({ id: assetId, world_id: worldId, is_active: true }, { session });
            if (!asset) throw new Error('Asset is not available in this world');

            const assetType = String(asset.asset_type || '').toLowerCase();
            if (!['share', 'commodity', 'crypto', 'bond'].includes(assetType)) {
                throw new Error('Unsupported asset type for backdoor deals');
            }
            if (assetTypeInput && assetTypeInput !== assetType) {
                throw new Error('assetType does not match assetId');
            }

            const sellerPortfolio = await database.collection('portfolio').findOne(
                { player_id: sellerPlayerId, asset_type: assetType, asset_id: assetId },
                { session }
            );
            if (!sellerPortfolio) throw new Error('You do not own this asset');

            const ownedQuantity = Number(sellerPortfolio.quantity || 0);
            let lockedQuantity = 0;
            if (assetType === 'share') {
                const lockedOrders = await database.collection('order_book').find(
                    {
                        world_id: worldId,
                        player_id: sellerPlayerId,
                        order_type: 'sell',
                        asset_type: 'share',
                        asset_id: assetId,
                        status: { $in: ['open', 'partial'] }
                    },
                    { session }
                ).toArray();
                lockedQuantity = lockedOrders.reduce(
                    (sum, order) => sum + (Number(order.quantity || 0) - Number(order.filled_quantity || 0)),
                    0
                );
            }

            const availableQuantity = ownedQuantity - lockedQuantity;
            if (availableQuantity < quantity) {
                throw new Error('Not enough unlocked quantity to propose this backdoor deal');
            }

            const totalAmount = quantity * pricePerUnit;
            const company = assetType === 'share'
                ? await database.collection('companies').findOne({ world_id: worldId, asset_id: assetId }, { session })
                : null;

            const dealId = await db.getNextId('private_deals');
            await database.collection('private_deals').insertOne({
                id: dealId,
                world_id: worldId,
                proposer_user_id: sellerUserId,
                recipient_user_id: recipientUserId,
                asset_type: assetType,
                asset_id: assetId,
                share_asset_id: assetType === 'share' ? assetId : null,
                company_id: company?.id || null,
                quantity,
                price_per_unit: pricePerUnit,
                price_per_share: pricePerUnit,
                total_amount: totalAmount,
                note: note || null,
                status: 'pending',
                created_at: new Date().toISOString()
            }, { session });

            const recipientUser = await database.collection('users').findOne({ id: recipientUserId }, { session });
            const recipientUsername = recipientUser?.username || `User ${recipientUserId}`;
            const assetLabel = company
                ? `${company.name} (${company.ticker})`
                : `${asset.name} (${asset.symbol})`;
            const noteSuffix = note ? ` Note: ${note}` : '';
            const message = `[Backdoor Deal Proposal #${dealId}] ${sellerUsername} offers ${formatQty(quantity)} units of ${assetLabel} at $${formatPrice(pricePerUnit)}/unit (total $${formatTotal(totalAmount)}). Accept or reject in Backdoor Deals.${noteSuffix}`;

            const dmId = await db.getNextId('direct_messages');
            const now = new Date().toISOString();
            await database.collection('direct_messages').insertOne({
                id: dmId,
                world_id: worldId,
                sender_user_id: sellerUserId,
                recipient_user_id: recipientUserId,
                message,
                is_read: false,
                created_at: now
            }, { session });

            return {
                dealId,
                assetType,
                assetId,
                assetName: asset.name,
                assetSymbol: asset.symbol,
                companyName: company?.name || null,
                companyTicker: company?.ticker || null,
                quantity,
                pricePerUnit,
                totalAmount,
                recipientUsername,
                dmId,
                message,
                now
            };
        }, TXN_RETRY_OPTIONS);

        const messagePayload = {
            id: result.dmId,
            world_id: worldId,
            sender_user_id: sellerUserId,
            sender_username: sellerUsername,
            recipient_user_id: recipientUserId,
            recipient_username: result.recipientUsername,
            message: result.message,
            is_read: false,
            created_at: result.now
        };

        wsHandler.broadcastToWorld(worldId, {
            type: 'chat_direct_message',
            message: messagePayload
        });

        res.status(201).json({
            message: 'Backdoor deal proposal sent',
            deal: {
                id: result.dealId,
                status: 'pending',
                asset_type: result.assetType,
                asset_id: result.assetId,
                asset_name: result.assetName,
                asset_symbol: result.assetSymbol,
                company_name: result.companyName,
                ticker: result.companyTicker || result.assetSymbol,
                quantity: result.quantity,
                price_per_unit: result.pricePerUnit,
                price_per_share: result.pricePerUnit,
                total_amount: result.totalAmount,
                seller_user_id: sellerUserId,
                recipient_user_id: recipientUserId
            },
            directMessage: messagePayload
        });
    } catch (err) {
        console.error('Backdoor deal proposal error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const acceptBackdoorDeal = async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const username = req.user.username;
        const dealId = Number(req.params.dealId);

        if (!Number.isInteger(dealId) || dealId <= 0) {
            return res.status(400).json({ error: 'dealId is required' });
        }

        const database = db.getDb();
        const result = await db.withTransaction(async (session) => {
            const deal = await database.collection('private_deals').findOne({ id: dealId }, { session });
            if (!deal) throw new Error('Backdoor deal not found');
            if (String(deal.status) !== 'pending') throw new Error('Only pending deals can be accepted');

            const worldId = Number(deal.world_id);
            const sellerUserId = Number(deal.proposer_user_id);
            const recipientUserId = Number(deal.recipient_user_id);
            if (recipientUserId !== userId) throw new Error('Only the deal recipient can accept this proposal');

            const sellerPlayerId = await resolvePlayerId(database, sellerUserId, worldId, session);
            const recipientPlayerId = await resolvePlayerId(database, recipientUserId, worldId, session);

            const { assetId, assetType, asset, company } = await resolveDealAsset(database, deal, session);
            if (!asset.is_active) throw new Error('Asset is inactive');
            const isAnchorShare = assetType === 'share' && company
                ? await isAnchorCompany(database, worldId, company, session)
                : false;

            const quantity = Number(deal.quantity || 0);
            const pricePerUnit = Number(deal.price_per_unit || deal.price_per_share || 0);
            const totalAmount = Number(deal.total_amount || (quantity * pricePerUnit));
            if (quantity <= 0 || pricePerUnit <= 0 || totalAmount <= 0) throw new Error('Backdoor deal values are invalid');

            const sellerPortfolio = await database.collection('portfolio').findOne(
                { player_id: sellerPlayerId, asset_type: assetType, asset_id: assetId },
                { session }
            );
            if (!sellerPortfolio) throw new Error('Seller no longer owns this asset');

            const ownedQuantity = Number(sellerPortfolio.quantity || 0);
            let lockedQuantity = 0;
            if (assetType === 'share') {
                const lockedOrders = await database.collection('order_book').find(
                    {
                        world_id: worldId,
                        player_id: sellerPlayerId,
                        order_type: 'sell',
                        asset_type: 'share',
                        asset_id: assetId,
                        status: { $in: ['open', 'partial'] }
                    },
                    { session }
                ).toArray();
                lockedQuantity = lockedOrders.reduce(
                    (sum, order) => sum + (Number(order.quantity || 0) - Number(order.filled_quantity || 0)),
                    0
                );
            }
            const availableQuantity = ownedQuantity - lockedQuantity;
            if (availableQuantity < quantity) throw new Error('Seller no longer has enough unlocked quantity');

            const recipientPlayer = await database.collection('world_players').findOne({ id: recipientPlayerId }, { session });
            const recipientCash = Number(recipientPlayer?.cash_balance || 0);
            if (recipientCash < totalAmount) throw new Error('You do not have enough cash to accept this deal');

            const sellerNextQuantity = ownedQuantity - quantity;
            if (sellerNextQuantity > 0) {
                await database.collection('portfolio').updateOne(
                    { id: sellerPortfolio.id },
                    { $set: { quantity: sellerNextQuantity } },
                    { session }
                );
            } else {
                await database.collection('portfolio').deleteOne({ id: sellerPortfolio.id }, { session });
            }

            const recipientPortfolio = await database.collection('portfolio').findOne(
                { player_id: recipientPlayerId, asset_type: assetType, asset_id: assetId },
                { session }
            );

            if (recipientPortfolio) {
                const oldQty = Number(recipientPortfolio.quantity || 0);
                const oldAvg = Number(recipientPortfolio.avg_buy_price || 0);
                const nextQty = oldQty + quantity;
                const nextAvg = nextQty > 0
                    ? (((oldQty * oldAvg) + (quantity * pricePerUnit)) / nextQty)
                    : pricePerUnit;

                await database.collection('portfolio').updateOne(
                    { id: recipientPortfolio.id },
                    { $set: { quantity: nextQty, avg_buy_price: nextAvg } },
                    { session }
                );
            } else {
                const portfolioId = await db.getNextId('portfolio');
                await database.collection('portfolio').insertOne({
                    id: portfolioId,
                    player_id: recipientPlayerId,
                    asset_type: assetType,
                    asset_id: assetId,
                    quantity,
                    avg_buy_price: pricePerUnit
                }, { session });
            }

            await database.collection('world_players').updateOne(
                { id: recipientPlayerId },
                { $inc: { cash_balance: -totalAmount } },
                { session }
            );
            await database.collection('world_players').updateOne(
                { id: sellerPlayerId },
                { $inc: { cash_balance: totalAmount } },
                { session }
            );

            const txId = await db.getNextId('transactions');
            const now = new Date().toISOString();
            await database.collection('transactions').insertOne({
                id: txId,
                world_id: worldId,
                buyer_id: recipientPlayerId,
                seller_id: sellerPlayerId,
                asset_type: assetType,
                asset_id: assetId,
                quantity,
                price_per_unit: pricePerUnit,
                total_amount: totalAmount,
                created_at: now
            }, { session });

            if (!(assetType === 'share' && isAnchorShare)) {
                const world = await database.collection('worlds').findOne({ id: worldId }, { session });
                const worldTick = Number(world?.current_tick || 0);
                const phId = await db.getNextId('price_history');
                await database.collection('price_history').insertOne({
                    id: phId,
                    world_id: worldId,
                    asset_type: assetType,
                    asset_id: assetId,
                    price: pricePerUnit,
                    volume: quantity,
                    world_tick: worldTick,
                    recorded_at: now
                }, { session });

                await database.collection('assets').updateOne(
                    { id: assetId },
                    { $set: { current_price: pricePerUnit } },
                    { session }
                );
            }

            if (assetType === 'share' && company) {
                if (!isAnchorShare) {
                    await database.collection('companies').updateOne(
                        { id: company.id },
                        { $set: { share_price: pricePerUnit } },
                        { session }
                    );

                    const topHolders = await database.collection('portfolio').find(
                        { asset_type: 'share', asset_id: assetId, quantity: { $gt: 0 } },
                        { session }
                    ).sort({ quantity: -1, player_id: 1 }).limit(1).toArray();
                    if (topHolders.length > 0) {
                        await database.collection('companies').updateOne(
                            { id: company.id },
                            { $set: { owner_player_id: topHolders[0].player_id } },
                            { session }
                        );
                    }
                }
            } else if (assetType === 'commodity') {
                await database.collection('commodities').updateOne(
                    { world_id: worldId, asset_id: assetId },
                    { $set: { current_price: pricePerUnit } },
                    { session }
                );
            } else if (assetType === 'crypto') {
                await database.collection('cryptos').updateOne(
                    { world_id: worldId, asset_id: assetId },
                    { $set: { current_price: pricePerUnit } },
                    { session }
                );
            } else if (assetType === 'bond') {
                await database.collection('bonds').updateOne(
                    { world_id: worldId, asset_id: assetId },
                    { $set: { current_value: pricePerUnit } },
                    { session }
                );
            }

            await database.collection('private_deals').updateOne(
                { id: dealId },
                { $set: { status: 'accepted', responded_at: now, accepted_transaction_id: txId } },
                { session }
            );

            const sellerUser = await database.collection('users').findOne({ id: sellerUserId }, { session });
            const sellerUsername = sellerUser?.username || `User ${sellerUserId}`;
            const assetLabel = company
                ? `${company.name} (${company.ticker})`
                : `${asset.name} (${asset.symbol})`;
            const confirmMessage = `[Backdoor Deal Accepted #${dealId}] ${username} accepted ${sellerUsername}'s offer for ${formatQty(quantity)} units of ${assetLabel} at $${formatPrice(pricePerUnit)}/unit (total $${formatTotal(totalAmount)}).`;

            const dmId = await db.getNextId('direct_messages');
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
                worldId,
                sellerUserId,
                sellerUsername,
                dmId,
                now,
                confirmMessage,
                txId,
                assetType,
                assetId,
                assetName: asset.name,
                assetSymbol: asset.symbol,
                quantity,
                pricePerUnit,
                totalAmount
            };
        }, TXN_RETRY_OPTIONS);

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
            message: 'Backdoor deal accepted and executed',
            deal: {
                id: dealId,
                status: 'accepted',
                asset_type: result.assetType,
                asset_id: result.assetId,
                asset_name: result.assetName,
                asset_symbol: result.assetSymbol,
                quantity: result.quantity,
                price_per_unit: result.pricePerUnit,
                price_per_share: result.pricePerUnit,
                total_amount: result.totalAmount,
                transaction_id: result.txId
            },
            directMessage: messagePayload
        });
    } catch (err) {
        console.error('Accept backdoor deal error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

const rejectBackdoorDeal = async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const username = req.user.username;
        const dealId = Number(req.params.dealId);
        if (!Number.isInteger(dealId) || dealId <= 0) {
            return res.status(400).json({ error: 'dealId is required' });
        }

        const database = db.getDb();
        const result = await db.withTransaction(async (session) => {
            const deal = await database.collection('private_deals').findOne({ id: dealId }, { session });
            if (!deal) throw new Error('Backdoor deal not found');
            if (String(deal.status) !== 'pending') throw new Error('Only pending deals can be rejected');

            const worldId = Number(deal.world_id);
            const sellerUserId = Number(deal.proposer_user_id);
            const recipientUserId = Number(deal.recipient_user_id);
            if (recipientUserId !== userId) throw new Error('Only the deal recipient can reject this proposal');

            await resolvePlayerId(database, userId, worldId, session);
            await resolvePlayerId(database, sellerUserId, worldId, session);

            const { assetType, asset, company } = await resolveDealAsset(database, deal, session);

            const now = new Date().toISOString();
            await database.collection('private_deals').updateOne(
                { id: dealId },
                { $set: { status: 'rejected', responded_at: now } },
                { session }
            );

            const quantity = Number(deal.quantity || 0);
            const pricePerUnit = Number(deal.price_per_unit || deal.price_per_share || 0);
            const totalAmount = Number(deal.total_amount || (quantity * pricePerUnit));
            const assetLabel = company
                ? `${company.name} (${company.ticker})`
                : `${asset.name} (${asset.symbol})`;
            const rejectMessage = `[Backdoor Deal Rejected #${dealId}] ${username} rejected the offer for ${formatQty(quantity)} units of ${assetLabel} at $${formatPrice(pricePerUnit)}/unit (total $${formatTotal(totalAmount)}).`;

            const dmId = await db.getNextId('direct_messages');
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
            return {
                worldId,
                sellerUserId,
                sellerUsername: sellerUser?.username || `User ${sellerUserId}`,
                dmId,
                now,
                rejectMessage,
                assetType
            };
        }, TXN_RETRY_OPTIONS);

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
            message: 'Backdoor deal rejected',
            deal: { id: dealId, status: 'rejected' },
            directMessage: messagePayload
        });
    } catch (err) {
        console.error('Reject backdoor deal error:', err);
        res.status(400).json({ error: err.message || 'Server error' });
    }
};

module.exports = {
    listBackdoorDeals,
    proposeBackdoorDeal,
    acceptBackdoorDeal,
    rejectBackdoorDeal
};
