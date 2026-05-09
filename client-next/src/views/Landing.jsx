'use client';

import React, { useState, useContext } from 'react';
import { AuthContext } from '../context/auth-context';
import { TrendingUp, Globe, Activity } from 'lucide-react';
import Link from 'next/link';

const PREF_KEY = 'marketWorldAuthPrefs';
const readStoredPrefs = () => {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); }
    catch { return {}; }
};

const Landing = () => {
    const { login, register } = useContext(AuthContext);
    const [storedPrefs] = useState(readStoredPrefs);
    const [isLogin, setIsLogin] = useState(true);
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState(storedPrefs.loginIdentifier || '');
    const [password, setPassword] = useState(storedPrefs.loginPassword || '');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [rememberLogin, setRememberLogin] = useState(Boolean(storedPrefs.rememberLogin));
    const [rememberPassword, setRememberPassword] = useState(Boolean(storedPrefs.rememberPassword));
    const [error, setError] = useState('');

    const persistPrefs = (identifierValue, passwordValue) => {
        localStorage.setItem(PREF_KEY, JSON.stringify({
            rememberLogin, rememberPassword,
            loginIdentifier: rememberLogin ? identifierValue : '',
            loginPassword: rememberPassword ? passwordValue : ''
        }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!isLogin && password !== confirmPassword) { setError('Passwords do not match'); return; }
        try {
            if (isLogin) { await login(email, password); persistPrefs(email, password); }
            else { await register(username, email, password); persistPrefs(email, password); }
        } catch (err) { setError(err.response?.data?.error || 'Authentication failed'); }
    };

    return (
        <div className="mw-auth-page">
            <div className="mw-auth-hero">
                <div className="mw-auth-grid">
                    {/* Left copy */}
                    <div className="mw-auth-copy">
                        <span className="mw-auth-kicker">Economic strategy simulation</span>
                        <h1 className="mw-auth-title">Build empires. Trade assets. Control the market.</h1>
                        <p className="mw-auth-subtitle">
                            Enter a competitive financial world where players create companies, issue stock, trade
                            assets, manage risk, and decide when to expand, hold, or liquidate.
                        </p>

                        <div className="d-flex gap-2 flex-wrap mt-3">
                            <Link href="/guide" className="btn btn-outline">Read Guide</Link>
                        </div>

                        <div className="mw-auth-highlights">
                            <span className="mw-pill">Realtime simulation</span>
                            <span className="mw-pill">Shares, bonds, crypto, commodities</span>
                            <span className="mw-pill">Company management loop</span>
                        </div>

                        <div className="d-flex gap-4 mt-3 flex-wrap" style={{ color: 'var(--text-secondary)' }}>
                            <div className="d-flex align-items-center gap-2">
                                <Globe size={18} color="var(--accent-blue)" />
                                <span>Dynamic Economies</span>
                            </div>
                            <div className="d-flex align-items-center gap-2">
                                <Activity size={18} color="var(--accent-purple)" />
                                <span>Live Events</span>
                            </div>
                            <div className="d-flex align-items-center gap-2">
                                <TrendingUp size={18} color="var(--accent-green)" />
                                <span>Order Book Trading</span>
                            </div>
                        </div>
                    </div>

                    {/* Auth card */}
                    <div className="glass-card p-4 align-self-center w-100" style={{ maxWidth: 430 }}>
                        <div className="d-flex gap-2 mb-4">
                            <button className={`btn flex-fill ${isLogin ? 'btn-primary' : 'btn-outline'}`} type="button"
                                onClick={() => { setIsLogin(true); setError(''); }}>Login</button>
                            <button className={`btn flex-fill ${!isLogin ? 'btn-primary' : 'btn-outline'}`} type="button"
                                onClick={() => { setIsLogin(false); setError(''); }}>Sign Up</button>
                        </div>

                        {error && (
                            <div className="alert mb-3 py-2 px-3" style={{
                                background: 'rgba(255,117,117,0.12)', color: 'var(--accent-red)',
                                border: '1px solid rgba(255,117,117,0.32)', borderRadius: 8, fontSize: '0.9rem'
                            }}>{error}</div>
                        )}

                        <form onSubmit={handleSubmit}>
                            {!isLogin && (
                                <div className="mb-3">
                                    <label className="form-label" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>Callsign (Username)</label>
                                    <input type="text" value={username} onChange={e => setUsername(e.target.value)} className="form-control" required />
                                </div>
                            )}
                            <div className="mb-3">
                                <label className="form-label" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{isLogin ? 'Username or Email' : 'Email'}</label>
                                <input type={isLogin ? 'text' : 'email'} value={email} onChange={e => setEmail(e.target.value)} className="form-control" required />
                            </div>
                            <div className="mb-3">
                                <label className="form-label" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>Encryption Key (Password)</label>
                                <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="form-control" required />
                            </div>
                            {!isLogin && (
                                <div className="mb-3">
                                    <label className="form-label" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>Confirm Password</label>
                                    <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className="form-control" required />
                                </div>
                            )}

                            <div className="row g-2 mb-3">
                                <div className="col-6">
                                    <label className="d-flex align-items-center gap-2" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                                        <input type="checkbox" checked={rememberLogin} onChange={e => setRememberLogin(e.target.checked)} />
                                        Remember login
                                    </label>
                                </div>
                                <div className="col-6">
                                    <label className="d-flex align-items-center gap-2" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                                        <input type="checkbox" checked={rememberPassword} onChange={e => setRememberPassword(e.target.checked)} />
                                        Remember password
                                    </label>
                                </div>
                            </div>

                            <button type="submit" className="btn btn-primary w-100 py-2">
                                {isLogin ? 'Initiate Link' : 'Construct Identity'}
                            </button>
                        </form>

                        <div className="text-center mt-3" style={{ fontSize: '0.9rem' }}>
                            <span className="text-muted">{isLogin ? "Don't have an ID? " : 'Already registered? '}</span>
                            <a href="#" onClick={e => { e.preventDefault(); setIsLogin(!isLogin); setError(''); }}>
                                {isLogin ? 'Register now.' : 'Access Terminal.'}
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Landing;
