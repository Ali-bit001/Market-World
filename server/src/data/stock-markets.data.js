const WORLD_COUNTRIES = [
  { code: 'US', name: 'United States', continent: 'North America', latitude: 39.8283, longitude: -98.5795 },
  { code: 'GB', name: 'United Kingdom', continent: 'Europe', latitude: 55.3781, longitude: -3.4360 },
  { code: 'DE', name: 'Germany', continent: 'Europe', latitude: 51.1657, longitude: 10.4515 },
  { code: 'JP', name: 'Japan', continent: 'Asia', latitude: 36.2048, longitude: 138.2529 },
  { code: 'HK', name: 'Hong Kong', continent: 'Asia', latitude: 22.3193, longitude: 114.1694 },
  { code: 'CN', name: 'China', continent: 'Asia', latitude: 35.8617, longitude: 104.1954 },
  { code: 'IN', name: 'India', continent: 'Asia', latitude: 20.5937, longitude: 78.9629 },
  { code: 'CA', name: 'Canada', continent: 'North America', latitude: 56.1304, longitude: -106.3468 },
  { code: 'AU', name: 'Australia', continent: 'Oceania', latitude: -25.2744, longitude: 133.7751 },
  { code: 'BR', name: 'Brazil', continent: 'South America', latitude: -14.2350, longitude: -51.9253 },
  { code: 'SG', name: 'Singapore', continent: 'Asia', latitude: 1.3521, longitude: 103.8198 },
  { code: 'FR', name: 'France', continent: 'Europe', latitude: 46.2276, longitude: 2.2137 }
];

const WORLD_MARKETS = [
  { code: 'NYSE', countryCode: 'US', name: 'New York Stock Exchange', city: 'New York', latitude: 40.7069, longitude: -74.0113, currency: 'USD', benchmarkName: 'Dow Jones', benchmarkLevel: 41000, minListingCapital: 2500000, listingTier: 'bluechip' },
  { code: 'NASDAQ', countryCode: 'US', name: 'NASDAQ', city: 'New York', latitude: 40.7570, longitude: -73.9855, currency: 'USD', benchmarkName: 'Nasdaq Composite', benchmarkLevel: 18000, minListingCapital: 1500000, listingTier: 'bluechip' },
  { code: 'LSE', countryCode: 'GB', name: 'London Stock Exchange', city: 'London', latitude: 51.5142, longitude: -0.0864, currency: 'GBP', benchmarkName: 'FTSE 100', benchmarkLevel: 8200, minListingCapital: 1000000, listingTier: 'bluechip' },
  { code: 'XETRA', countryCode: 'DE', name: 'Xetra', city: 'Frankfurt', latitude: 50.1109, longitude: 8.6821, currency: 'EUR', benchmarkName: 'DAX', benchmarkLevel: 18200, minListingCapital: 1200000, listingTier: 'bluechip' },
  { code: 'JPX', countryCode: 'JP', name: 'Japan Exchange Group', city: 'Tokyo', latitude: 35.6828, longitude: 139.7590, currency: 'JPY', benchmarkName: 'Nikkei 225', benchmarkLevel: 39000, minListingCapital: 1200000, listingTier: 'bluechip' },
  { code: 'HKEX', countryCode: 'HK', name: 'Hong Kong Exchanges', city: 'Hong Kong', latitude: 22.2855, longitude: 114.1577, currency: 'HKD', benchmarkName: 'Hang Seng', benchmarkLevel: 17000, minListingCapital: 900000, listingTier: 'main' },
  { code: 'SSE', countryCode: 'CN', name: 'Shanghai Stock Exchange', city: 'Shanghai', latitude: 31.2304, longitude: 121.4737, currency: 'CNY', benchmarkName: 'SSE Composite', benchmarkLevel: 3100, minListingCapital: 1100000, listingTier: 'main' },
  { code: 'NSE', countryCode: 'IN', name: 'National Stock Exchange of India', city: 'Mumbai', latitude: 19.0760, longitude: 72.8777, currency: 'INR', benchmarkName: 'NIFTY 50', benchmarkLevel: 24000, minListingCapital: 600000, listingTier: 'main' },
  { code: 'TSX', countryCode: 'CA', name: 'Toronto Stock Exchange', city: 'Toronto', latitude: 43.6487, longitude: -79.3772, currency: 'CAD', benchmarkName: 'S&P/TSX Composite', benchmarkLevel: 22000, minListingCapital: 700000, listingTier: 'main' },
  { code: 'ASX', countryCode: 'AU', name: 'Australian Securities Exchange', city: 'Sydney', latitude: -33.8688, longitude: 151.2093, currency: 'AUD', benchmarkName: 'S&P/ASX 200', benchmarkLevel: 7700, minListingCapital: 700000, listingTier: 'main' },
  { code: 'B3', countryCode: 'BR', name: 'Brasil Bolsa Balcao', city: 'Sao Paulo', latitude: -23.5505, longitude: -46.6333, currency: 'BRL', benchmarkName: 'Ibovespa', benchmarkLevel: 126000, minListingCapital: 500000, listingTier: 'main' },
  { code: 'SGX', countryCode: 'SG', name: 'Singapore Exchange', city: 'Singapore', latitude: 1.2855, longitude: 103.8504, currency: 'SGD', benchmarkName: 'STI', benchmarkLevel: 3250, minListingCapital: 700000, listingTier: 'main' }
];

module.exports = {
  WORLD_COUNTRIES,
  WORLD_MARKETS
};

