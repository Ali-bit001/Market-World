const db = require('../config/database');
const { WORLD_COUNTRIES, WORLD_MARKETS } = require('../data/stock-markets.data');
const { REAL_COMPANIES_BY_MARKET } = require('../data/real-companies.data');
const { resolveSeedPrice } = require('../services/market-data.service');

const BOT_PLAYSTYLE_LIBRARY = [
    { archetype: 'income_guardian', risk_profile: 'conservative', strategy: 'income', tempo: 'slow', preferred_assets: ['bond', 'share'] },
    { archetype: 'index_balancer', risk_profile: 'moderate', strategy: 'diversified', tempo: 'steady', preferred_assets: ['share', 'commodity'] },
    { archetype: 'macro_hunter', risk_profile: 'aggressive', strategy: 'event-driven', tempo: 'fast', preferred_assets: ['commodity', 'crypto'] },
    { archetype: 'quant_swing', risk_profile: 'aggressive', strategy: 'momentum', tempo: 'fast', preferred_assets: ['share', 'crypto'] },
    { archetype: 'sovereign_allocator', risk_profile: 'moderate', strategy: 'macro-rotation', tempo: 'steady', preferred_assets: ['bond', 'commodity'] }
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const STOCK_MARKET_INDEX_COMPONENTS = [10, 20, 100];
const EVENT_SEVERITY_SHOCK = { minor: 0.006, moderate: 0.011, major: 0.018, catastrophic: 0.028 };
const RELATION_INCIDENT_LOOKBACK_TICKS = 24;

const financialHealthBandFromScore = (score, isInsolvent) => {
    const normalizedScore = Number(score || 0);
    if (Boolean(isInsolvent) || normalizedScore < 35) return 'distressed';
    if (normalizedScore < 52) return 'vulnerable';
    if (normalizedScore < 75) return 'stable';
    return 'robust';
};

const conflictRiskLevelFromScore = (score) => {
    const normalizedScore = Number(score || 0);
    if (normalizedScore >= 72) return 'severe';
    if (normalizedScore >= 50) return 'elevated';
    if (normalizedScore >= 28) return 'guarded';
    return 'low';
};

const parseEffectsJson = (raw) => {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
};

const calculateQuantile = (sortedValues, quantile) => {
    if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0;
    const q = clamp(Number(quantile || 0), 0, 1);
    const index = (sortedValues.length - 1) * q;
    const lowerIndex = Math.floor(index);
    const upperIndex = Math.ceil(index);
    if (lowerIndex === upperIndex) return Number(sortedValues[lowerIndex] || 0);
    const lowerValue = Number(sortedValues[lowerIndex] || 0);
    const upperValue = Number(sortedValues[upperIndex] || lowerValue);
    const interpolationWeight = index - lowerIndex;
    return lowerValue + ((upperValue - lowerValue) * interpolationWeight);
};

const calculatePercentileRank = (sortedValues, value) => {
    if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0.5;
    const numericValue = Number(value || 0);
    let lowerBound = 0;
    while (lowerBound < sortedValues.length && Number(sortedValues[lowerBound]) < numericValue) lowerBound += 1;
    let upperBound = lowerBound;
    while (upperBound < sortedValues.length && Number(sortedValues[upperBound]) <= numericValue) upperBound += 1;
    return clamp(((lowerBound + upperBound) * 0.5) / sortedValues.length, 0, 1);
};

const buildAnchorTicker = (rawSymbol) => String(rawSymbol || '').toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 12);

const buildStockMarketIndexes = (companyRows, marketCode) => {
    const normalizedRows = (companyRows || []).map((row) => {
        const sharePrice = Number(row.share_price || 0);
        const totalShares = Number(row.total_shares || 0);
        const marketCap = Number(row.market_cap || (sharePrice * totalShares));
        const prevPriceRaw = row.prev_price === null || row.prev_price === undefined ? null : Number(row.prev_price);
        const prevPrice = Number.isFinite(prevPriceRaw) && prevPriceRaw > 0 ? prevPriceRaw : null;
        return { sharePrice, totalShares, marketCap, prevPrice };
    }).filter((row) => Number.isFinite(row.sharePrice) && row.sharePrice > 0 && Number.isFinite(row.totalShares) && row.totalShares > 0)
      .sort((a, b) => b.marketCap - a.marketCap);

    const code = String(marketCode || 'MKT').toUpperCase();

    return STOCK_MARKET_INDEX_COMPONENTS.flatMap((componentCount) => {
        if (normalizedRows.length < componentCount) return [];
        const constituents = normalizedRows.slice(0, componentCount);
        const totalShares = constituents.reduce((sum, row) => sum + row.totalShares, 0);
        if (!Number.isFinite(totalShares) || totalShares <= 0) return [];

        const weightedCurrent = constituents.reduce((sum, row) => sum + (row.sharePrice * row.totalShares), 0) / totalShares;
        const weightedPrevious = constituents.reduce((sum, row) => {
            const previous = Number.isFinite(row.prevPrice) && row.prevPrice > 0 ? row.prevPrice : row.sharePrice;
            return sum + (previous * row.totalShares);
        }, 0) / totalShares;

        const level = weightedCurrent * 100;
        const changePct = weightedPrevious > 0 ? ((weightedCurrent - weightedPrevious) / weightedPrevious) * 100 : 0;
        const marketCap = constituents.reduce((sum, row) => sum + row.marketCap, 0);

        return [{
            key: `${code}${componentCount}`,
            name: `${code} ${componentCount}`,
            component_count: componentCount,
            level: Number(level.toFixed(2)),
            change_pct: Number(changePct.toFixed(4)),
            market_cap: Number(marketCap.toFixed(2))
        }];
    });
};

const participantBootstrapInFlight = new Set();
const structureBootstrapInFlight = new Set();
const buildCapacityPlayerFilter = (worldId, additionalFilter = {}) => ({
    world_id: worldId,
    ...additionalFilter,
    $or: [
        { counts_toward_capacity: true },
        { is_bot: { $ne: true }, counts_toward_capacity: { $exists: false } }
    ]
});

const scheduleWorldParticipantsBootstrap = (worldId) => {
    const normalizedWorldId = Number(worldId || 0);
    if (!Number.isInteger(normalizedWorldId) || normalizedWorldId <= 0) return;
    if (participantBootstrapInFlight.has(normalizedWorldId)) return;

    participantBootstrapInFlight.add(normalizedWorldId);
    setImmediate(async () => {
        try {
            const database = db.getDb();
            await ensureWorldAnchorCompanies(database, normalizedWorldId, null);
            await ensureWorldBots(database, normalizedWorldId, null);
            await syncWorldAssets(database, normalizedWorldId, null);
        } catch (error) {
            console.error(`World participant bootstrap failed for world ${normalizedWorldId}:`, error);
        } finally {
            participantBootstrapInFlight.delete(normalizedWorldId);
        }
    });
};

const scheduleWorldStructureBootstrap = (worldId) => {
    const normalizedWorldId = Number(worldId || 0);
    if (!Number.isInteger(normalizedWorldId) || normalizedWorldId <= 0) return;
    if (structureBootstrapInFlight.has(normalizedWorldId)) return;

    structureBootstrapInFlight.add(normalizedWorldId);
    setImmediate(async () => {
        try {
            const database = db.getDb();
            await ensureWorldStockMarkets(database, normalizedWorldId, null);
            scheduleWorldParticipantsBootstrap(normalizedWorldId);
        } catch (error) {
            console.error(`World structure bootstrap failed for world ${normalizedWorldId}:`, error);
        } finally {
            structureBootstrapInFlight.delete(normalizedWorldId);
        }
    });
};

const syncWorldPlayerCount = async (database, worldId, session) => {
    await database.collection('world_players').updateMany(
        { world_id: worldId, is_bot: { $ne: true }, counts_toward_capacity: { $exists: false } },
        { $set: { counts_toward_capacity: true } },
        { session }
    );

    const count = await database.collection('world_players').countDocuments(
        buildCapacityPlayerFilter(worldId),
        { session }
    );
    await database.collection('worlds').updateOne({ id: worldId }, { $set: { current_players: count } }, { session });
};

const buildBotProfile = (worldId, botSerial) => {
    const style = BOT_PLAYSTYLE_LIBRARY[(worldId + botSerial) % BOT_PLAYSTYLE_LIBRARY.length];
    const tradePace = ['slow', 'steady', 'fast'][(worldId + botSerial) % 3];
    return {
        ...style,
        profile_version: 1,
        trade_pace: tradePace,
        risk_scalar: Number((0.45 + ((botSerial % 8) * 0.1)).toFixed(2)),
        rebalance_bias: Number((0.2 + ((botSerial % 7) * 0.08)).toFixed(2))
    };
};

const ensureWorldBots = async (database, worldId, session) => {
    const world = await database.collection('worlds').findOne({ id: worldId }, { session });
    if (!world) return;

    const currentPlayerCount = await database.collection('world_players').countDocuments(
        buildCapacityPlayerFilter(worldId),
        { session }
    );
    const existingBotCount = await database.collection('world_players').countDocuments({ world_id: worldId, is_bot: true, bot_role: "trader" }, { session });

    const targetBotCount = 10 + (worldId % 11);
    const availableSlots = Math.max(0, Number(world.max_players || 500) - currentPlayerCount);
    const botsToCreate = Math.max(0, Math.min(targetBotCount - existingBotCount, availableSlots));

    for (let index = 0; index < botsToCreate; index += 1) {
        const botSerial = existingBotCount + index + 1;
        const profile = buildBotProfile(worldId, botSerial);
        const username = `BOT-W${worldId}-${String(botSerial).padStart(3, '0')}`;
        const email = `bot.w${worldId}.${String(botSerial).padStart(3, '0')}@marketworld.local`;
        const startingCash = 150000.00;

        let user = await database.collection('users').findOne({ username }, { session });
        if (!user) {
            const userId = await db.getNextId('users');
            await database.collection('users').insertOne({
                id: userId,
                username,
                email,
                password_hash: 'BOT_ACCOUNT_LOCKED',
                current_world_id: worldId,
                is_bot: true,
                created_at: new Date().toISOString()
            }, { session });
            user = { id: userId };
        } else {
            await database.collection('users').updateOne({ id: user.id }, { $set: { current_world_id: worldId, is_bot: true } }, { session });
        }

        const playerExists = await database.collection('world_players').findOne({ user_id: user.id, world_id: worldId }, { session });
        if (!playerExists) {
            const playerId = await db.getNextId('world_players');
            await database.collection('world_players').insertOne({
                id: playerId,
                user_id: user.id,
                world_id: worldId,
                cash_balance: startingCash,
                net_worth: startingCash,
                is_bot: true,
                bot_role: "trader",
                counts_toward_capacity: true,
                bot_profile_json: JSON.stringify(profile)
            }, { session });
        }
    }

    await syncWorldPlayerCount(database, worldId, session);
};

const ensureWorldCountryRelations = async (database, worldId, session) => {
    const states = await database.collection('country_states').find({ world_id: worldId }, { session }).toArray();
    for (let i = 0; i < states.length; i++) {
        for (let j = i + 1; j < states.length; j++) {
            const cs_a = states[i];
            const cs_b = states[j];
            
            const ca_id = cs_a.country_id < cs_b.country_id ? cs_a.country_id : cs_b.country_id;
            const cb_id = cs_a.country_id < cs_b.country_id ? cs_b.country_id : cs_a.country_id;

            const rawScore = 20 + (((ca_id * 17) + (cb_id * 31) + (worldId * 13)) % 121) - 60;
            const score = Math.max(-70, Math.min(80, rawScore));

            let level = "critical";
            if (score >= 65) level = "allied";
            else if (score >= 35) level = "friendly";
            else if (score >= 5) level = "neutral";
            else if (score >= -20) level = "strained";
            else if (score >= -55) level = "hostile";

            const relationId = await db.getNextId('country_relations');
            await database.collection('country_relations').updateOne(
                { world_id: worldId, country_a_id: ca_id, country_b_id: cb_id },
                {
                    $setOnInsert: {
                        id: relationId,
                        relation_score: score,
                        relation_level: level,
                        last_incident_tick: -1
                    }
                },
                { session, upsert: true }
            );
        }
    }
};

const ensureCorporateControllerPlayer = async (database, worldId, market, startingCash, session) => {
    const marketToken = String(market.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const username = `CORP-${marketToken}-W${worldId}`;
    const email = `corp.${marketToken.toLowerCase()}.w${worldId}@marketworld.local`;

    let user = await database.collection('users').findOne({ username }, { session });
    if (!user) {
        const userId = await db.getNextId('users');
        await database.collection('users').insertOne({
            id: userId, username, email, password_hash: 'BOT_ACCOUNT_LOCKED', current_world_id: worldId, is_bot: true, created_at: new Date().toISOString()
        }, { session });
        user = { id: userId };
    } else {
        await database.collection('users').updateOne({ id: user.id }, { $set: { current_world_id: worldId, is_bot: true } }, { session });
    }

    const controllerProfile = { archetype: 'market_corporate_controller', strategy: 'non-trader', market_code: market.code, profile_version: 1 };
    
    let player = await database.collection('world_players').findOne({ user_id: user.id, world_id: worldId }, { session });
    if (!player) {
        const playerId = await db.getNextId('world_players');
        await database.collection('world_players').insertOne({
            id: playerId, user_id: user.id, world_id: worldId, cash_balance: startingCash, net_worth: startingCash, is_bot: true, bot_role: "market_corporate", counts_toward_capacity: false, bot_profile_json: JSON.stringify(controllerProfile)
        }, { session });
        return playerId;
    }
    return player.id;
};

const ensureWorldAnchorCompanies = async (database, worldId, session) => {
    const world = await database.collection('worlds').findOne({ id: worldId }, { session });
    if (!world) return false;

    const markets = await database.collection('stock_markets').find({ world_id: worldId, is_active: true }, { session }).sort({ id: 1 }).toArray();
    if (markets.length === 0) return false;

    const sectors = await database.collection('sectors').find({}, { session }).toArray();
    if (sectors.length === 0) return false;

    const sectorIdByName = new Map(sectors.map((row) => [String(row.name), Number(row.id)]));
    const fallbackSectorId = Number(sectors[0].id);

    const existingCompanies = await database.collection('companies').find({ world_id: worldId }, { session }).toArray();
    const existingTickers = new Set(existingCompanies.map((row) => String(row.ticker || '').toUpperCase()));
    const existingShareAssets = await database.collection('assets').find({ world_id: worldId, asset_type: "share" }, { session }).toArray();
    const existingShareSymbols = new Set(existingShareAssets.map((row) => String(row.symbol || '').toUpperCase()));
    let createdAny = false;

    const botCashFloor = Math.max(Number(world.starting_cash || 100000) * 320, 3000000);

    for (const market of markets) {
        const controllerPlayerId = await ensureCorporateControllerPlayer(database, worldId, market, botCashFloor, session);
        if (!controllerPlayerId) continue;

        const symbols = REAL_COMPANIES_BY_MARKET[String(market.code || '').toUpperCase()] || [];
        for (const symbolRaw of symbols) {
            const ticker = buildAnchorTicker(symbolRaw);
            if (existingTickers.has(ticker) || existingShareSymbols.has(ticker)) continue;

            const sectorId = Number(sectorIdByName.get('Technology') || fallbackSectorId);
            const benchmarkScale = clamp(Number(market.benchmark_level || 1000) / 10000, 0.35, 5.0);
            const baselineCap = Math.max(Number(market.min_listing_capital || 500000) * 2.6, 1200000);
            const targetMarketCap = baselineCap * benchmarkScale;
            const totalShares = Math.max(120000, Math.floor((300000 * (0.75 + (benchmarkScale * 0.22))) + ((Number(market.id) % 9) * 4500)));
            const apiPrice = await resolveSeedPrice(ticker, targetMarketCap / totalShares, { allowRemote: false });
            const sharePrice = Math.max(0.5, apiPrice);
            const treasury = Math.max(600000, targetMarketCap * 1.05);
            const listedShares = Math.max(1000, Math.floor(totalShares * 0.38));
            const listingPrice = Math.max(0.5, sharePrice * 1.012);
            const companyName = `${ticker} Holdings`;

            const companyId = await db.getNextId('companies');
            const shareAssetId = await db.getNextId('assets');

            await database.collection('assets').insertOne({
                id: shareAssetId, world_id: worldId, asset_type: "share", name: companyName, symbol: ticker, current_price: sharePrice, available_quantity: listedShares, is_active: true
            }, { session });

            await database.collection('companies').insertOne({
                id: companyId, world_id: worldId, owner_player_id: controllerPlayerId, sector_id: sectorId, stock_market_id: market.id, asset_id: shareAssetId, name: companyName, ticker, description: `Real-market inspired listing for ${ticker} on ${market.name} (${market.city})`, total_shares: totalShares, shares_in_market: listedShares, treasury, share_price: sharePrice, risk_level: 'moderate', growth_strategy: 'diversified', dividend_policy: 'low', is_listed: true, is_active: true, created_at: new Date().toISOString()
            }, { session });

            let portfolio = await database.collection('portfolio').findOne({ player_id: controllerPlayerId, asset_type: "share", asset_id: shareAssetId }, { session });
            if (portfolio) {
                await database.collection('portfolio').updateOne({ id: portfolio.id }, { $set: { quantity: totalShares, avg_buy_price: sharePrice } }, { session });
            } else {
                const portfolioId = await db.getNextId('portfolio');
                await database.collection('portfolio').insertOne({
                    id: portfolioId, player_id: controllerPlayerId, asset_type: "share", asset_id: shareAssetId, quantity: totalShares, avg_buy_price: sharePrice
                }, { session });
            }

            const orderId = await db.getNextId('order_book');
            await database.collection('order_book').insertOne({
                id: orderId, world_id: worldId, player_id: controllerPlayerId, order_type: "sell", asset_type: "share", asset_id: shareAssetId, stock_market_id: market.id, quantity: listedShares, price_per_unit: listingPrice, filled_quantity: 0, status: "open", created_at: new Date().toISOString()
            }, { session });

            existingTickers.add(ticker);
            existingShareSymbols.add(ticker);
            createdAny = true;
        }
    }
    return createdAny;
};
const seedCountries = async (database, session) => {
    for (const country of WORLD_COUNTRIES) {
        const existing = await database.collection('countries').findOne({ code: country.code }, { session });
        if (!existing) {
            const cId = await db.getNextId('countries');
            await database.collection('countries').insertOne({
                id: cId,
                code: country.code,
                name: country.name,
                continent: country.continent,
                latitude: country.latitude,
                longitude: country.longitude
            }, { session });
        } else if (existing.id === null || existing.id === undefined) {
            const cId = await db.getNextId('countries');
            await database.collection('countries').updateOne({ _id: existing._id }, {
                $set: { 
                    id: cId,
                    name: country.name, 
                    continent: country.continent, 
                    latitude: country.latitude, 
                    longitude: country.longitude 
                }
            }, { session });
        } else {
            await database.collection('countries').updateOne({ id: existing.id }, {
                $set: { name: country.name, continent: country.continent, latitude: country.latitude, longitude: country.longitude }
            }, { session });
        }
    }
};

const seedWorldStockMarkets = async (database, worldId, session) => {
    await seedCountries(database, session);
    const canonicalCodes = new Set(WORLD_MARKETS.map((market) => String(market.code || '').toUpperCase()));

    for (const market of WORLD_MARKETS) {
        const country = await database.collection('countries').findOne({ code: market.countryCode }, { session });
        if (!country) continue;

        const existing = await database.collection('stock_markets').findOne({ world_id: worldId, code: market.code }, { session });
        if (!existing) {
            const smId = await db.getNextId('stock_markets');
            await database.collection('stock_markets').insertOne({
                id: smId, world_id: worldId, country_id: country.id, code: market.code, name: market.name, city: market.city, latitude: market.latitude, longitude: market.longitude, currency: market.currency, benchmark_name: market.benchmarkName, benchmark_level: market.benchmarkLevel, min_listing_capital: market.minListingCapital, listing_tier: market.listingTier, is_active: true
            }, { session });
        } else {
            await database.collection('stock_markets').updateOne({ id: existing.id }, {
                $set: { country_id: country.id, name: market.name, city: market.city, latitude: market.latitude, longitude: market.longitude, currency: market.currency, benchmark_name: market.benchmarkName, benchmark_level: market.benchmarkLevel, min_listing_capital: market.minListingCapital, listing_tier: market.listingTier, is_active: true }
            }, { session });
        }
    }

    const deprecatedCodes = await database.collection('stock_markets').find(
        { world_id: worldId, code: { $nin: Array.from(canonicalCodes) }, is_active: true },
        { session }
    ).toArray();
    if (deprecatedCodes.length > 0) {
        await database.collection('stock_markets').updateMany(
            { world_id: worldId, code: { $nin: Array.from(canonicalCodes) } },
            { $set: { is_active: false } },
            { session }
        );
    }
};

const ensureWorldCountryStates = async (database, worldId, session) => {
    const markets = await database.collection('stock_markets').find({ world_id: worldId }, { session }).toArray();
    const processedCountries = new Set();
    
    for (const sm of markets) {
        if (processedCountries.has(sm.country_id)) continue;
        processedCountries.add(sm.country_id);
        
        const existing = await database.collection('country_states').findOne({ world_id: worldId, country_id: sm.country_id }, { session });
        if (!existing) {
            const csId = await db.getNextId('country_states');
            await database.collection('country_states').insertOne({
                id: csId,
                world_id: worldId,
                country_id: sm.country_id,
                treasury: 165000 + ((sm.country_id % 9) * 14000),
                tax_rate: 0.1100 + ((sm.country_id % 6) * 0.0100),
                stability: Math.min(0.9500, 0.6200 + ((sm.country_id % 7) * 0.0450)),
                defense_strength: 420.00 + ((sm.country_id % 11) * 45.00),
                gdp: 78000.00 + ((sm.country_id % 13) * 13500.00),
                population: 900000 + ((sm.country_id % 17) * 150000),
                is_insolvent: false,
                is_active: true
            }, { session });
        } else {
            await database.collection('country_states').updateOne({ id: existing.id }, { $set: { is_active: true } }, { session });
        }
    }
};

const seedWorldSovereignBonds = async (database, worldId, session) => {
    const states = await database.collection('country_states').find({ world_id: worldId }, { session }).toArray();
    for (const cs of states) {
        const country = await database.collection('countries').findOne({ id: cs.country_id }, { session });
        if (!country) continue;
        
        const existing = await database.collection('bonds').findOne({ world_id: worldId, country_id: cs.country_id }, { session });
        if (!existing) {
            const bId = await db.getNextId('bonds');
            const interest = Math.max(0.0180, Math.min(0.1650, 0.0180 + ((((90 + ((cs.country_id % 8) * 40)) - 45) / 415) * 0.1470)));
            const maturity = 90 + ((cs.country_id % 8) * 40);
            let symbol = null;
            for (let attempt = 0; attempt < 12; attempt += 1) {
                const suffix = attempt === 0 ? '' : String.fromCharCode(64 + attempt);
                const candidate = `${country.code}SB${String(bId).padStart(4, '0')}${suffix}`.slice(0, 20);
                const symbolExists = await database.collection('bonds').findOne({ world_id: worldId, symbol: candidate }, { session });
                if (!symbolExists) {
                    symbol = candidate;
                    break;
                }
            }
            if (!symbol) continue;
             
            await database.collection('bonds').insertOne({
                id: bId,
                world_id: worldId,
                government_id: null,
                country_id: cs.country_id,
                asset_id: -bId,
                name: `${country.name} Sovereign Bond`,
                symbol,
                face_value: 100.0000,
                current_value: 100.0000,
                interest_rate: interest,
                maturity_ticks: maturity,
                ticks_remaining: maturity,
                total_issued: 350 + (cs.population % 500),
                is_active: true
            }, { session });
        }
    }
};

const syncWorldAssets = async (database, worldId, session) => {
    const commodities = await database.collection('commodities').find({ world_id: worldId }, { session }).toArray();
    for (const c of commodities) {
        if (!c.asset_id) {
            const aId = await db.getNextId('assets');
            await database.collection('assets').insertOne({ id: aId, world_id: worldId, asset_type: "commodity", name: c.name, symbol: c.symbol, current_price: c.current_price, available_quantity: c.total_supply, is_active: true }, { session });
            await database.collection('commodities').updateOne({ id: c.id }, { $set: { asset_id: aId } }, { session });
        } else {
            await database.collection('assets').updateOne({ id: c.asset_id }, { $set: { name: c.name, symbol: c.symbol, current_price: c.current_price, available_quantity: c.total_supply, is_active: true } }, { session });
        }
    }

    const cryptos = await database.collection('cryptos').find({ world_id: worldId }, { session }).toArray();
    for (const c of cryptos) {
        if (!c.asset_id) {
            const aId = await db.getNextId('assets');
            await database.collection('assets').insertOne({ id: aId, world_id: worldId, asset_type: "crypto", name: c.name, symbol: c.symbol, current_price: c.current_price, available_quantity: c.circulating_supply, is_active: true }, { session });
            await database.collection('cryptos').updateOne({ id: c.id }, { $set: { asset_id: aId } }, { session });
        } else {
            await database.collection('assets').updateOne({ id: c.asset_id }, { $set: { name: c.name, symbol: c.symbol, current_price: c.current_price, available_quantity: c.circulating_supply, is_active: true } }, { session });
        }
    }

    const bonds = await database.collection('bonds').find({ world_id: worldId }, { session }).toArray();
    for (const b of bonds) {
        const symbol = b.symbol || `BND${b.id}`;
        if (!b.symbol) await database.collection('bonds').updateOne({ id: b.id }, { $set: { symbol } }, { session });
        
        if (!b.asset_id || Number(b.asset_id) <= 0) {
            const aId = await db.getNextId('assets');
            await database.collection('assets').insertOne({ id: aId, world_id: worldId, asset_type: "bond", name: b.name, symbol, current_price: b.current_value, available_quantity: b.total_issued, is_active: b.is_active }, { session });
            await database.collection('bonds').updateOne({ id: b.id }, { $set: { asset_id: aId } }, { session });
        } else {
            // Only sync is_active from bond to asset — never set active bond's asset to inactive
            // (the asset may have been incorrectly deactivated by a previous sync)
            const assetIsActive = b.is_active; // if bond is inactive (matured/defaulted), asset should be too
            await database.collection('assets').updateOne(
                { id: b.asset_id },
                { $set: { name: b.name, symbol, current_price: b.current_value, available_quantity: b.total_issued, is_active: assetIsActive } },
                { session }
            );
        }
    }

    const companies = await database.collection('companies').find({ world_id: worldId }, { session }).toArray();
    for (const c of companies) {
        if (!c.asset_id) {
            const aId = await db.getNextId('assets');
            await database.collection('assets').insertOne({ id: aId, world_id: worldId, asset_type: "share", name: c.name, symbol: c.ticker, current_price: c.share_price, available_quantity: 0, is_active: c.is_active }, { session });
            await database.collection('companies').updateOne({ id: c.id }, { $set: { asset_id: aId } }, { session });
        } else {
            const orders = await database.collection('order_book').find({ world_id: worldId, asset_type: "share", asset_id: c.asset_id, order_type: "sell", status: { $in: ["open", "partial"] } }, { session }).toArray();
            const availableQty = orders.reduce((sum, o) => sum + (Number(o.quantity) - Number(o.filled_quantity || 0)), 0);
            await database.collection('assets').updateOne({ id: c.asset_id }, { $set: { name: c.name, symbol: c.ticker, current_price: c.share_price, available_quantity: availableQty, is_active: c.is_active } }, { session });
        }
    }
};

const ensureWorldStockMarkets = async (database, worldId, session) => {
    const markets = await database.collection('stock_markets').find({ world_id: worldId }, { session }).toArray();
    const missingCoords = markets.some(m => m.latitude == null || m.longitude == null);

    if (markets.length < WORLD_MARKETS.length || missingCoords) {
        await seedWorldStockMarkets(database, worldId, session);
    }

    await ensureWorldCountryStates(database, worldId, session);
    await ensureWorldCountryRelations(database, worldId, session);
    await seedWorldSovereignBonds(database, worldId, session);

    // ensure all companies have a default market if null AND are listed
    const firstMarket = await database.collection('stock_markets').findOne({ world_id: worldId }, { sort: { id: 1 }, session });
    if (firstMarket) {
        // Only assign market to anchor companies (is_listed should be true for them)
        await database.collection('companies').updateMany(
            { world_id: worldId, stock_market_id: null, is_listed: true },
            { $set: { stock_market_id: firstMarket.id } },
            { session }
        );
    }

    const companies = await database.collection('companies').find({ world_id: worldId }, { session }).toArray();
    for (const c of companies) {
        await database.collection('order_book').updateMany({ world_id: worldId, asset_type: "share", asset_id: c.asset_id, stock_market_id: null }, { $set: { stock_market_id: c.stock_market_id } }, { session });
    }

    await syncWorldAssets(database, worldId, session);
};

const bootstrapWorldEconomy = async (database, worldId, session) => {
    const commodities = [
        { name: "Crude Oil", symbol: "OIL", base_price: 75.0, current_price: 75.0, supply_rate: 180.0, total_supply: 4500.0, volatility: 0.12 },
        { name: "Wheat", symbol: "WHT", base_price: 6.5, current_price: 6.5, supply_rate: 400.0, total_supply: 10000.0, volatility: 0.04 },
        { name: "Gold", symbol: "GLD", base_price: 1950.0, current_price: 1950.0, supply_rate: 15.0, total_supply: 350.0, volatility: 0.08 },
        { name: "Natural Gas", symbol: "GAS", base_price: 2.75, current_price: 2.75, supply_rate: 280.0, total_supply: 8000.0, volatility: 0.11 }
    ];
    for (const c of commodities) {
        const cId = await db.getNextId('commodities');
        await database.collection('commodities').insertOne({ id: cId, world_id: worldId, ...c }, { session });
    }

    const cryptos = [
        { name: "ByteCoin", symbol: "BYT", current_price: 240.0, max_supply: 21000000.0, circulating_supply: 8000000.0, volatility: 0.25 },
        { name: "NexaToken", symbol: "NXA", current_price: 12.5, max_supply: 100000000.0, circulating_supply: 42000000.0, volatility: 0.30 },
        { name: "AuroraCoin", symbol: "ARC", current_price: 500.0, max_supply: 5000000.0, circulating_supply: 1800000.0, volatility: 0.20 }
    ];
    for (const c of cryptos) {
        const cId = await db.getNextId('cryptos');
        await database.collection('cryptos').insertOne({ id: cId, world_id: worldId, ...c }, { session });
    }

    await seedWorldStockMarkets(database, worldId, session);
    await ensureWorldCountryStates(database, worldId, session);
    await ensureWorldCountryRelations(database, worldId, session);
    await seedWorldSovereignBonds(database, worldId, session);
    await syncWorldAssets(database, worldId, session);
};

const fetchWorldsWithStats = async () => {
    const database = db.getDb();
    const worlds = await database.collection('worlds').find({ status: "active" }).sort({ created_at: -1 }).toArray();

    for (const w of worlds) {
        const worldId = w.id;
        const [companyCount, governmentCount, stockMarketCount, assetCount, totalAssetValueAgg, companyBucketAgg, activePlayerCount] = await Promise.all([
            database.collection('companies').countDocuments({ world_id: worldId, is_active: true }),
            database.collection('country_states').countDocuments({ world_id: worldId, is_active: true }),
            database.collection('stock_markets').countDocuments({ world_id: worldId, is_active: true }),
            database.collection('assets').countDocuments({ world_id: worldId, is_active: true }),
            database.collection('assets').aggregate([
                { $match: { world_id: worldId, is_active: true } },
                { $group: { _id: null, total: { $sum: { $multiply: [{ $ifNull: ['$current_price', 0] }, { $ifNull: ['$available_quantity', 0] }] } } } }
            ]).toArray(),
            database.collection('companies').aggregate([
                { $match: { world_id: worldId, is_active: true } },
                { $project: { market_cap: { $multiply: [{ $ifNull: ['$share_price', 0] }, { $ifNull: ['$total_shares', 0] }] } } },
                {
                    $group: {
                        _id: null,
                        micro_count: { $sum: { $cond: [{ $lt: ['$market_cap', 1000] }, 1, 0] } },
                        small_count: { $sum: { $cond: [{ $and: [{ $gte: ['$market_cap', 1000] }, { $lt: ['$market_cap', 10000] }] }, 1, 0] } },
                        mid_count: { $sum: { $cond: [{ $and: [{ $gte: ['$market_cap', 10000] }, { $lt: ['$market_cap', 100000] }] }, 1, 0] } },
                        large_count: { $sum: { $cond: [{ $and: [{ $gte: ['$market_cap', 100000] }, { $lt: ['$market_cap', 1000000] }] }, 1, 0] } },
                        mega_count: { $sum: { $cond: [{ $gte: ['$market_cap', 1000000] }, 1, 0] } }
                    }
                }
            ]).toArray(),
            database.collection('world_players').countDocuments(buildCapacityPlayerFilter(worldId))
        ]);

        w.current_players = Number(activePlayerCount || 0);
        w.company_count = companyCount;
        w.government_count = governmentCount;
        w.stock_market_count = stockMarketCount;
        w.asset_count = assetCount;
        w.total_asset_value = Number(totalAssetValueAgg[0]?.total || 0);
        w.micro_count = Number(companyBucketAgg[0]?.micro_count || 0);
        w.small_count = Number(companyBucketAgg[0]?.small_count || 0);
        w.mid_count = Number(companyBucketAgg[0]?.mid_count || 0);
        w.large_count = Number(companyBucketAgg[0]?.large_count || 0);
        w.mega_count = Number(companyBucketAgg[0]?.mega_count || 0);
    }
    return worlds;
};

const listWorlds = async (req, res) => {
    try {
        let worlds = await fetchWorldsWithStats();

        const needsNewWorld = worlds.length === 0 || worlds.every(w => w.current_players >= w.max_players);

        if (needsNewWorld) {
            let createdWorldId = null;
            await db.withTransaction(async (session) => {
                const database = db.getDb();
                const nextWorldNum = worlds.length + 1;
                const newWorldName = `World Alpha ${nextWorldNum}`;
                
                const worldId = await db.getNextId('worlds');
                createdWorldId = worldId;
                await database.collection('worlds').insertOne({
                    id: worldId,
                    name: newWorldName,
                    description: `Automatically generated world ${nextWorldNum}`,
                    max_players: 500,
                    starting_cash: 100000.00,
                    tick_rate_seconds: 60,
                    status: "active",
                    current_tick: 0,
                    created_at: new Date().toISOString()
                }, { session });

                await bootstrapWorldEconomy(database, worldId, session);
            });
            scheduleWorldStructureBootstrap(createdWorldId);
            worlds = await fetchWorldsWithStats();
            return res.json({ worlds });
        }

        res.json({ worlds });
    } catch (error) {
        console.error('List worlds error:', error);
        if (error.stack) console.error(error.stack);
        res.status(500).json({ error: 'Internal server error', message: error.message, stack: error.stack });
    }
};

const joinWorld = async (req, res) => {
    try {
        const userId = req.user.id;
        const worldId = parseInt(req.params.id);

        if (!Number.isInteger(worldId)) {
            return res.status(400).json({ error: 'Invalid world id' });
        }

        let starting_cash = 0;
        await db.withTransaction(async (session) => {
            const database = db.getDb();

            const user = await database.collection('users').findOne({ id: userId }, { session });
            if (user.current_world_id) {
                if (user.current_world_id === worldId) throw new Error('You are already in this world');
                else throw new Error('You are already in another world. You must leave it first.');
            }

            const world = await database.collection('worlds').findOne({ id: worldId, status: "active" }, { session });
            if (!world) throw new Error('World not found or inactive');
            const activePlayerCount = await database.collection('world_players').countDocuments(
                buildCapacityPlayerFilter(worldId),
                { session }
            );
            if (activePlayerCount >= Number(world.max_players || 0)) throw new Error('World is full');

            starting_cash = world.starting_cash;
            const playerId = await db.getNextId('world_players');
            await database.collection('world_players').insertOne({
                id: playerId,
                user_id: userId,
                world_id: worldId,
                cash_balance: world.starting_cash,
                net_worth: world.starting_cash,
                counts_toward_capacity: true
            }, { session });

            await database.collection('users').updateOne({ id: userId }, { $set: { current_world_id: worldId } }, { session });
            await syncWorldPlayerCount(database, worldId, session);
        });

        scheduleWorldStructureBootstrap(worldId);

        res.json({ message: 'Successfully joined world', starting_cash });
    } catch (error) {
        console.error('Join world error:', error);
        res.status(error.message.includes('already in') ? 400 : 500).json({ error: error.message || 'Internal server error' });
    }
};

const leaveWorld = async (req, res) => {
    try {
        const userId = req.user.id;
        
        await db.withTransaction(async (session) => {
            const database = db.getDb();
            const user = await database.collection('users').findOne({ id: userId }, { session });
            const worldId = user.current_world_id;
            if (!worldId) throw new Error('You are not in any world');

            const player = await database.collection('world_players').findOne({ user_id: userId, world_id: worldId }, { session });
            if (!player) throw new Error('Player record not found');
            const playerId = player.id;

            await database.collection('companies').updateMany({ owner_player_id: playerId }, { $set: { is_active: false } }, { session });
            const companies = await database.collection('companies').find({ owner_player_id: playerId }, { session }).toArray();
            for (const c of companies) {
                await database.collection('assets').updateOne({ id: c.asset_id }, { $set: { is_active: false, current_price: 0, available_quantity: 0 } }, { session });
            }

            await database.collection('order_book').deleteMany({ player_id: playerId }, { session });
            await database.collection('portfolio').deleteMany({ player_id: playerId }, { session });
            await database.collection('world_players').deleteOne({ id: playerId }, { session });

            await syncWorldPlayerCount(database, worldId, session);
            await database.collection('users').updateOne({ id: userId }, { $set: { current_world_id: null } }, { session });
        });

        res.json({ message: 'Successfully left the world and liquidated assets' });
    } catch (error) {
        console.error('Leave world error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
};

const getWorldStockMarkets = async (req, res) => {
    try {
        const worldId = parseInt(req.params.id, 10);
        if (!Number.isInteger(worldId)) return res.status(400).json({ error: 'Invalid world id' });

        scheduleWorldStructureBootstrap(worldId);

        const database = db.getDb();
        const world = await database.collection('worlds').findOne({ id: worldId }, { projection: { current_tick: 1 } });
        if (!world) return res.status(404).json({ error: 'World not found' });
        const currentTick = Number(world.current_tick || 0);
        const prevTick = currentTick > 0 ? currentTick - 1 : null;
        const rawMarkets = await database.collection('stock_markets').aggregate([
            { $match: { world_id: worldId, is_active: true } },
            { $lookup: { from: 'countries', localField: 'country_id', foreignField: 'id', as: 'country' } },
            { $unwind: { path: '$country', preserveNullAndEmptyArrays: true } }
        ]).toArray();

        // Use $ne: false so companies without the is_listed field (legacy) are also included
        const companies = await database.collection('companies').find({ world_id: worldId, is_active: true, is_listed: { $ne: false } }).toArray();
        const assetIds = companies.map((c) => c.asset_id).filter((id) => Number.isFinite(id));
        const prevPriceMap = new Map();

        if (assetIds.length > 0 && prevTick !== null) {
            const priceRows = await database.collection('price_history').find(
                {
                    world_id: worldId,
                    asset_type: 'share',
                    asset_id: { $in: assetIds },
                    world_tick: { $in: [currentTick, prevTick] }
                },
                { projection: { asset_id: 1, price: 1, world_tick: 1, id: 1 } }
            ).sort({ world_tick: -1, id: -1 }).toArray();

            for (const row of priceRows) {
                if (row.world_tick !== prevTick) continue;
                if (!prevPriceMap.has(row.asset_id)) {
                    prevPriceMap.set(row.asset_id, Number(row.price));
                }
            }
        }

        const companiesByMarket = new Map();
        for (const c of companies) {
            if (!c.stock_market_id) continue;
            
            const prevPrice = prevPriceMap.get(c.asset_id) ?? null;

            const cData = {
                stock_market_id: c.stock_market_id,
                share_price: c.share_price,
                total_shares: c.total_shares,
                market_cap: c.share_price * c.total_shares,
                prev_price: prevPrice
            };
            if (!companiesByMarket.has(c.stock_market_id)) companiesByMarket.set(c.stock_market_id, []);
            companiesByMarket.get(c.stock_market_id).push(cData);
        }

        const markets = rawMarkets.map(m => {
            const mComps = companiesByMarket.get(m.id) || [];
            const listedMarketCap = mComps.reduce((sum, c) => sum + c.market_cap, 0);
            
            return {
                id: m.id, world_id: m.world_id, code: m.code, name: m.name, city: m.city, currency: m.currency, benchmark_name: m.benchmark_name, benchmark_level: m.benchmark_level, min_listing_capital: m.min_listing_capital, listing_tier: m.listing_tier, is_active: m.is_active,
                country_code: m.country ? m.country.code : null,
                country_name: m.country ? m.country.name : null,
                continent: m.country ? m.country.continent : null,
                latitude: m.latitude != null ? m.latitude : (m.country ? m.country.latitude : null),
                longitude: m.longitude != null ? m.longitude : (m.country ? m.country.longitude : null),
                listed_market_cap: listedMarketCap,
                listed_company_count: mComps.length,
                indexes: buildStockMarketIndexes(mComps, m.code)
            };
        }).sort((a, b) => b.listed_market_cap - a.listed_market_cap || a.code.localeCompare(b.code));

        res.json({ markets });
    } catch (error) {
        console.error('Get world stock markets error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const getStockMarketListings = async (req, res) => {
    try {
        const worldId = parseInt(req.params.id, 10);
        const marketId = parseInt(req.params.marketId, 10);
        if (!Number.isInteger(worldId) || !Number.isInteger(marketId)) return res.status(400).json({ error: 'Invalid world id or market id' });

        const database = db.getDb();
        const world = await database.collection('worlds').findOne({ id: worldId }, { projection: { current_tick: 1 } });
        if (!world) return res.status(404).json({ error: 'World not found' });
        const currentTick = Number(world.current_tick || 0);
        const prevTick = currentTick > 0 ? currentTick - 1 : null;
        const market = await database.collection('stock_markets').findOne({ world_id: worldId, id: marketId, is_active: true });
        if (!market) return res.status(404).json({ error: 'Stock market not found in this world' });
        
        const country = await database.collection('countries').findOne({ id: market.country_id });
        const marketObj = {
            ...market,
            country_code: country ? country.code : null,
            country_name: country ? country.name : null,
            continent: country ? country.continent : null,
            latitude: market.latitude != null ? market.latitude : (country ? country.latitude : null),
            longitude: market.longitude != null ? market.longitude : (country ? country.longitude : null)
        };

        // Use $ne: false so companies without the is_listed field (legacy) are also included
        const companies = await database.collection('companies').find({ world_id: worldId, stock_market_id: marketId, is_active: true, is_listed: { $ne: false } }).toArray();
        const assetIds = companies.map((c) => c.asset_id).filter((id) => Number.isFinite(id));
        const prevPriceMap = new Map();

        if (assetIds.length > 0 && prevTick !== null) {
            const priceRows = await database.collection('price_history').find(
                {
                    world_id: worldId,
                    asset_type: 'share',
                    asset_id: { $in: assetIds },
                    world_tick: { $in: [currentTick, prevTick] }
                },
                { projection: { asset_id: 1, price: 1, world_tick: 1, id: 1 } }
            ).sort({ world_tick: -1, id: -1 }).toArray();

            for (const row of priceRows) {
                if (row.world_tick !== prevTick) continue;
                if (!prevPriceMap.has(row.asset_id)) {
                    prevPriceMap.set(row.asset_id, Number(row.price));
                }
            }
        }

        const orders = await database.collection('order_book').find({ world_id: worldId, stock_market_id: marketId, asset_type: 'share', order_type: 'sell', status: { $in: ['open', 'partial'] } }).toArray();

        const rows = companies.map(c => {
            const prevPrice = prevPriceMap.get(c.asset_id) ?? null;
            const cOrders = orders.filter(o => o.asset_id === c.asset_id);
            const sharesForSale = cOrders.reduce((sum, o) => sum + (Number(o.quantity) - Number(o.filled_quantity || 0)), 0);
            const bestAsk = cOrders.length > 0 ? Math.min(...cOrders.map(o => o.price_per_unit)) : c.share_price;

            return {
                company_id: c.id,
                asset_id: c.asset_id,
                company_name: c.name,
                ticker: c.ticker,
                share_price: c.share_price,
                total_shares: c.total_shares,
                shares_in_market: c.shares_in_market,
                market_cap: c.share_price * c.total_shares,
                prev_price: prevPrice,
                shares_for_sale: sharesForSale,
                sell_order_count: cOrders.length,
                best_ask_price: bestAsk
            };
        }).sort((a, b) => b.shares_for_sale - a.shares_for_sale || b.market_cap - a.market_cap || a.company_name.localeCompare(b.company_name));

        const indexes = buildStockMarketIndexes(rows, marketObj.code);
        marketObj.indexes = indexes;

        res.json({ market: marketObj, indexes, listings: rows });
    } catch (error) {
        console.error('Get stock market listings error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const getCountryMacroIndicators = async (req, res) => {
    try {
        const worldId = parseInt(req.params.id, 10);
        if (!Number.isInteger(worldId)) return res.status(400).json({ error: 'Invalid world id' });

        const database = db.getDb();
        const world = await database.collection('worlds').findOne({ id: worldId });
        if (!world) return res.status(404).json({ error: 'World not found' });
        const currentTick = world.current_tick || 0;

        const states = await database.collection('country_states').aggregate([
            { $match: { world_id: worldId, is_active: true } },
            { $lookup: { from: 'countries', localField: 'country_id', foreignField: 'id', as: 'country' } },
            { $unwind: { path: '$country', preserveNullAndEmptyArrays: true } }
        ]).sort({ "country.name": 1 }).toArray();

        const stockMarkets = await database.collection('stock_markets').find({ world_id: worldId, is_active: true }).toArray();
        const companies = await database.collection('companies').find({ world_id: worldId, is_active: true }).toArray();

        const activeConflicts = await database.collection('country_conflicts').find({ world_id: worldId, status: 'active' }).toArray();
        const activeConflictsByCountry = new Map();
        for (const c of activeConflicts) {
            activeConflictsByCountry.set(c.aggressor_country_id, (activeConflictsByCountry.get(c.aggressor_country_id) || 0) + 1);
            activeConflictsByCountry.set(c.defender_country_id, (activeConflictsByCountry.get(c.defender_country_id) || 0) + 1);
        }

        const relations = await database.collection('country_relations').aggregate([
            { $match: { world_id: worldId } },
            { $lookup: { from: 'countries', localField: 'country_a_id', foreignField: 'id', as: 'ca' } },
            { $lookup: { from: 'countries', localField: 'country_b_id', foreignField: 'id', as: 'cb' } },
            { $unwind: { path: '$ca', preserveNullAndEmptyArrays: true } },
            { $unwind: { path: '$cb', preserveNullAndEmptyArrays: true } }
        ]).toArray();

        const relationStatsByCountry = new Map();
        for (const rel of relations) {
            const relationScore = Number(rel.relation_score || 0);
            const relationLevel = String(rel.relation_level || 'neutral').toLowerCase();
            const lastIncidentTick = Number(rel.last_incident_tick || -1);
            const isRecentIncident = lastIncidentTick >= Math.max(0, currentTick - RELATION_INCIDENT_LOOKBACK_TICKS);

            const processSide = (myId, otherId, otherCode, otherName) => {
                if (!relationStatsByCountry.has(myId)) {
                    relationStatsByCountry.set(myId, { relationCount: 0, totalScore: 0, allied_count: 0, friendly_count: 0, neutral_count: 0, strained_count: 0, hostile_count: 0, critical_count: 0, recentIncidents: 0, highTensionRelations: [] });
                }
                const stats = relationStatsByCountry.get(myId);
                stats.relationCount++;
                stats.totalScore += relationScore;
                if (stats[`${relationLevel}_count`] !== undefined) stats[`${relationLevel}_count`]++;
                else stats.neutral_count++;
                if (isRecentIncident) stats.recentIncidents++;
                stats.highTensionRelations.push({ country_id: otherId, country_name: otherName, country_code: otherCode, relation_level: relationLevel, relation_score: relationScore, last_incident_tick: lastIncidentTick });
            };
            
            if (rel.country_a_id) processSide(rel.country_a_id, rel.country_b_id, rel.cb?.code, rel.cb?.name);
            if (rel.country_b_id) processSide(rel.country_b_id, rel.country_a_id, rel.ca?.code, rel.ca?.name);
        }

        for (const stats of relationStatsByCountry.values()) {
            stats.highTensionRelations = stats.highTensionRelations.sort((a, b) => a.relation_score - b.relation_score || b.last_incident_tick - a.last_incident_tick).slice(0, 4);
        }

        const lookbackTick = Math.max(currentTick - 12, 0);
        const events = await database.collection('world_events').find({ world_id: worldId, event_tick: { $gte: lookbackTick } }).sort({ event_tick: -1, id: -1 }).limit(320).toArray();

        const countryShockMap = new Map();
        let globalShock = 0;

        for (const event of events) {
            const eventType = String(event.event_type || '').toLowerCase();
            const severityKey = String(event.severity || 'moderate').toLowerCase();
            const baseMagnitude = EVENT_SEVERITY_SHOCK[severityKey] || EVENT_SEVERITY_SHOCK.moderate;
            const eventTick = Number(event.event_tick || currentTick);
            const age = Math.max(0, currentTick - eventTick);
            const decay = Math.exp(-age / 6.5);
            const magnitude = baseMagnitude * decay;

            const effects = parseEffectsJson(event.effects_json);
            const impactedCountryIds = new Set();
            for (const key of ['country_id', 'country_a_id', 'country_b_id', 'aggressor_country_id', 'defender_country_id', 'winner_country_id', 'loser_country_id']) {
                const value = Number(effects[key]);
                if (Number.isInteger(value) && value > 0) impactedCountryIds.add(value);
            }

            let directionalBias = -1;
            if (eventType.match(/resolved|ceasefire|recovery|stability|boom|alliance/)) directionalBias = 1;

            if (eventType.match(/market_crash|yield_spike|panic/)) globalShock -= magnitude * 0.55;
            else if (eventType.match(/economic_boom|relief|rally/)) globalShock += magnitude * 0.45;

            for (const countryId of impactedCountryIds) {
                const current = Number(countryShockMap.get(countryId) || 0);
                countryShockMap.set(countryId, clamp(current + (directionalBias * magnitude), -0.2, 0.2));
            }
        }
        globalShock = clamp(globalShock, -0.06, 0.06);

        const emptyRelationStats = { relationCount: 0, totalScore: 0, allied_count: 0, friendly_count: 0, neutral_count: 0, strained_count: 0, hostile_count: 0, critical_count: 0, recentIncidents: 0, highTensionRelations: [] };

        const rawIndicators = states.map(cs => {
            const countryId = cs.country_id;
            const cMarkets = stockMarkets.filter(sm => sm.country_id === countryId);
            const cMarketIds = new Set(cMarkets.map(m => m.id));
            const cComps = companies.filter(c => cMarketIds.has(c.stock_market_id));
            const equityMarketCap = cComps.reduce((sum, c) => sum + (c.share_price * c.total_shares), 0);

            const treasury = Number(cs.treasury || 0);
            const gdp = Number(cs.gdp || 0);
            const population = Number(cs.population || 0);
            const taxRate = Number(cs.tax_rate || 0);
            const stability = clamp(Number(cs.stability || 0.5), 0, 1);
            const defenseStrength = Number(cs.defense_strength || 0);
            const isInsolvent = Boolean(cs.is_insolvent);

            const reserveRatio = treasury / Math.max(gdp, 1);
            const gdpPerCapita = gdp / Math.max(population, 1);
            const marketDepthRatio = equityMarketCap / Math.max(gdp, 1);
            const activeConflicts = Number(activeConflictsByCountry.get(countryId) || 0);
            const localEventShock = clamp(Number(countryShockMap.get(countryId) || 0) + globalShock, -0.14, 0.14);
            const solvencyBuffer = clamp(treasury / Math.max((population * 0.02) + (defenseStrength * 10), 1), 0, 4);

            return {
                row: cs, countryId, treasury, gdp, population, taxRate, stability, defenseStrength, isInsolvent, reserveRatio, gdpPerCapita, marketDepthRatio, activeConflicts, localEventShock, solvencyBuffer, equityMarketCap, relationStats: relationStatsByCountry.get(countryId) || emptyRelationStats,
                cMarkets
            };
        });

        const reserveSeries = rawIndicators.map(e => e.reserveRatio).sort((a, b) => a - b);
        const stabilitySeries = rawIndicators.map(e => e.stability).sort((a, b) => a - b);
        const gdpPerCapitaSeries = rawIndicators.map(e => e.gdpPerCapita).sort((a, b) => a - b);
        const marketDepthSeries = rawIndicators.map(e => e.marketDepthRatio).sort((a, b) => a - b);
        const solvencySeries = rawIndicators.map(e => e.solvencyBuffer).sort((a, b) => a - b);

        const reserveLowerQuartile = calculateQuantile(reserveSeries, 0.25);
        const reserveMedian = calculateQuantile(reserveSeries, 0.5);
        const stabilityLowerQuartile = calculateQuantile(stabilitySeries, 0.25);

        const indicators = rawIndicators.map(entry => {
            const reservePercentile = calculatePercentileRank(reserveSeries, entry.reserveRatio);
            const stabilityPercentile = calculatePercentileRank(stabilitySeries, entry.stability);
            const gdpPerCapitaPercentile = calculatePercentileRank(gdpPerCapitaSeries, entry.gdpPerCapita);
            const marketDepthPercentile = calculatePercentileRank(marketDepthSeries, entry.marketDepthRatio);
            const solvencyPercentile = calculatePercentileRank(solvencySeries, entry.solvencyBuffer);

            const reserveAnchorScore = clamp(((entry.reserveRatio - 0.03) / 0.05) * 100, 0, 100);
            const stabilityAnchorScore = clamp(((entry.stability - 0.18) / 0.62) * 100, 0, 100);
            const taxBalanceScore = clamp(100 - ((Math.abs(entry.taxRate - 0.18) / 0.14) * 100), 0, 100);
            const solvencyAnchorScore = clamp((entry.solvencyBuffer / 2.4) * 100, 0, 100);
            const eventAnchorScore = clamp(50 + (entry.localEventShock * 220), 0, 100);
            const conflictAnchorScore = clamp(100 - (entry.activeConflicts * 26), 0, 100);

            const absoluteMacroScore = clamp(
                (stabilityAnchorScore * 0.30) + (reserveAnchorScore * 0.24) + (taxBalanceScore * 0.10) + (solvencyAnchorScore * 0.12) + (eventAnchorScore * 0.10) + (conflictAnchorScore * 0.14) - (entry.isInsolvent ? 9 : 0) - ((entry.reserveRatio < reserveLowerQuartile && entry.stability < stabilityLowerQuartile) ? 4 : 0), 0, 100
            );

            const relativeMacroScore = clamp(
                (reservePercentile * 27) + (stabilityPercentile * 24) + (gdpPerCapitaPercentile * 22) + (marketDepthPercentile * 17) + (solvencyPercentile * 10) + (entry.reserveRatio >= reserveMedian ? 4 : 0), 0, 100
            );

            const financialHealthScore = clamp((absoluteMacroScore * 0.72) + (relativeMacroScore * 0.28), 0, 100);

            const fiscalMomentum = clamp(
                ((reservePercentile - 0.5) * 0.95) + ((stabilityPercentile - 0.5) * 0.85) + ((solvencyPercentile - 0.5) * 0.55) + ((taxBalanceScore - 50) / 140) + (entry.localEventShock * 2.1) - (entry.activeConflicts * 0.07) - (entry.isInsolvent ? 0.15 : 0), -1, 1
            );

            const relationCount = Number(entry.relationStats.relationCount || 0);
            const relationAverageScore = relationCount > 0 ? (Number(entry.relationStats.totalScore || 0) / relationCount) : 0;
            const alliedRelations = Number(entry.relationStats.allied_count || 0);
            const friendlyRelations = Number(entry.relationStats.friendly_count || 0);
            const neutralRelations = Number(entry.relationStats.neutral_count || 0);
            const strainedRelations = Number(entry.relationStats.strained_count || 0);
            const hostileRelations = Number(entry.relationStats.hostile_count || 0);
            const criticalRelations = Number(entry.relationStats.critical_count || 0);
            const recentRelationIncidents = Number(entry.relationStats.recentIncidents || 0);

            const hostileCriticalRelations = hostileRelations + criticalRelations;
            const alliedFriendlyRelations = alliedRelations + friendlyRelations;
            const relationPressure = clamp((hostileCriticalRelations * 12) + (strainedRelations * 6) + (recentRelationIncidents * 4) - (alliedFriendlyRelations * 2), 0, 85);
            const activeConflictPressure = clamp(entry.activeConflicts * 20, 0, 80);
            const fiscalFragilityPressure = clamp((50 - financialHealthScore) * 0.8, 0, 40);
            const relationScorePenalty = clamp((-relationAverageScore) * 0.55, 0, 35);

            const conflictRiskScore = clamp(relationPressure + activeConflictPressure + fiscalFragilityPressure + relationScorePenalty, 0, 100);

            const financialHealthBand = financialHealthBandFromScore(financialHealthScore, entry.isInsolvent);
            const conflictRiskLevel = conflictRiskLevelFromScore(conflictRiskScore);

            let conflictOutlook = 'Diplomatic conditions are calm right now.';
            if (conflictRiskLevel === 'guarded') conflictOutlook = 'Some tension is present. Monitor relation incidents and active conflicts.';
            else if (conflictRiskLevel === 'elevated') conflictOutlook = 'Escalation risk is elevated. New incidents could trigger conflicts.';
            else if (conflictRiskLevel === 'severe') conflictOutlook = 'Severe diplomatic strain. Future conflicts are likely unless relations improve.';

            return {
                country_id: entry.countryId,
                country_code: entry.row.country ? entry.row.country.code : null,
                country_name: entry.row.country ? entry.row.country.name : null,
                continent: entry.row.country ? entry.row.country.continent : null,
                latitude: Number((entry.row.country ? entry.row.country.latitude : null) || 0),
                longitude: Number((entry.row.country ? entry.row.country.longitude : null) || 0),
                treasury: Number(entry.treasury.toFixed(2)),
                gdp: Number(entry.gdp.toFixed(2)),
                population: Number(entry.population.toFixed(0)),
                tax_rate: Number(entry.taxRate.toFixed(4)),
                stability: Number(entry.stability.toFixed(4)),
                defense_strength: Number(entry.defenseStrength.toFixed(2)),
                is_insolvent: entry.isInsolvent,
                stock_market_count: entry.cMarkets.length,
                bluechip_market_count: entry.cMarkets.filter(m => m.listing_tier === 'bluechip').length,
                main_market_count: entry.cMarkets.filter(m => m.listing_tier === 'main').length,
                startup_market_count: entry.cMarkets.filter(m => m.listing_tier === 'startup').length,
                equity_market_cap: Number(entry.equityMarketCap || 0),
                active_conflicts: entry.activeConflicts,
                event_shock: Number(entry.localEventShock.toFixed(4)),
                reserve_ratio: Number(entry.reserveRatio.toFixed(4)),
                gdp_per_capita: Number(entry.gdpPerCapita.toFixed(4)),
                fiscal_momentum: Number(fiscalMomentum.toFixed(4)),
                solvency_buffer: Number(entry.solvencyBuffer.toFixed(4)),
                financial_health_score: Number(financialHealthScore.toFixed(2)),
                macro_score: Number(financialHealthScore.toFixed(2)),
                financial_health_band: financialHealthBand,
                relation_count: relationCount,
                relation_avg_score: Number(relationAverageScore.toFixed(2)),
                allied_relations: alliedRelations,
                friendly_relations: friendlyRelations,
                neutral_relations: neutralRelations,
                strained_relations: strainedRelations,
                hostile_relations: hostileRelations,
                critical_relations: criticalRelations,
                recent_relation_incidents: recentRelationIncidents,
                conflict_risk_score: Number(conflictRiskScore.toFixed(2)),
                conflict_risk_level: conflictRiskLevel,
                conflict_outlook: conflictOutlook,
                high_tension_relations: entry.relationStats.highTensionRelations.slice(0, 3)
            };
        });

        res.json({ current_tick: currentTick, indicators });
    } catch (error) {
        console.error('Get country macro indicators error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const getLeaderboard = async (req, res) => {
    try {
        const worldId = parseInt(req.params.id, 10);
        if (!Number.isInteger(worldId)) return res.status(400).json({ error: 'Invalid world id' });

        const database = db.getDb();
        const players = await database.collection('world_players').aggregate([
            { $match: buildCapacityPlayerFilter(worldId) },
            { $sort: { net_worth: -1, id: 1 } },
            { $limit: 100 },
            { $lookup: { from: 'users', localField: 'user_id', foreignField: 'id', as: 'user' } },
            { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } }
        ]).toArray();

        const leaderboard = players.map((entry, index) => ({
            rank: index + 1,
            user_id: entry.user_id,
            username: entry.user ? entry.user.username : null,
            net_worth: entry.net_worth,
            cash_balance: entry.cash_balance
        }));

        let ownRank = null;
        if (req.user?.id) {
            const self = await database.collection('world_players').aggregate([
                { $match: buildCapacityPlayerFilter(worldId, { user_id: req.user.id }) },
                { $lookup: { from: 'users', localField: 'user_id', foreignField: 'id', as: 'user' } },
                { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } }
            ]).toArray();

            if (self.length > 0) {
                const s = self[0];
                const rankCount = await database.collection('world_players').countDocuments({
                    $and: [
                        buildCapacityPlayerFilter(worldId),
                        {
                            $or: [
                                { net_worth: { $gt: s.net_worth } },
                                { net_worth: s.net_worth, id: { $lt: s.id } }
                            ]
                        }
                    ]
                });
                const rank = rankCount + 1;
                ownRank = {
                    rank, user_id: s.user_id, username: s.user ? s.user.username : null, net_worth: s.net_worth, cash_balance: s.cash_balance, inTopLeaderboard: rank > 0 && rank <= 100
                };
            }
        }

        res.json({ leaderboard, ownRank, limit: 100 });
    } catch (error) {
        console.error('Leaderboard error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const getWorldEvents = async (req, res) => {
    try {
        const worldId = parseInt(req.params.id, 10);
        const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);
        if (!Number.isInteger(worldId)) return res.status(400).json({ error: 'Invalid world id' });

        const database = db.getDb();
        const events = await database.collection('world_events').find({ world_id: worldId }, { projection: { id: 1, event_type: 1, title: 1, description: 1, severity: 1, created_at: 1 } }).sort({ created_at: -1 }).limit(limit).toArray();

        res.json({ events });
    } catch (error) {
        console.error('Get world events error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    listWorlds,
    joinWorld,
    leaveWorld,
    getWorldStockMarkets,
    getStockMarketListings,
    getCountryMacroIndicators,
    getLeaderboard,
    getWorldEvents
};
