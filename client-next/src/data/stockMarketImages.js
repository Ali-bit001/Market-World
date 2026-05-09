const MARKET_IMAGE_QUERIES = {
    NYSE: 'New York Stock Exchange facade',
    NASDAQ: 'Nasdaq MarketSite Times Square',
    LSE: 'London Stock Exchange Paternoster Square',
    JPX: 'Tokyo Stock Exchange building',
    HKEX: 'Hong Kong Exchanges and Clearing building',
    SSE: 'Shanghai Stock Exchange Pudong',
    TSX: 'Toronto Stock Exchange building',
    ASX: 'Australian Securities Exchange Sydney',
    FWB: 'Frankfurt Stock Exchange building',
    B3: 'B3 Sao Paulo stock exchange building'
};

const imageCache = new Map();

const getFallbackImage = (market) => {
    return {
        src: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/Wall_Street_sign_banner.jpg/1280px-Wall_Street_sign_banner.jpg',
        alt: `${market?.name || 'Stock market'} reference image`,
        caption: `${market?.name || 'Stock market'} - reference financial district view`
    };
};

const buildWikimediaSearchQuery = (market) => {
    if (!market) {
        return '';
    }

    const marketCode = String(market.code || '').toUpperCase();
    if (MARKET_IMAGE_QUERIES[marketCode]) {
        return MARKET_IMAGE_QUERIES[marketCode];
    }

    const name = String(market.name || '').trim();
    const city = String(market.city || '').trim();
    const country = String(market.country_name || '').trim();

    return `${name} stock exchange ${city} ${country} building`;
};

const getCacheKey = (market) => {
    const code = String(market?.code || '').toUpperCase();
    const city = String(market?.city || '').toLowerCase();
    return `${code}:${city}`;
};

export const fetchStockMarketImage = async (market) => {
    if (!market) {
        return null;
    }

    const cacheKey = getCacheKey(market);
    if (imageCache.has(cacheKey)) {
        return imageCache.get(cacheKey);
    }

    const query = buildWikimediaSearchQuery(market);
    const endpoint = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=5&gsrsearch=${encodeURIComponent(query)}&prop=imageinfo&iiprop=url&iiurlwidth=1200&format=json&origin=*`;

    try {
        const response = await fetch(endpoint);
        if (!response.ok) {
            throw new Error(`Wikimedia API returned ${response.status}`);
        }

        const payload = await response.json();
        const pages = Object.values(payload?.query?.pages || {});
        const firstWithImage = pages.find((page) => Array.isArray(page?.imageinfo) && page.imageinfo.length > 0);

        if (!firstWithImage) {
            const fallbackImage = getFallbackImage(market);
            imageCache.set(cacheKey, fallbackImage);
            return fallbackImage;
        }

        const imageInfo = firstWithImage.imageinfo[0];
        const image = {
            src: imageInfo.thumburl || imageInfo.url,
            alt: `${market.name || 'Stock market'} in ${market.city || market.country_name || 'global market'}`,
            caption: `${market.name} - ${market.city || ''}${market.city && market.country_name ? ', ' : ''}${market.country_name || ''}`
        };

        imageCache.set(cacheKey, image);
        return image;
    } catch {
        const fallbackImage = getFallbackImage(market);
        imageCache.set(cacheKey, fallbackImage);
        return fallbackImage;
    }
};
