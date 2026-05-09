'use client';

import React, { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

const spinnerCss = `@keyframes mw-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}`;

const NavigationOverlay = () => {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [navigating, setNavigating] = useState(false);
    const prevPathRef = useRef(null);
    // Use a ref for the timeout so cleanup doesn't re-run the effect
    const timeoutRef = useRef(null);
    // Track whether we've patched pushState so we only do it once
    const patchedRef = useRef(false);

    const showOverlay = () => {
        setNavigating(true);
        clearTimeout(timeoutRef.current);
        // Safety: hide after 4s even if navigation never completes
        timeoutRef.current = setTimeout(() => setNavigating(false), 4000);
    };

    const hideOverlay = () => {
        clearTimeout(timeoutRef.current);
        setNavigating(false);
    };

    // Hide when the actual URL changes (navigation completed)
    useEffect(() => {
        const current = pathname + (searchParams.toString() ? `?${searchParams.toString()}` : '');
        if (prevPathRef.current === null) {
            prevPathRef.current = current;
            return;
        }
        if (current !== prevPathRef.current) {
            prevPathRef.current = current;
            hideOverlay();
        }
    }, [pathname, searchParams]);

    // Patch pushState ONCE on mount — store originals in refs so cleanup is stable
    useEffect(() => {
        if (typeof window === 'undefined' || patchedRef.current) return;
        patchedRef.current = true;

        const originalPush = window.history.pushState.bind(window.history);
        const originalReplace = window.history.replaceState.bind(window.history);

        window.history.pushState = (state, title, url) => {
            const currentPath = window.location.pathname + window.location.search;
            const nextPath = String(url || '');
            if (nextPath && !nextPath.startsWith('#') && nextPath !== currentPath) {
                showOverlay();
            }
            return originalPush(state, title, url);
        };

        // replaceState is used by Next.js for scroll restoration etc — don't show overlay for it
        window.history.replaceState = originalReplace;

        return () => {
            window.history.pushState = originalPush;
            window.history.replaceState = originalReplace;
            patchedRef.current = false;
        };
        // Empty deps — run once on mount only
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Also catch <a> link clicks
    useEffect(() => {
        const handleClick = (e) => {
            const anchor = e.target.closest('a[href]');
            if (!anchor) return;
            const href = anchor.getAttribute('href');
            if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith('#')) return;
            const currentPath = window.location.pathname + window.location.search;
            if (href !== currentPath) showOverlay();
        };
        document.addEventListener('click', handleClick, true);
        return () => document.removeEventListener('click', handleClick, true);
    }, []);

    // Hide on browser back/forward
    useEffect(() => {
        const handlePop = () => hideOverlay();
        window.addEventListener('popstate', handlePop);
        return () => window.removeEventListener('popstate', handlePop);
    }, []);

    if (!navigating) return null;

    return (
        <>
            <style>{spinnerCss}</style>
            <div style={{
                position: 'fixed',
                inset: 0,
                zIndex: 9000,
                background: 'rgba(0, 0, 0, 0.55)',
                backdropFilter: 'blur(2px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'all'
            }}>
                <div style={{
                    width: 52,
                    height: 52,
                    borderRadius: '50%',
                    border: '4px solid rgba(255, 255, 255, 0.10)',
                    borderTopColor: 'var(--accent-blue, #69d9ff)',
                    animation: 'mw-spin 0.7s linear infinite'
                }} />
            </div>
        </>
    );
};

export default NavigationOverlay;
