'use client';

import React from 'react';

const spinnerCss = `@keyframes mw-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}`;

const LoadingScreen = () => (
    <>
        <style>{spinnerCss}</style>
        <div style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            background: 'rgba(6, 6, 6, 0.82)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
        }}>
            <div style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                border: '4px solid rgba(255, 255, 255, 0.08)',
                borderTopColor: 'var(--accent-blue, #69d9ff)',
                animation: 'mw-spin 0.75s linear infinite'
            }} />
        </div>
    </>
);

export default LoadingScreen;
