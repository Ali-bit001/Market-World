'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import * as topojson from 'topojson-client';

const Globe = dynamic(() => import('react-globe.gl'), { ssr: false });

const healthBandColor = (band) => {
    if (band === 'robust') return '#57a6ff';
    if (band === 'stable') return '#61d38f';
    if (band === 'vulnerable') return '#f2c76f';
    return '#ff766f';
};

const conflictRiskColor = (riskLevel) => {
    if (riskLevel === 'severe') return '#ff766f';
    if (riskLevel === 'elevated') return '#ff9a57';
    if (riskLevel === 'guarded') return '#f2c76f';
    return '#61d38f';
};

const SELECTED_BAR_COLOR = '#1fd474';

const CountryMacroGlobe = ({ countries = [], selectedCountryId, onSelectCountry }) => {
    const globeRef = useRef(null);
    const viewportRef = useRef(null);
    const [countryPolygons, setCountryPolygons] = useState([]);
    const [viewport, setViewport] = useState({ width: 980, height: 470 });

    useEffect(() => {
        let active = true;

        const loadPolygons = async () => {
            try {
                const response = await fetch('https://unpkg.com/world-atlas@2/countries-110m.json');
                const worldTopology = await response.json();
                const features = topojson.feature(worldTopology, worldTopology.objects.countries).features;

                if (active) {
                    setCountryPolygons(features);
                }
            } catch {
                if (active) {
                    setCountryPolygons([]);
                }
            }
        };

        loadPolygons();
        return () => {
            active = false;
        };
    }, []);

    useEffect(() => {
        if (!viewportRef.current) {
            return undefined;
        }

        const updateViewport = () => {
            const width = Math.max(320, Math.round(viewportRef.current?.clientWidth || 980));
            const height = Math.max(360, Math.min(520, Math.round(width * 0.48)));
            setViewport({ width, height });
        };

        updateViewport();

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', updateViewport);
            return () => window.removeEventListener('resize', updateViewport);
        }

        const observer = new ResizeObserver(updateViewport);
        observer.observe(viewportRef.current);

        return () => observer.disconnect();
    }, []);

    const macroBars = useMemo(() => {
        return (countries || [])
            .map((entry) => {
                const latitude = Number(entry.latitude);
                const longitude = Number(entry.longitude);
                const financialHealthScore = Number(entry.financial_health_score || entry.macro_score || 0);
                const conflictRiskScore = Number(entry.conflict_risk_score || 0);

                if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                    return null;
                }

                const clampedHealthScore = Math.max(0, Math.min(100, financialHealthScore));
                const clampedConflictRiskScore = Math.max(0, Math.min(100, conflictRiskScore));
                const barAltitude = 0.08 + (clampedHealthScore / 100) * 0.24;

                return {
                    ...entry,
                    latitude,
                    longitude,
                    financialHealthScore: clampedHealthScore,
                    conflictRiskScore: clampedConflictRiskScore,
                    barAltitude,
                    barColor: healthBandColor(entry.financial_health_band),
                    riskColor: conflictRiskColor(entry.conflict_risk_level),
                    isSelected: Number(entry.country_id) === Number(selectedCountryId)
                };
            })
            .filter(Boolean);
    }, [countries, selectedCountryId]);

    const macroPoints = useMemo(() => {
        return macroBars.map((entry) => ({
            ...entry,
            pointAltitude: entry.barAltitude + 0.03 + ((entry.conflictRiskScore / 100) * 0.02),
            pointColor: entry.isSelected ? SELECTED_BAR_COLOR : entry.riskColor,
            pointRadius: entry.isSelected ? 0.38 : 0.28
        }));
    }, [macroBars]);

    useEffect(() => {
        if (!globeRef.current || !selectedCountryId) {
            return;
        }

        const selected = macroBars.find((entry) => Number(entry.country_id) === Number(selectedCountryId));
        if (!selected) {
            return;
        }

        globeRef.current.pointOfView(
            {
                lat: selected.latitude,
                lng: selected.longitude,
                altitude: 1.8
            },
            850
        );
    }, [selectedCountryId, macroBars]);

    return (
        <div className="glass-panel" style={{ padding: '0.9rem' }}>
            <div className="text-muted" style={{ fontSize: '0.8rem', marginBottom: '0.4rem' }}>
                Click a country bar to inspect financial health and diplomatic conflict risk. Bar height and color track financial health band.
            </div>

            <div
                ref={viewportRef}
                style={{
                    width: '100%',
                    height: viewport.height,
                    borderRadius: 12,
                    overflow: 'hidden',
                    background: 'radial-gradient(circle at 30% 30%, #071026, #03060f)'
                }}
            >
                <Globe
                    ref={globeRef}
                    width={viewport.width}
                    height={viewport.height}
                    globeImageUrl="https://unpkg.com/three-globe/example/img/earth-night.jpg"
                    bumpImageUrl="https://unpkg.com/three-globe/example/img/earth-topology.png"
                    backgroundColor="rgba(0,0,0,0)"
                    polygonsData={countryPolygons}
                    polygonCapColor={() => 'rgba(93, 120, 158, 0.28)'}
                    polygonSideColor={() => 'rgba(43, 58, 87, 0.22)'}
                    polygonStrokeColor={() => 'rgba(196, 210, 236, 0.25)'}
                    polygonsTransitionDuration={260}
                    barsData={macroBars}
                    barLat="latitude"
                    barLng="longitude"
                    barAltitude={(bar) => (bar.isSelected ? bar.barAltitude + 0.035 : bar.barAltitude)}
                    barColor={(bar) => (bar.isSelected ? SELECTED_BAR_COLOR : bar.barColor)}
                    barLabel={(bar) => {
                        return `<div style="font-size:12px;line-height:1.45;">
                            <strong>${bar.country_name} (${bar.country_code})</strong><br/>
                            Financial Health: ${Number(bar.financialHealthScore || 0).toFixed(1)} / 100 (${bar.financial_health_band})<br/>
                            Conflict Risk: ${Number(bar.conflictRiskScore || 0).toFixed(1)} / 100 (${bar.conflict_risk_level})<br/>
                            Relations: Avg ${Number(bar.relation_avg_score || 0).toFixed(1)} | Hostile/Critical ${Number(bar.hostile_relations || 0) + Number(bar.critical_relations || 0)}
                        </div>`;
                    }}
                    onBarClick={(bar) => {
                        if (typeof onSelectCountry === 'function') {
                            onSelectCountry(bar.country_id);
                        }
                    }}
                    pointsData={macroPoints}
                    pointLat="latitude"
                    pointLng="longitude"
                    pointAltitude="pointAltitude"
                    pointRadius="pointRadius"
                    pointColor="pointColor"
                    pointsMerge={false}
                    pointResolution={18}
                    onPointClick={(point) => {
                        if (typeof onSelectCountry === 'function') {
                            onSelectCountry(point.country_id);
                        }
                    }}
                    barsTransitionDuration={340}
                />
            </div>

            <div style={{ display: 'flex', gap: '0.45rem', marginTop: '0.55rem', flexWrap: 'wrap' }}>
                <span className="badge" style={{ background: 'rgba(31,212,116,0.2)', color: SELECTED_BAR_COLOR }}>Selected Country</span>
                <span className="badge" style={{ background: 'rgba(87,166,255,0.2)', color: '#57a6ff' }}>Robust Health</span>
                <span className="badge" style={{ background: 'rgba(97,211,143,0.2)', color: '#61d38f' }}>Stable Health</span>
                <span className="badge" style={{ background: 'rgba(242,199,111,0.2)', color: '#f2c76f' }}>Vulnerable Health</span>
                <span className="badge" style={{ background: 'rgba(255,118,111,0.2)', color: '#ff766f' }}>Distressed Health</span>
            </div>
        </div>
    );
};

export default CountryMacroGlobe;
