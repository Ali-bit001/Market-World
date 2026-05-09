const db = require('../config/database');
const wsHandler = require('../websocket/ws.handler');

const MAX_ACTIVE_CONFLICTS = 2;
const BASE_CONFLICT_START_CHANCE = 0.0065;
const BASE_CEASEFIRE_CHANCE = 0.08;
const DAILY_CEASEFIRE_INCREMENT = 0.055;
const MAX_CEASEFIRE_CHANCE = 0.90;
const BOND_EVENT_MEMORY_TICKS = 8;

const EVENT_SEVERITY_BOND_IMPACT = {
    minor: 0.0025,
    moderate: 0.005,
    major: 0.009,
    catastrophic: 0.014
};

const MIN_BOND_MATURITY_TICKS = 45;
const MAX_BOND_MATURITY_TICKS = 460;
const MIN_BOND_FIXED_PROFIT_RATE = 0.018;
const MAX_BOND_FIXED_PROFIT_RATE = 0.165;

const SOVEREIGN_ISSUANCE_PROFILES = {
    long: { typeKey: 'long', typeLabel: 'Long Bond', symbolTag: 'LB', riskLabel: 'investment_grade', maturityMin: 300, maturityMax: 460, couponMin: 0.026, couponMax: 0.045, discountMin: 0.005, discountMax: 0.04, intervalBase: 28, qtyScale: 0.72 },
    note: { typeKey: 'note', typeLabel: 'Treasury Note', symbolTag: 'TN', riskLabel: 'balanced', maturityMin: 180, maturityMax: 300, couponMin: 0.037, couponMax: 0.062, discountMin: 0.012, discountMax: 0.065, intervalBase: 18, qtyScale: 0.95 },
    highYield: { typeKey: 'high_yield', typeLabel: 'High-Yield Note', symbolTag: 'HY', riskLabel: 'speculative', maturityMin: 95, maturityMax: 185, couponMin: 0.06, couponMax: 0.098, discountMin: 0.04, discountMax: 0.14, intervalBase: 12, qtyScale: 1.18 },
    emergency: { typeKey: 'emergency', typeLabel: 'Emergency Bill', symbolTag: 'EB', riskLabel: 'distressed', maturityMin: 45, maturityMax: 110, couponMin: 0.09, couponMax: 0.155, discountMin: 0.10, discountMax: 0.24, intervalBase: 7, qtyScale: 1.42 }
};

const RELATION_LEVEL_RANK = { allied: 0, friendly: 1, neutral: 2, strained: 3, hostile: 4, critical: 5 };

const RELATION_INCIDENT_PROFILES = {
    allied: { chance: 0.035, minDrop: 1.5, maxDrop: 4.5 },
    friendly: { chance: 0.055, minDrop: 2.0, maxDrop: 5.5 },
    neutral: { chance: 0.08, minDrop: 3.0, maxDrop: 7.0 },
    strained: { chance: 0.115, minDrop: 4.5, maxDrop: 9.5 },
    hostile: { chance: 0.165, minDrop: 5.5, maxDrop: 12.0 },
    critical: { chance: 0.22, minDrop: 6.0, maxDrop: 13.0 }
};

const RELATION_INCIDENT_TEMPLATES = [
    { eventType: 'diplomatic_trade_dispute', title: 'Trade Dispute Escalates', description: '{a} and {b} clash over tariffs and export controls.' },
    { eventType: 'diplomatic_sanctions_threat', title: 'Sanctions Threat Issued', description: '{a} signaled sanctions pressure against {b}, rattling regional confidence.' },
    { eventType: 'diplomatic_border_incident', title: 'Border Incident Reported', description: 'A frontier incident between {a} and {b} intensified diplomatic strain.' },
    { eventType: 'diplomatic_cyber_accusation', title: 'Cyber Intrusion Accusation', description: '{a} publicly accused {b} of cyber interference in strategic infrastructure.' }
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const applyWarCommodityBoost = async (worldId) => {
    const database = db.getDb();
    const warCommodities = await database.collection('commodities').find(
        { world_id: worldId, symbol: { $in: ['OIL', 'GAS', 'GLD'] } }
    ).toArray();
    if (warCommodities.length === 0) return;

    const updates = warCommodities.map((commodity) => {
        const multiplier = commodity.symbol === 'GLD' ? 1.08 : 1.15;
        const newPrice = Math.max(Number(commodity.current_price || 0) * multiplier, 0.01);
        return { commodity, newPrice };
    });

    await Promise.all([
        database.collection('commodities').bulkWrite(
            updates.map(({ commodity, newPrice }) => ({
                updateOne: {
                    filter: { id: commodity.id },
                    update: { $set: { current_price: newPrice } }
                }
            }))
        ),
        database.collection('assets').bulkWrite(
            updates
                .filter(({ commodity }) => Number.isInteger(Number(commodity.asset_id)) && Number(commodity.asset_id) > 0)
                .map(({ commodity, newPrice }) => ({
                    updateOne: {
                        filter: { id: Number(commodity.asset_id) },
                        update: { $set: { current_price: newPrice } }
                    }
                }))
        )
    ]);
};

const relationLevelFromScore = (score) => {
    if (score >= 65) return 'allied';
    if (score >= 35) return 'friendly';
    if (score >= 5) return 'neutral';
    if (score >= -20) return 'strained';
    if (score >= -55) return 'hostile';
    return 'critical';
};

const pickRandomItem = (values) => values[Math.floor(Math.random() * values.length)];

const safeParseEffectsJson = (value) => {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return {}; }
};

const randomBetween = (min, max) => {
    const lower = Number(min || 0);
    const upper = Number(max || lower);
    if (upper <= lower) return lower;
    return lower + (Math.random() * (upper - lower));
};

const calculateDurationProfitRate = (maturityTicks) => {
    const normalizedMaturity = clamp(
        (Number(maturityTicks || 0) - MIN_BOND_MATURITY_TICKS) / Math.max(MAX_BOND_MATURITY_TICKS - MIN_BOND_MATURITY_TICKS, 1),
        0, 1
    );
    return clamp(MIN_BOND_FIXED_PROFIT_RATE + (normalizedMaturity * (MAX_BOND_FIXED_PROFIT_RATE - MIN_BOND_FIXED_PROFIT_RATE)), MIN_BOND_FIXED_PROFIT_RATE, MAX_BOND_FIXED_PROFIT_RATE);
};

const pickIssuanceProfileFromHealth = (fiscalHealthScore, isInsolvent) => {
    if (isInsolvent || fiscalHealthScore < 0.28) return SOVEREIGN_ISSUANCE_PROFILES.emergency;
    if (fiscalHealthScore < 0.48) return SOVEREIGN_ISSUANCE_PROFILES.highYield;
    if (fiscalHealthScore < 0.74) return SOVEREIGN_ISSUANCE_PROFILES.note;
    return SOVEREIGN_ISSUANCE_PROFILES.long;
};

const buildBondSymbolCandidate = ({ countryCode, symbolTag, currentTick, sequenceId = 0, attempt = 0 }) => {
    const codeToken = String(countryCode || 'XX').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'XX';
    const tagToken = String(symbolTag || 'SB').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2) || 'SB';
    const tickToken = Math.max(0, Number(currentTick || 0)).toString(36).toUpperCase().padStart(4, '0').slice(-4);
    const sequenceToken = Math.max(0, Number(sequenceId || 0)).toString(36).toUpperCase().slice(-3).padStart(3, '0');
    const attemptToken = String.fromCharCode(65 + (Math.max(0, Number(attempt || 0)) % 26));
    return `${codeToken}${tagToken}${tickToken}${sequenceToken}${attemptToken}`.slice(0, 20);
};

const addCountryShock = (shockMap, countryId, shockValue) => {
    const normalizedCountryId = Number(countryId);
    if (!Number.isInteger(normalizedCountryId) || normalizedCountryId <= 0) return;
    const current = Number(shockMap.get(normalizedCountryId) || 0);
    shockMap.set(normalizedCountryId, current + Number(shockValue || 0));
};

const buildCountryConflictExposureMap = async (session, worldId) => {
    const database = db.getDb();
    const rows = await database.collection('country_conflicts').find({ world_id: worldId, status: "active" }, { session }).toArray();
    const exposure = new Map();
    for (const row of rows) {
        const aggressorCountryId = Number(row.aggressor_country_id || 0);
        const defenderCountryId = Number(row.defender_country_id || 0);
        if (Number.isInteger(aggressorCountryId) && aggressorCountryId > 0) {
            exposure.set(aggressorCountryId, Number(exposure.get(aggressorCountryId) || 0) + 1);
        }
        if (Number.isInteger(defenderCountryId) && defenderCountryId > 0) {
            exposure.set(defenderCountryId, Number(exposure.get(defenderCountryId) || 0) + 1);
        }
    }
    return exposure;
};

const buildCountryBondEventShockMap = async (session, worldId, currentTick) => {
    const database = db.getDb();
    const countryBondEventShocks = new Map();
    let globalBondEventShock = 0;

    const minTick = Math.max(Number(currentTick || 0) - BOND_EVENT_MEMORY_TICKS, 0);
    const rows = await database.collection('world_events')
        .find({ world_id: worldId, event_tick: { $gte: minTick } }, { session })
        .sort({ id: -1 })
        .limit(160)
        .toArray();

    for (const row of rows) {
        const type = String(row.event_type || '');
        const severity = String(row.severity || 'moderate');
        const severityImpact = Number(EVENT_SEVERITY_BOND_IMPACT[severity] || EVENT_SEVERITY_BOND_IMPACT.moderate);
        const eventTick = Number(row.event_tick || currentTick);
        const age = Math.max(0, Number(currentTick || 0) - eventTick);
        const decay = 1 - (Math.min(age, BOND_EVENT_MEMORY_TICKS) / (BOND_EVENT_MEMORY_TICKS + 1));
        const effects = safeParseEffectsJson(row.effects_json);

        const weightedShock = severityImpact * decay;
        const effectCountryId = Number(effects.country_id || effects.countryId || 0);
        const effectCountryAId = Number(effects.country_a_id || effects.countryAId || 0);
        const effectCountryBId = Number(effects.country_b_id || effects.countryBId || 0);
        const winnerCountryId = Number(effects.winner_country_id || effects.winnerCountryId || 0);
        const loserCountryId = Number(effects.loser_country_id || effects.loserCountryId || 0);

        if (type === 'bond_yield_spike') globalBondEventShock -= weightedShock * 1.05;
        else if (type === 'economic_boom') globalBondEventShock += weightedShock * 0.6;
        else if (type === 'market_crash') globalBondEventShock -= weightedShock * 0.9;

        if (type === 'country_conflict_started') {
            addCountryShock(countryBondEventShocks, Number(effects.aggressor_country_id || 0), -(weightedShock * 1.65));
            addCountryShock(countryBondEventShocks, Number(effects.defender_country_id || 0), -(weightedShock * 1.65));
        }
        if (type === 'country_conflict_resolved') {
            addCountryShock(countryBondEventShocks, winnerCountryId, weightedShock * 1.1);
            addCountryShock(countryBondEventShocks, loserCountryId, -(weightedShock * 0.45));
        }
        if (type === 'country_financial_turbulence') {
            addCountryShock(countryBondEventShocks, effectCountryId, -(weightedShock * 1.45));
        }
        if (type === 'country_insolvency') {
            addCountryShock(countryBondEventShocks, effectCountryId, -0.075 * decay);
        }
        if (type.startsWith('country_')) {
            const eventMultiplier = Number(effects.multiplier);
            if (Number.isFinite(eventMultiplier) && eventMultiplier > 0) {
                addCountryShock(countryBondEventShocks, effectCountryId, (eventMultiplier - 1) * 0.45 * decay);
            } else {
                if (type.includes('credit_upgrade')) addCountryShock(countryBondEventShocks, effectCountryId, weightedShock * 1.1);
                if (type.includes('budget_stress')) addCountryShock(countryBondEventShocks, effectCountryId, -(weightedShock * 1.3));
            }
        }
        if (type.startsWith('diplomatic_')) {
            addCountryShock(countryBondEventShocks, effectCountryAId, -(weightedShock * 0.55));
            addCountryShock(countryBondEventShocks, effectCountryBId, -(weightedShock * 0.55));
        }
    }

    globalBondEventShock = clamp(globalBondEventShock, -0.03, 0.03);
    for (const [countryId, shock] of countryBondEventShocks.entries()) {
        countryBondEventShocks.set(countryId, clamp(Number(shock || 0), -0.085, 0.085));
    }

    return { countryBondEventShocks, globalBondEventShock };
};

const enforceCountrySovereignBondFixedPricing = async (session, worldId, countryState) => {
    const database = db.getDb();
    const bonds = await database.collection('bonds').find(
        { world_id: worldId, country_id: countryState.country_id, is_active: true }, { session }
    ).toArray();

    const bulkBonds = [];
    const bulkAssets = [];

    for (const bond of bonds) {
        const fixedPrice = Math.max(Number(bond.face_value || 0), 0.01);
        const currentValue = Math.max(Number(bond.current_value || fixedPrice), 0.01);

        if (Math.abs(fixedPrice - currentValue) >= 0.00005) {
            bulkBonds.push({
                updateOne: { filter: { id: bond.id }, update: { $set: { current_value: fixedPrice } } }
            });
            if (Number.isInteger(Number(bond.asset_id)) && Number(bond.asset_id) > 0) {
                bulkAssets.push({
                    updateOne: { filter: { id: Number(bond.asset_id) }, update: { $set: { current_price: fixedPrice } } }
                });
            }
        }
    }

    if (bulkBonds.length > 0) await database.collection('bonds').bulkWrite(bulkBonds, { session });
    if (bulkAssets.length > 0) await database.collection('assets').bulkWrite(bulkAssets, { session });
};

const insertWorldEvent = async (session, worldId, currentTick, payload) => {
    const database = db.getDb();
    const eventId = await db.getNextId('world_events', session);
    await database.collection('world_events').insertOne({
        id: eventId,
        world_id: worldId,
        event_type: payload.eventType,
        title: payload.title,
        description: payload.description,
        severity: payload.severity,
        effects_json: JSON.stringify(payload.effects || {}),
        event_tick: currentTick,
        created_at: new Date().toISOString()
    }, { session });
};

const ensureCountryStates = async (session, worldId) => {
    const database = db.getDb();
    const stockMarkets = await database.collection('stock_markets').find({ world_id: worldId }, { session }).toArray();

    const bulk = [];
    for (const sm of stockMarkets) {
        const treasury = 165000 + ((sm.country_id % 9) * 14000);
        const taxRate = 0.1100 + ((sm.country_id % 6) * 0.0100);
        const stability = Math.min(0.9500, 0.6200 + ((sm.country_id % 7) * 0.0450));
        const defenseStrength = 420.00 + ((sm.country_id % 11) * 45.00);
        const gdp = 78000.00 + ((sm.country_id % 13) * 13500.00);
        const population = 900000 + ((sm.country_id % 17) * 150000);

        bulk.push({
            updateOne: {
                filter: { world_id: worldId, country_id: sm.country_id },
                update: {
                    $setOnInsert: {
                        id: await db.getNextId('country_states', session),
                        world_id: worldId,
                        country_id: sm.country_id,
                        treasury,
                        tax_rate: taxRate,
                        stability,
                        defense_strength: defenseStrength,
                        gdp,
                        population,
                        is_insolvent: false,
                        created_at: new Date().toISOString()
                    },
                    $set: { is_active: true, updated_at: new Date().toISOString() }
                },
                upsert: true
            }
        });
    }

    if (bulk.length > 0) await database.collection('country_states').bulkWrite(bulk, { session });
};

const ensureCountryRelations = async (session, worldId) => {
    const database = db.getDb();
    const countryStates = await database.collection('country_states').find({ world_id: worldId }, { session }).toArray();

    const bulk = [];
    for (let i = 0; i < countryStates.length; i++) {
        for (let j = i + 1; j < countryStates.length; j++) {
            const csA = countryStates[i];
            const csB = countryStates[j];
            
            const rawScore = 20 + (((csA.country_id * 17) + (csB.country_id * 31) + (csA.world_id * 13)) % 121) - 60;
            const score = Math.max(-70, Math.min(80, rawScore));
            const level = relationLevelFromScore(score);

            bulk.push({
                updateOne: {
                    filter: { world_id: worldId, country_a_id: Math.min(csA.country_id, csB.country_id), country_b_id: Math.max(csA.country_id, csB.country_id) },
                    update: {
                        $setOnInsert: {
                            id: await db.getNextId('country_relations', session),
                            world_id: worldId,
                            country_a_id: Math.min(csA.country_id, csB.country_id),
                            country_b_id: Math.max(csA.country_id, csB.country_id),
                            relation_score: score,
                            relation_level: level,
                            last_incident_tick: -1,
                            updated_at: new Date().toISOString()
                        }
                    },
                    upsert: true
                }
            });
        }
    }

    if (bulk.length > 0) await database.collection('country_relations').bulkWrite(bulk, { session });
};

const maybeTriggerRelationIncident = async (session, worldId, currentTick) => {
    const database = db.getDb();
    
    // Get active conflicts to exclude pairs
    const conflicts = await database.collection('country_conflicts').find({ world_id: worldId, status: "active" }, { session }).toArray();
    const conflictPairs = new Set();
    for (const c of conflicts) {
        conflictPairs.add(`${Math.min(c.aggressor_country_id, c.defender_country_id)}-${Math.max(c.aggressor_country_id, c.defender_country_id)}`);
    }

    const relations = await database.collection('country_relations').find({ world_id: worldId }, { session }).toArray();
    const validRelations = relations.filter(r => !conflictPairs.has(`${Math.min(r.country_a_id, r.country_b_id)}-${Math.max(r.country_a_id, r.country_b_id)}`));

    if (validRelations.length === 0) return null;

    const relation = validRelations[Math.floor(Math.random() * validRelations.length)];
    const profile = RELATION_INCIDENT_PROFILES[relation.relation_level] || RELATION_INCIDENT_PROFILES.neutral;

    if (Math.random() >= profile.chance) return null;

    const drop = profile.minDrop + (Math.random() * (profile.maxDrop - profile.minDrop));
    const oldScore = Number(relation.relation_score || 0);
    const newScore = clamp(oldScore - drop, -100, 100);
    const oldLevel = String(relation.relation_level || 'neutral');
    const newLevel = relationLevelFromScore(newScore);

    await database.collection('country_relations').updateOne(
        { id: relation.id },
        { $set: { relation_score: newScore, relation_level: newLevel, last_incident_tick: currentTick, updated_at: new Date().toISOString() } },
        { session }
    );

    const countryA = await database.collection('countries').findOne({ id: relation.country_a_id }, { session });
    const countryB = await database.collection('countries').findOne({ id: relation.country_b_id }, { session });
    const nameA = countryA ? countryA.name : `Country ${relation.country_a_id}`;
    const nameB = countryB ? countryB.name : `Country ${relation.country_b_id}`;

    const incidentTemplate = pickRandomItem(RELATION_INCIDENT_TEMPLATES);
    const title = `${incidentTemplate.title}: ${nameA} / ${nameB}`;
    const description = incidentTemplate.description.replace('{a}', nameA).replace('{b}', nameB);
    const severity = RELATION_LEVEL_RANK[newLevel] >= RELATION_LEVEL_RANK.hostile ? 'major' : 'moderate';

    const event = {
        eventType: incidentTemplate.eventType,
        severity,
        title,
        description,
        effects: {
            country_a_id: relation.country_a_id,
            country_b_id: relation.country_b_id,
            score_before: Number(oldScore.toFixed(2)),
            score_after: Number(newScore.toFixed(2)),
            level_before: oldLevel,
            level_after: newLevel,
            incident_drop: Number(drop.toFixed(2))
        },
        wsPayload: {
            type: 'news',
            title,
            description: `${nameA} and ${nameB} relations shifted from ${oldLevel} to ${newLevel}.`,
            severity
        }
    };

    await insertWorldEvent(session, worldId, currentTick, event);
    return event.wsPayload;
};

const processSovereignBonds = async (session, worldId, countryState, nextTreasury, isInsolvent = false) => {
    const database = db.getDb();
    const bonds = await database.collection('bonds').find(
        { world_id: worldId, country_id: countryState.country_id, is_active: true }, { session }
    ).toArray();

    let treasury = nextTreasury;
    let defaulted = false;

    const closeBondAsDefaulted = async (bondId, bondAssetId) => {
        if (bondAssetId) {
            await database.collection('portfolio').deleteMany({ asset_type: "bond", asset_id: bondAssetId }, { session });
            await database.collection('assets').updateOne(
                { id: bondAssetId },
                { $set: { is_active: false, current_price: 0, available_quantity: 0 } },
                { session }
            );
        } else {
            await database.collection('portfolio').deleteMany({ asset_type: "bond", asset_id: bondId }, { session });
        }
        await database.collection('bonds').updateOne(
            { id: bondId },
            { $set: { is_active: false, ticks_remaining: 0 } },
            { session }
        );
    };

    if (Boolean(isInsolvent)) {
        if (bonds.length > 0) defaulted = true;
        for (const bond of bonds) {
            await closeBondAsDefaulted(Number(bond.id), Number(bond.asset_id || 0));
        }
        return { treasury, defaulted };
    }

    for (const bond of bonds) {
        const bondAssetId = Number(bond.asset_id || 0);
        const faceValue = Number(bond.face_value || 0);
        const fixedProfitRate = Math.max(Number(bond.interest_rate || 0), 0);
        const currentTicksRemaining = Math.max(Number(bond.ticks_remaining || 0), 0);
        const nextTicksRemaining = Math.max(currentTicksRemaining - 1, 0);
        const willMatureThisTick = nextTicksRemaining <= 0;

        if (!willMatureThisTick) {
            await database.collection('bonds').updateOne({ id: bond.id }, { $set: { ticks_remaining: nextTicksRemaining } }, { session });
            continue;
        }

        const bondholders = await database.collection('portfolio').find(
            { asset_type: "bond", asset_id: bondAssetId || bond.id }, { session }
        ).toArray();

        const payoutPerUnit = faceValue * (1 + fixedProfitRate);
        const heldQuantity = bondholders.reduce((sum, holder) => sum + Number(holder.quantity || 0), 0);
        const totalPayout = heldQuantity * payoutPerUnit;

        if (totalPayout > 0 && treasury >= totalPayout) {
            treasury -= totalPayout;

            const bulkPlayers = [];
            const bondPayments = [];
            for (const owner of bondholders) {
                const payout = Number(owner.quantity || 0) * payoutPerUnit;
                if (payout <= 0) continue;
                bulkPlayers.push({
                    updateOne: { filter: { id: owner.player_id }, update: { $inc: { cash_balance: payout } } }
                });
                bondPayments.push({
                    bond_id: bond.id, player_id: owner.player_id, amount: payout, bonds_held: owner.quantity
                });
            }
            if (bulkPlayers.length > 0) await database.collection('world_players').bulkWrite(bulkPlayers, { session });
            if (bondPayments.length > 0) await database.collection('bond_payments').insertMany(bondPayments, { session });
        } else if (totalPayout > 0) {
            defaulted = true;
        }

        await closeBondAsDefaulted(Number(bond.id), bondAssetId);
    }

    return { treasury, defaulted };
};

const maybeIssueSovereignBond = async (session, worldId, currentTick, countryState, issuanceContext = {}) => {
    const database = db.getDb();
    const countryId = Number(countryState.country_id || 0);
    if (!Number.isInteger(countryId) || countryId <= 0) return null;

    const gdp = Number(issuanceContext.gdp || countryState.gdp || 0);
    const treasury = Number(issuanceContext.treasury || countryState.treasury || 0);
    const stability = clamp(Number(issuanceContext.stability ?? countryState.stability ?? 0.5), 0, 1);
    const isInsolvent = Boolean(issuanceContext.isInsolvent ?? countryState.is_insolvent);
    const activeConflictCount = Number(issuanceContext.activeConflictCount || 0);
    const eventShock = Number(issuanceContext.eventShock || 0);
    const reserveRatio = treasury / Math.max(gdp, 1);

    const fiscalHealthScore = clamp(
        (stability * 0.52) + (clamp(reserveRatio / 0.18, 0, 1) * 0.34) - (activeConflictCount * 0.08) - (isInsolvent ? 0.35 : 0) + (eventShock * 0.75),
        0, 1
    );

    const profile = pickIssuanceProfileFromHealth(fiscalHealthScore, isInsolvent);
    const auctionIntervalTicks = Math.max(6, Math.round(profile.intervalBase + (fiscalHealthScore * (isInsolvent ? 2 : 6)) + (activeConflictCount * 1.2)));

    if (((Number(currentTick || 0) + countryId) % auctionIntervalTicks) !== 0) return null;

    const activeBondCount = await database.collection('bonds').countDocuments({ world_id: worldId, country_id: countryId, is_active: true }, { session });

    const getBondCapForCountry = (gdpValue, insolvent) => {
        const g = Number(gdpValue || 0);
        if (insolvent) return Math.max(2, Math.floor(g / 50000));
        if (g >= 250000) return 10;
        if (g >= 150000) return 7;
        if (g >= 100000) return 5;
        if (g >= 60000)  return 4;
        return 3;
    };
    const maxActive = getBondCapForCountry(gdp, isInsolvent);

    if (activeBondCount >= maxActive) return null;

    const maturityTicks = Math.round(randomBetween(profile.maturityMin, profile.maturityMax));
    const faceValue = 100;
    const fixedProfitRate = calculateDurationProfitRate(maturityTicks);
    const issuePrice = faceValue;
    const issueUnits = Math.round(clamp((gdp / 850) * profile.qtyScale * (1 + (activeConflictCount * 0.14)) * (isInsolvent ? 1.35 : 1), 120, 1900));

    const bondId = await db.getNextId('bonds', session);
    let symbol = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = buildBondSymbolCandidate({ countryCode: countryState.country_code, symbolTag: profile.symbolTag, currentTick, sequenceId: bondId, attempt });
        const existing = await database.collection('bonds').findOne({ world_id: worldId, symbol: candidate }, { session });
        if (!existing) {
            symbol = candidate;
            break;
        }
    }

    if (!symbol) return null;

    const issueName = `${countryState.country_name} ${profile.typeLabel}`;
    
    await database.collection('bonds').insertOne({
        id: bondId,
        world_id: worldId,
        government_id: null,
        country_id: countryId,
        asset_id: -bondId,
        name: issueName,
        symbol,
        face_value: faceValue,
        current_value: issuePrice,
        interest_rate: fixedProfitRate,
        maturity_ticks: maturityTicks,
        ticks_remaining: maturityTicks,
        total_issued: issueUnits,
        is_active: true
    }, { session });

    const assetId = await db.getNextId('assets', session);
    await database.collection('assets').insertOne({
        id: assetId,
        world_id: worldId,
        asset_type: "bond",
        name: issueName,
        symbol,
        current_price: issuePrice,
        available_quantity: issueUnits,
        is_active: true
    }, { session });

    await database.collection('bonds').updateOne({ id: bondId }, { $set: { asset_id: assetId } }, { session });
    await database.collection('price_history').insertOne({
        world_id: worldId,
        asset_type: "bond",
        asset_id: assetId,
        price: issuePrice,
        volume: 0,
        world_tick: Number(currentTick || 0)
    }, { session });

    const proceeds = issuePrice * issueUnits;
    const eventSeverity = profile.riskLabel === 'distressed' ? 'major' : profile.riskLabel === 'speculative' ? 'moderate' : 'minor';

    const event = {
        eventType: 'sovereign_bond_auction',
        severity: eventSeverity,
        title: `Sovereign Auction: ${countryState.country_name}`,
        description: `${countryState.country_name} issued a ${profile.typeLabel} (${symbol}) with ${(fixedProfitRate * 100).toFixed(2)}% fixed maturity profit over ${maturityTicks} ticks, raising ${proceeds.toFixed(0)}.`,
        effects: {
            country_id: countryId,
            country_code: countryState.country_code,
            bond_id: bondId,
            bond_asset_id: assetId,
            bond_symbol: symbol,
            bond_type: profile.typeKey,
            risk_tier: profile.riskLabel,
            face_value: Number(faceValue.toFixed(2)),
            issue_price: Number(issuePrice.toFixed(4)),
            fixed_profit_rate: Number(fixedProfitRate.toFixed(6)),
            coupon_rate: Number(fixedProfitRate.toFixed(6)),
            maturity_ticks: maturityTicks,
            issuance_units: issueUnits,
            issuance_proceeds: Number(proceeds.toFixed(2)),
            fiscal_health_score: Number(fiscalHealthScore.toFixed(4)),
            auction_interval_ticks: auctionIntervalTicks
        },
        wsPayload: {
            type: 'news',
            title: `Sovereign Auction: ${countryState.country_name}`,
            description: `${profile.typeLabel} ${symbol} launched with ${(fixedProfitRate * 100).toFixed(2)}% fixed maturity profit (${profile.riskLabel}).`,
            severity: eventSeverity
        }
    };

    return { proceeds, event };
};

const processCountryFiscalState = async (session, worldId, currentTick, countryState, marketContext = {}) => {
    const database = db.getDb();
    const gdp = Number(countryState.gdp || 0);
    const population = Number(countryState.population || 0);
    const taxRate = Number(countryState.tax_rate || 0);
    const defenseStrength = Number(countryState.defense_strength || 0);

    let treasury = Number(countryState.treasury || 0);
    let stability = clamp(Number(countryState.stability || 0.5), 0, 1);
    let isInsolvent = Boolean(countryState.is_insolvent);

    const activeConflictCount = Number(marketContext.activeConflictsByCountry?.get(Number(countryState.country_id)) || 0);
    const countryEventShock = Number(marketContext.countryBondEventShocks?.get(Number(countryState.country_id)) || 0);
    const globalEventShock = Number(marketContext.globalBondEventShock || 0);
    const combinedEventShock = clamp(countryEventShock + globalEventShock, -0.14, 0.10);

    const pendingEvents = [];

    if (isInsolvent) {
        const emergencyAid = gdp * (0.0018 + (Math.random() * 0.0024));
        const insolvencyOperatingDrag = (defenseStrength * (0.014 + (activeConflictCount * 0.004))) + (population * 0.0000015);
        const stabilizationProgramBoost = Math.max(0, treasury - (gdp * 0.02)) * 0.00012;

        treasury = Math.max(0, treasury + emergencyAid + stabilizationProgramBoost - insolvencyOperatingDrag);

        const stabilityLift = 0.006 - (activeConflictCount * 0.0035) + (combinedEventShock * 0.32) + ((Math.random() - 0.5) * 0.004);
        stability = clamp(stability + stabilityLift, 0, 1);

        const reserveRatio = treasury / Math.max(gdp, 1);
        const recoveryThreshold = gdp * (0.02 + (activeConflictCount * 0.004));
        const canRecover = treasury > recoveryThreshold && stability > 0.14;
        const recoveryChance = clamp(0.18 + (stability * 0.45) + (reserveRatio * 1.8) - (activeConflictCount * 0.08), 0.12, 0.72);

        if (canRecover && Math.random() < recoveryChance) {
            treasury += gdp * 0.0011;
            stability = clamp(stability + 0.06, 0.18, 0.78);
            isInsolvent = false;
        }

        // Force recovery within 50-75 ticks of insolvency
        const insolvencyTick = Number(countryState.insolvency_tick || currentTick);
        const ticksInsolvent = currentTick - insolvencyTick;
        const forceRecovery = ticksInsolvent >= 50 + (Number(countryState.country_id || 0) % 26); // 50-75 range

        if (isInsolvent && forceRecovery) {
            isInsolvent = false;
            treasury = Math.max(treasury, gdp * 0.05);
            stability = Math.max(stability, 0.35);
        }

        if (isInsolvent) {
            const insolvencyBondResult = await processSovereignBonds(session, worldId, countryState, treasury, true);
            treasury = insolvencyBondResult.treasury;
        }
    }

    if (!isInsolvent) {
        const taxRevenue = (gdp * (taxRate + 0.014)) / 320;
        const defenseCost = defenseStrength * (0.031 + (activeConflictCount * 0.010));
        const socialCost = population * 0.0000060;
        const instabilityDrag = (1 - stability) * gdp * 0.00012;
        const globalRiskDrag = Math.max(0, -combinedEventShock) * gdp * 0.00018;
        const domesticDemandLift = stability * gdp * 0.000055;

        treasury = treasury + taxRevenue + domesticDemandLift - defenseCost - socialCost - instabilityDrag - globalRiskDrag;

        if (Math.random() < 0.012) {
            const shock = gdp * (0.00020 + (Math.random() * 0.00070));
            treasury = Math.max(0, treasury - shock);
            stability = clamp(stability - (0.008 + (Math.random() * 0.014)), 0, 1);

            pendingEvents.push({
                eventType: 'country_financial_turbulence',
                severity: 'moderate',
                title: `Financial Turbulence: ${countryState.country_name}`,
                description: `${countryState.country_name} absorbs a fiscal shock and risk premia jump across sovereign assets.`,
                effects: { country_code: countryState.country_code, treasury_shock: Number(shock.toFixed(2)) },
                wsPayload: { type: 'news', title: `Financial Turbulence: ${countryState.country_name}`, description: `${countryState.country_name} was hit by a treasury shock.`, severity: 'moderate' }
            });
        }

        const bondResult = await processSovereignBonds(session, worldId, countryState, treasury, false);
        treasury = bondResult.treasury;

        if (bondResult.defaulted) {
            isInsolvent = true;
            stability = clamp(stability - 0.10, 0, 1);
        }

        if (treasury <= 0) {
            const bailoutTriggered = Math.random() < 0.88;
            if (bailoutTriggered) {
                treasury = Math.max(2500, gdp * 0.012);
                stability = clamp(stability - 0.03, 0, 1);
            } else {
                isInsolvent = true;
                treasury = 0;
                stability = clamp(stability - 0.05, 0, 1);
            }
        } else {
            const reserveRatio = treasury / Math.max(gdp, 1);
            if (reserveRatio > 0.26) stability = clamp(stability + 0.007, 0, 1);
            else if (reserveRatio < 0.05) stability = clamp(stability - 0.006, 0, 1);
            else stability = clamp(stability + 0.0015, 0, 1);
        }
    }

    const issuanceResult = await maybeIssueSovereignBond(session, worldId, currentTick, countryState, {
        treasury, gdp, stability, isInsolvent, activeConflictCount, eventShock: combinedEventShock
    });

    if (issuanceResult) {
        treasury += Number(issuanceResult.proceeds || 0);
        pendingEvents.push(issuanceResult.event);
    }

    // Only enforce fixed bond pricing for non-wartime countries
    if (activeConflictCount === 0) {
        await enforceCountrySovereignBondFixedPricing(session, worldId, countryState);
    }

    if (isInsolvent) {
        const wasAlreadyInsolvent = Boolean(countryState.is_insolvent);
        const insolvencyTickValue = wasAlreadyInsolvent
            ? Number(countryState.insolvency_tick || currentTick)
            : currentTick;

        await database.collection('country_states').updateOne(
            { id: countryState.id },
            { $set: { is_insolvent: true, stability, treasury, insolvency_tick: insolvencyTickValue, updated_at: new Date().toISOString() } },
            { session }
        );

        if (!wasAlreadyInsolvent) {
            pendingEvents.push({
                eventType: 'country_insolvency',
                severity: 'major',
                title: `Sovereign Insolvency: ${countryState.country_name}`,
                description: `${countryState.country_name} has entered insolvency. Sovereign bond obligations are now defaulted.`,
                effects: { country_code: countryState.country_code, debt_status: 'defaulted' },
                wsPayload: { type: 'news', title: `Sovereign Insolvency: ${countryState.country_name}`, description: `${countryState.country_name} can no longer honor sovereign bond repayments.`, severity: 'major' }
            });
        }
    } else {
        await database.collection('country_states').updateOne(
            { id: countryState.id },
            { $set: { treasury, stability, is_insolvent: false, insolvency_tick: null, updated_at: new Date().toISOString() } },
            { session }
        );
    }

    for (const event of pendingEvents) {
        await insertWorldEvent(session, worldId, currentTick, event);
    }

    return pendingEvents.map((event) => event.wsPayload).filter(Boolean);
};

const maybeStartConflict = async (session, worldId, currentTick) => {
    const database = db.getDb();
    const activeCount = await database.collection('country_conflicts').countDocuments({ world_id: worldId, status: "active" }, { session });
    if (activeCount >= MAX_ACTIVE_CONFLICTS) return null;

    const conflicts = await database.collection('country_conflicts').find({ world_id: worldId, status: "active" }, { session }).toArray();
    const conflictPairs = new Set();
    for (const c of conflicts) {
        conflictPairs.add(`${Math.min(c.aggressor_country_id, c.defender_country_id)}-${Math.max(c.aggressor_country_id, c.defender_country_id)}`);
    }

    const relations = await database.collection('country_relations').find({ world_id: worldId, relation_level: { $in: ["hostile", "critical"] } }, { session }).toArray();
    
    // We need to fetch states to make sure they are active
    const activeStates = await database.collection('country_states').find({ world_id: worldId, is_active: true }, { session }).toArray();
    const activeCountryIds = new Set(activeStates.map(s => s.country_id));

    const validRelations = relations.filter(r => 
        !conflictPairs.has(`${Math.min(r.country_a_id, r.country_b_id)}-${Math.max(r.country_a_id, r.country_b_id)}`) &&
        activeCountryIds.has(r.country_a_id) && activeCountryIds.has(r.country_b_id)
    );

    if (validRelations.length === 0) return null;
    
    validRelations.sort((a, b) => {
        if (a.relation_level !== b.relation_level) {
            return a.relation_level === 'critical' ? -1 : 1;
        }
        return a.relation_score - b.relation_score;
    });
    
    // Pick from the worst relations
    const candidates = validRelations.slice(0, 3);
    const pair = candidates[Math.floor(Math.random() * candidates.length)];

    const levelMultiplier = pair.relation_level === 'critical' ? 1.8 : 1.2;
    const adjustedChance = BASE_CONFLICT_START_CHANCE * levelMultiplier * (1 + (0.18 * activeCount));
    if (Math.random() >= adjustedChance) return null;

    const aggressorCountryId = Math.random() < 0.5 ? Number(pair.country_a_id) : Number(pair.country_b_id);
    const defenderCountryId = aggressorCountryId === Number(pair.country_a_id) ? Number(pair.country_b_id) : Number(pair.country_a_id);
    
    const countryA = await database.collection('countries').findOne({ id: pair.country_a_id }, { session });
    const countryB = await database.collection('countries').findOne({ id: pair.country_b_id }, { session });
    const nameA = countryA ? countryA.name : `Country ${pair.country_a_id}`;
    const nameB = countryB ? countryB.name : `Country ${pair.country_b_id}`;

    const aggressorName = aggressorCountryId === pair.country_a_id ? nameA : nameB;
    const defenderName = defenderCountryId === pair.country_a_id ? nameA : nameB;

    const plannedDurationTicks = 5 + Math.floor(Math.random() * 9);

    const conflictId = await db.getNextId('country_conflicts', session);
    await database.collection('country_conflicts').insertOne({
        id: conflictId,
        world_id: worldId,
        aggressor_country_id: aggressorCountryId,
        defender_country_id: defenderCountryId,
        status: "active",
        started_tick: currentTick,
        planned_duration_ticks: plannedDurationTicks,
        ceasefire_chance: BASE_CEASEFIRE_CHANCE,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    }, { session });

    const stateA = activeStates.find(s => s.country_id === pair.country_a_id);
    const stateB = activeStates.find(s => s.country_id === pair.country_b_id);

    await database.collection('country_states').updateOne(
        { id: stateA.id }, { $set: { stability: Math.max(stateA.stability - 0.03, 0.05) } }, { session }
    );
    await database.collection('country_states').updateOne(
        { id: stateB.id }, { $set: { stability: Math.max(stateB.stability - 0.03, 0.05) } }, { session }
    );

    const conflictShock = pair.relation_level === 'critical' ? 8 : 13;
    const conflictStartScore = clamp(Number(pair.relation_score || -20) - conflictShock, -100, 100);
    const conflictStartLevel = relationLevelFromScore(conflictStartScore);
    await database.collection('country_relations').updateOne(
        { id: pair.id },
        { $set: { relation_score: conflictStartScore, relation_level: conflictStartLevel, last_incident_tick: currentTick, updated_at: new Date().toISOString() } },
        { session }
    );

    const event = {
        eventType: 'country_conflict_started',
        severity: 'major',
        title: `Conflict Ignites: ${aggressorName} vs ${defenderName}`,
        description: `Relations deteriorated to ${conflictStartLevel}. A sovereign conflict has started; ceasefire odds increase each day until peace is reached.`,
        effects: { aggressor_country_id: aggressorCountryId, defender_country_id: defenderCountryId, planned_duration_ticks: plannedDurationTicks, relation_score_after: Number(conflictStartScore.toFixed(2)), relation_level_after: conflictStartLevel },
        wsPayload: { type: 'news', title: `Conflict Ignites: ${aggressorName} vs ${defenderName}`, description: 'A new conflict started. Ceasefire probability now increases every day.', severity: 'major' }
    };

    await insertWorldEvent(session, worldId, currentTick, event);

    return { wsPayload: event.wsPayload, shouldBoostWarCommodities: true };
};

const resolveActiveConflicts = async (session, worldId, currentTick) => {
    const database = db.getDb();
    const conflicts = await database.collection('country_conflicts').find({ world_id: worldId, status: "active" }, { session }).sort({ started_tick: 1, id: 1 }).toArray();
    const notifications = [];

    for (const conflict of conflicts) {
        const sa = await database.collection('country_states').findOne({ world_id: worldId, country_id: conflict.aggressor_country_id }, { session });
        const sd = await database.collection('country_states').findOne({ world_id: worldId, country_id: conflict.defender_country_id }, { session });
        const ca = await database.collection('countries').findOne({ id: conflict.aggressor_country_id }, { session });
        const cd = await database.collection('countries').findOne({ id: conflict.defender_country_id }, { session });
        
        const relation = await database.collection('country_relations').findOne({
            world_id: worldId,
            country_a_id: Math.min(conflict.aggressor_country_id, conflict.defender_country_id),
            country_b_id: Math.max(conflict.aggressor_country_id, conflict.defender_country_id)
        }, { session });

        const elapsedTicks = Math.max(0, currentTick - Number(conflict.started_tick || 0));
        const ceasefireChance = clamp(BASE_CEASEFIRE_CHANCE + (elapsedTicks * DAILY_CEASEFIRE_INCREMENT), BASE_CEASEFIRE_CHANCE, MAX_CEASEFIRE_CHANCE);

        const aggressorWarCost = 125 + (Number(sa?.defense_strength || 0) * 0.010);
        const defenderWarCost = 125 + (Number(sd?.defense_strength || 0) * 0.010);

        if (sa) await database.collection('country_states').updateOne({ id: sa.id }, { $set: { treasury: Math.max(sa.treasury - aggressorWarCost, 0), stability: Math.max(sa.stability - 0.012, 0.05) } }, { session });
        if (sd) await database.collection('country_states').updateOne({ id: sd.id }, { $set: { treasury: Math.max(sd.treasury - defenderWarCost, 0), stability: Math.max(sd.stability - 0.010, 0.05) } }, { session });

        // Reduce bond market prices (not face value) for wartime countries
        try {
            const warBonds = await database.collection('bonds').find(
                { world_id: worldId, country_id: { $in: [conflict.aggressor_country_id, conflict.defender_country_id] }, is_active: true },
                { session }
            ).toArray();
            for (const bond of warBonds) {
                const warPrice = Math.max(Number(bond.current_value || 100) * 0.85, 1);
                await database.collection('bonds').updateOne({ id: bond.id }, { $set: { current_value: warPrice } }, { session });
                if (bond.asset_id && Number(bond.asset_id) > 0) {
                    await database.collection('assets').updateOne({ id: bond.asset_id }, { $set: { current_price: warPrice } }, { session });
                }
            }
        } catch (warBondErr) {
            console.error('War bond price reduction error:', warBondErr);
        }

        const durationReached = elapsedTicks >= Number(conflict.planned_duration_ticks || 0);
        const ceasefireTriggered = Math.random() < ceasefireChance;

        if (!durationReached && !ceasefireTriggered) {
            await database.collection('country_conflicts').updateOne({ id: conflict.id }, { $set: { ceasefire_chance: ceasefireChance } }, { session });
            continue;
        }

        const aggressorScore = Number(sa?.defense_strength || 0) * (0.55 + Number(sa?.stability || 0)) * (0.85 + (Math.random() * 0.35));
        const defenderScore = Number(sd?.defense_strength || 0) * (0.58 + Number(sd?.stability || 0)) * (0.85 + (Math.random() * 0.35));

        const aggressorWon = aggressorScore >= defenderScore;
        const winnerCountryId = aggressorWon ? conflict.aggressor_country_id : conflict.defender_country_id;
        const loserCountryId = aggressorWon ? conflict.defender_country_id : conflict.aggressor_country_id;
        const winnerName = aggressorWon ? ca?.name : cd?.name;
        const loserName = aggressorWon ? cd?.name : ca?.name;

        const loserTreasury = aggressorWon ? Number(sd?.treasury || 0) : Number(sa?.treasury || 0);
        const winnerGdp = aggressorWon ? Number(sa?.gdp || 0) : Number(sd?.gdp || 0);

        const wealthTransfer = Math.max(1200, Math.min(loserTreasury * 0.16, (winnerGdp * 0.018) + 8000));

        const winnerState = aggressorWon ? sa : sd;
        const loserState = aggressorWon ? sd : sa;

        if (winnerState) await database.collection('country_states').updateOne({ id: winnerState.id }, { $set: { treasury: winnerState.treasury + wealthTransfer, stability: Math.min(winnerState.stability + 0.04, 1.0), defense_strength: winnerState.defense_strength * 1.02 } }, { session });
        if (loserState) await database.collection('country_states').updateOne({ id: loserState.id }, { $set: { treasury: Math.max(loserState.treasury - wealthTransfer, 0), stability: Math.max(loserState.stability - 0.09, 0.02), defense_strength: Math.max(loserState.defense_strength * 0.95, 50) } }, { session });

        const terminalStatus = ceasefireTriggered && !durationReached ? 'ceasefire' : 'resolved';
        await database.collection('country_conflicts').updateOne(
            { id: conflict.id },
            { $set: { status: terminalStatus, ceasefire_chance: ceasefireChance, winner_country_id: winnerCountryId, loser_country_id: loserCountryId, wealth_transfer: wealthTransfer, resolved_tick: currentTick } },
            { session }
        );

        if (relation) {
            const relationBaseScore = Number(relation.relation_score || -45);
            const relationRecovery = terminalStatus === 'ceasefire' ? 14 : 8;
            const relationAfterResolution = clamp(relationBaseScore + relationRecovery, -100, 100);
            const relationAfterLevel = relationLevelFromScore(relationAfterResolution);

            await database.collection('country_relations').updateOne(
                { id: relation.id },
                { $set: { relation_score: relationAfterResolution, relation_level: relationAfterLevel, last_incident_tick: currentTick, updated_at: new Date().toISOString() } },
                { session }
            );
        }

        const event = {
            eventType: 'country_conflict_resolved',
            severity: 'major',
            title: `Conflict Ends: ${winnerName} over ${loserName}`,
            description: `${winnerName} secured terms and transferred ${wealthTransfer.toFixed(0)} treasury units from ${loserName}. No country was eliminated.`,
            effects: { winner_country_id: winnerCountryId, loser_country_id: loserCountryId, wealth_transfer: Number(wealthTransfer.toFixed(2)), ceasefire_resolution: terminalStatus === 'ceasefire' },
            wsPayload: { type: 'news', title: `Conflict Ends: ${winnerName} over ${loserName}`, description: `${winnerName} extracted ${wealthTransfer.toFixed(0)} from ${loserName}.`, severity: 'major' }
        };

        await insertWorldEvent(session, worldId, currentTick, event);
        notifications.push(event.wsPayload);
    }

    return notifications;
};

const processGovernments = async (worldId) => {
    try {
        // Run ensure functions WITHOUT any transaction.
        // ensureCountryStates/Relations call getNextId (writes to counters collection).
        // Running getNextId inside a transaction causes write conflicts with every
        // other concurrent tick transaction that also calls getNextId.
        // These functions are idempotent (use $setOnInsert + upsert) so no transaction needed.
        const database = db.getDb();
        const hasStates = await database.collection('country_states').countDocuments({ world_id: worldId });
        if (hasStates === 0) {
            // Pass null session — runs outside any transaction
            await ensureCountryStates(null, worldId);
        }
        const hasRelations = await database.collection('country_relations').countDocuments({ world_id: worldId });
        if (hasRelations === 0) {
            await ensureCountryRelations(null, worldId);
        }

        // Get current tick outside the transaction to reduce transaction scope
        const worldDoc = await database.collection('worlds').findOne({ id: worldId });
        const currentTick = Number(worldDoc?.current_tick || 0);

        const countryStates = await database.collection('country_states').aggregate([
            { $match: { world_id: worldId, is_active: true } },
            { $lookup: { from: 'countries', localField: 'country_id', foreignField: 'id', as: 'country_info' } },
            { $unwind: { path: '$country_info', preserveNullAndEmptyArrays: true } },
            { $addFields: { country_name: '$country_info.name', country_code: '$country_info.code' } },
            { $sort: { country_id: 1 } }
        ]).toArray();

        // Process each country in its own transaction to reduce conflict surface
        const pendingNotifications = [];
        let pendingWarCommodityBoost = false;
        for (const countryState of countryStates) {
            try {
                await db.withTransaction(async (session) => {
                    const activeConflictsByCountry = await buildCountryConflictExposureMap(session, worldId);
                    const { countryBondEventShocks, globalBondEventShock } = await buildCountryBondEventShockMap(session, worldId, currentTick);
                    const notifications = await processCountryFiscalState(session, worldId, currentTick, countryState, {
                        activeConflictsByCountry, countryBondEventShocks, globalBondEventShock
                    });
                    pendingNotifications.push(...notifications);
                });
            } catch (err) {
                console.error(`Country fiscal state error (country ${countryState.country_id}):`, err);
            }
        }

        // Diplomatic and conflict events in their own transaction
        try {
            await db.withTransaction(async (session) => {
                const incidentNotification = await maybeTriggerRelationIncident(session, worldId, currentTick);
                if (incidentNotification) pendingNotifications.push(incidentNotification);

                const startedConflictResult = await maybeStartConflict(session, worldId, currentTick);
                if (startedConflictResult?.wsPayload) pendingNotifications.push(startedConflictResult.wsPayload);
                if (startedConflictResult?.shouldBoostWarCommodities) {
                    pendingWarCommodityBoost = true;
                }

                const resolvedConflictNotifications = await resolveActiveConflicts(session, worldId, currentTick);
                pendingNotifications.push(...resolvedConflictNotifications);
            });
        } catch (err) {
            console.error(`Conflict processing error (world ${worldId}):`, err);
        }

        if (pendingWarCommodityBoost) {
            try {
                await applyWarCommodityBoost(worldId);
            } catch (warCommodityErr) {
                console.error('War commodity boost error:', warCommodityErr);
            }
        }

        for (const message of pendingNotifications) {
            wsHandler.broadcastToWorld(worldId, message);
        }
    } catch (err) {
        console.error('Country-state tick error:', err);
    }
};

module.exports = { processGovernments };
