'use client';

import React from 'react';
import Link from 'next/link';

const AssetCard = ({ title, icon, points, description }) => (
    <div className="glass-card surface-layered depth-3 p-3">
        <div className="d-flex align-items-center gap-2 mb-2">
            {icon && <span style={{ fontSize: '1.3rem' }}>{icon}</span>}
            <h4 className="mb-0">{title}</h4>
        </div>
        <p className="text-muted mb-2" style={{ fontSize: '0.92rem' }}>{description}</p>
        <ul style={{ marginLeft: '1rem', color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6 }}>
            {points.map(p => <li key={p}>{p}</li>)}
        </ul>
    </div>
);

const GuideBlock = ({ title, subtitle, children }) => (
    <div className="glass-panel surface-layered depth-4 mb-3">
        <h3 className="mb-1">{title}</h3>
        {subtitle && <p className="text-muted mb-3" style={{ fontSize: '0.92rem' }}>{subtitle}</p>}
        {children}
    </div>
);

const TipCard = ({ emoji, title, body }) => (
    <div className="glass-card depth-2 p-3">
        {emoji ? <div style={{ fontSize: '1.4rem', marginBottom: '0.35rem' }}>{emoji}</div> : null}
        <div style={{ fontWeight: 700, marginBottom: '0.3rem' }}>{title}</div>
        <p className="text-muted mb-0" style={{ fontSize: '0.88rem' }}>{body}</p>
    </div>
);

const Guide = () => (
    <div className="container-xl py-4">
        {/* Hero */}
        <div className="glass-card surface-layered depth-5 p-4 mb-4">
            <div className="text-muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: '0.75rem' }}>How To Play</div>
            <h2 className="mt-2 mb-2">Welcome to Market World</h2>
            <p className="text-muted mb-3" style={{ maxWidth: 860, fontSize: '0.97rem', lineHeight: 1.65 }}>
                Market World is a real-time financial simulation game. You start with $100,000 and compete against other players to grow your wealth by trading stocks, commodities, crypto, and bonds — all while world events shake up prices and countries go to war.
            </p>
            <div className="d-flex gap-2 flex-wrap">
                <Link href="/worlds" className="btn btn-primary">Browse Worlds</Link>
                <Link href="/dashboard" className="btn btn-outline">Open Dashboard</Link>
                <Link href="/" className="btn btn-outline">Back to Login</Link>
            </div>
        </div>

        {/* Getting Started */}
        <GuideBlock title="Getting Started" subtitle="New to Market World? Here's how to hit the ground running.">
            <div className="row g-2">
                {[
                    { step: '1', text: 'Join a world from the Worlds page. Each world is a separate economy with its own players and events.' },
                    { step: '2', text: 'You start with $100,000 in cash. This is your seed capital — spend it wisely.' },
                    { step: '3', text: 'Head to Assets & Trading. Browse commodities, crypto, and bonds. Click Buy to open the trade modal.' },
                    { step: '4', text: 'Go to Stock Market to browse listed companies. Buy shares using limit orders.' },
                    { step: '5', text: 'Watch the news ticker at the top. Events like wars and tech breakthroughs move prices fast.' },
                    { step: '6', text: 'Check Macro Indicators to see which countries are stable and which are heading for trouble.' },
                    { step: '7', text: 'Once you have capital, create your own company in Company Management and list it on an exchange.' }
                ].map(({ step, text }) => (
                    <div key={step} className="col-12 col-sm-6 col-lg-4">
                        <div className="glass-card depth-2 p-3 d-flex gap-2 align-items-start h-100">
                            <div style={{ minWidth: 28, height: 28, borderRadius: '50%', background: 'rgba(47,129,247,0.2)', border: '1px solid rgba(47,129,247,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.82rem', color: 'var(--accent-blue)', flexShrink: 0 }}>
                                {step}
                            </div>
                            <div style={{ fontSize: '0.87rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{text}</div>
                        </div>
                    </div>
                ))}
            </div>
        </GuideBlock>

        {/* Asset Classes */}
        <GuideBlock title="Asset Classes" subtitle="Four types of assets to trade. Each plays differently.">
            <div className="row g-3">
                <div className="col-12 col-md-6">
                    <AssetCard title="Stocks" icon={null} description="Buy shares of companies listed on stock exchanges." points={['Prices move based on company performance and world events', 'Use limit orders: set the price you want to buy or sell at', 'Orders sit in the order book until matched', 'Best for medium-term growth and dividend income']} />
                </div>
                <div className="col-12 col-md-6">
                    <AssetCard title="Commodities" icon={null} description="Oil, Gold, Wheat, Natural Gas — physical goods with global demand." points={['Buy and sell instantly at market price', 'Wars raise oil and gas prices significantly', 'Droughts and food crises push wheat prices up', 'Good for reacting quickly to world events']} />
                </div>
                <div className="col-12 col-md-6">
                    <AssetCard title="Crypto" icon="₿" description="High-volatility digital assets. High risk, high reward." points={['Can spike or crash dramatically in a single tick', 'Instant buy/sell at market price — no order book', 'Momentum-driven: rises fast in bull markets', 'Best for short-term speculation']} />
                </div>
                <div className="col-12 col-md-6">
                    <AssetCard title="Bonds" icon={null} description="Government bonds with a fixed payout at maturity." points={['Buy at face value, receive a fixed return at maturity', 'Cannot be sold — you hold until maturity', 'If the issuing country goes bankrupt, you lose everything', 'Best for safe, predictable returns in stable countries']} />
                </div>
            </div>
        </GuideBlock>

        {/* World Events */}
        <GuideBlock title="World Events" subtitle="Random events fire every few ticks and shake up the market. Pay attention.">
            <div className="row g-3">
                {[
                    { emoji: '', title: 'Wars & Conflicts', body: 'Military conflicts spike oil, gas, and gold prices. Bonds from involved countries become risky.' },
                    { emoji: '', title: 'Tech Breakthroughs', body: 'A major tech event can send tech stocks surging. Watch for these in the news ticker.' },
                    { emoji: '', title: 'Economic Crises', body: 'Recessions and financial shocks drag down most assets. Cash is king during a crisis.' },
                    { emoji: '', title: 'Economic Booms', body: 'Growth events lift stocks and commodities broadly. Ride the wave carefully.' },
                    { emoji: '', title: 'The News Ticker', body: 'Every event appears in the scrolling ticker at the top of the dashboard. Read it constantly.' }
                ].map(c => (
                    <div key={c.title} className="col-12 col-sm-6 col-lg-4">
                        <TipCard emoji={c.emoji} title={c.title} body={c.body} />
                    </div>
                ))}
            </div>
        </GuideBlock>

        {/* Countries & Macro */}
        <GuideBlock title="Countries & Macro Indicators" subtitle="Countries have financial health scores and diplomatic relations that affect your investments.">
            <div className="row g-3 mb-3">
                {[
                    { title: 'Financial Health', body: 'Countries are rated Robust, Stable, Vulnerable, or Distressed. Distressed countries are more likely to default on bonds.' },
                    { title: 'Conflict Risk', body: 'A rising conflict risk score means war is more likely. Active conflicts raise commodity prices and make bonds risky.' },
                    { title: 'Diplomatic Relations', body: 'Countries with hostile or critical relations are flashpoints. Watch the Macro page for early warning signs.' }
                ].map(c => (
                    <div key={c.title} className="col-12 col-md-4">
                        <div className="glass-card depth-2 p-3 h-100">
                            <h4 className="mb-2">{c.title}</h4>
                            <p className="text-muted mb-0" style={{ fontSize: '0.88rem' }}>{c.body}</p>
                        </div>
                    </div>
                ))}
            </div>
            <div className="glass-card depth-3 p-3">
                <h4 className="mb-2">How to use the Macro page</h4>
                <ul style={{ marginLeft: '1rem', color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.65 }}>
                    <li>Click a country on the globe to see its full financial and diplomatic profile.</li>
                    <li>Avoid buying bonds from countries with Vulnerable or Distressed health ratings.</li>
                    <li>When conflict risk climbs to Elevated or Severe, reduce exposure to that region's assets.</li>
                    <li>Stable, Robust countries with low conflict risk are the safest bond issuers.</li>
                </ul>
            </div>
        </GuideBlock>

        {/* Building a Company */}
        <GuideBlock title="Building a Company" subtitle="Create your own company and grow it into a market powerhouse.">
            <div className="row g-3 mb-3">
                {[
                    { title: 'Private (Unlisted)', body: 'Your company grows based on market trends. Its value shows in your net worth. Good for building value quietly before going public.' },
                    { title: 'Public (Listed)', body: 'List on a stock exchange so other players can buy your shares. Your share price is public and moves with the market.' },
                    { title: 'Strategy Settings', body: 'Tune Risk Level, Growth Strategy, and Dividend Policy. These affect how your company performs each tick.' }
                ].map(c => (
                    <div key={c.title} className="col-12 col-md-4">
                        <div className="glass-card depth-2 p-3 h-100">
                            <h4 className="mb-2">{c.title}</h4>
                            <p className="text-muted mb-0" style={{ fontSize: '0.88rem' }}>{c.body}</p>
                        </div>
                    </div>
                ))}
            </div>
            <div className="glass-card depth-3 p-3">
                <h4 className="mb-2">Company Tips</h4>
                <ul style={{ marginLeft: '1rem', color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.65 }}>
                    <li>Start with a moderate risk profile and switch to aggressive once you have a cash buffer.</li>
                    <li>Don't list too many shares at once — flooding the market drives your price down.</li>
                    <li>Dividends attract long-term shareholders and stabilize your share price.</li>
                    <li>Liquidating a company distributes remaining assets to all shareholders — including you.</li>
                </ul>
            </div>
        </GuideBlock>

        {/* Making Money */}
        <GuideBlock title="Making Money — Strategies That Work" subtitle="There's no single right way to play. Here are the main paths to wealth.">
            <div className="row g-3">
                {[
                    { emoji: '', title: 'Event Trading', body: 'React to news events faster than other players. Buy oil before a war escalates. Sell bonds before a country defaults.' },
                    { emoji: '', title: 'Diversification', body: 'Spread across commodities, crypto, and stocks. When one sector crashes, others may hold or rise.' },
                    { emoji: '', title: 'Bond Carry', body: 'Park capital in stable-country bonds for guaranteed returns. Low excitement, but reliable compounding.' },
                    { emoji: '', title: 'Company Building', body: 'Create a company, grow it, list it, and sell shares to other players at a premium.' },
                    { emoji: '', title: 'Buy the Dip', body: 'Keep cash reserves. When a crisis hits and prices crash, buy quality assets at a discount.' },
                    { emoji: '', title: 'Private Deals', body: 'Negotiate off-book share sales with other players via direct chat.' }
                ].map(c => (
                    <div key={c.title} className="col-12 col-sm-6 col-lg-4">
                        <TipCard emoji={c.emoji} title={c.title} body={c.body} />
                    </div>
                ))}
            </div>
        </GuideBlock>

        {/* Quick Reference */}
        <GuideBlock title="Quick Reference" subtitle="The most important things to remember.">
            <div className="glass-card depth-3 p-3">
                <ul style={{ marginLeft: '1rem', color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.75 }}>
                    <li>You start with <strong>$100,000</strong>. Don't blow it all on crypto in the first 10 ticks.</li>
                    <li><strong>Commodities and crypto</strong> execute instantly. <strong>Shares</strong> use limit orders.</li>
                    <li><strong>Bonds cannot be sold</strong> — only buy them if you're comfortable holding to maturity.</li>
                    <li>Watch the <strong>news ticker</strong> constantly. Events are your biggest edge.</li>
                    <li>Check the <strong>Macro page</strong> before buying bonds — distressed countries default.</li>
                    <li>Keep at least <strong>20–30% of your portfolio in cash</strong> for opportunities and emergencies.</li>
                    <li>The leaderboard ranks by <strong>net worth</strong> (cash + holdings + company value).</li>
                </ul>
            </div>
        </GuideBlock>
    </div>
);

export default Guide;
