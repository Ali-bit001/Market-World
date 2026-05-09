'use client';

import { useEffect, useState, useRef, useContext } from 'react';
import { AuthContext } from '../context/auth-context';

export const useWebSocket = () => {
    const [events, setEvents] = useState([]);
    const [lastTick, setLastTick] = useState(null);
    const ws = useRef(null);
    const { user } = useContext(AuthContext);

    useEffect(() => {
        if (!user || !user.current_world_id) return;

        // Connect to the same host as the Next custom server.
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        ws.current = new WebSocket(`${protocol}://${window.location.host}/ws`);

        ws.current.onopen = () => {
            console.log('WS Connected');
            ws.current.send(JSON.stringify({ type: 'subscribe', worldId: user.current_world_id }));
        };

        ws.current.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // Only advance lastTick (which triggers a full data refetch in Dashboard)
                // on the tick_snapshot message — not on every per-service broadcast.
                // Per-service messages (companies, commodities, cryptos) fire every tick
                // and would cause multiple redundant refetches per tick cycle.
                if (data.type === 'tick_snapshot') {
                    setLastTick(Date.now());
                }

                if (data.type === 'news' || data.type === 'event' || data.type === 'achievement' || data.type === 'trade_fill') {
                    setEvents(prev => [...prev, data].slice(-100));
                    // Also trigger a data refresh on trade fills so portfolio updates immediately
                    if (data.type === 'trade_fill') {
                        setLastTick(Date.now());
                    }
                }
            } catch (err) {
                console.error(err);
            }
        };

        ws.current.onclose = () => {
            console.log('WS Disconnected');
        };

        return () => {
            if (ws.current) {
                ws.current.close();
            }
        };
    }, [user]);

    return { events, lastTick };
};
