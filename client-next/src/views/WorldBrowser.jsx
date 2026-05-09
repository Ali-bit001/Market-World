'use client';

import React, { useEffect, useState, useContext } from 'react';
import api from '../api/axios';
import { AuthContext } from '../context/auth-context';
import { LogOut, Globe, Users, Clock, DollarSign } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

const WorldBrowser = () => {
    const [worlds, setWorlds] = useState([]);
    const [leaderboards, setLeaderboards] = useState({});
    const [openLeaderboardWorldId, setOpenLeaderboardWorldId] = useState(null);
    const [leaderboardLoadingWorldId, setLeaderboardLoadingWorldId] = useState(null);
    const [marketBoards, setMarketBoards] = useState({});
    const [openMarketWorldId, setOpenMarketWorldId] = useState(null);
    const [marketLoadingWorldId, setMarketLoadingWorldId] = useState(null);
    const [selectedMarketByWorld, setSelectedMarketByWorld] = useState({});
    const { logout, user, joinWorld, leaveWorld } = useContext(AuthContext);
    const router = useRouter();

    useEffect(() => {
        api.get('/worlds').then(({ data }) => setWorlds(data.worlds)).catch(console.error);
    }, []);

    const totals = worlds.reduce((acc, w) => {
        acc.worlds += 1;
        acc.assets += Number(w.asset_count || 0);
        acc.totalValue += Number(w.total_asset_value || 0);
        acc.companies += Number(w.company_count || 0);
        acc.countries += Number(w.government_count || 0);
        acc.markets += Number(w.stock_market_count || 0);
        return acc;
    }, { worlds: 0, assets: 0, totalValue: 0, companies: 0, countries: 0, markets: 0 });

    const fetchLeaderboard = async (worldId) => {
        setLeaderboardLoadingWorldId(worldId);
        try {
            const { data } = await api.get(`/worlds/${worldId}/leaderboard`);
            setLeaderboards(prev => ({ ...prev, [worldId]: { leaderboard: data.leaderboard || [], ownRank: data.ownRank || null, limit: Number(data.limit || 100) } }));
        } catch (err) {
            setLeaderboards(prev => ({ ...prev, [worldId]: { leaderboard: [], ownRank: null, limit: 100, error: err.response?.data?.error || 'Failed to fetch leaderboard' } }));
        } finally { setLeaderboardLoadingWorldId(null); }
    };

    const toggleLeaderboard = async (worldId) => {
        if (openLeaderboardWorldId === worldId) { setOpenLeaderboardWorldId(null); return; }
        setOpenLeaderboardWorldId(worldId);
        await fetchLeaderboard(worldId);
    };

    const fetchMarkets = async (worldId) => {
        setMarketLoadingWorldId(worldId);
        try {
            const { data } = await api.get(`/worlds/${worldId}/stock-markets`);
            const markets = data.markets || [];
            setMarketBoards(prev => ({ ...prev, [worldId]: { markets } }));
            if (markets.length > 0) setSelectedMarketByWorld(prev => ({ ...prev, [worldId]: prev[worldId] || markets[0] }));
        } catch (err) {
            setMarketBoards(prev => ({ ...prev, [worldId]: { markets: [], error: err.response?.data?.error || 'Failed to fetch stock markets' } }));
        } finally { setMarketLoadingWorldId(null); }
    };

    const toggleMarkets = async (worldId) => {
        if (openMarketWorldId === worldId) { setOpenMarketWorldId(null); return; }
        setOpenMarketWorldId(worldId);
        await fetchMarkets(worldId);
    };

    const handleJoin = async (worldId) => {
        try {
            if (user.current_world_id && user.current_world_id !== worldId) {
                if (window.confirm('You are in another world. Joining will liquidate your existing assets. Proceed?')) {
                    await leaveWorld(); await joinWorld(worldId); router.push('/dashboard');
                }
            } else if (user.current_world_id === worldId) {
                router.push('/dashboard');
            } else {
                await joinWorld(worldId); router.push('/dashboard');
            }
        } catch (err) { alert(err.response?.data?.error || 'Failed to join world'); }
    };

    const statCards = [
        { label: 'Worlds', value: totals.worlds },
        { label: 'Assets', value: totals.assets.toLocaleString() },
        { label: 'Asset Value', value: `$${totals.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}` },
        { label: 'Companies', value: totals.companies.toLocaleString() },
        { label: 'Countries', value: totals.countries.toLocaleString() },
        { label: 'Stock Markets', value: totals.markets.toLocaleString() },
    ];

    return (
        <div className="container-xl py-4">
            {/* Header */}
            <div className="d-flex justify-content-between align-items-start flex-wrap gap-3 mb-5">
                <div>
                    <h2 className="mb-1">Active Worlds</h2>
                    <p className="text-muted mb-0">Inspect world stats, company buckets, and enter the economy that fits your strategy.</p>
                </div>
                <div className="d-flex align-items-center gap-2 flex-wrap">
                    <Link href="/guide" className="btn btn-outline">Guide</Link>
                    <div className="glass-panel py-2 px-3 d-flex gap-2 align-items-center">
                        <span className="text-muted">ID:</span>
                        <span className="mono text-up">{user.username}</span>
                    </div>
                    <button className="btn btn-outline" onClick={logout}>
                        <LogOut size={16} className="me-1" /> Disconnect
                    </button>
                </div>
            </div>

            {/* Summary stat cards */}
            <div className="row g-2 mb-4">
                {statCards.map(s => (
                    <div key={s.label} className="col">
                        <div className="glass-card p-3">
                            <div className="text-muted" style={{ fontSize: '0.75rem', textTransform: 'uppercase' }}>{s.label}</div>
                            <div className="mono" style={{ fontSize: '1.2rem', fontWeight: 700 }}>{s.value}</div>
                        </div>
                    </div>
                ))}
            </div>

            {/* World cards */}
            <div className="row g-4">
                {worlds.map(w => {
                    const isCurrent = user.current_world_id === w.id;
                    const isLeaderboardOpen = openLeaderboardWorldId === w.id;
                    const isMarketOpen = openMarketWorldId === w.id;
                    const leaderboardData = leaderboards[w.id] || null;
                    const leaderboardRows = leaderboardData?.leaderboard || [];
                    const ownRank = leaderboardData?.ownRank || null;
                    const marketData = marketBoards[w.id] || null;
                    const worldMarkets = marketData?.markets || [];
                    const selectedMarketId = Number(selectedMarketByWorld[w.id]?.id || 0);
                    const selectedMarket = worldMarkets.find(m => Number(m.id) === selectedMarketId) || worldMarkets[0] || null;
                    const bucketCards = [
                        { label: 'Micro', value: Number(w.micro_count || 0) },
                        { label: 'Small', value: Number(w.small_count || 0) },
                        { label: 'Mid', value: Number(w.mid_count || 0) },
                        { label: 'Large', value: Number(w.large_count || 0) },
                        { label: 'Mega', value: Number(w.mega_count || 0) }
                    ];

                    return (
                        <div key={w.id} className="col-12 col-md-6 col-xl-4">
                            <div className="glass-card p-4 d-flex flex-column h-100">
                                <div className="d-flex justify-content-between align-items-center mb-3">
                                    <h3 className="mb-0 d-flex align-items-center gap-2">
                                        <Globe size={20} color={isCurrent ? 'var(--accent-green)' : 'var(--accent-blue)'} />
                                        {w.name}
                                    </h3>
                                    {isCurrent && (
                                        <span className="badge" style={{ background: 'rgba(63,185,80,0.2)', color: 'var(--accent-green)', fontSize: '0.8rem' }}>CURRENT</span>
                                    )}
                                </div>

                                <p className="text-muted mb-4 flex-grow-1" style={{ minHeight: 60 }}>{w.description}</p>

                                <div className="row g-2 mb-4" style={{ fontSize: '0.9rem' }}>
                                    <div className="col-6 d-flex align-items-center gap-2">
                                        <Users size={16} className="text-muted flex-shrink-0" />
                                        <span>{w.current_players} / {w.max_players} Traders</span>
                                    </div>
                                    <div className="col-6 d-flex align-items-center gap-2">
                                        <Clock size={16} className="text-muted flex-shrink-0" />
                                        <span>Tick: {w.tick_rate_seconds}s</span>
                                    </div>
                                    <div className="col-12 d-flex align-items-center gap-2">
                                        <DollarSign size={16} className="text-muted flex-shrink-0" />
                                        <span className="text-up mono">Starting Grant: ${Number(w.starting_cash).toLocaleString()}</span>
                                    </div>

                                    {/* Mini stat panels */}
                                    <div className="col-4">
                                        <div className="glass-panel p-2">
                                            <div className="text-muted" style={{ fontSize: '0.7rem' }}>Assets</div>
                                            <div className="mono" style={{ fontSize: '0.95rem' }}>{Number(w.asset_count || 0).toLocaleString()}</div>
                                        </div>
                                    </div>
                                    <div className="col-4">
                                        <div className="glass-panel p-2">
                                            <div className="text-muted" style={{ fontSize: '0.7rem' }}>Companies</div>
                                            <div className="mono" style={{ fontSize: '0.95rem' }}>{Number(w.company_count || 0).toLocaleString()}</div>
                                        </div>
                                    </div>
                                    <div className="col-4">
                                        <div className="glass-panel p-2">
                                            <div className="text-muted" style={{ fontSize: '0.7rem' }}>Countries</div>
                                            <div className="mono" style={{ fontSize: '0.95rem' }}>{Number(w.government_count || 0).toLocaleString()}</div>
                                        </div>
                                    </div>
                                    <div className="col-6">
                                        <div className="glass-panel p-2">
                                            <div className="text-muted" style={{ fontSize: '0.7rem' }}>Stock Markets</div>
                                            <div className="mono" style={{ fontSize: '0.95rem' }}>{Number(w.stock_market_count || 0).toLocaleString()}</div>
                                        </div>
                                    </div>
                                    <div className="col-6">
                                        <div className="glass-panel p-2">
                                            <div className="text-muted" style={{ fontSize: '0.7rem' }}>World Asset Value</div>
                                            <div className="mono" style={{ fontSize: '0.95rem' }}>${Number(w.total_asset_value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                                        </div>
                                    </div>

                                    {/* Cap buckets */}
                                    <div className="col-12">
                                        <div className="text-muted mb-1" style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Company Market Cap Groups</div>
                                        <div className="row g-1">
                                            {bucketCards.map(b => (
                                                <div key={b.label} className="col">
                                                    <div className="glass-panel p-1 text-center">
                                                        <div className="text-muted" style={{ fontSize: '0.62rem', textTransform: 'uppercase' }}>{b.label}</div>
                                                        <div className="mono" style={{ fontSize: '0.85rem' }}>{b.value}</div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                {/* Action buttons */}
                                <div className="d-grid gap-2" style={{ gridTemplateColumns: '1fr auto auto' }}>
                                    <button className={`btn ${isCurrent ? 'btn-success' : 'btn-primary'}`} onClick={() => handleJoin(w.id)}>
                                        {isCurrent ? 'Return to World' : 'Initialize Start Sequence'}
                                    </button>
                                    <button className="btn btn-outline" onClick={() => toggleLeaderboard(w.id)}>
                                        {isLeaderboardOpen ? 'Hide' : 'Leaderboard'}
                                    </button>
                                    <button className="btn btn-outline" onClick={() => toggleMarkets(w.id)}>
                                        {isMarketOpen ? 'Hide' : 'Markets'}
                                    </button>
                                </div>

                                {/* Markets panel */}
                                {isMarketOpen && (
                                    <div className="glass-panel mt-3 p-3">
                                        <div className="d-flex justify-content-between align-items-center mb-2">
                                            <strong>Stock Market Directory</strong>
                                            {marketLoadingWorldId === w.id && (
                                                <div className="d-flex align-items-center gap-2">
                                                    <div style={{ width: 42, height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                                                        <div className="mw-loading-progress-bar" />
                                                    </div>
                                                    <span className="text-muted" style={{ fontSize: '0.78rem' }}>Loading</span>
                                                </div>
                                            )}
                                        </div>
                                        {marketData?.error && <div className="text-muted mb-2" style={{ fontSize: '0.82rem' }}>{marketData.error}</div>}
                                        {worldMarkets.length === 0 ? (
                                            <div className="text-muted" style={{ fontSize: '0.82rem' }}>No active stock markets found.</div>
                                        ) : (
                                            <div className="row g-1 mb-2">
                                                {worldMarkets.map(market => {
                                                    const active = Number(selectedMarket?.id) === Number(market.id);
                                                    return (
                                                        <div key={`market-${w.id}-${market.id}`} className="col-auto">
                                                            <button
                                                                className={`btn btn-sm ${active ? 'btn-primary' : 'btn-outline'}`}
                                                                style={{ fontSize: '0.78rem' }}
                                                                onClick={() => setSelectedMarketByWorld(prev => ({ ...prev, [w.id]: market }))}
                                                            >
                                                                {market.code} <span className="text-muted" style={{ fontSize: '0.68rem' }}>{market.city}</span>
                                                            </button>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                        <div className="glass-card p-2">
                                            {selectedMarket ? (
                                                <div className="row g-2" style={{ fontSize: '0.82rem' }}>
                                                    <div className="col-6"><strong>Exchange:</strong> {selectedMarket.name} ({selectedMarket.code})</div>
                                                    <div className="col-6"><strong>Country:</strong> {selectedMarket.country_name}</div>
                                                    <div className="col-6"><strong>City:</strong> {selectedMarket.city}</div>
                                                    <div className="col-6"><strong>Currency:</strong> {selectedMarket.currency}</div>
                                                    <div className="col-6"><strong>Benchmark:</strong> {selectedMarket.benchmark_name}</div>
                                                    <div className="col-6"><strong>Index Level:</strong> {Number(selectedMarket.benchmark_level || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                                                    <div className="col-6"><strong>Tier:</strong> {selectedMarket.listing_tier}</div>
                                                    <div className="col-6"><strong>Min Capital:</strong> ${Number(selectedMarket.min_listing_capital || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                                                    <div className="col-6"><strong>Market Cap:</strong> ${Number(selectedMarket.listed_market_cap || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                                                    <div className="col-6"><strong>Listed Cos:</strong> {Number(selectedMarket.listed_company_count || 0).toLocaleString()}</div>
                                                </div>
                                            ) : (
                                                <div className="text-muted" style={{ fontSize: '0.82rem' }}>Select a market above.</div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Leaderboard panel */}
                                {isLeaderboardOpen && (
                                    <div className="glass-panel mt-3 p-3">
                                        <div className="d-flex justify-content-between align-items-center mb-2">
                                            <strong>Top 100 By Net Worth</strong>
                                            {leaderboardLoadingWorldId === w.id && (
                                                <div className="d-flex align-items-center gap-2">
                                                    <div style={{ width: 42, height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                                                        <div className="mw-loading-progress-bar" />
                                                    </div>
                                                    <span className="text-muted" style={{ fontSize: '0.78rem' }}>Loading</span>
                                                </div>
                                            )}
                                        </div>
                                        {leaderboardData?.error && <div className="text-muted mb-2" style={{ fontSize: '0.82rem' }}>{leaderboardData.error}</div>}
                                        <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--panel-border)', borderRadius: 8 }}>
                                            <table className="table table-borderless mb-0" style={{ width: '100%' }}>
                                                <thead>
                                                    <tr style={{ background: 'rgba(0,0,0,0.25)', borderBottom: '1px solid var(--panel-border)' }}>
                                                        <th style={{ padding: '0.5rem', fontSize: '0.75rem' }}>#</th>
                                                        <th style={{ padding: '0.5rem', fontSize: '0.75rem' }}>Trader</th>
                                                        <th style={{ padding: '0.5rem', fontSize: '0.75rem', textAlign: 'right' }}>Net Worth</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {leaderboardRows.length === 0 ? (
                                                        <tr><td colSpan={3} className="text-muted text-center py-3">No ranked players yet.</td></tr>
                                                    ) : leaderboardRows.map(entry => {
                                                        const isSelf = Number(entry.user_id) === Number(user.id);
                                                        return (
                                                            <tr key={`${w.id}-${entry.user_id}`} style={{ borderBottom: '1px solid var(--panel-border)', background: isSelf ? 'rgba(97,211,143,0.08)' : 'transparent' }}>
                                                                <td style={{ padding: '0.5rem', fontSize: '0.82rem' }} className="mono">{entry.rank}</td>
                                                                <td style={{ padding: '0.5rem', fontSize: '0.82rem' }}>{entry.username} {isSelf ? '(You)' : ''}</td>
                                                                <td style={{ padding: '0.5rem', fontSize: '0.82rem', textAlign: 'right' }} className="mono">${Number(entry.net_worth || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                        <div className="glass-card mt-2 p-2">
                                            {ownRank ? (
                                                <div style={{ fontSize: '0.84rem' }}>
                                                    <strong>Your Rank:</strong> #{ownRank.rank} | <strong>Valuation:</strong> ${Number(ownRank.net_worth || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                                    {!ownRank.inTopLeaderboard && <div className="text-muted mt-1" style={{ fontSize: '0.78rem' }}>You are outside the top 100 shown above.</div>}
                                                </div>
                                            ) : (
                                                <div className="text-muted" style={{ fontSize: '0.82rem' }}>Join this world to get your personal ranking.</div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default WorldBrowser;
