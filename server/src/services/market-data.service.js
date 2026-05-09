const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ALPHAVANTAGE_API_KEY || process.env.ALPHA_VANTAGE_API_KEY || '';
const CACHE_PATH = path.resolve(__dirname, '../../database/market_prices_cache.json');

const ALPHA_DAILY_LIMIT = Math.max(1, Number(process.env.ALPHAVANTAGE_DAILY_LIMIT || 25));
const ALPHA_TIMEOUT_MS = 12000;
const YAHOO_TIMEOUT_MS = 7000;
const MAX_REMOTE_SYMBOL_FETCH_PER_CALL = Math.max(0, Number(process.env.MARKET_DATA_REMOTE_SYMBOLS_PER_CALL || 3));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeNumber = (value, fallback = 0) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizePositive = (value, fallback = 0) => {
    const numeric = normalizeNumber(value, fallback);
    return numeric > 0 ? numeric : fallback;
};

const normalizeSymbol = (symbol) => String(symbol || '').trim().toUpperCase();

const getTodayKey = (date = new Date()) => date.toISOString().slice(0, 10);

const getDayProgress = (date = new Date()) => {
    const seconds = (
        (date.getUTCHours() * 3600) +
        (date.getUTCMinutes() * 60) +
        date.getUTCSeconds() +
        (date.getUTCMilliseconds() / 1000)
    );
    return clamp(seconds / 86400, 0, 1);
};

const createEmptyCache = () => ({
    symbols: {},
    meta: {
        alphaBudget: {
            date: '',
            used: 0
        },
        updatedAt: new Date().toISOString()
    }
});

const readCache = () => {
    try {
        if (!fs.existsSync(CACHE_PATH)) {
            return createEmptyCache();
        }
        const raw = fs.readFileSync(CACHE_PATH, 'utf8');
        const parsed = JSON.parse(raw || '{}');
        if (!parsed || typeof parsed !== 'object') {
            return createEmptyCache();
        }

        if (!parsed.symbols || typeof parsed.symbols !== 'object') {
            parsed.symbols = {};
        }
        if (!parsed.meta || typeof parsed.meta !== 'object') {
            parsed.meta = {};
        }
        if (!parsed.meta.alphaBudget || typeof parsed.meta.alphaBudget !== 'object') {
            parsed.meta.alphaBudget = { date: '', used: 0 };
        }

        return parsed;
    } catch {
        return createEmptyCache();
    }
};

const writeCache = (cache) => {
    try {
        const directory = path.dirname(CACHE_PATH);
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        cache.meta = cache.meta || {};
        cache.meta.updatedAt = new Date().toISOString();
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    } catch {
        // best effort cache write
    }
};

const buildSymbolEntry = (symbol, source, dailyRows, fetchedAt) => {
    const snapshot = extractDailySnapshot(dailyRows);
    return {
        symbol,
        source,
        fetchedAt: fetchedAt || new Date().toISOString(),
        fetchedDate: getTodayKey(),
        dailyRows,
        snapshot
    };
};

const normalizeDailyRows = (rows) => {
    if (!Array.isArray(rows)) {
        return [];
    }

    return rows
        .map((row) => ({
            date: String(row.date || ''),
            open: normalizePositive(row.open, 0),
            high: normalizePositive(row.high, 0),
            low: normalizePositive(row.low, 0),
            close: normalizePositive(row.close, 0)
        }))
        .filter((row) => row.date && row.close > 0)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 20);
};

const extractDailySnapshot = (dailyRows) => {
    const normalizedRows = normalizeDailyRows(dailyRows);
    if (normalizedRows.length === 0) {
        return null;
    }

    const latest = normalizedRows[0];
    const previous = normalizedRows[1] || latest;

    const open = normalizePositive(latest.open, latest.close);
    const close = normalizePositive(latest.close, open);
    const high = normalizePositive(latest.high, Math.max(open, close));
    const low = normalizePositive(latest.low, Math.min(open, close));
    const prevClose = normalizePositive(previous.close, open);

    return {
        asOfDate: latest.date,
        open,
        high: Math.max(high, open, close),
        low: Math.max(0.00000001, Math.min(low, open, close)),
        close,
        prevClose
    };
};

const computeTickPriceFromSnapshot = (snapshot, date = new Date()) => {
    if (!snapshot) {
        return 0;
    }

    const open = normalizePositive(snapshot.open, 0);
    const close = normalizePositive(snapshot.close, open || 0);
    const high = normalizePositive(snapshot.high, Math.max(open, close));
    const low = Math.max(0.00000001, normalizePositive(snapshot.low, Math.min(open || close, close)));
    const prevClose = normalizePositive(snapshot.prevClose, open || close);

    const progress = getDayProgress(date);
    const trendBase = prevClose + ((close - prevClose) * progress);
    const intradayAmplitude = Math.max((high - low) * 0.18, (trendBase * 0.0012));
    const wave = Math.sin(progress * Math.PI * 2) * intradayAmplitude;

    const computed = trendBase + wave;
    const floor = Math.max(0.00000001, Math.min(low, prevClose, close) * 0.985);
    const ceiling = Math.max(floor, Math.max(high, prevClose, close) * 1.015);
    return clamp(computed, floor, ceiling);
};

const applyAlphaBudget = (cache) => {
    const today = getTodayKey();
    cache.meta = cache.meta || {};
    cache.meta.alphaBudget = cache.meta.alphaBudget || { date: today, used: 0 };

    if (cache.meta.alphaBudget.date !== today) {
        cache.meta.alphaBudget = { date: today, used: 0 };
    }

    const used = Math.max(0, Number(cache.meta.alphaBudget.used || 0));
    const remaining = Math.max(0, ALPHA_DAILY_LIMIT - used);
    return {
        remaining,
        consume: (count = 1) => {
            cache.meta.alphaBudget.used = used + Math.max(1, Number(count || 1));
        }
    };
};

const fetchAlphaVantageDaily = async (symbol) => {
    if (!API_KEY) {
        return null;
    }

    const safeSymbol = normalizeSymbol(symbol);
    if (!safeSymbol) {
        return null;
    }

    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(safeSymbol)}&outputsize=compact&apikey=${encodeURIComponent(API_KEY)}`;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(ALPHA_TIMEOUT_MS) });
        if (!response.ok) {
            return null;
        }

        const payload = await response.json();
        if (payload?.Note || payload?.Information || payload?.ErrorMessage) {
            return null;
        }

        const series = payload?.['Time Series (Daily)'];
        if (!series || typeof series !== 'object') {
            return null;
        }

        const rows = normalizeDailyRows(
            Object.entries(series).map(([date, values]) => ({
                date,
                open: values?.['1. open'],
                high: values?.['2. high'],
                low: values?.['3. low'],
                close: values?.['4. close']
            }))
        );
        return rows.length > 0 ? rows : null;
    } catch {
        return null;
    }
};

const fetchYahooDaily = async (symbol) => {
    const safeSymbol = normalizeSymbol(symbol);
    if (!safeSymbol) {
        return null;
    }

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(safeSymbol)}?interval=1d&range=1mo`;
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
            headers: { 'User-Agent': 'Mozilla/5.0 MarketWorld/1.0' }
        });
        if (!response.ok) {
            return null;
        }

        const payload = await response.json();
        const result = payload?.chart?.result?.[0];
        const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
        const quote = result?.indicators?.quote?.[0] || {};
        const opens = Array.isArray(quote.open) ? quote.open : [];
        const highs = Array.isArray(quote.high) ? quote.high : [];
        const lows = Array.isArray(quote.low) ? quote.low : [];
        const closes = Array.isArray(quote.close) ? quote.close : [];

        const rows = [];
        for (let index = 0; index < timestamps.length; index += 1) {
            const timestamp = Number(timestamps[index] || 0);
            const close = normalizePositive(closes[index], 0);
            if (!close || !Number.isFinite(timestamp) || timestamp <= 0) {
                continue;
            }

            const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
            rows.push({
                date,
                open: normalizePositive(opens[index], close),
                high: normalizePositive(highs[index], close),
                low: normalizePositive(lows[index], close),
                close
            });
        }

        const normalized = normalizeDailyRows(rows);
        return normalized.length > 0 ? normalized : null;
    } catch {
        return null;
    }
};

const shouldRefreshToday = (entry) => {
    if (!entry || typeof entry !== 'object') {
        return true;
    }
    const today = getTodayKey();
    return String(entry.fetchedDate || '') !== today;
};

const getCachedPrice = (entry, fallback = 0) => {
    const snapshot = entry?.snapshot;
    const tickPrice = computeTickPriceFromSnapshot(snapshot);
    if (tickPrice > 0) {
        return tickPrice;
    }
    return normalizePositive(fallback, 0);
};

const resolveSymbolEntry = async (cache, symbol, fallbackPrice = 0, allowAlpha = true, allowRemote = true) => {
    const safeSymbol = normalizeSymbol(symbol);
    if (!safeSymbol) {
        return null;
    }

    let entry = cache.symbols[safeSymbol] || null;
    if (!shouldRefreshToday(entry)) {
        return entry;
    }

    const budget = applyAlphaBudget(cache);
    let dailyRows = null;
    let source = null;

    if (allowRemote && allowAlpha && API_KEY && budget.remaining > 0) {
        dailyRows = await fetchAlphaVantageDaily(safeSymbol);
        if (dailyRows && dailyRows.length > 0) {
            source = 'alphavantage_daily';
            budget.consume(1);
        }
    }

    if (allowRemote && (!dailyRows || dailyRows.length === 0)) {
        dailyRows = await fetchYahooDaily(safeSymbol);
        if (dailyRows && dailyRows.length > 0) {
            source = 'yahoo_daily';
        }
    }

    if (dailyRows && dailyRows.length > 0) {
        entry = buildSymbolEntry(safeSymbol, source, dailyRows, new Date().toISOString());
        cache.symbols[safeSymbol] = entry;
        return entry;
    }

    if (entry?.snapshot) {
        return entry;
    }

    if (fallbackPrice > 0) {
        const seedSnapshot = {
            asOfDate: getTodayKey(),
            open: fallbackPrice,
            high: fallbackPrice,
            low: fallbackPrice,
            close: fallbackPrice,
            prevClose: fallbackPrice
        };
        entry = {
            symbol: safeSymbol,
            source: 'fallback_seed',
            fetchedAt: new Date().toISOString(),
            fetchedDate: getTodayKey(),
            dailyRows: [{
                date: getTodayKey(),
                open: fallbackPrice,
                high: fallbackPrice,
                low: fallbackPrice,
                close: fallbackPrice
            }],
            snapshot: seedSnapshot
        };
        cache.symbols[safeSymbol] = entry;
        return entry;
    }

    return null;
};

const resolveSeedPrice = async (symbol, fallbackPrice, options = {}) => {
    const allowRemote = options?.allowRemote !== false;
    const cache = readCache();
    const entry = await resolveSymbolEntry(cache, symbol, normalizePositive(fallbackPrice, 0), true, allowRemote);
    writeCache(cache);
    return getCachedPrice(entry, fallbackPrice);
};

const resolveAnchorPrices = async (tickers, options = {}) => {
    const cache = readCache();
    const output = new Map();
    const uniqueSymbols = [...new Set((Array.isArray(tickers) ? tickers : []).map(normalizeSymbol).filter(Boolean))];
    const maxRemoteFetches = Math.max(0, Number(options?.maxRemoteFetches ?? MAX_REMOTE_SYMBOL_FETCH_PER_CALL));
    const allowRemoteFetches = options?.allowRemote !== false;
    let remoteAttempts = 0;

    for (const symbol of uniqueSymbols) {
        const allowRemote = allowRemoteFetches && remoteAttempts < maxRemoteFetches;
        if (allowRemote) remoteAttempts += 1;
        const entry = await resolveSymbolEntry(cache, symbol, 0, true, allowRemote);
        const price = getCachedPrice(entry, 0);
        if (price > 0) {
            output.set(symbol, Number(price.toFixed(6)));
        }
    }

    writeCache(cache);
    return output;
};

module.exports = {
    resolveSeedPrice,
    resolveAnchorPrices,
    extractDailySnapshot,
    computeTickPriceFromSnapshot
};
