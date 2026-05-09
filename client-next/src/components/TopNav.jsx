'use client';

import { useContext } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AuthContext } from '@/context/auth-context';

const isActivePath = (pathname, href) => {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
};

const TopNav = () => {
    const pathname = usePathname();
    const { user, loading, logout } = useContext(AuthContext);

    if (loading) return null;
    if (!user && pathname === '/') return null;

    const navLinks = user
        ? [
            { href: '/worlds', label: 'Worlds' },
            { href: '/dashboard', label: 'Dashboard' },
            { href: '/dashboard/achievements', label: 'Achievements' },
            { href: '/guide', label: 'Guide' },
            { href: '/settings', label: 'Settings' }
        ]
        : [
            { href: '/guide', label: 'Guide' },
            { href: '/', label: 'Login' }
        ];

    return (
        <header className="top-nav navbar navbar-expand-lg" aria-label="Main navigation">
            <div className="container-xl">
                <Link href={user ? (user.current_world_id ? '/dashboard' : '/worlds') : '/'} className="navbar-brand top-nav-brand">
                    <img src="/logo.svg" alt="Market World" className="top-nav-brand-logo" />
                    <span className="top-nav-brand-mark">
                        MarketWorld<span className="top-nav-brand-dot">.sim</span>
                    </span>
                </Link>

                <button
                    className="navbar-toggler border-0"
                    type="button"
                    data-bs-toggle="collapse"
                    data-bs-target="#mainNav"
                    aria-controls="mainNav"
                    aria-expanded="false"
                    aria-label="Toggle navigation"
                    style={{ color: 'var(--text-secondary)', boxShadow: 'none' }}
                >
                    <span className="navbar-toggler-icon" style={{ filter: 'invert(1) sepia(1) saturate(0)' }} />
                </button>

                <div className="collapse navbar-collapse" id="mainNav">
                    <nav className="navbar-nav mx-auto d-flex gap-1 align-items-center" aria-label="Main navigation links">
                        {navLinks.map((link) => (
                            <Link
                                key={link.href}
                                href={link.href}
                                className={`top-nav-link${isActivePath(pathname, link.href) ? ' active' : ''}`}
                            >
                                {link.label}
                            </Link>
                        ))}
                    </nav>

                    <div className="d-flex align-items-center gap-2">
                        {user && (
                            <div className="top-nav-user" title="Logged in user">
                                Trader: {user.username}
                            </div>
                        )}
                        {user ? (
                            <button type="button" className="btn btn-outline" onClick={logout}>
                                Disconnect
                            </button>
                        ) : (
                            <Link href="/" className="btn btn-outline">
                                Enter Terminal
                            </Link>
                        )}
                    </div>
                </div>
            </div>
        </header>
    );
};

export default TopNav;
