'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { feature } from 'topojson-client';
import countriesTopo from 'world-atlas/countries-110m.json';

const Globe = dynamic(() => import('react-globe.gl'), {
    ssr: false,
    loading: () => (
        <div
            className="glass-panel"
            style={{
                minHeight: 340,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
                fontSize: '0.86rem'
            }}
        >
            Loading 3D globe...
        </div>
    )
});

const TIER_VISUALS = {
    bluechip: {
        color: '#4aa3ff',
        barAltitude: 0.34,
        pointAltitude: 0.17,
        pointRadius: 0.54
    },
    main: {
        color: '#f2c76f',
        barAltitude: 0.23,
        pointAltitude: 0.13,
        pointRadius: 0.44
    },
    startup: {
        color: '#61d38f',
        barAltitude: 0.14,
        pointAltitude: 0.10,
        pointRadius: 0.34
    }
};

const getTierVisual = (tier) => TIER_VISUALS[String(tier || 'startup').toLowerCase()] || TIER_VISUALS.startup;

const MarketGlobe = ({ markets = [], selectedMarketId = null, onSelect }) => {
    const globeRef = useRef(null);
    const wrapperRef = useRef(null);
    const [dimensions, setDimensions] = useState({ width: 760, height: 420 });

    const countryPolygons = useMemo(() => {
        const collection = feature(countriesTopo, countriesTopo.objects.countries);
        return collection.features || [];
    }, []);

    const marketBars = useMemo(() => {
        const normalized = (markets || [])
            .map((market) => {
                const latitude = Number(market.latitude);
                const longitude = Number(market.longitude);
                const listedMarketCap = Math.max(0, Number(market.listed_market_cap || 0));
                const visual = getTierVisual(market.listing_tier);

                if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                    return null;
                }

                return {
                    ...market,
                    latitude,
                    longitude,
                    listedMarketCap,
                    isSelected: Number(market.id) === Number(selectedMarketId),
                    tierColor: visual.color,
                    tierBarAltitude: visual.barAltitude,
                    tierPointAltitude: visual.pointAltitude,
                    tierPointRadius: visual.pointRadius
                };
            })
            .filter(Boolean);

        return normalized.map((market) => ({
            ...market,
            barAltitude: market.isSelected ? market.tierBarAltitude + 0.03 : market.tierBarAltitude,
            pointAltitude: market.isSelected ? market.tierPointAltitude + 0.02 : market.tierPointAltitude,
            pointRadius: market.isSelected ? market.tierPointRadius + 0.08 : market.tierPointRadius
        }));
    }, [markets, selectedMarketId]);

    const selectedBarRings = useMemo(
        () => marketBars.filter((bar) => bar.isSelected),
        [marketBars]
    );

    const selectedMarket = useMemo(
        () => marketBars.find((bar) => bar.isSelected) || null,
        [marketBars]
    );

    useEffect(() => {
        if (!wrapperRef.current) {
            return undefined;
        }

        const updateSize = () => {
            if (!wrapperRef.current) {
                return;
            }

            const width = Math.max(300, Math.round(wrapperRef.current.clientWidth));
            const height = Math.max(300, Math.min(520, Math.round(width * 0.62)));
            setDimensions({ width, height });
        };

        updateSize();

        const resizeObserver = new ResizeObserver(() => {
            updateSize();
        });

        resizeObserver.observe(wrapperRef.current);

        return () => {
            resizeObserver.disconnect();
        };
    }, []);

    useEffect(() => {
        if (!globeRef.current) {
            return;
        }

        const controls = globeRef.current.controls?.();
        if (!controls) {
            return;
        }

        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.38;
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 150;
        controls.maxDistance = 360;
    }, [dimensions.width, dimensions.height]);

    useEffect(() => {
        if (!globeRef.current) {
            return;
        }

        const selected = marketBars.find((bar) => bar.isSelected);
        if (!selected) {
            return;
        }

        globeRef.current.pointOfView(
            {
                lat: selected.latitude,
                lng: selected.longitude,
                altitude: 1.9
            },
            800
        );
    }, [marketBars]);

    if (!markets.length) {
        return (
            <div className="glass-panel" style={{ padding: '0.8rem' }}>
                <div className="text-muted" style={{ fontSize: '0.85rem' }}>
                    No stock markets available in this world.
                </div>
            </div>
        );
    }

    return (
        <div className="glass-panel" style={{ padding: '0.75rem' }}>
            <div className="text-muted" style={{ fontSize: '0.78rem', marginBottom: '0.45rem' }}>
                Drag to orbit, scroll to zoom, and click a market bar to inspect exchange details. Bar color and height track listing tier.
            </div>

            <div
                ref={wrapperRef}
                style={{
                    width: '100%',
                    display: 'grid',
                    placeItems: 'center',
                    borderRadius: 12,
                    overflow: 'hidden',
                    border: '1px solid rgba(138, 190, 245, 0.22)',
                    background: 'radial-gradient(circle at 35% 20%, rgba(19, 53, 85, 0.75), rgba(5, 9, 16, 0.96))'
                }}
            >
                <Globe
                    ref={globeRef}
                    width={dimensions.width}
                    height={dimensions.height}
                    backgroundColor="rgba(0,0,0,0)"
                    showAtmosphere
                    showGraticules
                    globeImageUrl="https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
                    bumpImageUrl="https://unpkg.com/three-globe/example/img/earth-topology.png"
                    atmosphereColor="#67b8ff"
                    atmosphereAltitude={0.2}
                    polygonsData={countryPolygons}
                    polygonCapColor={() => 'rgba(28, 78, 120, 0.34)'}
                    polygonSideColor={() => 'rgba(12, 35, 55, 0.2)'}
                    polygonStrokeColor={() => 'rgba(167, 205, 255, 0.5)'}
                    polygonAltitude={0.0055}
                    polygonsTransitionDuration={300}
                    barsData={marketBars}
                    barLat="latitude"
                    barLng="longitude"
                    barAltitude="barAltitude"
                    barColor={(bar) => (bar.isSelected ? '#ffffff' : bar.tierColor)}
                    barTopRadius={0.42}
                    barResolution={12}
                    barLabel={(bar) => {
                        return `<div style="padding:6px 8px;border-radius:8px;background:rgba(5,10,18,.9);color:#eaf4ff;font-size:12px;line-height:1.35;max-width:260px;">
                            <strong>${bar.name} (${bar.code})</strong><br/>
                            ${bar.city}, ${bar.country_name}<br/>
                            Tier: ${bar.listing_tier} | Listed Cap: $${Number(bar.listedMarketCap || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}<br/>
                            Listed Companies: ${Number(bar.listed_company_count || 0).toLocaleString()}
                        </div>`;
                    }}
                    onBarClick={(bar) => {
                        if (onSelect) {
                            onSelect(bar);
                        }
                    }}
                    pointsData={marketBars}
                    pointLat="latitude"
                    pointLng="longitude"
                    pointColor={(point) => (point.isSelected ? '#f6fbff' : '#90d2ff')}
                    pointAltitude="pointAltitude"
                    pointRadius="pointRadius"
                    pointResolution={12}
                    pointsMerge={false}
                    onPointClick={(point) => {
                        if (onSelect) {
                            onSelect(point);
                        }
                    }}
                    ringsData={selectedBarRings}
                    ringLat="latitude"
                    ringLng="longitude"
                    ringColor={() => (t) => `rgba(255,255,255,${1 - t})`}
                    ringMaxRadius={4.5}
                    ringPropagationSpeed={1.2}
                    ringRepeatPeriod={850}
                />
            </div>

            <div style={{ display: 'flex', gap: '0.45rem', marginTop: '0.55rem', flexWrap: 'wrap' }}>
                <span className="badge" style={{ background: 'rgba(74,163,255,0.2)', color: '#4aa3ff' }}>Blue-chip Tier (max height)</span>
                <span className="badge" style={{ background: 'rgba(242,199,111,0.2)', color: '#f2c76f' }}>Main Tier (mid height)</span>
                <span className="badge" style={{ background: 'rgba(97,211,143,0.2)', color: '#61d38f' }}>Startup Tier (lowest height)</span>
            </div>
        </div>
    );
};

export default MarketGlobe;
