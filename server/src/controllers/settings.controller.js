const db = require('../config/database');

// Simple in-memory cache for exchange rates
let exchangeRateCache = null;
let exchangeRateCacheTime = 0;
const EXCHANGE_RATE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL', 'SGD'];

const DEFAULT_SETTINGS = {
    theme: 'bloomberg',
    currency: 'USD',
    show_news_ticker: true,
    number_format: 'compact'
};

const normalizeTheme = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'dark') return 'bloomberg';
    if (raw === 'light') return 'robinhood';
    if (raw === 'cyberpunk') return 'bloomberg';
    if (['bloomberg', 'robinhood'].includes(raw)) return raw;
    return null;
};

const getSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        const database = db.getDb();

        const settings = await database.collection('user_settings').findOne({ user_id: userId });

        if (!settings) {
            return res.json({ settings: DEFAULT_SETTINGS });
        }

        res.json({
            settings: {
                theme: normalizeTheme(settings.theme) || DEFAULT_SETTINGS.theme,
                currency: settings.currency || DEFAULT_SETTINGS.currency,
                show_news_ticker: settings.show_news_ticker !== undefined ? settings.show_news_ticker : DEFAULT_SETTINGS.show_news_ticker,
                number_format: settings.number_format || DEFAULT_SETTINGS.number_format
            }
        });
    } catch (err) {
        console.error('Get settings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

const updateSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        const { theme, currency, show_news_ticker, number_format } = req.body;

        const updates = {};
        if (theme !== undefined) {
            const normalizedTheme = normalizeTheme(theme);
            if (!normalizedTheme) return res.status(400).json({ error: 'Invalid theme' });
            updates.theme = normalizedTheme;
        }
        if (currency !== undefined) {
            if (!SUPPORTED_CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Invalid currency' });
            updates.currency = currency;
        }
        if (show_news_ticker !== undefined) {
            updates.show_news_ticker = Boolean(show_news_ticker);
        }
        if (number_format !== undefined) {
            if (!['compact', 'full'].includes(number_format)) return res.status(400).json({ error: 'Invalid number format' });
            updates.number_format = number_format;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No valid settings provided' });
        }

        const database = db.getDb();
        await database.collection('user_settings').updateOne(
            { user_id: userId },
            { $set: { ...updates, user_id: userId, updated_at: new Date().toISOString() } },
            { upsert: true }
        );

        res.json({ message: 'Settings updated', settings: updates });
    } catch (err) {
        console.error('Update settings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

const getExchangeRates = async (req, res) => {
    try {
        const now = Date.now();

        // Return cached rates if still fresh
        if (exchangeRateCache && (now - exchangeRateCacheTime) < EXCHANGE_RATE_CACHE_TTL_MS) {
            return res.json({ rates: exchangeRateCache, cached: true });
        }

        // Fetch fresh rates
        const https = require('https');
        const fetchRates = () => new Promise((resolve, reject) => {
            const request = https.get('https://open.er-api.com/v6/latest/USD', (response) => {
                let body = '';
                response.on('data', chunk => { body += chunk; });
                response.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        resolve(data);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            request.on('error', reject);
            request.setTimeout(5000, () => {
                request.destroy();
                reject(new Error('Exchange rate fetch timeout'));
            });
        });

        const data = await fetchRates();

        if (data && data.rates) {
            const filteredRates = {};
            for (const currency of SUPPORTED_CURRENCIES) {
                if (data.rates[currency] !== undefined) {
                    filteredRates[currency] = data.rates[currency];
                }
            }
            filteredRates['USD'] = 1.0; // ensure USD is always 1

            exchangeRateCache = filteredRates;
            exchangeRateCacheTime = now;

            return res.json({ rates: filteredRates, cached: false });
        }

        // Fallback to approximate rates if API fails
        const fallbackRates = {
            USD: 1.0, EUR: 0.92, GBP: 0.79, JPY: 149.5, CAD: 1.36,
            AUD: 1.53, CHF: 0.90, CNY: 7.24, INR: 83.1, BRL: 4.97, SGD: 1.34
        };
        res.json({ rates: fallbackRates, cached: false, fallback: true });
    } catch (err) {
        console.error('Exchange rates error:', err);
        // Return fallback rates on error
        const fallbackRates = {
            USD: 1.0, EUR: 0.92, GBP: 0.79, JPY: 149.5, CAD: 1.36,
            AUD: 1.53, CHF: 0.90, CNY: 7.24, INR: 83.1, BRL: 4.97, SGD: 1.34
        };
        res.json({ rates: fallbackRates, cached: false, fallback: true });
    }
};

module.exports = { getSettings, updateSettings, getExchangeRates };
