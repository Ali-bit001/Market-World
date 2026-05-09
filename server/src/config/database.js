const path = require('path');
const { MongoClient } = require('mongodb');
const {
  initializeMongoDatabase,
  DEFAULT_MONGODB_URI,
  DEFAULT_DB_NAME,
  resolveMongoUri
} = require('../../database/init_mongo');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const MONGODB_URI = resolveMongoUri(process.env.MONGODB_URI || DEFAULT_MONGODB_URI);
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || process.env.DB_NAME || DEFAULT_DB_NAME;

let mongoClient = null;
let mongoDb = null;
let initPromise = null;

const createMongoClient = () => new MongoClient(MONGODB_URI, {
  maxPoolSize: 50,
  minPoolSize: 5,
  connectTimeoutMS: 10000,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 30000
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const initialize = async () => {
  if (initPromise) return initPromise;
  
  initPromise = (async () => {
    const maxRetries = Math.max(0, Number(process.env.MONGODB_CONNECT_RETRIES || 4));
    const baseDelayMs = Math.max(100, Number(process.env.MONGODB_CONNECT_RETRY_DELAY_MS || 500));

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const client = createMongoClient();

      try {
        await client.connect();
        mongoClient = client;
        mongoDb = mongoClient.db(MONGODB_DB_NAME);

        await initializeMongoDatabase({
          client: mongoClient,
          db: mongoDb
        });

        return;
      } catch (error) {
        await client.close().catch(() => {});
        mongoClient = null;
        mongoDb = null;

        if (attempt >= maxRetries) {
          throw error;
        }

        const delay = baseDelayMs * Math.pow(2, attempt);
        await wait(delay);
      }
    }
  })().catch(error => {
    initPromise = null;
    throw error;
  });

  return initPromise;
};

const getDb = () => {
  if (!mongoDb) throw new Error('Database not initialized. Call await initialize() first.');
  return mongoDb;
};

const getClient = () => {
  if (!mongoClient) throw new Error('Database not initialized. Call await initialize() first.');
  return mongoClient;
};

const getNextId = async (collectionName, session = null) => {
    const db = getDb();
    let lastError = null;
    
    // ID generation always runs outside any transaction - it doesn't need isolation
    // Passing a session would cause write conflicts with concurrent tick operations
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const result = await db.collection('counters').findOneAndUpdate(
                { _id: collectionName },
                { $inc: { seq: 1 } },
                { returnDocument: 'after', upsert: true }
            );
            return result.seq || result.value?.seq;
        } catch (err) {
            lastError = err;
            if (err.code !== 112) {
                throw err;
            }
            await new Promise(r => setTimeout(r, 10 + attempt * 10));
        }
    }
    throw lastError;
};

const withTransaction = async (callback, { maxRetries = 5 } = {}) => {
  const client = getClient();

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const session = client.startSession();

    try {
      // maxTimeMS: 8 seconds per transaction attempt.
      // Without this, session.withTransaction() can hang for up to 120s
      // waiting for a lock held by a concurrent tick transaction.
      return await session.withTransaction(
        () => callback(session),
        { maxCommitTimeMS: 8000 }
      );
    } catch (error) {
      const labels = Array.isArray(error?.errorLabels) ? error.errorLabels : [];
      const isTransient = labels.includes('TransientTransactionError');
      const isWriteConflict = error?.code === 112;
      // MaxTimeMSExpired = code 50
      const isTimeout = error?.code === 50 || error?.codeName === 'MaxTimeMSExpired';

      if ((!isTransient && !isWriteConflict && !isTimeout) || attempt === maxRetries - 1) {
        throw error;
      }

      // Exponential backoff: 20ms, 40ms, 80ms, 160ms, 320ms
      const delay = 20 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
    } finally {
      await session.endSession();
    }
  }
};

const end = async () => {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    mongoDb = null;
    initPromise = null;
  }
};

module.exports = {
  initialize,
  getDb,
  getClient,
  getNextId,
  withTransaction,
  end
};
