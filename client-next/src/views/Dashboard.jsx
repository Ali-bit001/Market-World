'use client';

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, RefreshCcw, TrendingUp, Trophy, Wallet, X } from 'lucide-react';
import { AuthContext } from '../context/auth-context';
import { useSettings } from '../components/Providers';
import api from '../api/axios';
import { useWebSocket } from '../hooks/useWebSocket';
import MarketGlobe from '../components/MarketGlobe';
import CountryMacroGlobe from '../components/CountryMacroGlobe';
import LoadingScreen from '../components/LoadingScreen';

// formatMoney is now a factory - call makeMoney(rate, symbol) inside the component
const makeMoney = (rate, symbol) => (value, digits = 2) => {
    const converted = Number(value || 0) * rate;
    return symbol + converted.toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
    });
};

const formatNumber = (value, digits = 2) => {
    return Number(value || 0).toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: digits
    });
};

const formatChatTime = (value) => {
    if (!value) return '';
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const normalizeDbEvent = (event) => ({
    key: `db-${event.id}`,
    title: event.title,
    description: event.description,
    severity: event.severity || 'moderate',
    timestamp: new Date(event.created_at).getTime(),
    timeText: new Date(event.created_at).toLocaleString()
});

const normalizeWsEvent = (event) => ({
    key: `ws-${Date.now()}-${Math.random()}`,
    title: event.title || 'Live Update',
    description: event.description || event.message || 'Market update received',
    severity: event.severity || 'moderate',
    timestamp: Date.now(),
    timeText: new Date().toLocaleString()
});

const isRequestTimeout = (error) => {
    const message = String(error?.message || '').toLowerCase();
    return error?.code === 'ECONNABORTED' || message.includes('timeout');
};

const severityColor = (severity) => {
    if (severity === 'catastrophic') return 'var(--accent-red)';
    if (severity === 'major') return 'var(--accent-purple)';
    if (severity === 'minor') return 'var(--accent-green)';
    return 'var(--accent-blue)';
};

const achievementTierColor = (tier) => {
    if (tier === 'gold') return '#d4af37';
    if (tier === 'silver') return '#c0c0c0';
    return '#cd7f32';
};

const privateDealStatusColor = (status) => {
    if (status === 'accepted') return 'var(--accent-green)';
    if (status === 'rejected' || status === 'cancelled' || status === 'expired') return 'var(--accent-red)';
    return 'var(--accent-blue)';
};

const healthBandClass = (band) => {
    if (band === 'robust') return 'text-up';
    if (band === 'stable') return 'text-up';
    if (band === 'vulnerable') return '';
    return 'text-down';
};

const conflictRiskClass = (riskLevel) => {
    if (riskLevel === 'severe') return 'text-down';
    if (riskLevel === 'elevated') return 'text-down';
    if (riskLevel === 'guarded') return '';
    return 'text-up';
};

const MessageBox = ({ message, isError = false }) => {
    if (!message) return null;
    return (
        <div
            style={{
                marginTop: '0.6rem',
                padding: '0.55rem 0.75rem',
                borderRadius: 8,
                background: isError ? 'rgba(248, 81, 73, 0.15)' : 'rgba(63, 185, 80, 0.15)',
                color: isError ? 'var(--accent-red)' : 'var(--accent-green)',
                border: `1px solid ${isError ? 'rgba(248, 81, 73, 0.35)' : 'rgba(63, 185, 80, 0.35)'}`,
                fontSize: '0.88rem'
            }}
        >
            {message}
        </div>
    );
};

const Ticker = ({ events }) => {
    if (!events || events.length === 0) return null;

    return (
        <div className="ticker-wrap">
            <div className="ticker-content">
                {events.slice(0, 8).map((event) => (
                    <div key={event.key} className="ticker-item">
                        <span
                            className="badge"
                            style={{
                                background: severityColor(event.severity),
                                color: '#fff'
                            }}
                        >
                            {event.severity}
                        </span>
                        <strong style={{ color: '#fff' }}>{event.title}</strong> - {event.description}
                    </div>
                ))}
            </div>
        </div>
    );
};

const HISTORY_RANGE_OPTIONS = [
    { key: '10D', label: '10D', days: 10 },
    { key: '30D', label: '30D', days: 30 },
    { key: '100D', label: '100D', days: 100 },
    { key: 'ALL', label: 'All', days: null }
];

const filterHistoryRowsByRange = (rows, rangeKey) => {
    if (!rows || rows.length === 0) {
        return [];
    }

    const selectedRange = HISTORY_RANGE_OPTIONS.find((option) => option.key === rangeKey);
    if (!selectedRange || selectedRange.days === null) {
        return rows;
    }

    const latestGameDay = Number(rows[rows.length - 1]?.game_day || 0);
    if (!Number.isFinite(latestGameDay)) {
        return rows;
    }

    const cutoffDay = latestGameDay - selectedRange.days + 1;
    return rows.filter((row) => Number(row.game_day || 0) >= cutoffDay);
};

const formatHistoryDayLabel = (gameDay) => `Day ${Number(gameDay || 0)}`;

const normalizeAssetIdentifier = (value) => String(value || '').trim().toLowerCase();

const HistoryLineChart = ({ rows, selectedRange }) => {
    if (!rows || rows.length < 2) {
        return <div className="text-muted" style={{ fontSize: '0.85rem' }}>Not enough points for chart in this time range.</div>;
    }

    const width = 940;
    const height = 268;
    const padTop = 20;
    const padRight = 68;
    const padBottom = 34;
    const padLeft = 58;
    const chartWidth = width - padLeft - padRight;
    const chartHeight = height - padTop - padBottom;

    const normalizedRows = rows.map((row, index) => {
        const gameDay = Number(row.game_day || (index + 1));
        return {
            ...row,
            priceValue: Number(row.price || 0),
            gameDayValue: Number.isFinite(gameDay) ? gameDay : (index + 1)
        };
    });

    const prices = normalizedRows.map((row) => row.priceValue);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = Math.max(maxPrice - minPrice, 0.0000001);

    const minGameDay = Math.min(...normalizedRows.map((row) => row.gameDayValue));
    const maxGameDay = Math.max(...normalizedRows.map((row) => row.gameDayValue));
    const dayRange = Math.max(maxGameDay - minGameDay, 1);

    const points = normalizedRows.map((row) => {
        const x = padLeft + ((row.gameDayValue - minGameDay) / dayRange) * chartWidth;
        const y = padTop + (1 - ((row.priceValue - minPrice) / priceRange)) * chartHeight;
        return { x, y, row };
    });

    const linePath = points
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
        .join(' ');

    const areaPath = `${linePath} L ${points[points.length - 1].x} ${height - padBottom} L ${points[0].x} ${height - padBottom} Z`;

    const yTicks = Array.from({ length: 5 }, (_, index) => {
        const ratio = index / 4;
        const y = padTop + (ratio * chartHeight);
        const value = maxPrice - (ratio * priceRange);
        return { y, value };
    });

    const xTickIndices = Array.from(new Set([
        0,
        Math.floor((points.length - 1) / 2),
        points.length - 1
    ]));

    const firstPrice = normalizedRows[0].priceValue;
    const latestPrice = normalizedRows[normalizedRows.length - 1].priceValue;
    const delta = latestPrice - firstPrice;
    const deltaPct = firstPrice !== 0 ? (delta / firstPrice) * 100 : 0;

    return (
        <div>
            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                    gap: '0.45rem',
                    marginBottom: '0.7rem'
                }}
            >
                <div className="glass-card" style={{ padding: '0.45rem 0.55rem' }}>
                    <div className="text-muted" style={{ fontSize: '0.74rem' }}>Open</div>
                    <div className="mono">{formatNumber(firstPrice, 6)}</div>
                </div>
                <div className="glass-card" style={{ padding: '0.45rem 0.55rem' }}>
                    <div className="text-muted" style={{ fontSize: '0.74rem' }}>High</div>
                    <div className="mono">{formatNumber(maxPrice, 6)}</div>
                </div>
                <div className="glass-card" style={{ padding: '0.45rem 0.55rem' }}>
                    <div className="text-muted" style={{ fontSize: '0.74rem' }}>Low</div>
                    <div className="mono">{formatNumber(minPrice, 6)}</div>
                </div>
                <div className="glass-card" style={{ padding: '0.45rem 0.55rem' }}>
                    <div className="text-muted" style={{ fontSize: '0.74rem' }}>Latest</div>
                    <div className="mono">{formatNumber(latestPrice, 6)}</div>
                </div>
                <div className="glass-card" style={{ padding: '0.45rem 0.55rem' }}>
                    <div className="text-muted" style={{ fontSize: '0.74rem' }}>Change ({selectedRange})</div>
                    <div className={`mono ${delta >= 0 ? 'text-up' : 'text-down'}`}>
                        {delta >= 0 ? '+' : ''}{formatNumber(delta, 6)} ({delta >= 0 ? '+' : ''}{deltaPct.toFixed(2)}%)
                    </div>
                </div>
            </div>

            <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 268 }}>
                <defs>
                    <linearGradient id="historyAreaGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(47, 129, 247, 0.55)" />
                        <stop offset="100%" stopColor="rgba(47, 129, 247, 0.02)" />
                    </linearGradient>
                </defs>

                <rect x="0" y="0" width={width} height={height} rx="10" fill="rgba(255, 255, 255, 0.02)" />

                {yTicks.map((tick) => (
                    <g key={`y-${tick.y}`}>
                        <line
                            x1={padLeft}
                            y1={tick.y}
                            x2={width - padRight}
                            y2={tick.y}
                            stroke="rgba(255,255,255,0.12)"
                            strokeDasharray="3 5"
                        />
                        <text
                            x={width - padRight + 6}
                            y={tick.y + 3}
                            fill="var(--text-secondary)"
                            fontSize="11"
                        >
                            {formatNumber(tick.value, 4)}
                        </text>
                    </g>
                ))}

                {xTickIndices.map((index) => {
                    const point = points[index];
                    return (
                        <g key={`x-${index}`}>
                            <line
                                x1={point.x}
                                y1={height - padBottom}
                                x2={point.x}
                                y2={height - padBottom + 4}
                                stroke="rgba(255,255,255,0.4)"
                            />
                            <text
                                x={point.x}
                                y={height - 8}
                                fill="var(--text-secondary)"
                                fontSize="11"
                                textAnchor="middle"
                            >
                                {formatHistoryDayLabel(point.row.game_day)}
                            </text>
                        </g>
                    );
                })}

                <path d={areaPath} fill="url(#historyAreaGradient)" />
                <path d={linePath} fill="none" stroke="var(--accent-blue)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />

                <circle
                    cx={points[points.length - 1].x}
                    cy={points[points.length - 1].y}
                    r="4"
                    fill="var(--accent-blue)"
                    stroke="rgba(255,255,255,0.85)"
                    strokeWidth="1.5"
                />
            </svg>
        </div>
    );
};

const Dashboard = ({ mode = 'main' }) => {
    const { user, leaveWorld } = useContext(AuthContext);
    const { currencyRate, currencySymbol } = useSettings();
    const { events: liveEvents, lastTick } = useWebSocket();
    const router = useRouter();

    // Currency-aware money formatter - rebuilds when currency changes
    const formatMoney = useMemo(() => makeMoney(currencyRate, currencySymbol), [currencyRate, currencySymbol]);

    const [loading, setLoading] = useState(true);
    const [snapshot, setSnapshot] = useState({ world: null, assets: [] });
    const [portfolio, setPortfolio] = useState({ cash_balance: 0, net_worth: 0, holdings: [] });
    const [orders, setOrders] = useState([]);
    const [companies, setCompanies] = useState([]);
    const [sectors, setSectors] = useState([]);
    const [stockMarkets, setStockMarkets] = useState([]);
    const [newsFeed, setNewsFeed] = useState([]);
    const [achievementPopups, setAchievementPopups] = useState([]);

    const [worldSort, setWorldSort] = useState('asset_id');
    const [userSort, setUserSort] = useState('asset_id');

    const [selectedAsset, setSelectedAsset] = useState(null);
    const [historyRows, setHistoryRows] = useState([]);
    const [historyRange, setHistoryRange] = useState('30D');
    const [lastHistorySyncTick, setLastHistorySyncTick] = useState(null);
    const [selectedBrowseMarketId, setSelectedBrowseMarketId] = useState(null);
    const [stockListings, setStockListings] = useState([]);
    const [stockListingsLoading, setStockListingsLoading] = useState(false);
    const [countryIndicators, setCountryIndicators] = useState([]);
    const [selectedMacroCountryId, setSelectedMacroCountryId] = useState(null);

    const [selectedCompanyId, setSelectedCompanyId] = useState(null);
    const [manageForm, setManageForm] = useState({
        riskLevel: 'moderate',
        growthStrategy: 'organic',
        dividendPolicy: 'none',
        listStockMarketId: '',
        listQuantity: ''
    });

    const [createForm, setCreateForm] = useState({
        name: '',
        ticker: '',
        description: '',
        sectorId: '',
        stockMarketId: '',
        startingCapital: '',
        totalShares: '1000',
        riskLevel: 'moderate',
        growthStrategy: 'organic',
        dividendPolicy: 'none',
        listImmediately: false
    });

    const [tradeForm, setTradeForm] = useState({
        buyAssetId: '',
        buyIdentifier: '',
        buyQuantity: '',
        buyPrice: '',
        sellAssetId: '',
        sellIdentifier: '',
        sellQuantity: '',
        sellPrice: ''
    });

    // Modal state for buy/sell
    const [tradeModal, setTradeModal] = useState({ open: false, mode: 'buy', asset: null });
    const [modalQuantity, setModalQuantity] = useState('');
    const [modalPrice, setModalPrice] = useState('');
    const [modalStatus, setModalStatus] = useState({ text: '', isError: false });
    const [modalSubmitting, setModalSubmitting] = useState(false);

    const [buyStatus, setBuyStatus] = useState({ text: '', isError: false });
    const [sellStatus, setSellStatus] = useState({ text: '', isError: false });
    const [companyStatus, setCompanyStatus] = useState({ text: '', isError: false });
    const [manageStatus, setManageStatus] = useState({ text: '', isError: false });
    const [chatTab, setChatTab] = useState('world');
    const [chatUsers, setChatUsers] = useState([]);
    const [selectedChatUserId, setSelectedChatUserId] = useState(null);
    const [worldMessages, setWorldMessages] = useState([]);
    const [directMessages, setDirectMessages] = useState([]);
    const [privateDeals, setPrivateDeals] = useState([]);
    const [worldMessageDraft, setWorldMessageDraft] = useState('');
    const [directMessageDraft, setDirectMessageDraft] = useState('');
    const [dealForm, setDealForm] = useState({
        assetId: '',
        assetType: '',
        quantity: '',
        pricePerUnit: '',
        note: ''
    });
    const [chatStatus, setChatStatus] = useState({ text: '', isError: false });
    const [dealStatus, setDealStatus] = useState({ text: '', isError: false });
    const [chatLoading, setChatLoading] = useState(false);

    const wsCursorRef = useRef(0);
    const audioContextRef = useRef(null);
    const directMessagesContainerRef = useRef(null);
    const previousDirectThreadRef = useRef(null);

    const normalizedMode = ['main', 'assets', 'stock-market', 'macro', 'companies', 'chat'].includes(mode)
        ? mode
        : 'main';
    const modeTitleMap = {
        main: 'Main Dashboard',
        assets: 'Assets & Trading',
        'stock-market': 'Stock Market',
        macro: 'Macro Indicators',
        companies: 'Company Management',
        chat: 'Global Chat & Backdoor Deals'
    };
    const showMainSections = normalizedMode === 'main';
    const showAssetsSections = normalizedMode === 'assets';
    const showStockMarketSections = normalizedMode === 'stock-market';
    const showTradingSections = showAssetsSections || showStockMarketSections;
    const showMacroSections = normalizedMode === 'macro';
    const showCompanySections = normalizedMode === 'companies';
    const showChat = normalizedMode === 'chat';

    const playToneSequence = useCallback((notes) => {
        if (typeof window === 'undefined') {
            return;
        }

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            return;
        }

        if (!audioContextRef.current) {
            audioContextRef.current = new AudioContextClass();
        }

        const context = audioContextRef.current;
        const startAt = context.currentTime + 0.01;

        notes.forEach((note, index) => {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const noteStart = startAt + (index * Number(note.delay || 0.08));
            const noteDuration = Number(note.duration || 0.07);

            oscillator.type = note.type || 'sine';
            oscillator.frequency.setValueAtTime(Number(note.freq || 440), noteStart);

            gain.gain.setValueAtTime(0.0001, noteStart);
            gain.gain.exponentialRampToValueAtTime(Number(note.volume || 0.05), noteStart + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + noteDuration);

            oscillator.connect(gain);
            gain.connect(context.destination);

            oscillator.start(noteStart);
            oscillator.stop(noteStart + noteDuration + 0.01);
        });
    }, []);

    const playOrderPlacedSound = useCallback(() => {
        playToneSequence([
            { freq: 420, duration: 0.06, volume: 0.03, type: 'triangle' },
            { freq: 520, duration: 0.07, delay: 0.09, volume: 0.04, type: 'triangle' }
        ]);
    }, [playToneSequence]);

    const playOrderFilledSound = useCallback(() => {
        playToneSequence([
            { freq: 560, duration: 0.05, volume: 0.04, type: 'sine' },
            { freq: 740, duration: 0.05, delay: 0.075, volume: 0.05, type: 'sine' },
            { freq: 910, duration: 0.08, delay: 0.075, volume: 0.05, type: 'sine' }
        ]);
    }, [playToneSequence]);

    const playAchievementSound = useCallback(() => {
        playToneSequence([
            { freq: 520, duration: 0.07, volume: 0.04, type: 'triangle' },
            { freq: 660, duration: 0.07, delay: 0.08, volume: 0.05, type: 'triangle' },
            { freq: 820, duration: 0.1, delay: 0.08, volume: 0.06, type: 'triangle' }
        ]);
    }, [playToneSequence]);

    const fetchHistory = useCallback(async (assetType, assetId, name, options = {}) => {
        if (!user?.current_world_id) return;

        const isLiveRefresh = Boolean(options.isLiveRefresh);

        try {
            const { data } = await api.get('/market/history', {
                params: {
                    worldId: user.current_world_id,
                    assetType,
                    assetId,
                    limit: 500
                }
            });

            if (!isLiveRefresh) {
                setSelectedAsset({ assetType, assetId, name });
            }
            setHistoryRows(data.history || []);
            if (isLiveRefresh) {
                setLastHistorySyncTick(Number(lastTick || 0));
            }
        } catch {
            if (!isLiveRefresh) {
                setSelectedAsset({ assetType, assetId, name });
            }
            setHistoryRows([]);
        }
    }, [user?.current_world_id, lastTick]);

    const fetchGameData = useCallback(async () => {
        if (!user?.current_world_id) return;

        try {
            const worldId = user.current_world_id;

            const [snapshotRes, portfolioRes, ordersRes, companiesRes, sectorsRes, marketsRes, eventsRes, indicatorsRes] = await Promise.allSettled([
                api.get('/market/snapshot', { params: { worldId } }),
                api.get('/portfolio', { params: { worldId } }),
                api.get('/trading/orders', { params: { worldId } }),
                api.get('/companies', { params: { worldId } }),
                api.get('/companies/sectors'),
                api.get(`/worlds/${worldId}/stock-markets`),
                api.get(`/worlds/${worldId}/events`, { params: { limit: 80 } }),
                api.get(`/worlds/${worldId}/country-indicators`)
            ]);

            if (snapshotRes.status === 'fulfilled') {
                setSnapshot(snapshotRes.value.data || { world: null, assets: [] });
            }
            if (portfolioRes.status === 'fulfilled') {
                setPortfolio(portfolioRes.value.data || { cash_balance: 0, net_worth: 0, holdings: [] });
            }
            if (ordersRes.status === 'fulfilled') {
                setOrders(ordersRes.value.data.orders || []);
            }
            if (companiesRes.status === 'fulfilled') {
                setCompanies(companiesRes.value.data.companies || []);
            }
            if (sectorsRes.status === 'fulfilled') {
                setSectors(sectorsRes.value.data.sectors || []);
            }
            if (marketsRes.status === 'fulfilled') {
                setStockMarkets(marketsRes.value.data.markets || []);
            }
            if (indicatorsRes.status === 'fulfilled') {
                setCountryIndicators(indicatorsRes.value.data.indicators || []);
            }

            if (eventsRes.status === 'fulfilled') {
                setNewsFeed((prev) => {
                    const fetched = (eventsRes.value.data.events || []).map(normalizeDbEvent);
                    if (prev.length === 0) {
                        return fetched.slice(0, 100);
                    }

                    const seen = new Set(prev.map((item) => item.key));
                    const merged = [...prev];
                    for (const event of fetched) {
                        if (!seen.has(event.key)) {
                            merged.push(event);
                            seen.add(event.key);
                        }
                    }

                    return merged.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
                });
            }

            setCreateForm((prev) => ({
                ...prev,
                sectorId:
                    prev.sectorId || (sectorsRes.status === 'fulfilled' ? String(sectorsRes.value.data.sectors?.[0]?.id || '') : prev.sectorId),
                stockMarketId:
                    prev.stockMarketId || (marketsRes.status === 'fulfilled' ? String(marketsRes.value.data.markets?.[0]?.id || '') : prev.stockMarketId)
            }));

            const failedResults = [snapshotRes, portfolioRes, ordersRes, companiesRes, sectorsRes, marketsRes, eventsRes, indicatorsRes].filter(
                (result) => result.status === 'rejected'
            );
            const hasNonTimeoutFailure = failedResults.some((result) => !isRequestTimeout(result.reason));
            if (hasNonTimeoutFailure) {
                console.error('Dashboard fetch error:', failedResults.map((result) => result.reason));
            }
        } catch (err) {
            if (!isRequestTimeout(err)) {
                console.error('Dashboard fetch error:', err);
            }
        } finally {
            setLoading(false);
        }
    }, [user]);

    useEffect(() => {
        const timer = setTimeout(() => {
            fetchGameData();
        }, 0);

        return () => {
            clearTimeout(timer);
        };
    }, [fetchGameData, user, lastTick]);

    const fetchStockMarketListings = useCallback(async (marketId) => {
        const worldId = Number(user?.current_world_id);
        const normalizedMarketId = Number(marketId);

        if (!Number.isInteger(worldId) || !Number.isInteger(normalizedMarketId) || normalizedMarketId <= 0) {
            setStockListings([]);
            return;
        }

        try {
            setStockListingsLoading(true);
            const { data } = await api.get(`/worlds/${worldId}/stock-markets/${normalizedMarketId}/listings`);
            setStockListings(data.listings || []);
        } catch (err) {
            if (!isRequestTimeout(err)) {
                console.error('Stock market listings fetch error:', err);
                setStockListings([]);
            }
        } finally {
            setStockListingsLoading(false);
        }
    }, [user?.current_world_id]);

    useEffect(() => {
        if (stockMarkets.length === 0) {
            setSelectedBrowseMarketId(null);
            setStockListings([]);
            return;
        }

        setSelectedBrowseMarketId((previous) => {
            const previousId = Number(previous);
            if (Number.isInteger(previousId) && stockMarkets.some((market) => Number(market.id) === previousId)) {
                return previousId;
            }

            return Number(stockMarkets[0].id);
        });
    }, [stockMarkets]);

    useEffect(() => {
        if (!selectedBrowseMarketId) {
            setStockListings([]);
            return;
        }

        fetchStockMarketListings(selectedBrowseMarketId);
    }, [selectedBrowseMarketId, fetchStockMarketListings, lastTick]);

    useEffect(() => {
        if (!selectedAsset || !lastTick) {
            return;
        }

        fetchHistory(selectedAsset.assetType, selectedAsset.assetId, selectedAsset.name, { isLiveRefresh: true });
    }, [selectedAsset, lastTick, fetchHistory]);

    useEffect(() => {
        if (!countryIndicators || countryIndicators.length === 0) {
            setSelectedMacroCountryId(null);
            return;
        }

        setSelectedMacroCountryId((previous) => {
            const previousId = Number(previous);
            if (Number.isInteger(previousId) && countryIndicators.some((item) => Number(item.country_id) === previousId)) {
                return previousId;
            }

            return Number(countryIndicators[0].country_id);
        });
    }, [countryIndicators]);

    useEffect(() => {
        if (liveEvents.length <= wsCursorRef.current) return;

        const incomingEvents = liveEvents.slice(wsCursorRef.current);
        wsCursorRef.current = liveEvents.length;

        const streamEvents = incomingEvents
            .filter((event) => event.type === 'news' || event.type === 'event')
            .map(normalizeWsEvent);

        if (streamEvents.length > 0) {
            setNewsFeed((prev) => [...streamEvents.reverse(), ...prev].slice(0, 100));
        }

        const achievementEvents = incomingEvents
            .filter((event) => event.type === 'achievement' && Number(event.userId) === Number(user?.id));

        const tradeFillEvents = incomingEvents
            .filter((event) => event.type === 'trade_fill' && (Number(event.buyerUserId) === Number(user?.id) || Number(event.sellerUserId) === Number(user?.id)));

        if (achievementEvents.length > 0) {
            const createdAt = Date.now();
            const popupEntries = achievementEvents.map((event, index) => ({
                id: `achievement-${createdAt}-${index}`,
                title: event.achievementTitle || event.title || 'Achievement Unlocked',
                description: event.description || 'You reached a milestone.',
                tier: event.tier || 'bronze',
                threshold: event.threshold || null,
                unlockedValue: event.unlockedValue || null
            }));

            setAchievementPopups((prev) => [...popupEntries, ...prev].slice(0, 4));
            playAchievementSound();

            for (const popup of popupEntries) {
                setTimeout(() => {
                    setAchievementPopups((prev) => prev.filter((entry) => entry.id !== popup.id));
                }, 6500);
            }
        }

        if (tradeFillEvents.length > 0) {
            playOrderFilledSound();
            const fillNews = tradeFillEvents.map((event, index) => ({
                key: `fill-${Date.now()}-${index}`,
                title: event.title || 'Order Filled',
                description: event.description || 'One of your orders was filled.',
                severity: event.severity || 'minor',
                timestamp: Date.now(),
                timeText: new Date().toLocaleString()
            }));
            setNewsFeed((prev) => [...fillNews.reverse(), ...prev].slice(0, 100));
        }
    }, [liveEvents, playAchievementSound, playOrderFilledSound, user?.id]);

    const selectedCompany = useMemo(() => {
        return companies.find((company) => Number(company.id) === Number(selectedCompanyId)) || null;
    }, [companies, selectedCompanyId]);

    const selectedCreateMarket = useMemo(() => {
        return stockMarkets.find((market) => Number(market.id) === Number(createForm.stockMarketId)) || null;
    }, [stockMarkets, createForm.stockMarketId]);

    const selectedBrowseMarket = useMemo(() => {
        return stockMarkets.find((market) => Number(market.id) === Number(selectedBrowseMarketId)) || null;
    }, [stockMarkets, selectedBrowseMarketId]);

    const selectedBrowseMarketIndexes = useMemo(() => {
        return Array.isArray(selectedBrowseMarket?.indexes) ? selectedBrowseMarket.indexes : [];
    }, [selectedBrowseMarket]);

    const selectedMacroCountry = useMemo(() => {
        return countryIndicators.find((entry) => Number(entry.country_id) === Number(selectedMacroCountryId)) || null;
    }, [countryIndicators, selectedMacroCountryId]);

    const handleSelectCompany = (company) => {
        setSelectedCompanyId(company.id);
        setManageForm((prev) => ({
            ...prev,
            riskLevel: company.risk_level || 'moderate',
            growthStrategy: company.growth_strategy || 'organic',
            dividendPolicy: company.dividend_policy || 'none',
            listStockMarketId: String(company.stock_market_id || ''),
            listQuantity: ''
        }));
        setManageStatus({ text: '', isError: false });
    };

    const worldAssets = useMemo(() => {
        const copy = [...(snapshot.assets || [])];
        copy.sort((a, b) => {
            if (worldSort === 'price') return Number(a.current_price) - Number(b.current_price);
            if (worldSort === 'quantity') return Number(a.available_quantity) - Number(b.available_quantity);
            return Number(a.asset_id) - Number(b.asset_id);
        });
        return copy;
    }, [snapshot.assets, worldSort]);

    const findAssetByIdOrIdentifier = useCallback((rawAssetId, rawIdentifier) => {
        const assetId = Number(rawAssetId);
        if (Number.isInteger(assetId) && assetId > 0) {
            const byId = worldAssets.find((asset) => Number(asset.asset_id) === assetId);
            if (byId) {
                return byId;
            }
        }

        const identifier = normalizeAssetIdentifier(rawIdentifier);
        if (!identifier) {
            return null;
        }

        return worldAssets.find((asset) => {
            const symbol = normalizeAssetIdentifier(asset.symbol);
            const name = normalizeAssetIdentifier(asset.name);
            const organization = normalizeAssetIdentifier(asset.associated_organization);

            return symbol === identifier
                || symbol.includes(identifier)
                || name.includes(identifier)
                || organization.includes(identifier);
        }) || null;
    }, [worldAssets]);

    const marketAssets = useMemo(() => {
        return worldAssets.filter((asset) => asset.asset_type !== 'share');
    }, [worldAssets]);

    const visibleHistoryRows = useMemo(() => {
        return filterHistoryRowsByRange(historyRows, historyRange);
    }, [historyRows, historyRange]);

    const latestHistoryPoint = useMemo(() => {
        if (!historyRows || historyRows.length === 0) {
            return null;
        }
        return historyRows[historyRows.length - 1];
    }, [historyRows]);

    const stockListingsSummary = useMemo(() => {
        const companies = stockListings.length;
        const sharesForSale = stockListings.reduce((sum, listing) => sum + Number(listing.shares_for_sale || 0), 0);
        const listedShares = stockListings.reduce((sum, listing) => sum + Number(listing.shares_in_market || 0), 0);
        return { companies, sharesForSale, listedShares };
    }, [stockListings]);

    const userAssets = useMemo(() => {
        const normalized = (portfolio.holdings || []).map((holding) => {
            const metadata = holding.metadata || {};
            const maturityTicks = Number(metadata.maturity_ticks || 0);
            const ticksRemaining = Number(metadata.ticks_remaining || 0);
            const faceValue = Number(metadata.face_value || 0);
            const interestRate = Number(metadata.interest_rate || 0);
            const promisedUnitValue = Number(metadata.promised_unit_value || 0);
            return {
                ...holding,
                current_price: Number(metadata.current_price || 0),
                prev_price: null,
                symbol: metadata.symbol || metadata.ticker || `${holding.asset_type.toUpperCase()}-${holding.asset_id}`,
                name: metadata.name || `${holding.asset_type} ${holding.asset_id}`,
                maturity_ticks: maturityTicks,
                ticks_remaining: ticksRemaining,
                face_value: faceValue,
                interest_rate: interestRate,
                promised_unit_value: promisedUnitValue
            };
        });

        normalized.sort((a, b) => {
            if (userSort === 'price') return Number(a.current_price) - Number(b.current_price);
            if (userSort === 'quantity') return Number(a.quantity) - Number(b.quantity);
            return Number(a.asset_id) - Number(b.asset_id);
        });

        return normalized;
    }, [portfolio.holdings, userSort]);

    const userBondAssets = useMemo(() => {
        return userAssets.filter((asset) => asset.asset_type === 'bond');
    }, [userAssets]);

    const userNonBondAssets = useMemo(() => {
        return userAssets.filter((asset) => asset.asset_type !== 'bond');
    }, [userAssets]);

    const topPortfolioHoldings = useMemo(() => {
        const ranked = userAssets
            .map((asset) => {
                const estimatedValue = Number(asset.current_price || 0) * Number(asset.quantity || 0);
                return {
                    ...asset,
                    estimatedValue
                };
            })
            .sort((a, b) => Number(b.estimatedValue || 0) - Number(a.estimatedValue || 0));

        return ranked.slice(0, 8);
    }, [userAssets]);

    const pendingShareOrders = useMemo(() => {
        return orders
            .filter((order) => order.asset_type === 'share')
            .sort((a, b) => Number(a.id) - Number(b.id));
    }, [orders]);

    const buyAssetPreview = useMemo(() => {
        return findAssetByIdOrIdentifier(tradeForm.buyAssetId, tradeForm.buyIdentifier);
    }, [tradeForm.buyAssetId, tradeForm.buyIdentifier, findAssetByIdOrIdentifier]);

    const sellAssetPreview = useMemo(() => {
        return findAssetByIdOrIdentifier(tradeForm.sellAssetId, tradeForm.sellIdentifier);
    }, [tradeForm.sellAssetId, tradeForm.sellIdentifier, findAssetByIdOrIdentifier]);

    const buyIsShare = buyAssetPreview?.asset_type === 'share';
    const sellIsShare = sellAssetPreview?.asset_type === 'share';
    const sellIsBond = sellAssetPreview?.asset_type === 'bond';

    const selectedChatUser = useMemo(() => {
        return chatUsers.find((entry) => Number(entry.id) === Number(selectedChatUserId)) || null;
    }, [chatUsers, selectedChatUserId]);

    const peerChatUsers = useMemo(() => {
        return chatUsers.filter((entry) => Number(entry.id) !== Number(user?.id));
    }, [chatUsers, user]);

    const sellableAssets = useMemo(() => {
        return (portfolio?.holdings || [])
            .map((holding) => ({
                asset_id: Number(holding.asset_id),
                asset_type: String(holding.asset_type || '').toLowerCase(),
                quantity: Number(holding.quantity || 0),
                current_price: Number(holding.metadata?.current_price || 0),
                name: holding.metadata?.name || 'Unknown Asset',
                symbol: holding.metadata?.symbol || 'N/A'
            }))
            .filter((holding) => (
                Number.isInteger(holding.asset_id)
                && holding.asset_id > 0
                && ['share', 'commodity', 'crypto', 'bond'].includes(holding.asset_type)
                && Number(holding.quantity) > 0
            ))
            .sort((a, b) => a.asset_id - b.asset_id);
    }, [portfolio]);

    const selectedDealAsset = useMemo(() => {
        return sellableAssets.find((asset) => Number(asset.asset_id) === Number(dealForm.assetId)) || null;
    }, [sellableAssets, dealForm.assetId]);

    useEffect(() => {
        if (sellableAssets.length === 0) {
            setDealForm((prev) => ({
                ...prev,
                assetId: '',
                assetType: '',
                pricePerUnit: ''
            }));
            return;
        }

        setDealForm((prev) => {
            const currentAssetId = Number(prev.assetId);
            const currentAssetStillValid = Number.isInteger(currentAssetId)
                && sellableAssets.some((asset) => Number(asset.asset_id) === currentAssetId);

            if (currentAssetStillValid) {
                return prev;
            }

            const fallbackAsset = sellableAssets[0];
            return {
                ...prev,
                assetId: String(fallbackAsset.asset_id),
                assetType: fallbackAsset.asset_type,
                pricePerUnit: Number(fallbackAsset.current_price || 0) > 0
                    ? String(fallbackAsset.current_price)
                    : prev.pricePerUnit
            };
        });
    }, [sellableAssets]);

    const handleLeave = async () => {
        if (window.confirm('Are you sure you want to leave this world? This liquidates your current participation.')) {
            await leaveWorld();
            router.push('/worlds');
        }
    };

    const submitOrder = async (orderType) => {
        if (!user?.current_world_id) return;

        const isBuy = orderType === 'buy';
        const rawAssetId = isBuy ? tradeForm.buyAssetId : tradeForm.sellAssetId;
        const rawIdentifier = isBuy ? tradeForm.buyIdentifier : tradeForm.sellIdentifier;
        const quantity = Number(isBuy ? tradeForm.buyQuantity : tradeForm.sellQuantity);
        const enteredPrice = Number(isBuy ? tradeForm.buyPrice : tradeForm.sellPrice);

        const worldAsset = findAssetByIdOrIdentifier(rawAssetId, rawIdentifier);
        const assetId = Number(worldAsset?.asset_id || 0);
        const assetType = worldAsset?.asset_type;
        const fallbackPrice = Number(worldAsset?.current_price || 0);
        const isShareAsset = assetType === 'share';
        const pricePerUnit = isShareAsset ? enteredPrice : fallbackPrice;

        if (!isBuy && assetType === 'bond') {
            setSellStatus({ text: 'Bonds are locked until maturity and cannot be sold.', isError: true });
            return;
        }

        if (!worldAsset || !Number.isInteger(assetId) || assetId <= 0 || !assetType || !Number.isFinite(quantity) || quantity <= 0) {
            const setStatus = isBuy ? setBuyStatus : setSellStatus;
            setStatus({ text: 'Enter a valid asset ID/identifier and quantity.', isError: true });
            return;
        }

        if (isShareAsset && (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0)) {
            const setStatus = isBuy ? setBuyStatus : setSellStatus;
            setStatus({ text: 'For shares, enter a valid limit price.', isError: true });
            return;
        }

        if (!isShareAsset && (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0)) {
            const setStatus = isBuy ? setBuyStatus : setSellStatus;
            setStatus({ text: 'Market price unavailable for this asset right now. Try again shortly.', isError: true });
            return;
        }

        try {
            const { data } = await api.post('/trading/orders', {
                worldId: user.current_world_id,
                orderType,
                assetType,
                assetId,
                quantity,
                pricePerUnit
            });

            const successMessage = data?.message
                || `${isBuy ? 'Buy' : 'Sell'} order placed for ${quantity} unit(s) of ${worldAsset.name} (#${assetId}).`;

            if (isBuy) {
                setBuyStatus({ text: successMessage, isError: false });
                setTradeForm((prev) => ({ ...prev, buyAssetId: String(assetId), buyIdentifier: worldAsset.symbol || worldAsset.name || '', buyQuantity: '', buyPrice: '' }));
            } else {
                setSellStatus({ text: successMessage, isError: false });
                setTradeForm((prev) => ({ ...prev, sellAssetId: String(assetId), sellIdentifier: worldAsset.symbol || worldAsset.name || '', sellQuantity: '', sellPrice: '' }));
            }

            playOrderPlacedSound();

            fetchGameData();
        } catch (err) {
            const message = err.response?.data?.error || 'Order submission failed';
            const setStatus = isBuy ? setBuyStatus : setSellStatus;
            setStatus({ text: message, isError: true });
        }
    };

    const openTradeModal = (mode, asset) => {
        setTradeModal({ open: true, mode, asset });
        setModalQuantity('');
        setModalPrice(asset ? String(asset.current_price ?? '') : '');
        setModalStatus({ text: '', isError: false });
    };

    const closeTradeModal = () => {
        setTradeModal({ open: false, mode: 'buy', asset: null });
        setModalQuantity('');
        setModalPrice('');
        setModalStatus({ text: '', isError: false });
        setModalSubmitting(false);
    };

    const submitModalOrder = async () => {
        if (!user?.current_world_id || !tradeModal.asset || modalSubmitting) return;

        const asset = tradeModal.asset;
        const orderType = tradeModal.mode;
        const quantity = Number(modalQuantity);
        const isShare = asset.asset_type === 'share';
        const pricePerUnit = isShare ? Number(modalPrice) : Number(asset.current_price || 0);

        if (orderType === 'sell' && asset.asset_type === 'bond') {
            setModalStatus({ text: 'Bonds are locked until maturity and cannot be sold.', isError: true });
            return;
        }

        if (!Number.isFinite(quantity) || quantity <= 0) {
            setModalStatus({ text: 'Enter a valid quantity.', isError: true });
            return;
        }

        if (isShare && (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0)) {
            setModalStatus({ text: 'Enter a valid limit price for shares.', isError: true });
            return;
        }

        if (!isShare && (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0)) {
            setModalStatus({ text: 'Market price unavailable. Try again shortly.', isError: true });
            return;
        }

        setModalSubmitting(true);
        setModalStatus({ text: '', isError: false });

        try {
            const { data } = await api.post('/trading/orders', {
                worldId: user.current_world_id,
                orderType,
                assetType: asset.asset_type,
                assetId: Number(asset.asset_id),
                quantity,
                pricePerUnit
            });

            const successMessage = data?.message
                || `${orderType === 'buy' ? 'Buy' : 'Sell'} order placed for ${quantity} unit(s) of ${asset.name}.`;

            setModalStatus({ text: successMessage, isError: false });
            setModalQuantity('');
            playOrderPlacedSound();
            fetchGameData();

            setTimeout(() => closeTradeModal(), 2000);
        } catch (err) {
            setModalStatus({ text: err.response?.data?.error || 'Order submission failed', isError: true });
        } finally {
            setModalSubmitting(false);
        }
    };

    const handleCreateCompany = async (event) => {
        event.preventDefault();
        if (!user?.current_world_id) return;

        try {
            const payload = {
                worldId: user.current_world_id,
                sectorId: Number(createForm.sectorId),
                stockMarketId: createForm.listImmediately ? Number(createForm.stockMarketId) : null,
                name: createForm.name,
                ticker: createForm.ticker,
                description: createForm.description,
                totalShares: Number(createForm.totalShares),
                startingCapital: Number(createForm.startingCapital),
                riskLevel: createForm.riskLevel,
                growthStrategy: createForm.growthStrategy,
                dividendPolicy: createForm.dividendPolicy
            };

            await api.post('/companies', payload);

            setCompanyStatus({ text: `Company ${createForm.name} created successfully.`, isError: false });
            setCreateForm((prev) => ({
                ...prev,
                name: '',
                ticker: '',
                description: '',
                startingCapital: '',
                totalShares: '1000'
            }));

            fetchGameData();
        } catch (err) {
            setCompanyStatus({
                text: err.response?.data?.error || 'Company creation failed',
                isError: true
            });
        }
    };

    const handleUpdateCompanySettings = async () => {
        if (!selectedCompany || !user?.current_world_id) {
            setManageStatus({ text: 'Select a company first.', isError: true });
            return;
        }

        try {
            await api.patch(`/companies/${selectedCompany.id}/settings`, {
                worldId: user.current_world_id,
                risk_level: manageForm.riskLevel,
                growth_strategy: manageForm.growthStrategy,
                dividend_policy: manageForm.dividendPolicy
            });

            setManageStatus({ text: 'Company settings updated.', isError: false });
            fetchGameData();
        } catch (err) {
            setManageStatus({
                text: err.response?.data?.error || 'Failed to update company settings',
                isError: true
            });
        }
    };

    const handleListShares = async () => {
        if (!selectedCompany || !user?.current_world_id) {
            setManageStatus({ text: 'Select a company first.', isError: true });
            return;
        }

        const qty = Number(manageForm.listQuantity);
        const stockMarketId = Number(manageForm.listStockMarketId);
        if (!Number.isInteger(qty) || qty <= 0) {
            setManageStatus({ text: 'Enter a valid integer quantity to list.', isError: true });
            return;
        }

        if (!Number.isInteger(stockMarketId) || stockMarketId <= 0) {
            setManageStatus({ text: 'Select a valid stock market first.', isError: true });
            return;
        }

        try {
            await api.post(`/companies/${selectedCompany.id}/list-shares`, {
                worldId: user.current_world_id,
                stockMarketId,
                quantity: qty,
                pricePerUnit: Number(selectedCompany.share_price)
            });

            setManageStatus({ text: `Listed ${qty} shares of ${selectedCompany.name}.`, isError: false });
            setManageForm((prev) => ({ ...prev, listQuantity: '' }));
            fetchGameData();
        } catch (err) {
            setManageStatus({
                text: err.response?.data?.error || 'Failed to list company shares',
                isError: true
            });
        }
    };

    const handleLiquidateCompany = async () => {
        if (!selectedCompany || !user?.current_world_id) {
            setManageStatus({ text: 'Select a company first.', isError: true });
            return;
        }

        if (!window.confirm(`Liquidate ${selectedCompany.name}? This action is irreversible.`)) {
            return;
        }

        try {
            const { data } = await api.post(`/companies/${selectedCompany.id}/liquidate`, {
                worldId: user.current_world_id
            });

            setManageStatus({
                text: `Liquidated ${selectedCompany.name}. Total payout distributed: ${formatMoney(data.totalPayout || 0)}.`,
                isError: false
            });

            setSelectedCompanyId(null);
            fetchGameData();
        } catch (err) {
            setManageStatus({
                text: err.response?.data?.error || 'Failed to liquidate company',
                isError: true
            });
        }
    };

    const [listOnMarketForm, setListOnMarketForm] = useState({ stockMarketId: '', open: false });
    const [listOnMarketStatus, setListOnMarketStatus] = useState({ text: '', isError: false });

    const handleListOnMarket = async () => {
        if (!selectedCompany || !user?.current_world_id) {
            setListOnMarketStatus({ text: 'Select a company first.', isError: true });
            return;
        }

        const stockMarketId = Number(listOnMarketForm.stockMarketId);
        if (!Number.isInteger(stockMarketId) || stockMarketId <= 0) {
            setListOnMarketStatus({ text: 'Select a valid stock market.', isError: true });
            return;
        }

        try {
            await api.post(`/companies/${selectedCompany.id}/list-on-market`, {
                worldId: user.current_world_id,
                stockMarketId
            });

            setListOnMarketStatus({ text: `${selectedCompany.name} is now listed on the market.`, isError: false });
            setListOnMarketForm({ stockMarketId: '', open: false });
            fetchGameData();
        } catch (err) {
            setListOnMarketStatus({
                text: err.response?.data?.error || 'Failed to list company on market',
                isError: true
            });
        }
    };

    const fetchChatData = useCallback(async () => {
        if (!showChat || !user?.current_world_id) return;

        const worldId = Number(user.current_world_id);
        const selectedDirectId = Number(selectedChatUserId);
        const canFetchDirect = chatTab === 'direct' && Number.isInteger(selectedDirectId) && selectedDirectId > 0;

        try {
            setChatLoading(true);

            const requests = [
                api.get('/chat/users', { params: { worldId } }),
                api.get('/chat/world', { params: { worldId, limit: 80 } })
            ];

            if (canFetchDirect) {
                requests.push(api.get('/chat/direct', {
                    params: {
                        worldId,
                        withUserId: selectedDirectId,
                        limit: 80
                    }
                }));

                requests.push(api.get('/trading/backdoor-deals', {
                    params: {
                        worldId,
                        withUserId: selectedDirectId,
                        limit: 80
                    }
                }));
            }

            const [usersRes, worldRes, directRes, privateDealsRes] = await Promise.all(requests);
            const nextUsers = usersRes.data.users || [];
            const peers = nextUsers.filter((entry) => Number(entry.id) !== Number(user.id));

            setChatUsers(nextUsers);
            setWorldMessages(worldRes.data.messages || []);

            if (canFetchDirect) {
                setDirectMessages(directRes?.data?.messages || []);
                setPrivateDeals(privateDealsRes?.data?.deals || []);
            } else if (chatTab === 'direct') {
                setDirectMessages([]);
                setPrivateDeals([]);
            }

            if (!selectedDirectId && peers.length > 0) {
                setSelectedChatUserId(peers[0].id);
            }

            if (selectedDirectId && !nextUsers.some((entry) => Number(entry.id) === selectedDirectId)) {
                setSelectedChatUserId(peers[0]?.id || null);
            }
        } catch (err) {
            setChatStatus({
                text: err.response?.data?.error || 'Failed to sync chat',
                isError: true
            });
        } finally {
            setChatLoading(false);
        }
    }, [showChat, chatTab, selectedChatUserId, user]);

    useEffect(() => {
        if (!showChat || !user?.current_world_id) return;

        const timer = setTimeout(() => {
            fetchChatData();
        }, 0);

        const interval = setInterval(() => {
            fetchChatData();
        }, 4000);

        return () => {
            clearTimeout(timer);
            clearInterval(interval);
        };
    }, [showChat, user, chatTab, selectedChatUserId, fetchChatData]);

    useEffect(() => {
        if (!showChat || chatTab !== 'direct') {
            return;
        }

        const container = directMessagesContainerRef.current;
        if (!container) {
            return;
        }

        const activeThreadId = Number(selectedChatUserId || 0);
        const threadChanged = Number(previousDirectThreadRef.current || 0) !== activeThreadId;
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        const isNearBottom = distanceFromBottom <= 64;

        if (threadChanged || isNearBottom) {
            container.scrollTop = container.scrollHeight;
        }

        previousDirectThreadRef.current = activeThreadId;
    }, [showChat, chatTab, selectedChatUserId, directMessages]);

    const handleSendWorldMessage = async () => {
        if (!user?.current_world_id) return;

        const message = worldMessageDraft.trim();
        if (!message) return;

        try {
            const { data } = await api.post('/chat/world', {
                worldId: user.current_world_id,
                message
            });

            setWorldMessages((prev) => [...prev, data.message].slice(-200));
            setWorldMessageDraft('');
            setChatStatus({ text: '', isError: false });
        } catch (err) {
            setChatStatus({
                text: err.response?.data?.error || 'Failed to send world message',
                isError: true
            });
        }
    };

    const handleSendDirectMessage = async () => {
        if (!user?.current_world_id) return;

        const recipientUserId = Number(selectedChatUserId);
        const message = directMessageDraft.trim();

        if (!Number.isInteger(recipientUserId) || recipientUserId <= 0) {
            setChatStatus({ text: 'Select a user first.', isError: true });
            return;
        }

        if (!message) return;

        try {
            const { data } = await api.post('/chat/direct', {
                worldId: user.current_world_id,
                recipientUserId,
                message
            });

            setDirectMessages((prev) => [...prev, data.message].slice(-200));
            setDirectMessageDraft('');
            setChatStatus({ text: '', isError: false });
            fetchChatData();
        } catch (err) {
            setChatStatus({
                text: err.response?.data?.error || 'Failed to send direct message',
                isError: true
            });
        }
    };

    const handleExecutePrivateDeal = async () => {
        if (!user?.current_world_id) return;

        const recipientUserId = Number(selectedChatUserId);
        const assetId = Number(dealForm.assetId);
        const assetType = String(dealForm.assetType || '').toLowerCase();
        const quantity = Number(dealForm.quantity);
        const pricePerUnit = Number(dealForm.pricePerUnit);

        if (!Number.isInteger(recipientUserId) || recipientUserId <= 0) {
            setDealStatus({ text: 'Select a direct chat recipient first.', isError: true });
            return;
        }

        if (!Number.isInteger(assetId) || assetId <= 0) {
            setDealStatus({ text: 'Choose an asset to sell.', isError: true });
            return;
        }

        if (!Number.isFinite(quantity) || quantity <= 0) {
            setDealStatus({ text: 'Enter a valid quantity.', isError: true });
            return;
        }

        if (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0) {
            setDealStatus({ text: 'Enter a valid price per unit.', isError: true });
            return;
        }

        try {
            await api.post('/trading/backdoor-deals', {
                worldId: user.current_world_id,
                recipientUserId,
                assetType,
                assetId,
                quantity,
                pricePerUnit,
                note: dealForm.note
            });

            setDealStatus({ text: 'Backdoor deal proposal sent. It executes only after acceptance.', isError: false });
            setDealForm((prev) => ({
                ...prev,
                quantity: '',
                note: ''
            }));

            fetchGameData();
            fetchChatData();
        } catch (err) {
            setDealStatus({
                text: err.response?.data?.error || 'Failed to send backdoor deal proposal',
                isError: true
            });
        }
    };

    const handleRespondPrivateDeal = async (dealId, action) => {
        if (!user?.current_world_id) return;

        const normalizedDealId = Number(dealId);
        if (!Number.isInteger(normalizedDealId) || normalizedDealId <= 0) {
            setDealStatus({ text: 'Invalid private deal selected.', isError: true });
            return;
        }

        if (action !== 'accept' && action !== 'reject') {
            setDealStatus({ text: 'Unsupported private deal action.', isError: true });
            return;
        }

        try {
            await api.post(`/trading/backdoor-deals/${normalizedDealId}/${action}`);
            setDealStatus({
                text: action === 'accept'
                    ? 'Backdoor deal accepted and executed.'
                    : 'Backdoor deal rejected.',
                isError: false
            });
            fetchGameData();
            fetchChatData();
        } catch (err) {
            setDealStatus({
                text: err.response?.data?.error || `Failed to ${action} backdoor deal`,
                isError: true
            });
        }
    };

    if (loading) {
        return <LoadingScreen context="dashboard" title="Loading Dashboard" />;
    }

    const modalAsset = tradeModal.asset;
    const modalIsShare = modalAsset?.asset_type === 'share';
    const modalIsBond = modalAsset?.asset_type === 'bond';

    return (
        <div>
            {/* Trade Modal */}
            {tradeModal.open && (
                <div
                    onClick={closeTradeModal}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 200,
                        background: 'rgba(0,0,0,0.72)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backdropFilter: 'blur(3px)'
                    }}
                >
                    <div
                        className="glass-panel"
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            width: 'min(95vw, 440px)',
                            padding: '1.4rem',
                            boxShadow: '0 16px 48px rgba(0,0,0,0.7)',
                            position: 'relative'
                        }}
                    >
                        {/* Header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                            <strong style={{ fontSize: '1.05rem' }}>
                                {modalAsset ? `${modalAsset.name} (${modalAsset.symbol || modalAsset.asset_type})` : 'Trade'}
                            </strong>
                            <button className="btn btn-outline" style={{ padding: '0.25rem 0.45rem' }} onClick={closeTradeModal}>
                                <X size={14} />
                            </button>
                        </div>

                        {/* Tabs */}
                        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                            <button
                                className={`btn ${tradeModal.mode === 'buy' ? 'btn-primary' : 'btn-outline'}`}
                                style={{ flex: 1 }}
                                onClick={() => {
                                    setTradeModal((prev) => ({ ...prev, mode: 'buy' }));
                                    setModalStatus({ text: '', isError: false });
                                }}
                            >
                                Buy
                            </button>
                            <button
                                className={`btn ${tradeModal.mode === 'sell' ? 'btn-primary' : 'btn-outline'}`}
                                style={{ flex: 1 }}
                                disabled={modalIsBond}
                                onClick={() => {
                                    setTradeModal((prev) => ({ ...prev, mode: 'sell' }));
                                    setModalStatus({ text: '', isError: false });
                                }}
                            >
                                {modalIsBond ? 'Sell (Locked)' : 'Sell'}
                            </button>
                        </div>

                        {/* Asset info */}
                        {modalAsset && (
                            <div className="glass-card" style={{ padding: '0.6rem 0.75rem', marginBottom: '0.9rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                                    <div>
                                        <div className="text-muted" style={{ fontSize: '0.74rem' }}>Type</div>
                                        <div style={{ textTransform: 'capitalize' }}>{modalAsset.asset_type}</div>
                                    </div>
                                    <div>
                                        <div className="text-muted" style={{ fontSize: '0.74rem' }}>Current Price</div>
                                        <div className="mono">{formatNumber(modalAsset.current_price, 6)}</div>
                                    </div>
                                    <div>
                                        <div className="text-muted" style={{ fontSize: '0.74rem' }}>Available</div>
                                        <div className="mono">{formatNumber(modalAsset.available_quantity ?? modalAsset.quantity, 4)}</div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Quantity */}
                        <div className="form-group">
                            <label>Quantity</label>
                            <input
                                className="form-control"
                                type="number"
                                min="0.00000001"
                                step="0.00000001"
                                value={modalQuantity}
                                onChange={(e) => setModalQuantity(e.target.value)}
                                placeholder="Enter quantity"
                                autoFocus
                            />
                        </div>

                        {/* Limit price (shares only) */}
                        {modalIsShare && (
                            <div className="form-group">
                                <label>{tradeModal.mode === 'buy' ? 'Bid Price (limit)' : 'Ask Price (limit)'}</label>
                                <input
                                    className="form-control"
                                    type="number"
                                    min="0.00000001"
                                    step="0.00000001"
                                    value={modalPrice}
                                    onChange={(e) => setModalPrice(e.target.value)}
                                    placeholder="Price per share"
                                />
                                <div className="text-muted" style={{ marginTop: '0.3rem', fontSize: '0.76rem' }}>
                                    {tradeModal.mode === 'buy'
                                        ? 'Higher bid prices get priority in the order queue.'
                                        : 'Lower ask prices get priority in the order queue.'}
                                </div>
                            </div>
                        )}

                        {!modalIsShare && modalAsset && (
                            <div className="text-muted" style={{ marginBottom: '0.75rem', fontSize: '0.8rem' }}>
                                {modalIsBond
                                    ? 'Bonds execute at market price and are held until maturity.'
                                    : 'Executes immediately at current market price.'}
                            </div>
                        )}

                        <button
                            className="btn btn-primary"
                            style={{ width: '100%', position: 'relative' }}
                            disabled={(modalIsBond && tradeModal.mode === 'sell') || modalSubmitting}
                            onClick={submitModalOrder}
                        >
                            {modalSubmitting ? (
                                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                                    <span style={{
                                        width: 16, height: 16, borderRadius: '50%',
                                        border: '2px solid rgba(0,0,0,0.2)',
                                        borderTopColor: '#0d0d0d',
                                        display: 'inline-block',
                                        animation: 'mw-spin 0.7s linear infinite'
                                    }} />
                                    Processing...
                                </span>
                            ) : (
                                tradeModal.mode === 'buy' ? 'Confirm Buy' : 'Confirm Sell'
                            )}
                        </button>

                        {modalStatus.text && (
                            <div style={{
                                marginTop: '0.75rem',
                                padding: '0.6rem 0.75rem',
                                borderRadius: 8,
                                background: modalStatus.isError ? 'rgba(248,81,73,0.15)' : 'rgba(63,185,80,0.15)',
                                color: modalStatus.isError ? 'var(--accent-red)' : 'var(--accent-green)',
                                border: `1px solid ${modalStatus.isError ? 'rgba(248,81,73,0.35)' : 'rgba(63,185,80,0.35)'}`,
                                fontSize: '0.88rem',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem'
                            }}>
                                <span style={{ fontSize: '1rem' }}>{modalStatus.isError ? '✗' : '✓'}</span>
                                {modalStatus.text}
                            </div>
                        )}
                    </div>
                </div>
            )}
            {achievementPopups.length > 0 && (
                <div
                    style={{
                        position: 'fixed',
                        top: '1rem',
                        right: '1rem',
                        width: 'min(92vw, 360px)',
                        display: 'grid',
                        gap: '0.65rem',
                        zIndex: 130
                    }}
                >
                    {achievementPopups.map((popup) => (
                        <div
                            key={popup.id}
                            className="glass-panel"
                            style={{
                                padding: '0.75rem 0.85rem',
                                border: `1px solid ${achievementTierColor(popup.tier)}`,
                                boxShadow: '0 8px 26px rgba(0,0,0,0.35)',
                                background: 'rgba(8, 13, 24, 0.93)'
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                                <span
                                    style={{
                                        fontSize: '0.72rem',
                                        letterSpacing: '0.04em',
                                        textTransform: 'uppercase',
                                        color: achievementTierColor(popup.tier),
                                        fontWeight: 700
                                    }}
                                >
                                    Achievement Unlocked
                                </span>
                                <button
                                    className="btn btn-outline"
                                    style={{ padding: '0.2rem 0.35rem', minWidth: 30 }}
                                    onClick={() => setAchievementPopups((prev) => prev.filter((entry) => entry.id !== popup.id))}
                                >
                                    <X size={12} />
                                </button>
                            </div>
                            <div style={{ marginTop: '0.35rem', fontWeight: 700 }}>{popup.title}</div>
                            <div className="text-muted" style={{ marginTop: '0.2rem', fontSize: '0.82rem' }}>
                                {popup.description}
                            </div>
                            {(popup.threshold || popup.unlockedValue) && (
                                <div className="mono" style={{ marginTop: '0.4rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                                    {popup.threshold ? `Target: ${formatMoney(popup.threshold, 0)}` : ''}
                                    {popup.threshold && popup.unlockedValue ? ' | ' : ''}
                                    {popup.unlockedValue ? `Reached: ${formatMoney(popup.unlockedValue, 0)}` : ''}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <Ticker events={newsFeed} />

            <div style={{ padding: '2rem' }}>
                <div className="flex-between" style={{ marginBottom: '1.3rem', gap: '1rem', flexWrap: 'wrap' }}>
                    <div>
                        <h2>{modeTitleMap[normalizedMode] || 'Main Dashboard'}</h2>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.4rem' }}>
                            <RefreshCcw size={14} className={lastTick ? 'text-up' : 'text-muted'} />
                            <span className="text-muted" style={{ fontSize: '0.85rem' }}>
                                Sync: {lastTick ? 'Connected' : 'Waiting'} | Day {snapshot.world?.current_tick ?? 0}
                            </span>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <button className="btn btn-outline" onClick={() => router.push('/dashboard/achievements')}>
                            <Trophy size={16} /> Achievements
                        </button>
                        <button className="btn btn-outline" onClick={handleLeave}>Leave World</button>
                    </div>
                </div>

                <div className="glass-panel" style={{
                    padding: '0.75rem',
                    marginBottom: '1rem',
                    boxShadow: '0 2px 12px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)'
                }}>
                    <div className="text-muted" style={{ fontSize: '0.78rem', marginBottom: '0.5rem' }}>Navigate Dashboard</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem' }}>
                        <button className={`btn ${normalizedMode === 'main' ? 'btn-primary' : 'btn-outline'}`} onClick={() => router.push('/dashboard')}>Main</button>
                        <button className={`btn ${normalizedMode === 'assets' ? 'btn-primary' : 'btn-outline'}`} onClick={() => router.push('/dashboard/assets')}>Assets & Buying</button>
                        <button className={`btn ${normalizedMode === 'stock-market' ? 'btn-primary' : 'btn-outline'}`} onClick={() => router.push('/dashboard/stock-market')}>Stock Market</button>
                        <button className={`btn ${normalizedMode === 'macro' ? 'btn-primary' : 'btn-outline'}`} onClick={() => router.push('/dashboard/macro')}>Macro Indicators</button>
                        <button className={`btn ${normalizedMode === 'companies' ? 'btn-primary' : 'btn-outline'}`} onClick={() => router.push('/dashboard/companies')}>Company Management</button>
                        <button className={`btn ${normalizedMode === 'chat' ? 'btn-primary' : 'btn-outline'}`} onClick={() => router.push('/dashboard/chat')}>Chat & Deals</button>
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '0.9rem', marginBottom: '1.1rem' }}>
                    <div className="glass-card" style={{
                        padding: '1rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.8rem',
                        boxShadow: '0 4px 18px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.07)',
                        background: 'linear-gradient(160deg, rgba(47,129,247,0.07) 0%, rgba(0,0,0,0) 60%)'
                    }}>
                        <div style={{
                            background: 'rgba(47, 129, 247, 0.18)',
                            borderRadius: 10,
                            padding: '0.7rem',
                            boxShadow: '0 2px 8px rgba(47,129,247,0.25), inset 0 1px 0 rgba(255,255,255,0.1)'
                        }}>
                            <Wallet size={24} color="var(--accent-blue)" />
                        </div>
                        <div>
                            <div className="text-muted" style={{ fontSize: '0.8rem' }}>Capital</div>
                            <div className="mono" style={{ fontWeight: 700, fontSize: '1.2rem' }}>{formatMoney(portfolio.cash_balance)}</div>
                        </div>
                    </div>

                    <div className="glass-card" style={{
                        padding: '1rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.8rem',
                        boxShadow: '0 4px 18px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.07)',
                        background: 'linear-gradient(160deg, rgba(163,113,247,0.07) 0%, rgba(0,0,0,0) 60%)'
                    }}>
                        <div style={{
                            background: 'rgba(163, 113, 247, 0.18)',
                            borderRadius: 10,
                            padding: '0.7rem',
                            boxShadow: '0 2px 8px rgba(163,113,247,0.25), inset 0 1px 0 rgba(255,255,255,0.1)'
                        }}>
                            <TrendingUp size={24} color="var(--accent-purple)" />
                        </div>
                        <div>
                            <div className="text-muted" style={{ fontSize: '0.8rem' }}>Net Worth</div>
                            <div className="mono" style={{ fontWeight: 700, fontSize: '1.2rem' }}>{formatMoney(portfolio.net_worth)}</div>
                        </div>
                    </div>

                    <div className="glass-card" style={{
                        padding: '1rem',
                        boxShadow: '0 4px 18px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)'
                    }}>
                        <div className="text-muted" style={{ fontSize: '0.8rem' }}>World</div>
                        <div style={{ fontWeight: 700 }}>{snapshot.world?.name || 'Unknown world'}</div>
                        <div className="text-muted" style={{ fontSize: '0.8rem' }}>Tick rate: {snapshot.world?.tick_rate_seconds || '-'}s</div>
                    </div>

                    <div className="glass-card" style={{
                        padding: '1rem',
                        boxShadow: '0 4px 18px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)'
                    }}>
                        <div className="text-muted" style={{ fontSize: '0.8rem' }}>News Feed</div>
                        <div style={{ fontWeight: 700 }}>{newsFeed.length} / 100</div>
                        <button className="btn btn-outline" style={{ marginTop: '0.5rem', width: '100%' }} onClick={() => setNewsFeed([])}>
                            Clear News
                        </button>
                    </div>

                </div>

                <div className="glass-panel" style={{ padding: '1rem', marginBottom: '1rem', maxHeight: 240, overflowY: 'auto' }}>
                    {newsFeed.length === 0 ? (
                        <div className="text-muted">No news yet.</div>
                    ) : (
                        newsFeed.map((item) => (
                            <div key={item.key} style={{ borderBottom: '1px solid var(--panel-border)', padding: '0.5rem 0' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center' }}>
                                    <span style={{
                                        fontSize: '0.72rem',
                                        textTransform: 'uppercase',
                                        background: severityColor(item.severity),
                                        color: '#fff',
                                        borderRadius: 5,
                                        padding: '0.15rem 0.35rem'
                                    }}>
                                        {item.severity}
                                    </span>
                                    <span className="text-muted" style={{ fontSize: '0.75rem' }}>{item.timeText}</span>
                                </div>
                                <div style={{ marginTop: '0.25rem' }}>
                                    <strong>{item.title}</strong> - {item.description}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {showMainSections && (
                    <div className="glass-panel" style={{ overflow: 'hidden', marginBottom: '1rem' }}>
                        <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--panel-border)' }}>
                            <strong>Portfolio Snapshot</strong>
                            <div className="text-muted" style={{ marginTop: '0.3rem', fontSize: '0.82rem' }}>
                                Top holdings by estimated value. Use Assets & Buying for full execution and history views.
                            </div>
                        </div>

                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ background: 'rgba(0,0,0,0.25)', borderBottom: '1px solid var(--panel-border)' }}>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Asset</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Type</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Owned</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Unit Price</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Est. Value</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {topPortfolioHoldings.length === 0 ? (
                                        <tr>
                                            <td colSpan={5} style={{ padding: '0.9rem', textAlign: 'center' }} className="text-muted">
                                                No holdings yet.
                                            </td>
                                        </tr>
                                    ) : topPortfolioHoldings.map((asset) => (
                                        <tr key={`top-${asset.asset_type}-${asset.asset_id}`} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                            <td style={{ padding: '0.6rem' }}>#{asset.asset_id} {asset.symbol ? `(${asset.symbol})` : ''}</td>
                                            <td style={{ padding: '0.6rem', textTransform: 'capitalize' }}>{asset.asset_type}</td>
                                            <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(asset.quantity, 6)}</td>
                                            <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(asset.current_price, 6)}</td>
                                            <td style={{ padding: '0.6rem' }} className="mono">{formatMoney(asset.estimatedValue || 0)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {showAssetsSections && (
                    <div className="glass-panel" style={{ overflow: 'hidden', marginBottom: '1rem' }}>
                        <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--panel-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <strong>World Assets (Commodities, Bonds, Crypto)</strong>
                            <select className="form-control" style={{ width: 180, marginBottom: 0 }} value={worldSort} onChange={(event) => setWorldSort(event.target.value)}>
                                <option value="asset_id">Sort by Asset ID</option>
                                <option value="price">Sort by Unit Price</option>
                                <option value="quantity">Sort by Quantity</option>
                            </select>
                        </div>
                        <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ background: 'rgba(0,0,0,0.25)', borderBottom: '1px solid var(--panel-border)' }}>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Asset ID</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Unit Cost</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Prev Price</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>% Change</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Available</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Type</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Associated Organization</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {marketAssets.length === 0 ? (
                                        <tr>
                                            <td colSpan={8} style={{ padding: '0.9rem', textAlign: 'center' }} className="text-muted">No non-stock assets available.</td>
                                        </tr>
                                    ) : marketAssets.map((asset) => {
                                        const change = asset.percent_change;
                                        const changeText = change === null || Number.isNaN(change)
                                            ? '-'
                                            : `${change >= 0 ? '+' : ''}${Number(change).toFixed(2)}%`;

                                        return (
                                            <tr key={asset.asset_id} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                                <td style={{ padding: '0.6rem' }}>#{asset.asset_id} {asset.symbol ? `(${asset.symbol})` : ''}</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(asset.current_price, 6)}</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{asset.prev_price === null ? '-' : formatNumber(asset.prev_price, 6)}</td>
                                                <td style={{ padding: '0.6rem' }} className={change >= 0 ? 'text-up mono' : 'text-down mono'}>{changeText}</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(asset.available_quantity, 4)}</td>
                                                <td style={{ padding: '0.6rem', textTransform: 'capitalize' }}>{asset.asset_type}</td>
                                                <td style={{ padding: '0.6rem' }}>{asset.associated_organization}</td>
                                                <td style={{ padding: '0.6rem' }}>
                                                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                                        <button
                                                            className="btn btn-outline"
                                                            style={{ padding: '0.3rem 0.6rem' }}
                                                            onClick={() => fetchHistory(asset.asset_type, asset.asset_id, asset.name)}
                                                        >
                                                            View
                                                        </button>
                                                        <button
                                                            className="btn btn-primary"
                                                            style={{ padding: '0.3rem 0.6rem' }}
                                                            onClick={() => openTradeModal('buy', asset)}
                                                        >
                                                            Buy
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {showStockMarketSections && (
                    <div className="glass-panel" style={{ overflow: 'hidden', marginBottom: '1rem' }}>
                        <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--panel-border)' }}>
                            <strong>Stocks By Exchange</strong>
                            <div className="text-muted" style={{ marginTop: '0.35rem', fontSize: '0.82rem' }}>
                                Click a market on the globe to inspect listed companies and currently available shares for sale on that exchange.
                            </div>
                        </div>

                        <div style={{ padding: '0.9rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '0.85rem' }}>
                            <div>
                                <MarketGlobe
                                    markets={stockMarkets}
                                    selectedMarketId={selectedBrowseMarketId || null}
                                    onSelect={(market) => setSelectedBrowseMarketId(Number(market.id))}
                                />
                            </div>

                            <div className="glass-card" style={{ padding: '0.75rem' }}>
                                <div style={{ fontWeight: 700 }}>
                                    {selectedBrowseMarket
                                        ? `${selectedBrowseMarket.name} (${selectedBrowseMarket.code})`
                                        : 'Select a stock market'}
                                </div>
                                <div className="text-muted" style={{ marginTop: '0.3rem', fontSize: '0.82rem' }}>
                                    {selectedBrowseMarket
                                        ? `${selectedBrowseMarket.city}, ${selectedBrowseMarket.country_name} | ${selectedBrowseMarket.currency} | ${selectedBrowseMarket.listing_tier} tier`
                                        : 'No market selected.'}
                                </div>

                                <div
                                    style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                                        gap: '0.45rem',
                                        marginTop: '0.65rem'
                                    }}
                                >
                                    <div className="glass-panel" style={{ padding: '0.45rem 0.55rem' }}>
                                        <div className="text-muted" style={{ fontSize: '0.74rem' }}>Companies</div>
                                        <div className="mono">{formatNumber(stockListingsSummary.companies, 0)}</div>
                                    </div>
                                    <div className="glass-panel" style={{ padding: '0.45rem 0.55rem' }}>
                                        <div className="text-muted" style={{ fontSize: '0.74rem' }}>Shares For Sale</div>
                                        <div className="mono">{formatNumber(stockListingsSummary.sharesForSale, 2)}</div>
                                    </div>
                                    <div className="glass-panel" style={{ padding: '0.45rem 0.55rem' }}>
                                        <div className="text-muted" style={{ fontSize: '0.74rem' }}>Shares Listed</div>
                                        <div className="mono">{formatNumber(stockListingsSummary.listedShares, 2)}</div>
                                    </div>
                                </div>

                                <div className="glass-panel" style={{ marginTop: '0.65rem', padding: '0.55rem 0.6rem' }}>
                                    <div className="text-muted" style={{ fontSize: '0.74rem', marginBottom: '0.4rem' }}>Exchange Indexes</div>
                                    {selectedBrowseMarketIndexes.length === 0 ? (
                                        <div className="text-muted" style={{ fontSize: '0.8rem' }}>
                                            Indexes appear automatically once this market has at least 10, 20, or 100 active companies.
                                        </div>
                                    ) : (
                                        <div style={{ display: 'grid', gap: '0.35rem' }}>
                                            {selectedBrowseMarketIndexes.map((index) => (
                                                <div
                                                    key={index.key}
                                                    style={{
                                                        display: 'flex',
                                                        justifyContent: 'space-between',
                                                        gap: '0.6rem',
                                                        border: '1px solid var(--panel-border)',
                                                        borderRadius: 7,
                                                        padding: '0.35rem 0.45rem',
                                                        fontSize: '0.8rem'
                                                    }}
                                                >
                                                    <div>
                                                        <strong>{index.name}</strong>
                                                        <span className="text-muted"> ({index.component_count} companies)</span>
                                                    </div>
                                                    <div className="mono" style={{ textAlign: 'right' }}>
                                                        <div>{formatNumber(index.level, 2)}</div>
                                                        <div className={Number(index.change_pct) >= 0 ? 'text-up' : 'text-down'}>
                                                            {Number(index.change_pct) >= 0 ? '+' : ''}{formatNumber(index.change_pct, 3)}%
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto', borderTop: '1px solid var(--panel-border)' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ background: 'rgba(0,0,0,0.25)', borderBottom: '1px solid var(--panel-border)' }}>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Asset ID</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Company</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Last Price</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Best Ask</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Shares For Sale</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Open Sell Orders</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {stockListingsLoading ? (
                                        <tr>
                                            <td colSpan={7} style={{ padding: '0.9rem', textAlign: 'center' }} className="text-muted">Loading market listings...</td>
                                        </tr>
                                    ) : stockListings.length === 0 ? (
                                        <tr>
                                            <td colSpan={7} style={{ padding: '0.9rem', textAlign: 'center' }} className="text-muted">No listed companies available for this market yet.</td>
                                        </tr>
                                    ) : stockListings.map((listing) => {
                                        const ownedHolding = userAssets.find((h) => Number(h.asset_id) === Number(listing.asset_id) && h.asset_type === 'share');
                                        return (
                                            <tr key={listing.asset_id} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                                <td style={{ padding: '0.6rem' }} className="mono">#{listing.asset_id}</td>
                                                <td style={{ padding: '0.6rem' }}>{listing.company_name} ({listing.ticker})</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(listing.share_price, 6)}</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(listing.best_ask_price, 6)}</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(listing.shares_for_sale, 4)}</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(listing.sell_order_count, 0)}</td>
                                                <td style={{ padding: '0.6rem' }}>
                                                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                                        <button
                                                            className="btn btn-outline"
                                                            style={{ padding: '0.3rem 0.6rem' }}
                                                            onClick={() => fetchHistory('share', listing.asset_id, `${listing.company_name} (${listing.ticker})`)}
                                                        >
                                                            View
                                                        </button>
                                                        <button
                                                            className="btn btn-primary"
                                                            style={{ padding: '0.3rem 0.6rem' }}
                                                            onClick={() => openTradeModal('buy', {
                                                                asset_id: listing.asset_id,
                                                                asset_type: 'share',
                                                                name: listing.company_name,
                                                                symbol: listing.ticker,
                                                                current_price: listing.share_price,
                                                                available_quantity: listing.shares_for_sale
                                                            })}
                                                        >
                                                            Buy
                                                        </button>
                                                        {ownedHolding && (
                                                            <button
                                                                className="btn btn-outline"
                                                                style={{ padding: '0.3rem 0.6rem', color: 'var(--accent-red)', borderColor: 'rgba(248,81,73,0.4)' }}
                                                                onClick={() => openTradeModal('sell', {
                                                                    asset_id: listing.asset_id,
                                                                    asset_type: 'share',
                                                                    name: listing.company_name,
                                                                    symbol: listing.ticker,
                                                                    current_price: listing.share_price,
                                                                    available_quantity: ownedHolding.quantity
                                                                })}
                                                            >
                                                                Sell
                                                            </button>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {showStockMarketSections && selectedAsset && (
                    <div className="glass-panel" style={{
                        marginBottom: '1rem',
                        boxShadow: '0 6px 28px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)'
                    }}>
                        <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--panel-border)' }}>
                            <strong>Asset Price History</strong>
                            <div className="text-muted" style={{ marginTop: '0.35rem', fontSize: '0.82rem' }}>
                                {`Asset #${selectedAsset.assetId} (${selectedAsset.assetType}) - ${selectedAsset.name}`}
                            </div>
                        </div>

                        <div style={{ padding: '1rem' }}>
                            {latestHistoryPoint && (
                                <div className="live-update-pill" style={{ marginBottom: '0.72rem' }}>
                                    Live update synced: Day {Number(latestHistoryPoint.game_day || 0)}
                                    {Number.isFinite(Number(lastHistorySyncTick)) && Number(lastHistorySyncTick) > 0
                                        ? ` | Tick ${Number(lastHistorySyncTick)}`
                                        : ''}
                                </div>
                            )}

                            <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                                {HISTORY_RANGE_OPTIONS.map((option) => (
                                    <button
                                        key={option.key}
                                        className={`btn ${historyRange === option.key ? 'btn-primary' : 'btn-outline'}`}
                                        style={{ padding: '0.28rem 0.6rem' }}
                                        onClick={() => setHistoryRange(option.key)}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                                <div className="text-muted" style={{ alignSelf: 'center', fontSize: '0.78rem', marginLeft: 'auto' }}>
                                    Showing {visibleHistoryRows.length} / {historyRows.length} points.
                                </div>
                            </div>

                            <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: '0.8rem', border: '1px solid var(--panel-border)', borderRadius: 8 }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead style={{ position: 'sticky', top: 0, background: 'var(--panel-bg)', zIndex: 1 }}>
                                        <tr style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                            <th style={{ padding: '0.55rem', textAlign: 'left' }}>Index</th>
                                            <th style={{ padding: '0.55rem', textAlign: 'left' }}>Game Day</th>
                                            <th style={{ padding: '0.55rem', textAlign: 'left' }}>Price</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {visibleHistoryRows.length === 0 ? (
                                            <tr><td colSpan={3} style={{ padding: '0.8rem', textAlign: 'center' }} className="text-muted">No history loaded.</td></tr>
                                        ) : visibleHistoryRows.map((row, index) => (
                                            <tr key={row.id} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                                <td style={{ padding: '0.5rem' }} className="mono">{index + 1}</td>
                                                <td style={{ padding: '0.5rem' }}>Day {Number(row.game_day || 0)}</td>
                                                <td style={{ padding: '0.5rem' }} className="mono">{formatNumber(row.price, 6)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <div style={{ height: 300 }}>
                                <HistoryLineChart rows={visibleHistoryRows} selectedRange={historyRange} />
                            </div>
                        </div>
                    </div>
                )}

                {showAssetsSections && (
                    <div className="glass-panel" style={{ overflow: 'hidden', marginBottom: '1rem' }}>
                        <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--panel-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <strong>Your Assets (Non-Bond)</strong>
                            <select className="form-control" style={{ width: 180, marginBottom: 0 }} value={userSort} onChange={(event) => setUserSort(event.target.value)}>
                                <option value="asset_id">Sort by Asset ID</option>
                                <option value="price">Sort by Unit Price</option>
                                <option value="quantity">Sort by Quantity</option>
                            </select>
                        </div>
                        <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ background: 'rgba(0,0,0,0.25)', borderBottom: '1px solid var(--panel-border)' }}>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Asset ID</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Unit Cost</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Prev Price</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>% Change</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Owned</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Type</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Associated Organization</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {userNonBondAssets.length === 0 ? (
                                        <tr>
                                            <td colSpan={8} style={{ padding: '0.9rem', textAlign: 'center' }} className="text-muted">No non-bond holdings.</td>
                                        </tr>
                                    ) : userNonBondAssets.map((asset) => (
                                        <tr key={`${asset.asset_type}-${asset.asset_id}`} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                            <td style={{ padding: '0.6rem' }}>#{asset.asset_id} {asset.symbol ? `(${asset.symbol})` : ''}</td>
                                            <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(asset.current_price, 6)}</td>
                                            <td style={{ padding: '0.6rem' }} className="mono">-</td>
                                            <td style={{ padding: '0.6rem' }} className="mono">-</td>
                                            <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(asset.quantity, 8)}</td>
                                            <td style={{ padding: '0.6rem', textTransform: 'capitalize' }}>{asset.asset_type}</td>
                                            <td style={{ padding: '0.6rem' }}>{asset.name}</td>
                                            <td style={{ padding: '0.6rem' }}>
                                                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                                    <button
                                                        className="btn btn-outline"
                                                        style={{ padding: '0.3rem 0.6rem' }}
                                                        onClick={() => fetchHistory(asset.asset_type, asset.asset_id, asset.name)}
                                                    >
                                                        View
                                                    </button>
                                                    <button
                                                        className="btn btn-outline"
                                                        style={{ padding: '0.3rem 0.6rem', color: 'var(--accent-red)', borderColor: 'rgba(248,81,73,0.4)' }}
                                                        onClick={() => openTradeModal('sell', {
                                                            asset_id: asset.asset_id,
                                                            asset_type: asset.asset_type,
                                                            name: asset.name,
                                                            symbol: asset.symbol,
                                                            current_price: asset.current_price,
                                                            available_quantity: asset.quantity
                                                        })}
                                                    >
                                                        Sell
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {showAssetsSections && (
                    <div className="glass-panel" style={{ overflow: 'hidden', marginBottom: '1rem' }}>
                        <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--panel-border)' }}>
                            <strong>Your Bonds</strong>
                            <div className="text-muted" style={{ marginTop: '0.35rem', fontSize: '0.8rem' }}>
                                Bond units are non-transferable: hold until maturity for fixed treasury-funded payout.
                            </div>
                        </div>
                        <div style={{ overflowX: 'auto', maxHeight: 280, overflowY: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ background: 'rgba(0,0,0,0.25)', borderBottom: '1px solid var(--panel-border)' }}>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Bond</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Owned</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Unit Price</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Fixed Profit</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Maturity</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Maturity Payout / Unit</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>Est. Maturity Value</th>
                                        <th style={{ padding: '0.65rem', textAlign: 'left' }}>History</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {userBondAssets.length === 0 ? (
                                        <tr>
                                            <td colSpan={8} style={{ padding: '0.9rem', textAlign: 'center' }} className="text-muted">No bond holdings.</td>
                                        </tr>
                                    ) : userBondAssets.map((asset) => {
                                        const promisedUnit = Number(asset.promised_unit_value || 0);
                                        const estimatedMaturityValue = promisedUnit * Number(asset.quantity || 0);
                                        const totalMaturity = Number(asset.maturity_ticks || 0);
                                        const remaining = Math.max(0, Number(asset.ticks_remaining || 0));
                                        const elapsed = Math.max(0, totalMaturity - remaining);
                                        return (
                                            <tr key={`${asset.asset_type}-${asset.asset_id}`} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                                <td style={{ padding: '0.6rem' }}>#{asset.asset_id} {asset.symbol ? `(${asset.symbol})` : ''}</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(asset.quantity, 8)}</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(asset.current_price, 6)}</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{(Number(asset.interest_rate || 0) * 100).toFixed(2)}%</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{elapsed}/{totalMaturity} days (rem {remaining})</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(promisedUnit, 6)}</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(estimatedMaturityValue, 6)}</td>
                                                <td style={{ padding: '0.6rem' }}>
                                                    <button
                                                        className="btn btn-outline"
                                                        style={{ padding: '0.3rem 0.6rem' }}
                                                        onClick={() => fetchHistory(asset.asset_type, asset.asset_id, asset.name)}
                                                    >
                                                        View
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {showAssetsSections && (
                    <div className="glass-panel" style={{ marginBottom: '1rem' }}>
                        <strong>Asset Price History</strong>
                        <div className="text-muted" style={{ marginTop: '0.35rem', marginBottom: '0.7rem' }}>
                            {selectedAsset
                                ? `Asset #${selectedAsset.assetId} (${selectedAsset.assetType}) - ${selectedAsset.name}`
                                : 'Select an asset history button.'}
                        </div>

                        {selectedAsset && latestHistoryPoint && (
                            <div className="live-update-pill" style={{ marginBottom: '0.72rem' }}>
                                Live update synced: Day {Number(latestHistoryPoint.game_day || 0)}
                                {Number.isFinite(Number(lastHistorySyncTick)) && Number(lastHistorySyncTick) > 0
                                    ? ` | Tick ${Number(lastHistorySyncTick)}`
                                    : ''}
                            </div>
                        )}

                        <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                            {HISTORY_RANGE_OPTIONS.map((option) => (
                                <button
                                    key={option.key}
                                    className={`btn ${historyRange === option.key ? 'btn-primary' : 'btn-outline'}`}
                                    style={{ padding: '0.28rem 0.6rem' }}
                                    onClick={() => setHistoryRange(option.key)}
                                >
                                    {option.label}
                                </button>
                            ))}
                            <div className="text-muted" style={{ alignSelf: 'center', fontSize: '0.78rem' }}>
                                Showing {visibleHistoryRows.length} / {historyRows.length} points.
                            </div>
                        </div>

                        <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: '0.8rem' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Index</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Game Day</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Price</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {visibleHistoryRows.length === 0 ? (
                                        <tr><td colSpan={3} style={{ padding: '0.8rem', textAlign: 'center' }} className="text-muted">No history loaded.</td></tr>
                                    ) : visibleHistoryRows.map((row, index) => (
                                        <tr key={row.id} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                            <td style={{ padding: '0.5rem' }} className="mono">{index + 1}</td>
                                            <td style={{ padding: '0.5rem' }}>
                                                Day {Number(row.game_day || 0)}
                                            </td>
                                            <td style={{ padding: '0.5rem' }} className="mono">{formatNumber(row.price, 6)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <HistoryLineChart rows={visibleHistoryRows} selectedRange={historyRange} />
                    </div>
                )}

                {showStockMarketSections && (
                    <div className="glass-panel" style={{ overflow: 'hidden', marginBottom: '1rem' }}>
                        <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--panel-border)' }}>
                            <strong>Pending Share Orders</strong>
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Order ID</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Type</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Asset</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Quantity</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Unit Cost</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pendingShareOrders.length === 0 ? (
                                        <tr><td colSpan={6} style={{ padding: '0.8rem', textAlign: 'center' }} className="text-muted">No pending share buy/sell orders.</td></tr>
                                    ) : pendingShareOrders.map((order) => (
                                        <tr key={order.id} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                            <td style={{ padding: '0.55rem' }} className="mono">{order.id}</td>
                                            <td style={{ padding: '0.55rem', textTransform: 'capitalize' }}>{order.order_type}</td>
                                            <td style={{ padding: '0.55rem' }}>#{order.asset_id} ({order.asset_meta?.symbol || '-'} / {order.asset_type})</td>
                                            <td style={{ padding: '0.55rem' }} className="mono">{formatNumber(order.remaining_quantity, 8)}</td>
                                            <td style={{ padding: '0.55rem' }} className="mono">{formatNumber(order.price_per_unit, 8)}</td>
                                            <td style={{ padding: '0.55rem' }}>{order.status}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {showCompanySections && (
                    <div className="glass-panel" style={{ overflow: 'hidden', marginBottom: '1rem' }}>
                        <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--panel-border)' }}>
                            <strong>Your Companies</strong>
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Company</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Sector</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Exchange</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Risk</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Strategy</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Control</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Shares Owned</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Shares On Market</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Status</th>
                                        <th style={{ padding: '0.55rem', textAlign: 'left' }}>Manage</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {companies.filter((company) => company.is_active).length === 0 ? (
                                        <tr><td colSpan={10} style={{ padding: '0.8rem', textAlign: 'center' }} className="text-muted">No controllable companies.</td></tr>
                                    ) : companies.filter((company) => company.is_active).map((company) => (
                                        <tr key={company.id} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                            <td style={{ padding: '0.55rem' }}>{company.name} ({company.ticker})</td>
                                            <td style={{ padding: '0.55rem' }}>{company.sector_name}</td>
                                            <td style={{ padding: '0.55rem' }}>{company.stock_market_code || '-'} ({company.country_code || '-'})</td>
                                            <td style={{ padding: '0.55rem' }}>{company.risk_level}</td>
                                            <td style={{ padding: '0.55rem' }}>{company.growth_strategy}</td>
                                            <td style={{ padding: '0.55rem', textTransform: 'capitalize' }}>{String(company.controller_source || 'owner').replace('_', ' ')}</td>
                                            <td style={{ padding: '0.55rem' }} className="mono">{formatNumber(company.shares_owned, 4)}</td>
                                            <td style={{ padding: '0.55rem' }} className="mono">{formatNumber(company.shares_listed, 4)}</td>
                                            <td style={{ padding: '0.55rem' }}>{company.is_active ? 'Active' : 'Liquidated'}</td>
                                            <td style={{ padding: '0.55rem' }}>
                                                <button className="btn btn-outline" style={{ padding: '0.3rem 0.6rem' }} onClick={() => handleSelectCompany(company)}>
                                                    Manage
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {showCompanySections && (
                    <div className="glass-panel" style={{ marginBottom: '1rem' }}>
                        <strong>Manage Selected Company</strong>
                        {selectedCompany ? (
                            <>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.8rem', marginTop: '0.8rem' }}>
                                    <div>
                                        <div className="text-muted" style={{ fontSize: '0.78rem' }}>Selected Company</div>
                                        <div>{selectedCompany.name}</div>
                                    </div>
                                    <div>
                                        <div className="text-muted" style={{ fontSize: '0.78rem' }}>Sector</div>
                                        <div>{selectedCompany.sector_name}</div>
                                    </div>
                                    <div>
                                        <div className="text-muted" style={{ fontSize: '0.78rem' }}>Status</div>
                                        <div>{selectedCompany.is_active ? 'Active' : 'Liquidated'}</div>
                                    </div>
                                    <div>
                                        <div className="text-muted" style={{ fontSize: '0.78rem' }}>Listing Status</div>
                                        <div style={{ color: selectedCompany.is_listed ? 'var(--accent-green)' : 'var(--text-secondary)' }}>
                                            {selectedCompany.is_listed ? `Listed on ${selectedCompany.stock_market_code || 'Exchange'}` : 'Private (Unlisted)'}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-muted" style={{ fontSize: '0.78rem' }}>Shares Owned</div>
                                        <div>{formatNumber(selectedCompany.shares_owned, 4)}</div>
                                    </div>
                                    <div>
                                        <div className="text-muted" style={{ fontSize: '0.78rem' }}>Shares On Market</div>
                                        <div>{formatNumber(selectedCompany.shares_listed, 4)}</div>
                                    </div>
                                    <div>
                                        <div className="text-muted" style={{ fontSize: '0.78rem' }}>Company ID</div>
                                        <div>{selectedCompany.id}</div>
                                    </div>
                                    <div>
                                        <div className="text-muted" style={{ fontSize: '0.78rem' }}>Listing Exchange</div>
                                        <div>{selectedCompany.stock_market_name || '-'} ({selectedCompany.stock_market_code || '-'})</div>
                                    </div>
                                </div>

                                {/* List on Market section for private companies */}
                                {!selectedCompany.is_listed && (
                                    <div style={{ marginTop: '0.9rem', padding: '0.75rem', background: 'rgba(105, 217, 255, 0.06)', border: '1px solid rgba(105, 217, 255, 0.18)', borderRadius: 8 }}>
                                        <div style={{ fontSize: '0.88rem', marginBottom: '0.5rem', color: 'var(--accent-blue)' }}>
                                            This company is private. List it on a stock market to allow public trading.
                                        </div>
                                        {!listOnMarketForm.open ? (
                                            <button
                                                type="button"
                                                className="btn btn-outline"
                                                onClick={() => setListOnMarketForm({ stockMarketId: String(stockMarkets[0]?.id || ''), open: true })}
                                            >
                                                List on Market
                                            </button>
                                        ) : (
                                            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                                                <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 180 }}>
                                                    <label>Select Stock Market</label>
                                                    <select
                                                        className="form-control"
                                                        value={listOnMarketForm.stockMarketId}
                                                        onChange={(e) => setListOnMarketForm((prev) => ({ ...prev, stockMarketId: e.target.value }))}
                                                    >
                                                        {stockMarkets.map((market) => (
                                                            <option key={market.id} value={market.id}>
                                                                {market.code} - {market.name} (min ${(market.min_listing_capital || 0).toLocaleString()})
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <button type="button" className="btn btn-success" onClick={handleListOnMarket}>Confirm Listing</button>
                                                <button type="button" className="btn btn-outline" onClick={() => setListOnMarketForm({ stockMarketId: '', open: false })}>Cancel</button>
                                            </div>
                                        )}
                                        {listOnMarketStatus.text && (
                                            <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: listOnMarketStatus.isError ? 'var(--accent-red)' : 'var(--accent-green)' }}>
                                                {listOnMarketStatus.text}
                                            </div>
                                        )}
                                    </div>
                                )}

                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.8rem', marginTop: '0.9rem' }}>
                                    <div className="form-group">
                                        <label>Risk Level</label>
                                        <select className="form-control" value={manageForm.riskLevel} onChange={(event) => setManageForm((prev) => ({ ...prev, riskLevel: event.target.value }))}>
                                            <option value="conservative">Conservative</option>
                                            <option value="moderate">Moderate</option>
                                            <option value="aggressive">Aggressive</option>
                                        </select>
                                    </div>

                                    <div className="form-group">
                                        <label>Business Strategy</label>
                                        <select className="form-control" value={manageForm.growthStrategy} onChange={(event) => setManageForm((prev) => ({ ...prev, growthStrategy: event.target.value }))}>
                                            <option value="organic">Organic</option>
                                            <option value="acquisition">Acquisition</option>
                                            <option value="diversified">Diversified</option>
                                        </select>
                                    </div>

                                    <div className="form-group">
                                        <label>Dividend Policy</label>
                                        <select className="form-control" value={manageForm.dividendPolicy} onChange={(event) => setManageForm((prev) => ({ ...prev, dividendPolicy: event.target.value }))}>
                                            <option value="none">None</option>
                                            <option value="low">Low</option>
                                            <option value="medium">Medium</option>
                                            <option value="high">High</option>
                                        </select>
                                    </div>

                                    {selectedCompany.is_listed && (
                                        <>
                                            <div className="form-group">
                                                <label>Shares To Put On Market</label>
                                                <input
                                                    className="form-control"
                                                    type="number"
                                                    min="1"
                                                    step="1"
                                                    value={manageForm.listQuantity}
                                                    onChange={(event) => setManageForm((prev) => ({ ...prev, listQuantity: event.target.value }))}
                                                    placeholder="Enter shares"
                                                />
                                            </div>

                                            <div className="form-group">
                                                <label>Listing Stock Market</label>
                                                <select
                                                    className="form-control"
                                                    value={manageForm.listStockMarketId}
                                                    onChange={(event) => setManageForm((prev) => ({ ...prev, listStockMarketId: event.target.value }))}
                                                >
                                                    {stockMarkets.map((market) => (
                                                        <option key={market.id} value={market.id}>
                                                            {market.code} - {market.name} ({market.country_code})
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                        </>
                                    )}

                                </div>

                                <div className="text-muted" style={{ marginTop: '-0.15rem', marginBottom: '0.75rem', fontSize: '0.8rem' }}>
                                    Shares are listed at the live company share price and must use the company\'s assigned exchange.
                                </div>

                                <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                                    <button className="btn btn-outline" onClick={handleUpdateCompanySettings}>Save Changes</button>
                                    {selectedCompany.is_listed && (
                                        <button className="btn btn-outline" onClick={handleListShares}>List Shares</button>
                                    )}
                                    <button className="btn btn-danger" onClick={handleLiquidateCompany}>Liquidate</button>
                                </div>
                            </>
                        ) : (
                            <div className="text-muted" style={{ marginTop: '0.8rem' }}>No company selected.</div>
                        )}
                        <MessageBox message={manageStatus.text} isError={manageStatus.isError} />
                    </div>
                )}

                {showCompanySections && (
                    <div className="glass-panel" style={{ marginBottom: '1rem' }}>
                        <strong>Create Company</strong>
                        <form onSubmit={handleCreateCompany} style={{ marginTop: '0.8rem' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.8rem' }}>
                                <div className="form-group">
                                    <label>Company Name</label>
                                    <input className="form-control" value={createForm.name} onChange={(event) => setCreateForm((prev) => ({ ...prev, name: event.target.value }))} required />
                                </div>

                                <div className="form-group">
                                    <label>Ticker</label>
                                    <input className="form-control" maxLength={10} value={createForm.ticker} onChange={(event) => setCreateForm((prev) => ({ ...prev, ticker: event.target.value.toUpperCase() }))} required />
                                </div>

                                <div className="form-group">
                                    <label>Sector</label>
                                    <select className="form-control" value={createForm.sectorId} onChange={(event) => setCreateForm((prev) => ({ ...prev, sectorId: event.target.value }))} required>
                                        {sectors.map((sector) => (
                                            <option key={sector.id} value={sector.id}>{sector.name}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="form-group" style={{ gridColumn: 'span 2' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={createForm.listImmediately}
                                            onChange={(e) => setCreateForm((prev) => ({ ...prev, listImmediately: e.target.checked }))}
                                            style={{ width: 16, height: 16 }}
                                        />
                                        List on stock market immediately
                                    </label>
                                    {!createForm.listImmediately && (
                                        <div style={{ marginTop: '0.4rem', fontSize: '0.82rem', color: 'var(--text-secondary)', padding: '0.4rem 0.6rem', background: 'rgba(105, 217, 255, 0.06)', borderRadius: 6, border: '1px solid rgba(105, 217, 255, 0.15)' }}>
                                            Company will be private. You can list it later once it reaches sufficient market cap.
                                        </div>
                                    )}
                                </div>

                                {createForm.listImmediately && (
                                    <div className="form-group">
                                        <label>Stock Market</label>
                                        <select className="form-control" value={createForm.stockMarketId} onChange={(event) => setCreateForm((prev) => ({ ...prev, stockMarketId: event.target.value }))} required={createForm.listImmediately}>
                                            {stockMarkets.map((market) => (
                                                <option key={market.id} value={market.id}>
                                                    {market.code} - {market.name} ({market.country_code})
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}

                                <div className="form-group" style={{ gridColumn: 'span 2' }}>
                                    <label>Description</label>
                                    <input className="form-control" value={createForm.description} onChange={(event) => setCreateForm((prev) => ({ ...prev, description: event.target.value }))} />
                                </div>

                                <div className="form-group">
                                    <label>Starting Capital</label>
                                    <input className="form-control" type="number" min="1" step="0.01" value={createForm.startingCapital} onChange={(event) => setCreateForm((prev) => ({ ...prev, startingCapital: event.target.value }))} required />
                                </div>

                                <div className="form-group">
                                    <label>Number of Shares</label>
                                    <input className="form-control" type="number" min="1" step="1" value={createForm.totalShares} onChange={(event) => setCreateForm((prev) => ({ ...prev, totalShares: event.target.value }))} required />
                                </div>

                                <div className="form-group">
                                    <label>Risk Level</label>
                                    <select className="form-control" value={createForm.riskLevel} onChange={(event) => setCreateForm((prev) => ({ ...prev, riskLevel: event.target.value }))}>
                                        <option value="conservative">Conservative</option>
                                        <option value="moderate">Moderate</option>
                                        <option value="aggressive">Aggressive</option>
                                    </select>
                                </div>

                                <div className="form-group">
                                    <label>Strategy</label>
                                    <select className="form-control" value={createForm.growthStrategy} onChange={(event) => setCreateForm((prev) => ({ ...prev, growthStrategy: event.target.value }))}>
                                        <option value="organic">Organic</option>
                                        <option value="acquisition">Acquisition</option>
                                        <option value="diversified">Diversified</option>
                                    </select>
                                </div>

                                <div className="form-group">
                                    <label>Dividend Policy</label>
                                    <select className="form-control" value={createForm.dividendPolicy} onChange={(event) => setCreateForm((prev) => ({ ...prev, dividendPolicy: event.target.value }))}>
                                        <option value="none">None</option>
                                        <option value="low">Low</option>
                                        <option value="medium">Medium</option>
                                        <option value="high">High</option>
                                    </select>
                                </div>
                            </div>

                            <div style={{ marginBottom: '0.85rem' }}>
                                {createForm.listImmediately && (
                                    <MarketGlobe
                                        markets={stockMarkets}
                                        selectedMarketId={createForm.stockMarketId || null}
                                        onSelect={(market) => setCreateForm((prev) => ({ ...prev, stockMarketId: String(market.id) }))}
                                    />
                                )}
                            </div>

                            <div className="glass-card" style={{ marginBottom: '0.85rem', padding: '0.65rem 0.75rem' }}>
                                {selectedCreateMarket ? (
                                    <div style={{ fontSize: '0.82rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.45rem' }}>
                                        <div><strong>Exchange:</strong> {selectedCreateMarket.name} ({selectedCreateMarket.code})</div>
                                        <div><strong>Country:</strong> {selectedCreateMarket.country_name}</div>
                                        <div><strong>City:</strong> {selectedCreateMarket.city}</div>
                                        <div><strong>Benchmark:</strong> {selectedCreateMarket.benchmark_name}</div>
                                        <div><strong>Tier:</strong> {selectedCreateMarket.listing_tier}</div>
                                        <div><strong>Minimum Listing Capital:</strong> ${Number(selectedCreateMarket.min_listing_capital || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                                        <div><strong>Listed Market Cap:</strong> ${Number(selectedCreateMarket.listed_market_cap || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                                        <div><strong>Listed Companies:</strong> {Number(selectedCreateMarket.listed_company_count || 0).toLocaleString()}</div>
                                    </div>
                                ) : (
                                    <div className="text-muted" style={{ fontSize: '0.82rem' }}>
                                        Select a stock market to create your company listing.
                                    </div>
                                )}
                            </div>

                            <button className="btn btn-primary" type="submit">Create Company</button>
                        </form>
                        <MessageBox message={companyStatus.text} isError={companyStatus.isError} />
                    </div>
                )}

                {showAssetsSections && (portfolio.holdings || []).length === 0 && (
                    <div className="glass-panel" style={{ marginTop: '1rem', textAlign: 'center', padding: '2rem' }}>
                        <AlertCircle size={34} color="var(--text-secondary)" style={{ marginBottom: '0.7rem' }} />
                        <div style={{ fontWeight: 700 }}>No active holdings yet.</div>
                        <div className="text-muted" style={{ fontSize: '0.9rem', marginTop: '0.3rem' }}>
                            Use the Buy buttons in the asset tables above to place your first orders.
                        </div>
                    </div>
                )}

                {showMacroSections && (
                    <>
                        <div className="glass-panel" style={{ overflow: 'hidden', marginBottom: '1rem' }}>
                            <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--panel-border)' }}>
                                <strong>Country Financial Health Globe</strong>
                                <div className="text-muted" style={{ marginTop: '0.3rem', fontSize: '0.82rem' }}>
                                    Click a country to inspect fiscal health, diplomatic relations, and conflict escalation risk.
                                </div>
                            </div>
                            <div style={{ padding: '0.85rem' }}>
                                <CountryMacroGlobe
                                    countries={countryIndicators}
                                    selectedCountryId={selectedMacroCountryId}
                                    onSelectCountry={(countryId) => setSelectedMacroCountryId(Number(countryId))}
                                />
                            </div>
                        </div>

                        <div className="glass-panel" style={{ marginBottom: '1rem', overflow: 'hidden' }}>
                            <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--panel-border)' }}>
                                <strong>Selected Country Financial + Diplomatic Indicators</strong>
                            </div>

                            {!selectedMacroCountry ? (
                                <div style={{ padding: '0.95rem' }} className="text-muted">No country selected.</div>
                            ) : (
                                <div style={{ padding: '0.9rem' }}>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.65rem' }}>
                                        <div className="glass-card" style={{ padding: '0.6rem 0.7rem' }}>
                                            <div className="text-muted" style={{ fontSize: '0.74rem' }}>Country</div>
                                            <div style={{ fontWeight: 700 }}>{selectedMacroCountry.country_name} ({selectedMacroCountry.country_code})</div>
                                        </div>
                                        <div className="glass-card" style={{ padding: '0.6rem 0.7rem' }}>
                                            <div className="text-muted" style={{ fontSize: '0.74rem' }}>Financial Health Score</div>
                                            <div className="mono">{formatNumber(selectedMacroCountry.financial_health_score || selectedMacroCountry.macro_score, 2)} / 100</div>
                                        </div>
                                        <div className="glass-card" style={{ padding: '0.6rem 0.7rem' }}>
                                            <div className="text-muted" style={{ fontSize: '0.74rem' }}>Financial Health Band</div>
                                            <div className={`mono ${healthBandClass(selectedMacroCountry.financial_health_band)}`} style={{ textTransform: 'capitalize' }}>
                                                {selectedMacroCountry.financial_health_band}
                                            </div>
                                        </div>
                                        <div className="glass-card" style={{ padding: '0.6rem 0.7rem' }}>
                                            <div className="text-muted" style={{ fontSize: '0.74rem' }}>Conflict Risk</div>
                                            <div className={`mono ${conflictRiskClass(selectedMacroCountry.conflict_risk_level)}`} style={{ textTransform: 'capitalize' }}>
                                                {formatNumber(selectedMacroCountry.conflict_risk_score, 2)} / 100 ({selectedMacroCountry.conflict_risk_level})
                                            </div>
                                        </div>
                                        <div className="glass-card" style={{ padding: '0.6rem 0.7rem' }}>
                                            <div className="text-muted" style={{ fontSize: '0.74rem' }}>Relation Average Score</div>
                                            <div className={`mono ${Number(selectedMacroCountry.relation_avg_score || 0) < 0 ? 'text-down' : 'text-up'}`}>
                                                {formatNumber(selectedMacroCountry.relation_avg_score, 2)}
                                            </div>
                                        </div>
                                        <div className="glass-card" style={{ padding: '0.6rem 0.7rem' }}>
                                            <div className="text-muted" style={{ fontSize: '0.74rem' }}>Hostile + Critical Relations</div>
                                            <div className="mono">
                                                {formatNumber(Number(selectedMacroCountry.hostile_relations || 0) + Number(selectedMacroCountry.critical_relations || 0), 0)}
                                            </div>
                                        </div>
                                        <div className="glass-card" style={{ padding: '0.6rem 0.7rem' }}>
                                            <div className="text-muted" style={{ fontSize: '0.74rem' }}>Active Conflicts</div>
                                            <div className="mono">{formatNumber(selectedMacroCountry.active_conflicts, 0)}</div>
                                        </div>
                                        <div className="glass-card" style={{ padding: '0.6rem 0.7rem' }}>
                                            <div className="text-muted" style={{ fontSize: '0.74rem' }}>Recent Relation Incidents</div>
                                            <div className="mono">{formatNumber(selectedMacroCountry.recent_relation_incidents, 0)}</div>
                                        </div>
                                        <div className="glass-card" style={{ padding: '0.6rem 0.7rem' }}>
                                            <div className="text-muted" style={{ fontSize: '0.74rem' }}>Reserve Ratio</div>
                                            <div className="mono">{formatNumber(Number(selectedMacroCountry.reserve_ratio || 0) * 100, 2)}%</div>
                                        </div>
                                        <div className="glass-card" style={{ padding: '0.6rem 0.7rem' }}>
                                            <div className="text-muted" style={{ fontSize: '0.74rem' }}>Stability</div>
                                            <div className="mono">{formatNumber(Number(selectedMacroCountry.stability || 0) * 100, 2)}%</div>
                                        </div>
                                        <div className="glass-card" style={{ padding: '0.6rem 0.7rem' }}>
                                            <div className="text-muted" style={{ fontSize: '0.74rem' }}>Fiscal Momentum</div>
                                            <div className={`mono ${Number(selectedMacroCountry.fiscal_momentum || 0) >= 0 ? 'text-up' : 'text-down'}`}>
                                                {Number(selectedMacroCountry.fiscal_momentum || 0) >= 0 ? '+' : ''}{formatNumber(selectedMacroCountry.fiscal_momentum, 3)}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="glass-card" style={{ marginTop: '0.75rem', padding: '0.65rem 0.75rem' }}>
                                        <div className="text-muted" style={{ fontSize: '0.74rem', marginBottom: '0.25rem' }}>Conflict Outlook</div>
                                        <div style={{ fontSize: '0.85rem' }}>{selectedMacroCountry.conflict_outlook || 'No conflict outlook available.'}</div>
                                    </div>

                                    <div className="glass-card" style={{ marginTop: '0.75rem', padding: '0.65rem 0.75rem' }}>
                                        <div className="text-muted" style={{ fontSize: '0.74rem', marginBottom: '0.35rem' }}>Top Diplomatic Flashpoints</div>
                                        {!Array.isArray(selectedMacroCountry.high_tension_relations) || selectedMacroCountry.high_tension_relations.length === 0 ? (
                                            <div className="text-muted" style={{ fontSize: '0.82rem' }}>No elevated bilateral tensions detected right now.</div>
                                        ) : (
                                            <div style={{ display: 'grid', gap: '0.35rem' }}>
                                                {selectedMacroCountry.high_tension_relations.map((relation) => (
                                                    <div
                                                        key={`flashpoint-${selectedMacroCountry.country_id}-${relation.country_id}-${relation.relation_level}`}
                                                        style={{
                                                            border: '1px solid var(--panel-border)',
                                                            borderRadius: 8,
                                                            padding: '0.4rem 0.5rem',
                                                            display: 'flex',
                                                            justifyContent: 'space-between',
                                                            gap: '0.6rem',
                                                            alignItems: 'center'
                                                        }}
                                                    >
                                                        <div>
                                                            <strong>{relation.country_name} ({relation.country_code})</strong>
                                                            <span className="text-muted" style={{ marginLeft: '0.45rem', textTransform: 'capitalize' }}>{relation.relation_level}</span>
                                                        </div>
                                                        <div className="mono" style={{ textAlign: 'right' }}>
                                                            <div className={Number(relation.relation_score || 0) < 0 ? 'text-down' : 'text-up'}>{formatNumber(relation.relation_score, 2)}</div>
                                                            <div className="text-muted" style={{ fontSize: '0.72rem' }}>last incident tick {formatNumber(relation.last_incident_tick, 0)}</div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="glass-panel" style={{ overflow: 'hidden', marginBottom: '1rem' }}>
                            <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--panel-border)' }}>
                                <strong>Country Financial + Conflict Screener</strong>
                            </div>
                            <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ background: 'rgba(0,0,0,0.25)', borderBottom: '1px solid var(--panel-border)' }}>
                                            <th style={{ padding: '0.65rem', textAlign: 'left' }}>Country</th>
                                            <th style={{ padding: '0.65rem', textAlign: 'left' }}>Financial Health</th>
                                            <th style={{ padding: '0.65rem', textAlign: 'left' }}>Health Band</th>
                                            <th style={{ padding: '0.65rem', textAlign: 'left' }}>Conflict Risk</th>
                                            <th style={{ padding: '0.65rem', textAlign: 'left' }}>Relation Avg</th>
                                            <th style={{ padding: '0.65rem', textAlign: 'left' }}>Hostile/Critical</th>
                                            <th style={{ padding: '0.65rem', textAlign: 'left' }}>Conflicts</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {countryIndicators.length === 0 ? (
                                            <tr><td colSpan={7} style={{ padding: '0.8rem', textAlign: 'center' }} className="text-muted">No country indicator data available yet.</td></tr>
                                        ) : countryIndicators.map((entry) => (
                                            <tr
                                                key={`macro-${entry.country_id}`}
                                                style={{
                                                    borderBottom: '1px solid var(--panel-border)',
                                                    background: Number(entry.country_id) === Number(selectedMacroCountryId) ? 'rgba(74,163,255,0.08)' : 'transparent',
                                                    cursor: 'pointer'
                                                }}
                                                onClick={() => setSelectedMacroCountryId(Number(entry.country_id))}
                                            >
                                                <td style={{ padding: '0.6rem' }}>{entry.country_name} ({entry.country_code})</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(entry.financial_health_score || entry.macro_score, 2)} / 100</td>
                                                <td style={{ padding: '0.6rem', textTransform: 'capitalize' }} className={healthBandClass(entry.financial_health_band)}>{entry.financial_health_band}</td>
                                                <td style={{ padding: '0.6rem', textTransform: 'capitalize' }} className={`mono ${conflictRiskClass(entry.conflict_risk_level)}`}>
                                                    {formatNumber(entry.conflict_risk_score, 2)} ({entry.conflict_risk_level})
                                                </td>
                                                <td style={{ padding: '0.6rem' }} className={`mono ${Number(entry.relation_avg_score || 0) < 0 ? 'text-down' : 'text-up'}`}>{formatNumber(entry.relation_avg_score, 2)}</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(Number(entry.hostile_relations || 0) + Number(entry.critical_relations || 0), 0)}</td>
                                                <td style={{ padding: '0.6rem' }} className="mono">{formatNumber(entry.active_conflicts, 0)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </>
                )}
            </div>

            {showChat && (
                <div
                    className="glass-panel"
                    style={{
                        width: '100%',
                        maxHeight: 'none',
                        padding: '0.85rem',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.6rem',
                        overflow: 'hidden'
                    }}
                >
                    <div className="flex-between" style={{ gap: '0.6rem' }}>
                        <strong>Trade Comms</strong>
                        <span className="text-muted" style={{ fontSize: '0.78rem' }}>
                            {chatLoading ? 'Syncing...' : 'Live'}
                        </span>
                    </div>

                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                            className={`btn ${chatTab === 'world' ? 'btn-primary' : 'btn-outline'}`}
                            style={{ flex: 1 }}
                            onClick={() => setChatTab('world')}
                        >
                            World
                        </button>
                        <button
                            className={`btn ${chatTab === 'direct' ? 'btn-primary' : 'btn-outline'}`}
                            style={{ flex: 1 }}
                            onClick={() => setChatTab('direct')}
                        >
                            Direct
                        </button>
                    </div>

                    {chatTab === 'world' ? (
                        <>
                            <div
                                style={{
                                    border: '1px solid var(--panel-border)',
                                    borderRadius: 8,
                                    padding: '0.55rem',
                                    overflowY: 'auto',
                                    maxHeight: 290,
                                    background: 'rgba(0,0,0,0.25)'
                                }}
                            >
                                {worldMessages.length === 0 ? (
                                    <div className="text-muted" style={{ fontSize: '0.85rem' }}>
                                        No world messages yet.
                                    </div>
                                ) : (
                                    worldMessages.map((entry) => {
                                        const isMine = Number(entry.sender_user_id) === Number(user?.id);
                                        return (
                                            <div key={`world-msg-${entry.id}`} style={{ marginBottom: '0.55rem' }}>
                                                <div className="text-muted" style={{ fontSize: '0.72rem' }}>
                                                    {entry.sender_username || 'Trader'} {isMine ? '(You)' : ''} | {formatChatTime(entry.created_at)}
                                                </div>
                                                <div
                                                    style={{
                                                        marginTop: '0.2rem',
                                                        border: '1px solid var(--panel-border)',
                                                        borderRadius: 8,
                                                        padding: '0.4rem 0.5rem',
                                                        background: isMine ? 'rgba(97,211,143,0.10)' : 'rgba(255,255,255,0.03)',
                                                        fontSize: '0.85rem'
                                                    }}
                                                >
                                                    {entry.message}
                                                </div>
                                            </div>
                                        );
                                    })
                                )}
                            </div>

                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <input
                                    className="form-control"
                                    placeholder="Message the entire world..."
                                    maxLength={500}
                                    value={worldMessageDraft}
                                    onChange={(event) => setWorldMessageDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            event.preventDefault();
                                            handleSendWorldMessage();
                                        }
                                    }}
                                />
                                <button className="btn btn-primary" onClick={handleSendWorldMessage}>Send</button>
                            </div>
                        </>
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '0.6rem', minHeight: 480, flex: 1 }}>
                            <div
                                style={{
                                    border: '1px solid var(--panel-border)',
                                    borderRadius: 8,
                                    padding: '0.35rem',
                                    overflowY: 'auto',
                                    overflowX: 'hidden',
                                    maxHeight: 320,
                                    background: 'rgba(0,0,0,0.25)',
                                    minHeight: 0
                                }}
                            >
                                {peerChatUsers.length === 0 ? (
                                    <div className="text-muted" style={{ fontSize: '0.78rem', padding: '0.45rem' }}>
                                        No users available.
                                    </div>
                                ) : (
                                    peerChatUsers.map((entry) => {
                                        const active = Number(entry.id) === Number(selectedChatUserId);
                                        const unread = Number(entry.unread_count || 0);
                                        return (
                                            <button
                                                key={`peer-${entry.id}`}
                                                className={`btn ${active ? 'btn-primary' : 'btn-outline'}`}
                                                style={{ width: '100%', justifyContent: 'space-between', marginBottom: '0.35rem', padding: '0.45rem 0.5rem' }}
                                                onClick={() => {
                                                    setSelectedChatUserId(entry.id);
                                                    setPrivateDeals([]);
                                                    setChatStatus({ text: '', isError: false });
                                                    setDealStatus({ text: '', isError: false });
                                                }}
                                            >
                                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 72 }}>
                                                    {entry.username}
                                                </span>
                                                {unread > 0 && (
                                                    <span
                                                        style={{
                                                            marginLeft: '0.35rem',
                                                            background: 'rgba(255,117,117,0.22)',
                                                            color: 'var(--accent-red)',
                                                            borderRadius: 999,
                                                            border: '1px solid rgba(255,117,117,0.45)',
                                                            fontSize: '0.68rem',
                                                            minWidth: 18,
                                                            textAlign: 'center'
                                                        }}
                                                    >
                                                        {unread > 9 ? '9+' : unread}
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })
                                )}
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minHeight: 0, flex: 1, overflow: 'hidden' }}>
                                <div className="text-muted" style={{ fontSize: '0.78rem' }}>
                                    {selectedChatUser ? `Direct with ${selectedChatUser.username}` : 'Select a user to start direct chat'}
                                </div>
                                <div
                                    ref={directMessagesContainerRef}
                                    style={{
                                        border: '1px solid var(--panel-border)',
                                        borderRadius: 8,
                                        padding: '0.55rem',
                                        overflowY: 'scroll',
                                        maxHeight: 130,
                                        background: 'rgba(0,0,0,0.25)',
                                        scrollbarGutter: 'stable'
                                    }}
                                >
                                    {directMessages.length === 0 ? (
                                        <div className="text-muted" style={{ fontSize: '0.82rem' }}>
                                            No direct messages yet.
                                        </div>
                                    ) : (
                                        directMessages.map((entry) => {
                                            const isMine = Number(entry.sender_user_id) === Number(user?.id);
                                            return (
                                                <div
                                                    key={`dm-${entry.id}`}
                                                    style={{
                                                        display: 'flex',
                                                        justifyContent: isMine ? 'flex-end' : 'flex-start',
                                                        marginBottom: '0.45rem'
                                                    }}
                                                >
                                                    <div
                                                        style={{
                                                            maxWidth: '85%',
                                                            border: '1px solid var(--panel-border)',
                                                            borderRadius: 8,
                                                            padding: '0.4rem 0.5rem',
                                                            background: isMine ? 'rgba(97,211,143,0.12)' : 'rgba(255,255,255,0.03)',
                                                            fontSize: '0.84rem'
                                                        }}
                                                    >
                                                        <div className="text-muted" style={{ fontSize: '0.68rem' }}>
                                                            {isMine ? 'You' : entry.sender_username} | {formatChatTime(entry.created_at)}
                                                        </div>
                                                        <div style={{ marginTop: '0.15rem' }}>{entry.message}</div>
                                                    </div>
                                                </div>
                                            );
                                        })
                                    )}
                                </div>

                                <div style={{ display: 'flex', gap: '0.45rem' }}>
                                    <input
                                        className="form-control"
                                        placeholder={selectedChatUser ? `Message ${selectedChatUser.username}...` : 'Select a user first'}
                                        maxLength={500}
                                        disabled={!selectedChatUser}
                                        value={directMessageDraft}
                                        onChange={(event) => setDirectMessageDraft(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault();
                                                handleSendDirectMessage();
                                            }
                                        }}
                                    />
                                    <button className="btn btn-primary" disabled={!selectedChatUser} onClick={handleSendDirectMessage}>Send</button>
                                </div>

                                <div className="glass-card" style={{ padding: '0.55rem', marginTop: '0.2rem' }}>
                                    <div className="text-muted" style={{ fontSize: '0.73rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                                        Deal History
                                    </div>

                                    {privateDeals.length === 0 ? (
                                        <div className="text-muted" style={{ marginTop: '0.35rem', fontSize: '0.76rem' }}>
                                            No deal proposals in this thread yet.
                                        </div>
                                    ) : (
                                        <div style={{ display: 'grid', gap: '0.4rem', marginTop: '0.38rem', maxHeight: 120, overflowY: 'scroll' }}>
                                            {privateDeals.map((deal) => {
                                                const isMine = Number(deal.proposer_user_id) === Number(user?.id);
                                                const status = String(deal.status || 'pending');
                                                const isActionable = Number(deal.is_actionable || 0) === 1 && status === 'pending';
                                                const quantity = Number(deal.quantity || 0);
                                                const pricePerUnit = Number(deal.price_per_unit || deal.price_per_share || 0);
                                                const totalAmount = Number(deal.total_amount || (quantity * pricePerUnit));
                                                const dealLabel = deal.company_name
                                                    ? `${deal.company_name} (${deal.ticker})`
                                                    : `${deal.asset_name || 'Asset'} (${deal.asset_symbol || 'N/A'})`;

                                                return (
                                                    <div
                                                        key={`deal-${deal.id}`}
                                                        style={{
                                                            border: '1px solid var(--panel-border)',
                                                            borderRadius: 8,
                                                            padding: '0.45rem 0.5rem',
                                                            background: 'rgba(0,0,0,0.18)'
                                                        }}
                                                    >
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.45rem', alignItems: 'center' }}>
                                                            <strong style={{ fontSize: '0.78rem' }}>
                                                                {dealLabel}
                                                            </strong>
                                                            <span
                                                                style={{
                                                                    fontSize: '0.68rem',
                                                                    textTransform: 'uppercase',
                                                                    color: privateDealStatusColor(status),
                                                                    fontWeight: 700,
                                                                    letterSpacing: '0.03em'
                                                                }}
                                                            >
                                                                {status}
                                                            </span>
                                                        </div>

                                                        <div className="text-muted" style={{ marginTop: '0.2rem', fontSize: '0.74rem' }}>
                                                            {isMine
                                                                ? `You offered ${formatNumber(quantity, 4)} units at ${formatMoney(pricePerUnit, 6)} each (total ${formatMoney(totalAmount)}).`
                                                                : `${deal.proposer_username} offered ${formatNumber(quantity, 4)} units at ${formatMoney(pricePerUnit, 6)} each (total ${formatMoney(totalAmount)}).`}
                                                        </div>

                                                        {deal.note && (
                                                            <div className="text-muted" style={{ marginTop: '0.18rem', fontSize: '0.72rem' }}>
                                                                Note: {deal.note}
                                                            </div>
                                                        )}

                                                        <div className="text-muted" style={{ marginTop: '0.22rem', fontSize: '0.68rem' }}>
                                                            Proposal #{deal.id} | {formatChatTime(deal.created_at)}
                                                        </div>

                                                        {isActionable && (
                                                            <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.36rem' }}>
                                                                <button
                                                                    className="btn btn-primary"
                                                                    style={{ flex: 1, padding: '0.3rem 0.45rem' }}
                                                                    onClick={() => handleRespondPrivateDeal(deal.id, 'accept')}
                                                                >
                                                                    Accept
                                                                </button>
                                                                <button
                                                                    className="btn btn-outline"
                                                                    style={{ flex: 1, padding: '0.3rem 0.45rem' }}
                                                                    onClick={() => handleRespondPrivateDeal(deal.id, 'reject')}
                                                                >
                                                                    Reject
                                                                </button>
                                                            </div>
                                                        )}

                                                        {isMine && status === 'pending' && (
                                                            <div className="text-muted" style={{ marginTop: '0.24rem', fontSize: '0.7rem' }}>
                                                                Waiting for recipient approval.
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                                <div className="glass-card" style={{ padding: '0.55rem', marginTop: '0.2rem' }}>
                                    <div className="text-muted" style={{ fontSize: '0.73rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                                        Backdoor Deal Proposal (Off-Book)
                                    </div>
                                    <div className="text-muted" style={{ marginTop: '0.2rem', fontSize: '0.76rem' }}>
                                        Propose an off-book transfer for shares, commodities, crypto, or bonds. Transfer executes only after recipient acceptance.
                                    </div>

                                    <div
                                        style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                                            gap: '0.45rem',
                                            marginTop: '0.45rem'
                                        }}
                                    >
                                        <select
                                            className="form-control"
                                            value={dealForm.assetId}
                                            disabled={!selectedChatUser || sellableAssets.length === 0}
                                            onChange={(event) => {
                                                const value = event.target.value;
                                                const selectedAsset = sellableAssets.find((entry) => Number(entry.asset_id) === Number(value));
                                                setDealForm((prev) => ({
                                                    ...prev,
                                                    assetId: value,
                                                    assetType: selectedAsset?.asset_type || prev.assetType,
                                                    pricePerUnit: selectedAsset && Number(selectedAsset.current_price || 0) > 0
                                                        ? String(selectedAsset.current_price)
                                                        : prev.pricePerUnit
                                                }));
                                            }}
                                        >
                                            {sellableAssets.length === 0 ? (
                                                <option value="">No sellable asset</option>
                                            ) : sellableAssets.map((asset) => (
                                                <option key={`${asset.asset_type}-${asset.asset_id}`} value={asset.asset_id}>
                                                    {asset.symbol} ({asset.asset_type}, qty {formatNumber(asset.quantity, 2)})
                                                </option>
                                            ))}
                                        </select>

                                        <input
                                            className="form-control"
                                            type="number"
                                            min="0.0001"
                                            step="0.0001"
                                            placeholder="Quantity"
                                            value={dealForm.quantity}
                                            disabled={!selectedChatUser || sellableAssets.length === 0}
                                            onChange={(event) => setDealForm((prev) => ({ ...prev, quantity: event.target.value }))}
                                        />

                                        <input
                                            className="form-control"
                                            type="number"
                                            min="0.0001"
                                            step="0.0001"
                                            placeholder="Price/unit"
                                            value={dealForm.pricePerUnit}
                                            disabled={!selectedChatUser || sellableAssets.length === 0}
                                            onChange={(event) => setDealForm((prev) => ({ ...prev, pricePerUnit: event.target.value }))}
                                        />
                                    </div>

                                    <input
                                        className="form-control"
                                        style={{ marginTop: '0.4rem' }}
                                        maxLength={180}
                                        placeholder="Optional note for this backdoor deal..."
                                        value={dealForm.note}
                                        disabled={!selectedChatUser || sellableAssets.length === 0}
                                        onChange={(event) => setDealForm((prev) => ({ ...prev, note: event.target.value }))}
                                    />

                                    {selectedDealAsset && (
                                        <div className="text-muted" style={{ marginTop: '0.3rem', fontSize: '0.74rem' }}>
                                            {selectedDealAsset.name} ({selectedDealAsset.symbol}) | Type: {selectedDealAsset.asset_type} | You hold {formatNumber(selectedDealAsset.quantity, 4)} units | Last price {formatNumber(selectedDealAsset.current_price, 6)}
                                        </div>
                                    )}

                                    <button
                                        className="btn btn-outline"
                                        style={{ marginTop: '0.45rem', width: '100%' }}
                                        disabled={!selectedChatUser || sellableAssets.length === 0}
                                        onClick={handleExecutePrivateDeal}
                                    >
                                        Send Backdoor Proposal
                                    </button>

                                    <MessageBox message={dealStatus.text} isError={dealStatus.isError} />
                                </div>
                            </div>
                        </div>
                    )}

                    <MessageBox message={chatStatus.text} isError={chatStatus.isError} />
                </div>
            )}
        </div>
    );
};

export default Dashboard;
