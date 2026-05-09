const db = require('../config/database');
const wsHandler = require('../websocket/ws.handler');

const BASE_EVENT_CHANCE = 0.20;
const MIN_TICKS_BETWEEN_EVENTS = 1;
const MAX_SILENT_TICKS = 6;

const COOLDOWN_TICKS_BY_SEVERITY = {
    minor: 7,
    moderate: 30,
    major: 365,
    catastrophic: 365
};

const COMMODITY_MAX_TICK_MOVE = 0.15;

const clampCommodityEventPrice = (commodity, nextPriceCandidate) => {
    const minPrice = Math.max(Number(commodity.min_price ?? commodity.base_price ?? 0.01), 0.01);
    const configuredMax = Number(commodity.max_price);
    const maxPrice = Number.isFinite(configuredMax) && configuredMax > minPrice
        ? configuredMax
        : Math.max(minPrice * 5, minPrice + 1);

    const currentPrice = Math.max(Number(commodity.current_price || 0), minPrice);
    const tickLow = Math.max(minPrice, currentPrice * (1 - COMMODITY_MAX_TICK_MOVE));
    const tickHigh = Math.min(maxPrice, currentPrice * (1 + COMMODITY_MAX_TICK_MOVE));
    return Math.min(tickHigh, Math.max(tickLow, nextPriceCandidate));
};

/**
 * Returns a Set of player IDs that are market_corporate bots (anchor company owners).
 * Anchor companies should NOT be affected by game events — they follow real-world API data.
 */
const getAnchorPlayerIds = async (session, worldId) => {
    const database = db.getDb();
    const bots = await database.collection('world_players').find(
        { world_id: worldId, is_bot: true, bot_role: 'market_corporate' },
        { session }
    ).toArray();
    return new Set(bots.map(b => Number(b.id)));
};

const applyMultiplierToSector = async (session, worldId, sectorId, multiplier) => {
    const database = db.getDb();
    const anchorIds = await getAnchorPlayerIds(session, worldId);
    const companies = await database.collection('companies').find({ world_id: worldId, sector_id: sectorId, is_active: true }, { session }).toArray();
    if (companies.length === 0) return;

    const bulkCompanies = [];
    for (const c of companies) {
        if (anchorIds.has(Number(c.owner_player_id))) continue; // skip anchor companies
        bulkCompanies.push({
            updateOne: {
                filter: { id: c.id },
                update: { $set: { share_price: Math.max(Number(c.share_price || 0) * multiplier, 0.01) } }
            }
        });
    }
    if (bulkCompanies.length > 0) await database.collection('companies').bulkWrite(bulkCompanies, { session });
};

const applyMultiplierToCommodity = async (session, worldId, symbol, multiplier) => {
    const database = db.getDb();
    const commodities = await database.collection('commodities').find({ world_id: worldId, symbol }, { session }).toArray();
    if (commodities.length === 0) return;

    const bulk = [];
    for (const c of commodities) {
        const nextPrice = clampCommodityEventPrice(c, Number(c.current_price || 0) * multiplier);
        bulk.push({
            updateOne: {
                filter: { id: c.id },
                update: { $set: { current_price: nextPrice } }
            }
        });
    }
    await database.collection('commodities').bulkWrite(bulk, { session });
};

const applyMultiplierToCrypto = async (session, worldId, symbol, multiplier) => {
    const database = db.getDb();
    const cryptos = await database.collection('cryptos').find({ world_id: worldId, symbol }, { session }).toArray();
    if (cryptos.length === 0) return;

    const bulk = [];
    for (const c of cryptos) {
        bulk.push({
            updateOne: {
                filter: { id: c.id },
                update: { $set: { current_price: Math.max(Number(c.current_price || 0) * multiplier, 0.00000001) } }
            }
        });
    }
    await database.collection('cryptos').bulkWrite(bulk, { session });
};

const applyMultiplierToCountryBonds = async () => {};

const applyMultiplierToCountryStocks = async (session, worldId, countryId, multiplier) => {
    const database = db.getDb();
    const anchorIds = await getAnchorPlayerIds(session, worldId);
    const markets = await database.collection('stock_markets').find({ world_id: worldId, country_id: countryId }, { session }).toArray();
    const marketIds = markets.map(m => m.id);

    if (marketIds.length === 0) return;

    const companies = await database.collection('companies').find({ world_id: worldId, stock_market_id: { $in: marketIds }, is_active: true }, { session }).toArray();
    if (companies.length === 0) return;

    const bulk = [];
    for (const c of companies) {
        if (anchorIds.has(Number(c.owner_player_id))) continue; // skip anchor companies
        bulk.push({
            updateOne: {
                filter: { id: c.id },
                update: { $set: { share_price: Math.max(Number(c.share_price || 0) * multiplier, 0.01) } }
            }
        });
    }
    if (bulk.length > 0) await database.collection('companies').bulkWrite(bulk, { session });
};

const pickWeightedEvent = (events) => {
    const totalWeight = events.reduce((sum, event) => sum + Number(event.weight || 1), 0);
    if (totalWeight <= 0) {
        return events[Math.floor(Math.random() * events.length)];
    }

    let rand = Math.random() * totalWeight;
    for (const event of events) {
        rand -= Number(event.weight || 1);
        if (rand <= 0) {
            return event;
        }
    }

    return events[events.length - 1];
};

const shouldTriggerEvent = async (session, worldId) => {
    const database = db.getDb();
    const world = await database.collection('worlds').findOne({ id: worldId }, { session });

    if (!world) {
        return { trigger: false, currentTick: 0, tickRateSeconds: 60 };
    }

    const tickRateSeconds = Math.max(Number(world.tick_rate_seconds || 60), 1);
    const currentTick = Math.max(Number(world.current_tick || 0), 0);

    const lastEvent = await database.collection('world_events')
        .find({ world_id: worldId }, { session })
        .sort({ id: -1 })
        .limit(1)
        .next();

    if (!lastEvent) {
        return { trigger: true, currentTick, tickRateSeconds };
    }

    const eventTick = Number(lastEvent.event_tick);
    let ticksSinceLastEvent = 0;

    if (Number.isFinite(eventTick) && eventTick >= 0) {
        ticksSinceLastEvent = Math.max(0, currentTick - eventTick);
    } else {
        const elapsedSeconds = Math.max(
            0,
            Math.floor((Date.now() - new Date(lastEvent.created_at || new Date()).getTime()) / 1000)
        );
        ticksSinceLastEvent = Math.floor(elapsedSeconds / tickRateSeconds);
    }

    if (ticksSinceLastEvent < MIN_TICKS_BETWEEN_EVENTS) {
        return { trigger: false, currentTick, tickRateSeconds };
    }

    if (ticksSinceLastEvent >= MAX_SILENT_TICKS) {
        return { trigger: true, currentTick, tickRateSeconds };
    }

    return { trigger: Math.random() < BASE_EVENT_CHANCE, currentTick, tickRateSeconds };
};

const getEventRecencyMap = async (session, worldId, currentTick, tickRateSeconds) => {
    const database = db.getDb();
    const rows = await database.collection('world_events').aggregate([
        { $match: { world_id: worldId } },
        { $group: { _id: "$event_type", last_event_tick: { $max: "$event_tick" }, last_event_time: { $max: "$created_at" } } }
    ], { session }).toArray();

    const recency = new Map();
    for (const row of rows) {
        const eventTick = Number(row.last_event_tick);
        if (Number.isFinite(eventTick) && eventTick >= 0) {
            recency.set(row._id, eventTick);
            continue;
        }

        if (!row.last_event_time) {
            continue;
        }

        const elapsedSeconds = Math.max(
            0,
            Math.floor((Date.now() - new Date(row.last_event_time).getTime()) / 1000)
        );
        const ticksAgo = Math.floor(elapsedSeconds / Math.max(tickRateSeconds, 1));
        recency.set(row._id, Math.max(currentTick - ticksAgo, 0));
    }

    return recency;
};

const buildCoreEvents = () => {
    // Filters out anchor companies (market_corporate bots) — they follow real-world API data only
    const filterUserCompanies = async (session, worldId, companies) => {
        const anchorIds = await getAnchorPlayerIds(session, worldId);
        return companies.filter(c => !anchorIds.has(Number(c.owner_player_id)));
    };

    return [
        {
            type: 'market_crash',
            title: 'Global Market Crash',
            severity: 'catastrophic',
            weight: 0.20,
            description: 'Investor panic triggers a broad-risk liquidation wave.',
            effects: { companies: 0.80, cryptos: 0.70 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const all = await database.collection('companies').find({ world_id: worldId }, { session }).toArray();
                const companies = await filterUserCompanies(session, worldId, all);
                const bulkC = companies.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { share_price: Math.max(Number(c.share_price || 0) * 0.80, 0.01) } } }
                }));
                if (bulkC.length > 0) await database.collection('companies').bulkWrite(bulkC, { session });

                const cryptos = await database.collection('cryptos').find({ world_id: worldId }, { session }).toArray();
                const bulkCr = cryptos.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { current_price: Math.max(Number(c.current_price || 0) * 0.70, 0.00000001) } } }
                }));
                if (bulkCr.length > 0) await database.collection('cryptos').bulkWrite(bulkCr, { session });
            }
        },
        {
            type: 'economic_boom',
            title: 'Economic Boom',
            severity: 'major',
            weight: 1.80,
            description: 'Broad expansion raises demand and risk appetite.',
            effects: { companies: 1.08 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const all = await database.collection('companies').find({ world_id: worldId }, { session }).toArray();
                const companies = await filterUserCompanies(session, worldId, all);
                const bulk = companies.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { share_price: Math.max(Number(c.share_price || 0) * 1.08, 0.01) } } }
                }));
                if (bulk.length > 0) await database.collection('companies').bulkWrite(bulk, { session });
            }
        },
        {
            type: 'oil_crisis',
            title: 'Energy Supply Shock',
            severity: 'major',
            weight: 0.85,
            description: 'Pipeline and transport outages tighten fuel markets.',
            effects: { oilGas: 1.28, manufacturing: 0.95 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const commodities = await database.collection('commodities').find({ world_id: worldId, symbol: { $in: ["OIL", "GAS"] } }, { session }).toArray();
                const bulkCom = commodities.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { current_price: clampCommodityEventPrice(c, Number(c.current_price || 0) * 1.28) } } }
                }));
                if (bulkCom.length > 0) await database.collection('commodities').bulkWrite(bulkCom, { session });

                const targetSectors = await database.collection('sectors').find({ name: { $in: ["Manufacturing", "Transportation"] } }, { session }).toArray();
                const sectorIds = targetSectors.map(s => s.id);
                if (sectorIds.length > 0) {
                    const all = await database.collection('companies').find({ world_id: worldId, sector_id: { $in: sectorIds } }, { session }).toArray();
                    const companies = await filterUserCompanies(session, worldId, all);
                    const bulkC = companies.map(c => ({
                        updateOne: { filter: { id: c.id }, update: { $set: { share_price: Math.max(Number(c.share_price || 0) * 0.95, 0.01) } } }
                    }));
                    if (bulkC.length > 0) await database.collection('companies').bulkWrite(bulkC, { session });
                }
            }
        },
        {
            type: 'tech_breakthrough',
            title: 'Technology Breakthrough',
            severity: 'moderate',
            weight: 1.60,
            description: 'A major productivity leap boosts software and automation output.',
            effects: { tech: 1.10, cryptos: 1.04 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const techSector = await database.collection('sectors').findOne({ name: "Technology" }, { session });
                if (techSector) {
                    const all = await database.collection('companies').find({ world_id: worldId, sector_id: techSector.id }, { session }).toArray();
                    const companies = await filterUserCompanies(session, worldId, all);
                    const bulkC = companies.map(c => ({
                        updateOne: { filter: { id: c.id }, update: { $set: { share_price: Math.max(Number(c.share_price || 0) * 1.10, 0.01) } } }
                    }));
                    if (bulkC.length > 0) await database.collection('companies').bulkWrite(bulkC, { session });
                }

                const cryptos = await database.collection('cryptos').find({ world_id: worldId }, { session }).toArray();
                const bulkCr = cryptos.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { current_price: Math.max(Number(c.current_price || 0) * 1.04, 0.00000001) } } }
                }));
                if (bulkCr.length > 0) await database.collection('cryptos').bulkWrite(bulkCr, { session });
            }
        },
        {
            type: 'drought',
            title: 'Severe Drought',
            severity: 'moderate',
            weight: 1.00,
            description: 'Crop stress drives food and fiber prices higher.',
            effects: { agriCommodities: 1.20 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const commodities = await database.collection('commodities').find({ world_id: worldId, symbol: { $in: ["WHT", "RCE", "COF", "CTN"] } }, { session }).toArray();
                const bulkCom = commodities.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { current_price: clampCommodityEventPrice(c, Number(c.current_price || 0) * 1.20) } } }
                }));
                if (bulkCom.length > 0) await database.collection('commodities').bulkWrite(bulkCom, { session });
            }
        },
        {
            type: 'crypto_hack',
            title: 'Major Exchange Hack',
            severity: 'major',
            weight: 0.40,
            description: 'A leading exchange exploit shakes digital-asset confidence.',
            effects: { randomCrypto: 0.62 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                // MongoDB doesn't have an easy RAND() limit 1, we can get all and pick one
                const cryptos = await database.collection('cryptos').find({ world_id: worldId }, { session }).toArray();
                if (cryptos.length > 0) {
                    const c = cryptos[Math.floor(Math.random() * cryptos.length)];
                    await database.collection('cryptos').updateOne({ id: c.id }, { $set: { current_price: Math.max(Number(c.current_price || 0) * 0.62, 0.00000001) } }, { session });
                }
            }
        },
        {
            type: 'crypto_adoption',
            title: 'Sovereign Crypto Adoption',
            severity: 'major',
            weight: 1.20,
            description: 'A nation announces reserve allocation into digital assets.',
            effects: { cryptos: 1.18 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const cryptos = await database.collection('cryptos').find({ world_id: worldId }, { session }).toArray();
                const bulkCr = cryptos.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { current_price: Math.max(Number(c.current_price || 0) * 1.18, 0.00000001) } } }
                }));
                if (bulkCr.length > 0) await database.collection('cryptos').bulkWrite(bulkCr, { session });
            }
        },
        {
            type: 'bond_yield_spike',
            title: 'Sovereign Yield Spike',
            severity: 'moderate',
            weight: 0.45,
            description: 'Borrowing costs rise and sovereign risk sentiment weakens.',
            effects: { bonds: 0.94 },
            apply: async () => {}
        },
        {
            type: 'logistics_normalization',
            title: 'Logistics Normalization',
            severity: 'minor',
            weight: 1.40,
            description: 'Shipping lanes clear and transport delays ease.',
            effects: { transport: 1.03, commodities: 0.97 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const transportSector = await database.collection('sectors').findOne({ name: "Transportation" }, { session });
                if (transportSector) {
                    const all = await database.collection('companies').find({ world_id: worldId, sector_id: transportSector.id }, { session }).toArray();
                    const companies = await filterUserCompanies(session, worldId, all);
                    const bulkC = companies.map(c => ({
                        updateOne: { filter: { id: c.id }, update: { $set: { share_price: Math.max(Number(c.share_price || 0) * 1.03, 0.01) } } }
                    }));
                    if (bulkC.length > 0) await database.collection('companies').bulkWrite(bulkC, { session });
                }

                const commodities = await database.collection('commodities').find({ world_id: worldId }, { session }).toArray();
                const bulkCom = commodities.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { current_price: clampCommodityEventPrice(c, Number(c.current_price || 0) * 0.97) } } }
                }));
                if (bulkCom.length > 0) await database.collection('commodities').bulkWrite(bulkCom, { session });
            }
        },
        {
            type: 'liquidity_crunch_finance',
            title: 'Interbank Liquidity Crunch',
            severity: 'major',
            weight: 0.35,
            description: 'Funding spreads widen across financial institutions.',
            effects: { finance: 0.89 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const financeSector = await database.collection('sectors').findOne({ name: "Finance" }, { session });
                if (financeSector) {
                    const all = await database.collection('companies').find({ world_id: worldId, sector_id: financeSector.id }, { session }).toArray();
                    const companies = await filterUserCompanies(session, worldId, all);
                    const bulkC = companies.map(c => ({
                        updateOne: { filter: { id: c.id }, update: { $set: { share_price: Math.max(Number(c.share_price || 0) * 0.89, 0.01) } } }
                    }));
                    if (bulkC.length > 0) await database.collection('companies').bulkWrite(bulkC, { session });
                }
            }
        },
        {
            type: 'green_subsidy_wave',
            title: 'Green Subsidy Wave',
            severity: 'moderate',
            weight: 1.40,
            description: 'Sovereign states boost clean-energy capex with tax credits.',
            effects: { energy: 1.07, tech: 1.04 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const targetSectors = await database.collection('sectors').find({ name: { $in: ["Energy", "Technology"] } }, { session }).toArray();
                const sectorMultipliers = {};
                for (const s of targetSectors) {
                    if (s.name === 'Energy') sectorMultipliers[s.id] = 1.07;
                    if (s.name === 'Technology') sectorMultipliers[s.id] = 1.04;
                }

                const all_gsw = await database.collection('companies').find({ world_id: worldId, sector_id: { $in: Object.keys(sectorMultipliers).map(Number) } }, { session }).toArray();
                const companies = await filterUserCompanies(session, worldId, all_gsw);
                const bulkC = companies.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { share_price: Math.max(Number(c.share_price || 0) * (sectorMultipliers[c.sector_id] || 1), 0.01) } } }
                }));
                if (bulkC.length > 0) await database.collection('companies').bulkWrite(bulkC, { session });
            }
        },
        {
            type: 'trade_reopening',
            title: 'Trade Reopening Pact',
            severity: 'minor',
            weight: 1.50,
            description: 'Tariff relief supports cross-border industrial demand.',
            effects: { manufacturing: 1.04, transportation: 1.03 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const targetSectors = await database.collection('sectors').find({ name: { $in: ["Manufacturing", "Transportation"] } }, { session }).toArray();
                const sectorMultipliers = {};
                for (const s of targetSectors) {
                    if (s.name === 'Manufacturing') sectorMultipliers[s.id] = 1.04;
                    if (s.name === 'Transportation') sectorMultipliers[s.id] = 1.03;
                }

                const all_tr = await database.collection('companies').find({ world_id: worldId, sector_id: { $in: Object.keys(sectorMultipliers).map(Number) } }, { session }).toArray();
                const companies_tr = await filterUserCompanies(session, worldId, all_tr);
                const bulkC = companies_tr.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { share_price: Math.max(Number(c.share_price || 0) * (sectorMultipliers[c.sector_id] || 1), 0.01) } } }
                }));
                if (bulkC.length > 0) await database.collection('companies').bulkWrite(bulkC, { session });
            }
        },
        {
            type: 'innovation_wave',
            title: 'Global Innovation Wave',
            severity: 'moderate',
            weight: 1.40,
            description: 'A surge of patents and startups drives broad market optimism.',
            effects: { companies: 1.05, cryptos: 1.06 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const all_iw = await database.collection('companies').find({ world_id: worldId }, { session }).toArray();
                const companies_iw = await filterUserCompanies(session, worldId, all_iw);
                const bulkC = companies_iw.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { share_price: Math.max(Number(c.share_price || 0) * 1.05, 0.01) } } }
                }));
                if (bulkC.length > 0) await database.collection('companies').bulkWrite(bulkC, { session });

                const cryptos = await database.collection('cryptos').find({ world_id: worldId }, { session }).toArray();
                const bulkCr = cryptos.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { current_price: Math.max(Number(c.current_price || 0) * 1.06, 0.00000001) } } }
                }));
                if (bulkCr.length > 0) await database.collection('cryptos').bulkWrite(bulkCr, { session });
            }
        },
        {
            type: 'consumer_confidence_surge',
            title: 'Consumer Confidence Surge',
            severity: 'minor',
            weight: 1.60,
            description: 'Household spending data beats expectations across major economies.',
            effects: { companies: 1.03 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const all_ccs = await database.collection('companies').find({ world_id: worldId }, { session }).toArray();
                const companies_ccs = await filterUserCompanies(session, worldId, all_ccs);
                const bulk = companies_ccs.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { share_price: Math.max(Number(c.share_price || 0) * 1.03, 0.01) } } }
                }));
                if (bulk.length > 0) await database.collection('companies').bulkWrite(bulk, { session });
            }
        },
        {
            type: 'commodity_supply_relief',
            title: 'Commodity Supply Relief',
            severity: 'minor',
            weight: 1.50,
            description: 'New extraction agreements ease global commodity supply constraints.',
            effects: { commodities: 1.04 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const commodities = await database.collection('commodities').find({ world_id: worldId }, { session }).toArray();
                const bulk = commodities.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { current_price: clampCommodityEventPrice(c, Number(c.current_price || 0) * 1.04) } } }
                }));
                if (bulk.length > 0) await database.collection('commodities').bulkWrite(bulk, { session });
            }
        },
        {
            type: 'diplomatic_breakthrough',
            title: 'Major Diplomatic Breakthrough',
            severity: 'moderate',
            weight: 1.30,
            description: 'Key nations sign a landmark trade and cooperation agreement.',
            effects: { companies: 1.04, commodities: 1.02 },
            apply: async (session, worldId) => {
                const database = db.getDb();
                const all_db = await database.collection('companies').find({ world_id: worldId }, { session }).toArray();
                const companies_db = await filterUserCompanies(session, worldId, all_db);
                const bulkC = companies_db.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { share_price: Math.max(Number(c.share_price || 0) * 1.04, 0.01) } } }
                }));
                if (bulkC.length > 0) await database.collection('companies').bulkWrite(bulkC, { session });

                const commodities = await database.collection('commodities').find({ world_id: worldId }, { session }).toArray();
                const bulkCom = commodities.map(c => ({
                    updateOne: { filter: { id: c.id }, update: { $set: { current_price: clampCommodityEventPrice(c, Number(c.current_price || 0) * 1.02) } } }
                }));
                if (bulkCom.length > 0) await database.collection('commodities').bulkWrite(bulkCom, { session });
            }
        }
    ];
};

const buildSectorEvents = async (session, worldId) => {
    const database = db.getDb();
    const sectors = await database.collection('sectors').find({}, { session }).sort({ id: 1 }).toArray();
    const templates = [
        { key: 'policy_tailwind', title: 'Policy Tailwind', severity: 'minor', weight: 1.40, multiplier: 1.03, text: 'Regulatory relief improves capital access for {sector} firms.' },
        { key: 'regulatory_crackdown', title: 'Regulatory Crackdown', severity: 'moderate', weight: 0.60, multiplier: 0.96, text: 'Compliance burden rises sharply for {sector} operators.' },
        { key: 'talent_influx', title: 'Talent Influx', severity: 'minor', weight: 1.40, multiplier: 1.025, text: 'Specialized labor inflow increases execution speed in {sector}.' },
        { key: 'labor_disruption', title: 'Labor Disruption', severity: 'moderate', weight: 0.55, multiplier: 0.95, text: 'Strikes and turnover reduce throughput in {sector}.' },
        { key: 'input_cost_drop', title: 'Input Cost Relief', severity: 'minor', weight: 1.40, multiplier: 1.02, text: 'Supplier pricing eases for {sector} producers.' },
        { key: 'input_cost_spike', title: 'Input Cost Spike', severity: 'moderate', weight: 0.55, multiplier: 0.96, text: 'Raw-material inflation compresses {sector} margins.' },
        { key: 'innovation_cycle', title: 'Innovation Cycle', severity: 'major', weight: 1.20, multiplier: 1.07, text: 'A breakthrough refreshes the product cycle in {sector}.' },
        { key: 'legal_overhang', title: 'Legal Overhang', severity: 'major', weight: 0.40, multiplier: 0.91, text: 'Major litigation risk reprices {sector} valuations lower.' }
    ];

    const events = [];
    for (const sector of sectors) {
        for (const template of templates) {
            const title = `${template.title}: ${sector.name}`;
            const description = template.text.replace('{sector}', sector.name);
            events.push({
                type: `sector_${sector.id}_${template.key}`,
                title,
                severity: template.severity,
                weight: template.weight,
                description,
                effects: { sectorId: sector.id, multiplier: template.multiplier },
                apply: async (sess, targetWorldId) => {
                    await applyMultiplierToSector(sess, targetWorldId, sector.id, template.multiplier);
                }
            });
        }
    }

    return events;
};

const buildCommodityEvents = async (session, worldId) => {
    const database = db.getDb();
    const commodities = await database.collection('commodities').find({ world_id: worldId }, { session }).sort({ id: 1 }).toArray();
    const templates = [
        { key: 'demand_surge', title: 'Demand Surge', severity: 'moderate', weight: 0.95, multiplier: 1.11, text: 'Industrial demand spikes for {name}.' },
        { key: 'inventory_glut', title: 'Inventory Glut', severity: 'moderate', weight: 0.95, multiplier: 0.90, text: 'Warehouses report excess stock in {name}.' },
        { key: 'logistics_delay', title: 'Logistics Delay', severity: 'minor', weight: 1.00, multiplier: 1.05, text: 'Transport bottlenecks slow {name} deliveries.' },
        { key: 'efficiency_upgrade', title: 'Production Efficiency Upgrade', severity: 'minor', weight: 1.00, multiplier: 0.96, text: 'Extraction and processing gains reduce {name} costs.' }
    ];

    const events = [];
    for (const commodity of commodities) {
        for (const template of templates) {
            events.push({
                type: `commodity_${commodity.symbol}_${template.key}`,
                title: `${template.title}: ${commodity.name}`,
                severity: template.severity,
                weight: template.weight,
                description: template.text.replace('{name}', commodity.name),
                effects: { symbol: commodity.symbol, multiplier: template.multiplier },
                apply: async (sess, targetWorldId) => {
                    await applyMultiplierToCommodity(sess, targetWorldId, commodity.symbol, template.multiplier);
                }
            });
        }
    }

    return events;
};

const buildCryptoEvents = async (session, worldId) => {
    const database = db.getDb();
    const cryptos = await database.collection('cryptos').find({ world_id: worldId }, { session }).sort({ id: 1 }).toArray();
    const templates = [
        { key: 'protocol_upgrade', title: 'Protocol Upgrade', severity: 'moderate', weight: 0.95, multiplier: 1.09, text: '{name} deploys a successful performance upgrade.' },
        { key: 'security_incident', title: 'Security Incident', severity: 'major', weight: 0.70, multiplier: 0.82, text: 'A wallet exploit hits confidence in {name}.' },
        { key: 'institutional_inflow', title: 'Institutional Inflow', severity: 'moderate', weight: 0.90, multiplier: 1.07, text: 'Funds report renewed accumulation in {name}.' },
        { key: 'liquidity_drain', title: 'Liquidity Drain', severity: 'moderate', weight: 0.90, multiplier: 0.91, text: 'Market depth thins out for {name}.' }
    ];

    const events = [];
    for (const crypto of cryptos) {
        for (const template of templates) {
            events.push({
                type: `crypto_${crypto.symbol}_${template.key}`,
                title: `${template.title}: ${crypto.name}`,
                severity: template.severity,
                weight: template.weight,
                description: template.text.replace('{name}', crypto.name),
                effects: { symbol: crypto.symbol, multiplier: template.multiplier },
                apply: async (sess, targetWorldId) => {
                    await applyMultiplierToCrypto(sess, targetWorldId, crypto.symbol, template.multiplier);
                }
            });
        }
    }

    return events;
};

const buildCountryEvents = async (session, worldId) => {
    const database = db.getDb();
    const countryStates = await database.collection('country_states').find({ world_id: worldId, is_active: true }, { session }).sort({ country_id: 1 }).toArray();
    const countryIds = countryStates.map(cs => cs.country_id);
    const countriesInfo = await database.collection('countries').find({ id: { $in: countryIds } }, { session }).toArray();
    const countryMap = new Map();
    for (const c of countriesInfo) {
        countryMap.set(c.id, c.name);
    }

    const templates = [
        {
            key: 'credit_upgrade',
            title: 'Credit Upgrade',
            severity: 'moderate',
            weight: 0.90,
            multiplier: 1.06,
            stockMultiplier: 1.04,
            text: '{name} sees fiscal metrics improve, lifting local equities and confidence.'
        },
        {
            key: 'budget_stress',
            title: 'Budget Stress',
            severity: 'major',
            weight: 0.70,
            multiplier: 0.90,
            stockMultiplier: 0.94,
            text: '{name} posts a weak budget and debt concerns weigh on local equities.'
        }
    ];

    const events = [];
    for (const cs of countryStates) {
        const name = countryMap.get(cs.country_id) || `Country ${cs.country_id}`;
        for (const template of templates) {
            events.push({
                type: `country_${cs.country_id}_${template.key}`,
                title: `${template.title}: ${name}`,
                severity: template.severity,
                weight: template.weight,
                description: template.text.replace('{name}', name),
                effects: {
                    countryId: cs.country_id,
                    multiplier: template.multiplier,
                    stockMultiplier: template.stockMultiplier
                },
                apply: async (sess, targetWorldId) => {
                    await applyMultiplierToCountryBonds(sess, targetWorldId, cs.country_id, template.multiplier);
                    await applyMultiplierToCountryStocks(sess, targetWorldId, cs.country_id, template.stockMultiplier);
                }
            });
        }
    }

    return events;
};

const buildEventCatalog = async (session, worldId) => {
    const [sectorEvents, commodityEvents, cryptoEvents, countryEvents] = await Promise.all([
        buildSectorEvents(session, worldId),
        buildCommodityEvents(session, worldId),
        buildCryptoEvents(session, worldId),
        buildCountryEvents(session, worldId)
    ]);

    return [
        ...buildCoreEvents(),
        ...sectorEvents,
        ...commodityEvents,
        ...cryptoEvents,
        ...countryEvents
    ];
};

const syncAssetsFromSubtypes = async (session, worldId) => {
    const database = db.getDb();
    const companies = await database.collection('companies').find({ world_id: worldId }, { session }).toArray();
    const bulkAssets = [];

    for (const c of companies) {
        if (c.asset_id) {
            bulkAssets.push({
                updateOne: {
                    filter: { id: c.asset_id },
                    update: { $set: { current_price: c.share_price, name: c.name, symbol: c.ticker, is_active: c.is_active } }
                }
            });
        }
    }

    const commodities = await database.collection('commodities').find({ world_id: worldId }, { session }).toArray();
    for (const c of commodities) {
        if (c.asset_id) {
            bulkAssets.push({
                updateOne: {
                    filter: { id: c.asset_id },
                    update: { $set: { current_price: c.current_price, name: c.name, symbol: c.symbol, available_quantity: c.total_supply, is_active: true } }
                }
            });
        }
    }

    const cryptos = await database.collection('cryptos').find({ world_id: worldId }, { session }).toArray();
    for (const c of cryptos) {
        if (c.asset_id) {
            bulkAssets.push({
                updateOne: {
                    filter: { id: c.asset_id },
                    update: { $set: { current_price: c.current_price, name: c.name, symbol: c.symbol, available_quantity: c.circulating_supply, is_active: true } }
                }
            });
        }
    }

    const bonds = await database.collection('bonds').find({ world_id: worldId }, { session }).toArray();
    for (const b of bonds) {
        if (b.asset_id) {
            bulkAssets.push({
                updateOne: {
                    filter: { id: b.asset_id },
                    update: { $set: { current_price: b.current_value, name: b.name, symbol: b.symbol, available_quantity: b.total_issued, is_active: b.is_active } }
                }
            });
        }
    }

    if (bulkAssets.length > 0) {
        await database.collection('assets').bulkWrite(bulkAssets, { session });
    }
};

const clampMarketPrices = async (session, worldId) => {
    // This is handled partly in syncAssetsFromSubtypes and partly by apply events having MAX logic
};

const processEvents = async (worldId) => {
    try {
        await db.withTransaction(async (session) => {
            const database = db.getDb();
            const triggerState = await shouldTriggerEvent(session, worldId);
            if (!triggerState.trigger) {
                return;
            }

            const allEvents = await buildEventCatalog(session, worldId);
            if (allEvents.length === 0) {
                return;
            }

            const recencyMap = await getEventRecencyMap(
                session,
                worldId,
                triggerState.currentTick,
                triggerState.tickRateSeconds
            );

            const eligibleEvents = allEvents.filter((event) => {
                const lastTick = recencyMap.get(event.type);
                if (typeof lastTick !== 'number') {
                    return true;
                }

                const cooldown = Number(COOLDOWN_TICKS_BY_SEVERITY[event.severity] || 30);
                return (triggerState.currentTick - lastTick) >= cooldown;
            });

            if (eligibleEvents.length === 0) {
                return;
            }

            const chosenEvent = pickWeightedEvent(eligibleEvents);
            const { type, title, severity, description, effects, apply } = chosenEvent;

            await apply(session, worldId);

            await syncAssetsFromSubtypes(session, worldId);
            await clampMarketPrices(session, worldId);

            const eventId = await db.getNextId('world_events', session);
            await database.collection('world_events').insertOne({
                id: eventId,
                world_id: worldId,
                event_type: type,
                title,
                description,
                severity,
                effects_json: JSON.stringify(effects || {}),
                event_tick: triggerState.currentTick,
                created_at: new Date().toISOString()
            }, { session });

            wsHandler.broadcastToWorld(worldId, { type: 'news', title, description, severity });
        });

    } catch (err) {
        console.error('Event generation error:', err);
    }
};

module.exports = { processEvents };
