const db = require('../config/database');
const wsHandler = require('../websocket/ws.handler');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const COUNTRY_STOCK_EVENT_MEMORY_TICKS = 8;

const EVENT_SEVERITY_STOCK_IMPACT = {
    minor: 0.0012,
    moderate: 0.0022,
    major: 0.0038,
    catastrophic: 0.0060
};

const safeParseEffectsJson = (value) => {
    if (!value) return {};
    if (typeof value === 'object') return value;

    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
};

const addCountryShock = (shockMap, countryId, shockValue) => {
    const normalizedCountryId = Number(countryId);
    if (!Number.isInteger(normalizedCountryId) || normalizedCountryId <= 0) {
        return;
    }

    const current = Number(shockMap.get(normalizedCountryId) || 0);
    shockMap.set(normalizedCountryId, current + Number(shockValue || 0));
};

const buildCountryConflictExposureMap = async (session, worldId) => {
    const database = db.getDb();
    const rows = await database.collection('country_conflicts').aggregate([
        { $match: { world_id: worldId, status: "active" } },
        { $project: { countries: [ "$aggressor_country_id", "$defender_country_id" ] } },
        { $unwind: "$countries" },
        { $group: { _id: "$countries", active_conflicts: { $sum: 1 } } }
    ], { session }).toArray();

    const exposure = new Map();
    for (const row of rows) {
        const countryId = Number(row._id || 0);
        if (countryId > 0) {
            exposure.set(countryId, Number(row.active_conflicts || 0));
        }
    }
    return exposure;
};

const buildCountryStockEventShockMap = async (session, worldId, currentTick) => {
    const database = db.getDb();
    const countryStockEventShocks = new Map();
    let globalStockEventShock = 0;

    const minTick = Math.max(Number(currentTick || 0) - COUNTRY_STOCK_EVENT_MEMORY_TICKS, 0);
    const events = await database.collection('world_events').find(
        { world_id: worldId, event_tick: { $gte: minTick } },
        { session }
    ).sort({ id: -1 }).limit(220).toArray();

    for (const row of events) {
        const type = String(row.event_type || '');
        const severity = String(row.severity || 'moderate');
        const severityImpact = Number(EVENT_SEVERITY_STOCK_IMPACT[severity] || EVENT_SEVERITY_STOCK_IMPACT.moderate);
        const eventTick = Number(row.event_tick || currentTick);
        const age = Math.max(0, Number(currentTick || 0) - eventTick);
        const decay = 1 - (Math.min(age, COUNTRY_STOCK_EVENT_MEMORY_TICKS) / (COUNTRY_STOCK_EVENT_MEMORY_TICKS + 1));
        const effects = safeParseEffectsJson(row.effects_json);
        const weightedShock = severityImpact * decay;

        const effectCountryId = Number(effects.country_id || effects.countryId || 0);
        const effectCountryAId = Number(effects.country_a_id || effects.countryAId || 0);
        const effectCountryBId = Number(effects.country_b_id || effects.countryBId || 0);
        const winnerCountryId = Number(effects.winner_country_id || effects.winnerCountryId || 0);
        const loserCountryId = Number(effects.loser_country_id || effects.loserCountryId || 0);

        if (type === 'market_crash') {
            globalStockEventShock -= weightedShock * 1.35;
        } else if (type === 'economic_boom') {
            globalStockEventShock += weightedShock * 1.10;
        } else if (type === 'bond_yield_spike') {
            globalStockEventShock -= weightedShock * 0.40;
        }

        if (type === 'country_conflict_started') {
            addCountryShock(countryStockEventShocks, Number(effects.aggressor_country_id || 0), -(weightedShock * 2.40));
            addCountryShock(countryStockEventShocks, Number(effects.defender_country_id || 0), -(weightedShock * 2.40));
        }

        if (type === 'country_conflict_resolved') {
            addCountryShock(countryStockEventShocks, winnerCountryId, weightedShock * 1.30);
            addCountryShock(countryStockEventShocks, loserCountryId, -(weightedShock * 0.45));
        }

        if (type === 'country_financial_turbulence') {
            addCountryShock(countryStockEventShocks, effectCountryId, -(weightedShock * 2.10));
        }

        if (type === 'country_insolvency') {
            addCountryShock(countryStockEventShocks, effectCountryId, -0.030 * decay);
        }

        if (type.startsWith('country_')) {
            const eventMultiplier = Number(effects.multiplier);
            if (Number.isFinite(eventMultiplier) && eventMultiplier > 0) {
                addCountryShock(countryStockEventShocks, effectCountryId, (eventMultiplier - 1) * 0.55 * decay);
            } else {
                if (type.includes('credit_upgrade')) {
                    addCountryShock(countryStockEventShocks, effectCountryId, weightedShock * 1.20);
                }
                if (type.includes('budget_stress')) {
                    addCountryShock(countryStockEventShocks, effectCountryId, -(weightedShock * 1.55));
                }
            }
        }

        if (type.startsWith('diplomatic_')) {
            addCountryShock(countryStockEventShocks, effectCountryAId, -(weightedShock * 0.90));
            addCountryShock(countryStockEventShocks, effectCountryBId, -(weightedShock * 0.90));
        }
    }

    globalStockEventShock = clamp(globalStockEventShock, -0.012, 0.012);
    for (const [countryId, shock] of countryStockEventShocks.entries()) {
        countryStockEventShocks.set(countryId, clamp(Number(shock || 0), -0.035, 0.035));
    }

    return {
        countryStockEventShocks,
        globalStockEventShock
    };
};

const processCompanies = async (worldId) => {
    try {
        await db.withTransaction(async (session) => {
            const database = db.getDb();
            const worldRows = await database.collection('worlds').findOne({ id: worldId }, { session });
            const currentTick = Number(worldRows?.current_tick || 0);

            const activeConflictsByCountry = await buildCountryConflictExposureMap(session, worldId);
            const { countryStockEventShocks, globalStockEventShock } = await buildCountryStockEventShockMap(session, worldId, currentTick);

            // Identify anchor/bot companies (owned by market_corporate bots)
            const botPlayers = await database.collection('world_players').find(
                { world_id: worldId, is_bot: true, bot_role: 'market_corporate' },
                { session }
            ).toArray();
            const botPlayerIds = new Set(botPlayers.map(p => p.id));

            const companies = await database.collection('companies').aggregate([
                { $match: { world_id: worldId, is_active: true } },
                { $lookup: { from: 'sectors', localField: 'sector_id', foreignField: 'id', as: 'sector' } },
                { $unwind: { path: '$sector', preserveNullAndEmptyArrays: true } },
                { $lookup: { from: 'stock_markets', localField: 'stock_market_id', foreignField: 'id', as: 'market' } },
                { $unwind: { path: '$market', preserveNullAndEmptyArrays: true } },
                { $lookup: { from: 'country_states', let: { c_id: '$market.country_id' }, pipeline: [
                    { $match: { $expr: { $and: [ { $eq: ['$world_id', worldId] }, { $eq: ['$country_id', '$$c_id'] } ] } } }
                ], as: 'country_state' } },
                { $unwind: { path: '$country_state', preserveNullAndEmptyArrays: true } }
            ], { session }).toArray();

            const bulkCompanies = [];
            const bulkAssets = [];
            const playerCashUpdates = new Map(); // player_id -> additional cash
            const dividendHistoryInserts = [];

            for (let c of companies) {
                const isAnchorCompany = botPlayerIds.has(Number(c.owner_player_id));

                // Anchor companies must follow API-sourced global market data.
                // Skip any local simulation drift for these symbols.
                if (isAnchorCompany) continue;

                // 1. Calculate Revenue (scaled down to avoid runaway compounding)
                let riskGrowthMulti = 1.0;
                let riskVolatilityMulti = 1.0;
                let strategyGrowthMulti = 1.0;
                let strategyVolatilityMulti = 1.0;
                let strategyOperatingCostMulti = 1.0;

                switch(c.growth_strategy) {
                    case 'acquisition':
                        strategyGrowthMulti = 1.14;
                        strategyVolatilityMulti = 1.28;
                        strategyOperatingCostMulti = 1.25;
                        break;
                    case 'diversified':
                        strategyGrowthMulti = 1.05;
                        strategyVolatilityMulti = 0.88;
                        strategyOperatingCostMulti = 1.08;
                        break;
                    default:
                        strategyGrowthMulti = 1.0;
                        strategyVolatilityMulti = 0.92;
                        strategyOperatingCostMulti = 0.95;
                }

                switch(c.risk_level) {
                    case 'conservative':
                        riskGrowthMulti = 0.85;
                        riskVolatilityMulti = 0.70;
                        break;
                    case 'aggressive':
                        riskGrowthMulti = 1.10;
                        riskVolatilityMulti = 1.20;
                        break;
                    default:
                        riskGrowthMulti = 1.0;
                        riskVolatilityMulti = 1.0;
                }

                const baseGrowthRate = c.sector ? Number(c.sector.base_growth_rate || 0) : 0;
                const volatilityFactor = c.sector ? Number(c.sector.volatility_factor || 0) : 0;
                const growthRate = baseGrowthRate * 0.015 * riskGrowthMulti * strategyGrowthMulti;
                const volatility = volatilityFactor * 0.030 * riskVolatilityMulti * strategyVolatilityMulti;
                const randomShock = (Math.random() * 2 - 1) * volatility;

                // For unlisted companies, skip geo/market pressure effects
                const isListed = c.is_listed !== false; // default true for legacy companies
                const countryId = (isListed && c.market) ? Number(c.market.country_id || 0) : 0;
                const activeConflictCount = isListed ? Number(activeConflictsByCountry.get(countryId) || 0) : 0;
                const countryEventShock = isListed ? Number(countryStockEventShocks.get(countryId) || 0) : 0;
                const countryStability = (isListed && c.country_state) ? Number(c.country_state.stability) : 0.62;
                const countryStabilityDrift = (isListed && Number.isFinite(countryStability))
                    ? clamp((countryStability - 0.62) * 0.006, -0.003, 0.003)
                    : 0;
                const countryIsInsolvent = (isListed && c.country_state) ? Number(c.country_state.is_insolvent || 0) : 0;
                const countryInsolvencyPenalty = countryIsInsolvent ? -0.0065 : 0;
                const countryConflictPenalty = isListed ? -(Math.min(activeConflictCount, 4) * 0.0018) : 0;
                const geoDrift = countryStabilityDrift
                    + countryInsolvencyPenalty
                    + countryConflictPenalty
                    + countryEventShock
                    + (isListed ? Number(globalStockEventShock || 0) : 0);

                const performance = clamp(growthRate + randomShock + (geoDrift * 0.38), -0.008, 0.0075);
                
                // Revenue is based off their current treasury size
                const currentTreasury = Number(c.treasury || 0);
                const revenue = currentTreasury * performance;
                const operatingCost = currentTreasury * 0.0003 * strategyOperatingCostMulti;
                
                let newTreasury = currentTreasury + revenue - operatingCost;
                if (newTreasury < 0) newTreasury = 0;

                // 2. Process Dividends
                let dividendPayout = 0;
                let divPct = 0;
                if (revenue > 0) {
                    switch(c.dividend_policy) {
                        case 'low': divPct = 0.05; break;
                        case 'medium': divPct = 0.15; break;
                        case 'high': divPct = 0.30; break;
                    }
                    dividendPayout = revenue * divPct;
                    newTreasury -= dividendPayout;
                }

                // 3. Distribute Dividends to Shareholders
                if (dividendPayout > 0) {
                    const dividendPerShare = dividendPayout / c.total_shares;
                    
                    // Get all players holding this share
                    const shareholders = await database.collection('portfolio').find(
                        { asset_type: 'share', asset_id: c.asset_id },
                        { session }
                    ).toArray();

                    for (let owner of shareholders) {
                        const payout = owner.quantity * dividendPerShare;
                        if (payout > 0) {
                            const pId = owner.player_id;
                            const currentCash = playerCashUpdates.get(pId) || 0;
                            playerCashUpdates.set(pId, currentCash + payout);
                            
                            dividendHistoryInserts.push({
                                company_id: c.id,
                                player_id: pId,
                                amount: payout,
                                shares_held: owner.quantity
                            });
                        }
                    }
                }

                // 4. Update share price logic with tighter mean-reversion to fundamentals
                const totalShares = Math.max(Number(c.total_shares || 0), 1);
                const intrinsicPrice = Math.max(newTreasury / totalShares, 0.01);
                const currentPrice = Math.max(Number(c.share_price || intrinsicPrice), 0.01);

                const fundamentalPull = ((intrinsicPrice - currentPrice) / currentPrice) * 0.22;
                const operatingDrift = performance * 0.10;
                const marketNoise = (Math.random() * 0.0018) - 0.0009; // -0.09% to 0.09%

                const priceChange = clamp(fundamentalPull + operatingDrift + marketNoise + geoDrift, -0.028, 0.028);
                let newPrice = currentPrice * (1 + priceChange);

                const minBand = Math.max(0.01, intrinsicPrice * (countryIsInsolvent ? 0.60 : 0.73));
                const maxBand = Math.max(minBand + 0.01, intrinsicPrice * 1.40);
                newPrice = clamp(newPrice, minBand, maxBand);

                bulkCompanies.push({
                    updateOne: {
                        filter: { id: c.id },
                        update: { $set: { treasury: newTreasury, revenue_per_tick: revenue, share_price: newPrice } }
                    }
                });

                if (c.asset_id) {
                    bulkAssets.push({
                        updateOne: {
                            filter: { id: c.asset_id },
                            update: { $set: { current_price: newPrice } }
                        }
                    });
                }
            }

            if (bulkCompanies.length > 0) {
                await database.collection('companies').bulkWrite(bulkCompanies, { session });
            }
            if (bulkAssets.length > 0) {
                await database.collection('assets').bulkWrite(bulkAssets, { session });
            }
            
            const bulkPlayers = [];
            for (const [pId, amount] of playerCashUpdates.entries()) {
                bulkPlayers.push({
                    updateOne: {
                        filter: { id: pId },
                        update: { $inc: { cash_balance: amount } }
                    }
                });
            }
            if (bulkPlayers.length > 0) {
                await database.collection('world_players').bulkWrite(bulkPlayers, { session });
            }

            if (dividendHistoryInserts.length > 0) {
                await database.collection('dividend_history').insertMany(dividendHistoryInserts, { session });
            }

        });
        
        wsHandler.broadcastToWorld(worldId, { type: 'companies', message: 'Company tick completed' });
    } catch (err) {
        console.error('Company process error:', err);
    }
};

module.exports = { processCompanies };

