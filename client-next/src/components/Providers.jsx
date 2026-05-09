'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { AuthProvider } from '@/context/AuthContext';
import TopNav from '@/components/TopNav';

const SettingsContext = createContext({
    theme: 'bloomberg',
    currency: 'USD',
    currencySymbol: '$',
    currencyRate: 1,
    showNewsTicker: true,
    numberFormat: 'compact',
    setTheme: () => {},
    setCurrency: () => {},
    setCurrencyRate: () => {}
});

export const useSettings = () => useContext(SettingsContext);

const CURRENCY_SYMBOLS = {
    USD: '$',
    EUR: 'EUR ',
    GBP: 'GBP ',
    JPY: 'JPY ',
    CAD: 'CAD ',
    AUD: 'AUD ',
    CHF: 'CHF ',
    CNY: 'CNY ',
    INR: 'INR ',
    BRL: 'BRL ',
    SGD: 'SGD '
};

const normalizeTheme = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'dark') return 'bloomberg';
    if (raw === 'light') return 'robinhood';
    if (raw === 'cyberpunk') return 'bloomberg';
    if (['bloomberg', 'robinhood'].includes(raw)) return raw;
    return 'bloomberg';
};

function ThemeInitializer({ children }) {
    const [theme, setTheme] = useState('bloomberg');
    const [currency, setCurrencyState] = useState('USD');
    const [currencyRate, setCurrencyRate] = useState(1);
    const [showNewsTicker, setShowNewsTicker] = useState(true);
    const [numberFormat, setNumberFormat] = useState('compact');
    const [settingsBootstrapped, setSettingsBootstrapped] = useState(false);

    const syncRateForCurrency = async (targetCurrency) => {
        if (!targetCurrency || targetCurrency === 'USD') {
            setCurrencyRate(1);
            return;
        }

        try {
            const response = await fetch('/api/settings/exchange-rates');
            const data = await response.json();
            const rate = Number(data?.rates?.[targetCurrency]);
            if (Number.isFinite(rate) && rate > 0) {
                setCurrencyRate(rate);
            }
        } catch {
            // keep last known rate
        }
    };

    useEffect(() => {
        const savedTheme = normalizeTheme(localStorage.getItem('mw-theme'));
        const savedCurrency = localStorage.getItem('mw-currency') || 'USD';
        const savedTicker = localStorage.getItem('mw-show-ticker');
        const savedFormat = localStorage.getItem('mw-number-format') || 'compact';

        setTheme(savedTheme);
        setCurrencyState(savedCurrency);
        setShowNewsTicker(savedTicker !== 'false');
        setNumberFormat(savedFormat);
        document.documentElement.setAttribute('data-theme', savedTheme);
        setSettingsBootstrapped(true);
        syncRateForCurrency(savedCurrency);
    }, []);

    useEffect(() => {
        if (!settingsBootstrapped) return;

        syncRateForCurrency(currency);
        const timer = setInterval(() => {
            syncRateForCurrency(currency);
        }, 30000);

        return () => clearInterval(timer);
    }, [currency, settingsBootstrapped]);

    const handleSetTheme = (newTheme) => {
        const normalized = normalizeTheme(newTheme);
        setTheme(normalized);
        document.documentElement.setAttribute('data-theme', normalized);
        localStorage.setItem('mw-theme', normalized);
    };

    const setCurrency = (newCurrency, rate) => {
        setCurrencyState(newCurrency);
        localStorage.setItem('mw-currency', newCurrency);
        if (rate && Number.isFinite(rate) && rate > 0) {
            setCurrencyRate(rate);
        } else if (newCurrency === 'USD') {
            setCurrencyRate(1);
        }
    };

    const currencySymbol = CURRENCY_SYMBOLS[currency] || `${currency} `;

    return (
        <SettingsContext.Provider value={{
            theme,
            currency,
            currencySymbol,
            currencyRate,
            showNewsTicker,
            numberFormat,
            setTheme: handleSetTheme,
            setCurrency,
            setCurrencyRate
        }}>
            {children}
        </SettingsContext.Provider>
    );
}

export default function Providers({ children }) {
    return (
        <ThemeInitializer>
            <AuthProvider>
                <TopNav />
                {children}
            </AuthProvider>
        </ThemeInitializer>
    );
}

