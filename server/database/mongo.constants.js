const TABLE_NAMES = [
  'users',
  'worlds',
  'countries',
  'stock_markets',
  'assets',
  'world_players',
  'user_achievements',
  'user_achievement_progress',
  'sectors',
  'companies',
  'company_investments',
  'commodities',
  'governments',
  'government_relations',
  'bonds',
  'country_states',
  'country_relations',
  'country_conflicts',
  'cryptos',
  'portfolio',
  'order_book',
  'transactions',
  'world_events',
  'price_history',
  'dividend_history',
  'bond_payments',
  'world_chat_messages',
  'direct_messages',
  'private_deals'
];

const UNIQUE_INDEXES = {
  users: [['username'], ['email']],
  countries: [['code']],
  stock_markets: [['world_id', 'code']],
  assets: [['world_id', 'asset_type', 'symbol']],
  world_players: [['user_id', 'world_id']],
  user_achievements: [['user_id', 'achievement_code']],
  user_achievement_progress: [['user_id', 'metric_key']],
  companies: [['world_id', 'ticker']],
  commodities: [['world_id', 'symbol']],
  bonds: [['world_id', 'symbol']],
  country_states: [['world_id', 'country_id']],
  country_relations: [['world_id', 'country_a_id', 'country_b_id']],
  cryptos: [['world_id', 'symbol']],
  portfolio: [['player_id', 'asset_type', 'asset_id']]
};

const SECONDARY_INDEXES = {
  price_history: [
    {
      keys: { world_id: 1, world_tick: -1, asset_id: 1, id: -1 },
      options: { name: 'idx_price_history_world_tick_asset' }
    },
    {
      keys: { world_id: 1, asset_type: 1, asset_id: 1, world_tick: -1, id: -1 },
      options: { name: 'idx_price_history_world_type_asset_tick' }
    }
  ]
};

const SEED_SECTORS = [
  { id: 1, name: 'Technology', description: 'Software, hardware, AI, and digital services', base_growth_rate: 0.035, volatility_factor: 0.08 },
  { id: 2, name: 'Healthcare', description: 'Pharmaceuticals, biotech, and medical devices', base_growth_rate: 0.025, volatility_factor: 0.06 },
  { id: 3, name: 'Energy', description: 'Oil, gas, renewables, and utilities', base_growth_rate: 0.02, volatility_factor: 0.09 },
  { id: 4, name: 'Finance', description: 'Banking, insurance, and financial services', base_growth_rate: 0.02, volatility_factor: 0.07 },
  { id: 5, name: 'Agriculture', description: 'Farming, food production, and agrochemicals', base_growth_rate: 0.015, volatility_factor: 0.04 },
  { id: 6, name: 'Manufacturing', description: 'Industrial goods, machinery, and production', base_growth_rate: 0.018, volatility_factor: 0.05 },
  { id: 7, name: 'Real Estate', description: 'Property development, REITs, and construction', base_growth_rate: 0.015, volatility_factor: 0.06 },
  { id: 8, name: 'Entertainment', description: 'Media, gaming, streaming, and hospitality', base_growth_rate: 0.03, volatility_factor: 0.07 },
  { id: 9, name: 'Transportation', description: 'Airlines, shipping, logistics, and automotive', base_growth_rate: 0.02, volatility_factor: 0.06 },
  { id: 10, name: 'Telecommunications', description: 'Wireless, broadband, and communication services', base_growth_rate: 0.022, volatility_factor: 0.05 }
];

const SEED_WORLD = {
  id: 1,
  name: 'Genesis Market',
  description:
    'The original trading floor. A balanced economy with sovereign countries, diverse commodities, and endless opportunity. Perfect for new traders.',
  max_players: 500,
  current_players: 0,
  tick_rate_seconds: 30,
  current_tick: 0,
  starting_cash: 100000,
  status: 'active'
};

const SEED_COUNTRIES = [
  { id: 1, code: 'US', name: 'United States', continent: 'North America', latitude: 39.8283, longitude: -98.5795 },
  { id: 2, code: 'GB', name: 'United Kingdom', continent: 'Europe', latitude: 55.3781, longitude: -3.436 },
  { id: 3, code: 'DE', name: 'Germany', continent: 'Europe', latitude: 51.1657, longitude: 10.4515 },
  { id: 4, code: 'JP', name: 'Japan', continent: 'Asia', latitude: 36.2048, longitude: 138.2529 },
  { id: 5, code: 'HK', name: 'Hong Kong', continent: 'Asia', latitude: 22.3193, longitude: 114.1694 },
  { id: 6, code: 'CN', name: 'China', continent: 'Asia', latitude: 35.8617, longitude: 104.1954 },
  { id: 7, code: 'IN', name: 'India', continent: 'Asia', latitude: 20.5937, longitude: 78.9629 },
  { id: 8, code: 'CA', name: 'Canada', continent: 'North America', latitude: 56.1304, longitude: -106.3468 },
  { id: 9, code: 'AU', name: 'Australia', continent: 'Oceania', latitude: -25.2744, longitude: 133.7751 },
  { id: 10, code: 'BR', name: 'Brazil', continent: 'South America', latitude: -14.235, longitude: -51.9253 },
  { id: 11, code: 'SG', name: 'Singapore', continent: 'Asia', latitude: 1.3521, longitude: 103.8198 },
  { id: 12, code: 'FR', name: 'France', continent: 'Europe', latitude: 46.2276, longitude: 2.2137 }
];

const SEED_STOCK_MARKETS = [
  {
    id: 1,
    world_id: 1,
    country_code: 'US',
    code: 'NYSE',
    name: 'New York Stock Exchange',
    city: 'New York',
    latitude: 40.7069,
    longitude: -74.0113,
    currency: 'USD',
    benchmark_name: 'Dow 500',
    benchmark_level: 41000,
    min_listing_capital: 2500000,
    listing_tier: 'bluechip',
    is_active: true
  },
  {
    id: 2,
    world_id: 1,
    country_code: 'US',
    code: 'NASDAQ',
    name: 'NASDAQ',
    city: 'New York',
    latitude: 40.757,
    longitude: -73.9855,
    currency: 'USD',
    benchmark_name: 'Nasdaq Composite',
    benchmark_level: 18000,
    min_listing_capital: 1500000,
    listing_tier: 'main',
    is_active: true
  },
  {
    id: 3,
    world_id: 1,
    country_code: 'GB',
    code: 'LSE',
    name: 'London Stock Exchange',
    city: 'London',
    latitude: 51.5142,
    longitude: -0.0864,
    currency: 'GBP',
    benchmark_name: 'FTSE 100',
    benchmark_level: 8200,
    min_listing_capital: 1000000,
    listing_tier: 'main',
    is_active: true
  },
  {
    id: 4,
    world_id: 1,
    country_code: 'DE',
    code: 'XETRA',
    name: 'Xetra',
    city: 'Frankfurt',
    latitude: 50.1109,
    longitude: 8.6821,
    currency: 'EUR',
    benchmark_name: 'DAX',
    benchmark_level: 18200,
    min_listing_capital: 1200000,
    listing_tier: 'bluechip',
    is_active: true
  },
  {
    id: 5,
    world_id: 1,
    country_code: 'JP',
    code: 'JPX',
    name: 'Japan Exchange Group',
    city: 'Tokyo',
    latitude: 35.6828,
    longitude: 139.759,
    currency: 'JPY',
    benchmark_name: 'Nikkei 225',
    benchmark_level: 39000,
    min_listing_capital: 1200000,
    listing_tier: 'main',
    is_active: true
  },
  {
    id: 6,
    world_id: 1,
    country_code: 'HK',
    code: 'HKEX',
    name: 'Hong Kong Exchanges',
    city: 'Hong Kong',
    latitude: 22.2855,
    longitude: 114.1577,
    currency: 'HKD',
    benchmark_name: 'Hang Seng',
    benchmark_level: 17000,
    min_listing_capital: 900000,
    listing_tier: 'main',
    is_active: true
  },
  {
    id: 7,
    world_id: 1,
    country_code: 'CN',
    code: 'SSE',
    name: 'Shanghai Stock Exchange',
    city: 'Shanghai',
    latitude: 31.2304,
    longitude: 121.4737,
    currency: 'CNY',
    benchmark_name: 'SSE Composite',
    benchmark_level: 3100,
    min_listing_capital: 1100000,
    listing_tier: 'main',
    is_active: true
  },
  {
    id: 8,
    world_id: 1,
    country_code: 'IN',
    code: 'NSE',
    name: 'National Stock Exchange of India',
    city: 'Mumbai',
    latitude: 19.076,
    longitude: 72.8777,
    currency: 'INR',
    benchmark_name: 'NIFTY 50',
    benchmark_level: 24000,
    min_listing_capital: 600000,
    listing_tier: 'startup',
    is_active: true
  },
  {
    id: 9,
    world_id: 1,
    country_code: 'CA',
    code: 'TSX',
    name: 'Toronto Stock Exchange',
    city: 'Toronto',
    latitude: 43.6487,
    longitude: -79.3772,
    currency: 'CAD',
    benchmark_name: 'S&P/TSX Composite',
    benchmark_level: 22000,
    min_listing_capital: 700000,
    listing_tier: 'main',
    is_active: true
  },
  {
    id: 10,
    world_id: 1,
    country_code: 'AU',
    code: 'ASX',
    name: 'Australian Securities Exchange',
    city: 'Sydney',
    latitude: -33.8688,
    longitude: 151.2093,
    currency: 'AUD',
    benchmark_name: 'S&P/ASX 200',
    benchmark_level: 7700,
    min_listing_capital: 700000,
    listing_tier: 'startup',
    is_active: true
  },
  {
    id: 11,
    world_id: 1,
    country_code: 'BR',
    code: 'B3',
    name: 'Brasil Bolsa Balcao',
    city: 'Sao Paulo',
    latitude: -23.5505,
    longitude: -46.6333,
    currency: 'BRL',
    benchmark_name: 'Ibovespa',
    benchmark_level: 126000,
    min_listing_capital: 500000,
    listing_tier: 'startup',
    is_active: true
  },
  {
    id: 12,
    world_id: 1,
    country_code: 'SG',
    code: 'SGX',
    name: 'Singapore Exchange',
    city: 'Singapore',
    latitude: 1.2855,
    longitude: 103.8504,
    currency: 'SGD',
    benchmark_name: 'STI',
    benchmark_level: 3250,
    min_listing_capital: 700000,
    listing_tier: 'main',
    is_active: true
  }
];

const SEED_COMMODITIES = [
  { id: 1, world_id: 1, name: 'Crude Oil', symbol: 'OIL', base_price: 75, max_price: 260, current_price: 75, supply_rate: 200, total_supply: 5000, volatility: 0.12 },
  { id: 2, world_id: 1, name: 'Wheat', symbol: 'WHT', base_price: 6.5, max_price: 22, current_price: 6.5, supply_rate: 500, total_supply: 15000, volatility: 0.04 },
  { id: 3, world_id: 1, name: 'Rice', symbol: 'RCE', base_price: 14, max_price: 48, current_price: 14, supply_rate: 400, total_supply: 12000, volatility: 0.035 },
  { id: 4, world_id: 1, name: 'Lumber', symbol: 'WOD', base_price: 450, max_price: 1600, current_price: 450, supply_rate: 150, total_supply: 3000, volatility: 0.06 },
  { id: 5, world_id: 1, name: 'Steel', symbol: 'STL', base_price: 800, max_price: 2800, current_price: 800, supply_rate: 100, total_supply: 2000, volatility: 0.07 },
  { id: 6, world_id: 1, name: 'Gold', symbol: 'GLD', base_price: 1950, max_price: 6200, current_price: 1950, supply_rate: 20, total_supply: 500, volatility: 0.08 },
  { id: 7, world_id: 1, name: 'Copper', symbol: 'CPR', base_price: 3.8, max_price: 14, current_price: 3.8, supply_rate: 300, total_supply: 8000, volatility: 0.055 },
  { id: 8, world_id: 1, name: 'Natural Gas', symbol: 'GAS', base_price: 2.75, max_price: 11, current_price: 2.75, supply_rate: 350, total_supply: 10000, volatility: 0.11 },
  { id: 9, world_id: 1, name: 'Coffee', symbol: 'COF', base_price: 1.85, max_price: 7.2, current_price: 1.85, supply_rate: 250, total_supply: 7000, volatility: 0.065 },
  { id: 10, world_id: 1, name: 'Cotton', symbol: 'CTN', base_price: 0.82, max_price: 3.3, current_price: 0.82, supply_rate: 350, total_supply: 9000, volatility: 0.04 }
];

const SEED_CRYPTOS = [
  { id: 1, world_id: 1, name: 'ByteCoin', symbol: 'BYT', current_price: 245.5, max_supply: 21000000, circulating_supply: 8500000, volatility: 0.25 },
  { id: 2, world_id: 1, name: 'NexaToken', symbol: 'NXA', current_price: 12.75, max_supply: 100000000, circulating_supply: 45000000, volatility: 0.3 },
  { id: 3, world_id: 1, name: 'Ethereal', symbol: 'ETH', current_price: 1850, max_supply: 120000000, circulating_supply: 65000000, volatility: 0.22 },
  { id: 4, world_id: 1, name: 'SolVault', symbol: 'SVT', current_price: 35.2, max_supply: 500000000, circulating_supply: 200000000, volatility: 0.35 },
  { id: 5, world_id: 1, name: 'ChainLink', symbol: 'CLK', current_price: 8.4, max_supply: 1000000000, circulating_supply: 400000000, volatility: 0.28 },
  { id: 6, world_id: 1, name: 'QuantumBit', symbol: 'QBT', current_price: 0.055, max_supply: 10000000000, circulating_supply: 3000000000, volatility: 0.4 },
  { id: 7, world_id: 1, name: 'AuroraCoin', symbol: 'ARC', current_price: 520, max_supply: 5000000, circulating_supply: 2000000, volatility: 0.2 }
];

module.exports = {
  TABLE_NAMES,
  UNIQUE_INDEXES,
  SECONDARY_INDEXES,
  SEED_SECTORS,
  SEED_WORLD,
  SEED_COUNTRIES,
  SEED_STOCK_MARKETS,
  SEED_COMMODITIES,
  SEED_CRYPTOS
};
