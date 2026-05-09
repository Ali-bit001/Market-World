const { MongoClient } = require('mongodb');
const { resolveMongoUri, DEFAULT_MONGODB_URI, DEFAULT_DB_NAME } = require('../database/init_mongo');

require('dotenv').config({ path: './.env' });

const boundsBySymbol = {
  OIL: { base: 75, max: 260 },
  WHT: { base: 6.5, max: 22 },
  RCE: { base: 14, max: 48 },
  WOD: { base: 450, max: 1600 },
  STL: { base: 800, max: 2800 },
  GLD: { base: 1950, max: 6200 },
  CPR: { base: 3.8, max: 14 },
  GAS: { base: 2.75, max: 11 },
  COF: { base: 1.85, max: 7.2 },
  CTN: { base: 0.82, max: 3.3 }
};

const run = async () => {
  const uri = resolveMongoUri(process.env.MONGODB_URI || DEFAULT_MONGODB_URI);
  const dbName = process.env.MONGODB_DB_NAME || process.env.DB_NAME || DEFAULT_DB_NAME;
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db(dbName);
    const commodities = await db.collection('commodities').find(
      {},
      { projection: { id: 1, symbol: 1, base_price: 1, current_price: 1, max_price: 1 } }
    ).toArray();

    const bulk = [];
    for (const c of commodities) {
      const symbol = String(c.symbol || '').toUpperCase();
      const configured = boundsBySymbol[symbol];
      const base = configured
        ? configured.base
        : Math.max(Number(c.base_price ?? c.current_price ?? 0.01), 0.01);
      const max = configured
        ? configured.max
        : Math.max(base * 5, base + 1);

      bulk.push({
        updateOne: {
          filter: { id: c.id },
          update: { $set: { base_price: base, min_price: base, max_price: max } }
        }
      });
    }

    const result = bulk.length > 0
      ? await db.collection('commodities').bulkWrite(bulk)
      : { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };

    console.log(JSON.stringify({
      dbName,
      totalCommodities: commodities.length,
      matched: result.matchedCount,
      modified: result.modifiedCount,
      upserts: result.upsertedCount || 0
    }, null, 2));
  } finally {
    await client.close();
  }
};

run().catch((err) => {
  console.error('Failed to update commodity bounds:', err);
  process.exit(1);
});
