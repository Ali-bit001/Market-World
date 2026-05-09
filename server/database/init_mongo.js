const path = require('path');
const { MongoClient } = require('mongodb');
const {
  TABLE_NAMES,
  UNIQUE_INDEXES,
  SECONDARY_INDEXES,
  SEED_SECTORS,
  SEED_WORLD,
  SEED_COUNTRIES,
  SEED_STOCK_MARKETS,
  SEED_COMMODITIES,
  SEED_CRYPTOS
} = require('./mongo.constants');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const DEFAULT_MONGODB_URI =
  'mongodb+srv://malirizwan2006_db_user:<db_password>@cluster0.cwtsjii.mongodb.net/?appName=Cluster0';
const DEFAULT_DB_NAME = 'market_world';

const resolveMongoUri = (rawUri) => {
  const uri = String(rawUri || '').trim();
  if (!uri) {
    throw new Error('MongoDB URI is empty. Set MONGODB_URI in server/.env.');
  }

  if (!uri.includes('<db_password>')) {
    return uri;
  }

  const rawPassword = String(process.env.MONGODB_PASSWORD || process.env.DB_PASSWORD || '').trim();
  if (!rawPassword) {
    throw new Error(
      'MONGODB_URI contains <db_password>. Set MONGODB_PASSWORD (or replace <db_password> directly in MONGODB_URI).'
    );
  }

  return uri.replace('<db_password>', encodeURIComponent(rawPassword));
};

const withAuditFields = (row, nowIso) => ({
  ...row,
  created_at: row.created_at || nowIso,
  updated_at: nowIso
});

const buildSeedPayload = () => {
  const nowIso = new Date().toISOString();

  const worlds = [withAuditFields({ ...SEED_WORLD }, nowIso)];

  const countries = SEED_COUNTRIES.map((country) => withAuditFields({ ...country }, nowIso));
  const countryIdByCode = new Map(countries.map((country) => [country.code, country.id]));

  const stockMarkets = SEED_STOCK_MARKETS.map((market) => {
    const countryId = countryIdByCode.get(market.country_code);

    return withAuditFields(
      {
        id: market.id,
        world_id: market.world_id,
        country_id: countryId,
        code: market.code,
        name: market.name,
        city: market.city,
        latitude: market.latitude,
        longitude: market.longitude,
        currency: market.currency,
        benchmark_name: market.benchmark_name,
        benchmark_level: market.benchmark_level,
        min_listing_capital: market.min_listing_capital,
        listing_tier: market.listing_tier,
        is_active: market.is_active
      },
      nowIso
    );
  });

  const commodityAssets = SEED_COMMODITIES.map((commodity, index) =>
    withAuditFields(
      {
        id: index + 1,
        world_id: commodity.world_id,
        asset_type: 'commodity',
        name: commodity.name,
        symbol: commodity.symbol,
        current_price: commodity.current_price,
        available_quantity: commodity.total_supply,
        is_active: true
      },
      nowIso
    )
  );

  const cryptosAssetOffset = commodityAssets.length;
  const cryptoAssets = SEED_CRYPTOS.map((crypto, index) =>
    withAuditFields(
      {
        id: cryptosAssetOffset + index + 1,
        world_id: crypto.world_id,
        asset_type: 'crypto',
        name: crypto.name,
        symbol: crypto.symbol,
        current_price: crypto.current_price,
        available_quantity: crypto.circulating_supply,
        is_active: true
      },
      nowIso
    )
  );

  const assets = [...commodityAssets, ...cryptoAssets];
  const assetIdBySymbol = new Map(assets.map((asset) => [asset.symbol, asset.id]));

  const commodities = SEED_COMMODITIES.map((commodity) =>
    withAuditFields(
      {
        ...commodity,
        asset_id: assetIdBySymbol.get(commodity.symbol)
      },
      nowIso
    )
  );

  const cryptos = SEED_CRYPTOS.map((crypto) =>
    withAuditFields(
      {
        ...crypto,
        asset_id: assetIdBySymbol.get(crypto.symbol)
      },
      nowIso
    )
  );

  const seededCountryIds = [...new Set(stockMarkets.map((market) => market.country_id))];
  const countryStates = seededCountryIds.map((countryId, index) =>
    withAuditFields(
      {
        id: index + 1,
        world_id: 1,
        country_id: countryId,
        treasury: 165000 + (countryId % 9) * 14000,
        tax_rate: 0.11 + (countryId % 6) * 0.01,
        stability: Math.min(0.95, 0.62 + (countryId % 7) * 0.045),
        defense_strength: 420 + (countryId % 11) * 45,
        gdp: 78000 + (countryId % 13) * 13500,
        population: 900000 + (countryId % 17) * 150000,
        is_insolvent: false,
        is_active: true
      },
      nowIso
    )
  );

  return {
    sectors: SEED_SECTORS.map((sector) => withAuditFields({ ...sector }, nowIso)),
    worlds,
    countries,
    stock_markets: stockMarkets,
    assets,
    commodities,
    cryptos,
    country_states: countryStates
  };
};

const createDocument = (tableName, row, ordinal) => {
  const document = { ...row };

  if (document.id !== undefined && document.id !== null) {
    document._id = `${tableName}:${document.id}`;
  } else {
    document._id = `${tableName}:auto:${ordinal}`;
  }

  return document;
};

const ensureIndexes = async (db) => {
  for (const tableName of TABLE_NAMES) {
    const collection = db.collection(tableName);
    await collection.createIndex({ id: 1 }, { unique: true, sparse: true, name: 'uk_id' });

    const uniqueIndexSets = UNIQUE_INDEXES[tableName] || [];
    for (const uniqueSet of uniqueIndexSets) {
      const key = {};
      for (const field of uniqueSet) {
        key[field] = 1;
      }

      await collection.createIndex(key, {
        unique: true,
        sparse: true,
        name: `uk_${uniqueSet.join('_')}`
      });
    }

    const secondaryIndexes = SECONDARY_INDEXES[tableName] || [];
    for (const indexDef of secondaryIndexes) {
      const keys = indexDef?.keys;
      if (!keys || typeof keys !== 'object') {
        continue;
      }

      await collection.createIndex(keys, indexDef?.options || {});
    }
  }
};

const getCollectionSeedFilter = (tableName, row) => {
  const uniqueSets = UNIQUE_INDEXES[tableName] || [];
  const filters = [];

  for (const uniqueSet of uniqueSets) {
    const hasAllFields = uniqueSet.every((field) => row[field] !== undefined && row[field] !== null);
    if (!hasAllFields) continue;
    const filter = {};
    for (const field of uniqueSet) filter[field] = row[field];
    filters.push(filter);
  }

  if (row.id !== undefined && row.id !== null) filters.push({ id: row.id });
  if (row._id !== undefined && row._id !== null) filters.push({ _id: row._id });

  if (filters.length === 0) return null;
  if (filters.length === 1) return filters[0];
  return { $or: filters };
};

const seedIfEmpty = async (db, options = {}) => {
  const worldsCount = await db.collection('worlds').countDocuments();
  if (worldsCount > 0 && !options.forceReseed) {
    return { seeded: false, reason: 'worlds-not-empty' };
  }

  if (options.forceReseed) {
    for (const tableName of TABLE_NAMES) {
      await db.collection(tableName).deleteMany({});
    }
    await db.collection('counters').deleteMany({});
  }

  const payload = buildSeedPayload();
  for (const [tableName, rows] of Object.entries(payload)) {
    if (!rows.length) {
      continue;
    }

    const collection = db.collection(tableName);

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const document = createDocument(tableName, row, index + 1);
      const filter = getCollectionSeedFilter(tableName, row);
      try {
        if (filter) {
          await collection.updateOne(filter, { $setOnInsert: document }, { upsert: true });
        } else {
          await collection.updateOne({ _id: document._id }, { $setOnInsert: document }, { upsert: true });
        }
      } catch (error) {
        if (error?.code === 11000 && error?.keyValue && typeof error.keyValue === 'object') {
          await collection.updateOne(error.keyValue, { $setOnInsert: document }, { upsert: true });
        } else {
          throw error;
        }
      }
    }

    const maxId = rows.reduce((max, r) => Math.max(max, r.id || 0), 0);
    if (maxId >= 0) {
      const existingMaxId = await collection
        .find({ id: { $type: 'number' } }, { projection: { id: 1 } })
        .sort({ id: -1 })
        .limit(1)
        .toArray()
        .then((docs) => Number(docs[0]?.id || 0));
      const nextCounter = Math.max(maxId, existingMaxId);

      await db.collection('counters').updateOne(
        { _id: tableName },
        { $set: { seq: nextCounter } },
        { upsert: true }
      );
    }
  }

  return {
    seeded: true,
    seededTables: Object.keys(payload)
  };
};

const ensureCommodityPriceBounds = async (db) => {
  const commodities = await db.collection('commodities').find(
    { $or: [{ base_price: { $exists: false } }, { max_price: { $exists: false } }] },
    { projection: { id: 1, current_price: 1, base_price: 1, max_price: 1 } }
  ).toArray();

  if (commodities.length === 0) {
    return;
  }

  const bulk = [];
  for (const commodity of commodities) {
    const currentPrice = Number(commodity.current_price || 0.01);
    const basePrice = Number.isFinite(Number(commodity.base_price))
      ? Number(commodity.base_price)
      : Math.max(currentPrice, 0.01);
    const maxPrice = Number.isFinite(Number(commodity.max_price))
      ? Number(commodity.max_price)
      : Math.max(basePrice * 5, basePrice + 1);

    bulk.push({
      updateOne: {
        filter: { id: commodity.id },
        update: { $set: { base_price: basePrice, max_price: maxPrice } }
      }
    });
  }

  if (bulk.length > 0) {
    await db.collection('commodities').bulkWrite(bulk);
  }
};

const initializeMongoDatabase = async (options = {}) => {
  const uri = resolveMongoUri(options.uri || process.env.MONGODB_URI || DEFAULT_MONGODB_URI);
  const dbName = options.dbName || process.env.MONGODB_DB_NAME || process.env.DB_NAME || DEFAULT_DB_NAME;
  const externalClient = options.client;

  const client =
    externalClient ||
    new MongoClient(uri, {
      maxPoolSize: 50,
      minPoolSize: 5,
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 30000
    });

  if (!externalClient) {
    await client.connect();
  }

  const db = options.db || client.db(dbName);

  try {
    await ensureIndexes(db);
    const seedResult = await seedIfEmpty(db, { forceReseed: Boolean(options.forceReseed) });
    await ensureCommodityPriceBounds(db);

    return {
      dbName,
      seeded: seedResult.seeded,
      seededTables: seedResult.seededTables || [],
      reason: seedResult.reason || null
    };
  } finally {
    if (!externalClient) {
      await client.close();
    }
  }
};

if (require.main === module) {
  const forceReseed = process.argv.includes('--force-reseed') || process.argv.includes('--force');
  initializeMongoDatabase({ forceReseed })
    .then((result) => {
      console.log('MongoDB initialization complete:', result);
      process.exit(0);
    })
    .catch((error) => {
      console.error('MongoDB initialization failed:', error);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_MONGODB_URI,
  DEFAULT_DB_NAME,
  resolveMongoUri,
  initializeMongoDatabase
};
