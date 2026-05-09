'use client';

import React, { useCallback, useContext, useEffect, useState } from 'react';
import { AuthContext } from '../context/auth-context';
import { useSettings } from '../components/Providers';
import api from '../api/axios';
import LoadingScreen from '../components/LoadingScreen';

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL', 'SGD'];
const THEME_OPTIONS = [
    { key: 'bloomberg', label: 'Bloomberg Desk' },
    { key: 'robinhood', label: 'Robinhood Minimal' }
];

const normalizeTheme = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'dark') return 'bloomberg';
    if (raw === 'light') return 'robinhood';
    if (raw === 'cyberpunk') return 'bloomberg';
    if (['bloomberg', 'robinhood'].includes(raw)) return raw;
    return 'bloomberg';
};

const Settings = () => {
    const { user } = useContext(AuthContext);
    const { setTheme: applyTheme, setCurrency: applyGlobalCurrency } = useSettings();

    const [theme, setTheme] = useState('bloomberg');
    const [currency, setCurrency] = useState('USD');
    const [showNewsTicker, setShowNewsTicker] = useState(true);
    const [numberFormat, setNumberFormat] = useState('compact');
    const [exchangeRates, setExchangeRates] = useState({});
    const [status, setStatus] = useState({ text: '', isError: false });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadSettings = async () => {
            try {
                const savedTheme = normalizeTheme(localStorage.getItem('mw-theme'));
                const savedCurrency = localStorage.getItem('mw-currency') || 'USD';
                const savedTicker = localStorage.getItem('mw-show-ticker');
                const savedFormat = localStorage.getItem('mw-number-format') || 'compact';
                setTheme(savedTheme); setCurrency(savedCurrency);
                setShowNewsTicker(savedTicker !== 'false'); setNumberFormat(savedFormat);
                if (user) {
                    const { data } = await api.get('/settings');
                    if (data.settings) {
                        setTheme(normalizeTheme(data.settings.theme || savedTheme));
                        setCurrency(data.settings.currency || savedCurrency);
                        setShowNewsTicker(data.settings.show_news_ticker !== undefined ? data.settings.show_news_ticker : true);
                        setNumberFormat(data.settings.number_format || savedFormat);
                    }
                }
                const ratesRes = await api.get('/settings/exchange-rates');
                if (ratesRes.data.rates) setExchangeRates(ratesRes.data.rates);
            } catch (err) { console.error('Load settings error:', err); }
            finally { setLoading(false); }
        };
        loadSettings();
    }, [user]);

    const handleThemeChange = useCallback((newTheme) => {
        const normalized = normalizeTheme(newTheme);
        setTheme(normalized); applyTheme(normalized);
    }, [applyTheme]);

    const handleSave = async () => {
        try {
            setStatus({ text: '', isError: false });
            localStorage.setItem('mw-theme', theme);
            localStorage.setItem('mw-currency', currency);
            localStorage.setItem('mw-show-ticker', String(showNewsTicker));
            localStorage.setItem('mw-number-format', numberFormat);
            applyTheme(theme);
            const rate = currency === 'USD' ? 1 : (exchangeRates[currency] || 1);
            applyGlobalCurrency(currency, rate);
            if (user) await api.patch('/settings', { theme, currency, show_news_ticker: showNewsTicker, number_format: numberFormat });
            setStatus({ text: 'Settings saved successfully.', isError: false });
        } catch (err) {
            setStatus({ text: err.response?.data?.error || 'Failed to save settings.', isError: true });
        }
    };

    const currentRate = exchangeRates[currency];
    const rateDisplay = currency === 'USD' ? '1.00 (base)' : (currentRate ? currentRate.toFixed(4) : '--');

    if (loading) return <LoadingScreen context="settings" title="Loading Settings" />;

    return (
        <div className="container-xl py-4">
            <div style={{ maxWidth: 640 }}>
                <h2 className="mb-4">Settings</h2>

                {/* Appearance */}
                <div className="glass-panel mb-3 p-4">
                    <h3 className="mb-3" style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}>Appearance</h3>
                    <div className="mb-3">
                        <label className="form-label" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>Theme</label>
                        <div className="d-flex gap-3">
                            {THEME_OPTIONS.map(t => (
                                <button key={t.key} type="button"
                                    className={`btn ${theme === t.key ? 'btn-primary' : 'btn-outline'}`}
                                    style={{ minWidth: 150 }} onClick={() => handleThemeChange(t.key)}>
                                    {t.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Currency */}
                <div className="glass-panel mb-3 p-4">
                    <h3 className="mb-3" style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}>Currency</h3>
                    <div className="mb-3">
                        <label className="form-label" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>Display Currency</label>
                        <select className="form-control" value={currency} onChange={e => setCurrency(e.target.value)}>
                            {SUPPORTED_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                    </div>
                    {currency !== 'USD' && (
                        <div className="p-2 px-3" style={{ background: 'rgba(105,217,255,0.08)', border: '1px solid rgba(105,217,255,0.2)', borderRadius: 8, fontSize: '0.85rem', color: 'var(--accent-blue)' }}>
                            1 USD = {rateDisplay} {currency}
                        </div>
                    )}
                </div>

                {/* Display Preferences */}
                <div className="glass-panel mb-3 p-4">
                    <h3 className="mb-3" style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}>Display Preferences</h3>
                    <div className="d-flex align-items-center justify-content-between mb-3">
                        <label className="form-label mb-0" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>Show News Ticker</label>
                        <button type="button" className={`btn ${showNewsTicker ? 'btn-success' : 'btn-outline'}`}
                            style={{ minWidth: 80 }} onClick={() => setShowNewsTicker(!showNewsTicker)}>
                            {showNewsTicker ? 'On' : 'Off'}
                        </button>
                    </div>
                    <div className="mb-0">
                        <label className="form-label" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>Number Format</label>
                        <div className="d-flex gap-3">
                            {[{ key: 'compact', label: 'Compact (1.2M)' }, { key: 'full', label: 'Full (1,200,000)' }].map(opt => (
                                <button key={opt.key} type="button"
                                    className={`btn ${numberFormat === opt.key ? 'btn-primary' : 'btn-outline'}`}
                                    onClick={() => setNumberFormat(opt.key)}>
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                <button type="button" className="btn btn-primary w-100 py-2" onClick={handleSave}>
                    Save Settings
                </button>

                {status.text && (
                    <div className="mt-3 p-2 px-3" style={{
                        borderRadius: 8,
                        background: status.isError ? 'rgba(248,81,73,0.15)' : 'rgba(63,185,80,0.15)',
                        color: status.isError ? 'var(--accent-red)' : 'var(--accent-green)',
                        border: `1px solid ${status.isError ? 'rgba(248,81,73,0.35)' : 'rgba(63,185,80,0.35)'}`,
                        fontSize: '0.88rem'
                    }}>
                        {status.text}
                    </div>
                )}
            </div>
        </div>
    );
};

export default Settings;
