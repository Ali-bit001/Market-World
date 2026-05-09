'use client';

import React, { useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Trophy } from 'lucide-react';
import api from '../api/axios';
import { AuthContext } from '../context/auth-context';
import LoadingScreen from '../components/LoadingScreen';

const tierColor = (tier) => {
    if (tier === 'gold') return '#d4af37';
    if (tier === 'silver') return '#c0c0c0';
    return '#cd7f32';
};

const categoryLabel = (category) => {
    if (category === 'wealth') return 'Wealth';
    if (category === 'commodities') return 'Commodities';
    if (category === 'companies') return 'Companies';
    return 'General';
};

const formatMetric = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

const Achievements = () => {
    const router = useRouter();
    const { user } = useContext(AuthContext);
    const [loading, setLoading] = useState(true);
    const [achievements, setAchievements] = useState([]);

    useEffect(() => {
        api.get('/auth/achievements')
            .then(({ data }) => setAchievements(data.achievements || []))
            .catch(() => setAchievements([]))
            .finally(() => setLoading(false));
    }, []);

    const unlockedCount = useMemo(() => achievements.filter(e => e.unlocked).length, [achievements]);

    const grouped = useMemo(() => {
        const groups = new Map();
        for (const entry of achievements) {
            const key = entry.category || 'general';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(entry);
        }
        return Array.from(groups.entries()).map(([category, entries]) => ({
            category,
            entries: entries.sort((a, b) => {
                if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
                return Number(a.threshold || 0) - Number(b.threshold || 0);
            })
        }));
    }, [achievements]);

    if (loading) return <LoadingScreen context="dashboard" title="Loading Achievements" />;

    return (
        <div className="container-xl py-4">
            {/* Header */}
            <div className="d-flex justify-content-between align-items-start flex-wrap gap-3 mb-4">
                <div>
                    <h2 className="mb-1">Achievement Vault</h2>
                    <div className="text-muted" style={{ fontSize: '0.9rem' }}>Persistent account milestones across every world and season.</div>
                </div>
                <div className="d-flex align-items-center gap-2">
                    <div className="glass-card p-2 px-3">
                        <span className="text-muted" style={{ fontSize: '0.8rem' }}>Unlocked</span>
                        <div className="mono fw-bold">{unlockedCount} / {achievements.length}</div>
                    </div>
                    <button className="btn btn-outline" onClick={() => router.push(user?.current_world_id ? '/dashboard' : '/worlds')}>
                        <ArrowLeft size={16} className="me-1" /> Back
                    </button>
                </div>
            </div>

            {grouped.length === 0 ? (
                <div className="glass-panel">No achievements available yet.</div>
            ) : (
                grouped.map(group => (
                    <div key={group.category} className="glass-panel mb-3">
                        <div className="d-flex align-items-center gap-2 mb-3">
                            <Trophy size={16} color="var(--accent-purple)" />
                            <strong>{categoryLabel(group.category)}</strong>
                        </div>
                        <div className="row g-3">
                            {group.entries.map(entry => {
                                const progress = Number(entry.progress || 0);
                                const threshold = Number(entry.threshold || 0);
                                const ratio = Math.max(0, Math.min(1, Number(entry.progress_ratio || 0)));
                                const unlocked = Boolean(entry.unlocked);

                                return (
                                    <div key={entry.code} className="col-12 col-sm-6 col-lg-4">
                                        <div className="glass-card p-3 h-100" style={{ border: `1px solid ${unlocked ? tierColor(entry.tier) : 'var(--panel-border)'}`, boxShadow: unlocked ? '0 10px 20px rgba(0,0,0,0.28)' : 'none' }}>
                                            <div className="d-flex justify-content-between align-items-center gap-2 mb-1">
                                                <strong style={{ fontSize: '0.92rem' }}>{entry.title}</strong>
                                                <span style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: unlocked ? tierColor(entry.tier) : 'var(--text-secondary)', fontWeight: 700 }}>
                                                    {entry.tier}
                                                </span>
                                            </div>
                                            <div className="text-muted mb-2" style={{ fontSize: '0.8rem' }}>{entry.description}</div>
                                            <div className="mono mb-1" style={{ fontSize: '0.78rem' }}>
                                                Progress: {formatMetric(progress)} / {formatMetric(threshold)}
                                            </div>
                                            <div style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 999, height: 7, overflow: 'hidden', marginBottom: '0.5rem' }}>
                                                <div style={{ width: `${(ratio * 100).toFixed(1)}%`, height: '100%', background: unlocked ? tierColor(entry.tier) : 'var(--accent-blue)', transition: 'width 0.3s ease' }} />
                                            </div>
                                            <div style={{ fontSize: '0.77rem', color: unlocked ? 'var(--accent-green)' : 'var(--text-secondary)' }}>
                                                {unlocked ? `Unlocked ${entry.unlocked_at ? new Date(entry.unlocked_at).toLocaleString() : ''}` : 'Locked'}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))
            )}
        </div>
    );
};

export default Achievements;
