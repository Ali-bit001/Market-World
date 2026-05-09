const ACHIEVEMENTS = [
    {
        code: 'wealth_bronze_1m',
        title: 'Bronze Trader',
        tier: 'bronze',
        category: 'wealth',
        metricKey: 'net_worth_peak',
        threshold: 1000000,
        description: 'Reach a net worth of $1,000,000 in any world.'
    },
    {
        code: 'wealth_silver_100m',
        title: 'Silver Magnate',
        tier: 'silver',
        category: 'wealth',
        metricKey: 'net_worth_peak',
        threshold: 100000000,
        description: 'Reach a net worth of $100,000,000 in any world.'
    },
    {
        code: 'wealth_gold_1b',
        title: 'Gold Sovereign',
        tier: 'gold',
        category: 'wealth',
        metricKey: 'net_worth_peak',
        threshold: 1000000000,
        description: 'Reach a net worth of $1,000,000,000 in any world.'
    },
    {
        code: 'commodity_oil_profit_10k',
        title: 'Oil Alpha',
        tier: 'bronze',
        category: 'commodities',
        metricKey: 'commodity_profit_OIL',
        threshold: 10000,
        description: 'Earn $10,000 realized profit trading Crude Oil.'
    },
    {
        code: 'commodity_gold_profit_10k',
        title: 'Gold Arbitrageur',
        tier: 'bronze',
        category: 'commodities',
        metricKey: 'commodity_profit_GLD',
        threshold: 10000,
        description: 'Earn $10,000 realized profit trading Gold.'
    },
    {
        code: 'commodity_wheat_profit_10k',
        title: 'Wheat Whisperer',
        tier: 'bronze',
        category: 'commodities',
        metricKey: 'commodity_profit_WHT',
        threshold: 10000,
        description: 'Earn $10,000 realized profit trading Wheat.'
    },
    {
        code: 'commodity_gas_profit_10k',
        title: 'Gas Grid Trader',
        tier: 'bronze',
        category: 'commodities',
        metricKey: 'commodity_profit_GAS',
        threshold: 10000,
        description: 'Earn $10,000 realized profit trading Natural Gas.'
    },
    {
        code: 'commodity_diversifier_3',
        title: 'Commodity Polyglot',
        tier: 'silver',
        category: 'commodities',
        metricKey: 'commodity_distinct_profitable_count',
        threshold: 3,
        description: 'Earn profit on at least 3 different commodities.'
    },
    {
        code: 'company_takeover_1',
        title: 'Corporate Raider',
        tier: 'gold',
        category: 'companies',
        metricKey: 'company_takeover_count',
        threshold: 1,
        description: 'Acquire a controlling stake in a company you did not found.'
    },
    {
        code: 'founder_shares_sold_100',
        title: 'Founder Liquidity Event',
        tier: 'silver',
        category: 'companies',
        metricKey: 'founder_shares_sold',
        threshold: 100,
        description: 'Sell 100 shares from a company you founded.'
    }
];

const ACHIEVEMENTS_BY_CODE = ACHIEVEMENTS.reduce((accumulator, achievement) => {
    accumulator[achievement.code] = achievement;
    return accumulator;
}, {});

const getAchievementByCode = (code) => {
    return ACHIEVEMENTS_BY_CODE[code] || null;
};

const getAchievementsByMetricKey = (metricKey) => {
    return ACHIEVEMENTS.filter((achievement) => achievement.metricKey === metricKey);
};

module.exports = {
    ACHIEVEMENTS,
    WEALTH_ACHIEVEMENTS: ACHIEVEMENTS.filter((achievement) => achievement.metricKey === 'net_worth_peak'),
    getAchievementByCode,
    getAchievementsByMetricKey
};
