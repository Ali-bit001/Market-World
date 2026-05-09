'use client';

import React, { useState, useEffect } from 'react';
import api from '../api/axios';
import { jwtDecode } from 'jwt-decode';
import { AuthContext } from './auth-context';
import { useRouter } from 'next/navigation';
import LoadingScreen from '../components/LoadingScreen';

export const AuthProvider = ({ children }) => {
    const router = useRouter();
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    const logout = () => {
        localStorage.removeItem('token');
        setUser(null);
        router.push('/');
    };

    useEffect(() => {
        const loadUser = async () => {
            const token = localStorage.getItem('token');
            if (token) {
                try {
                    const decoded = jwtDecode(token);
                    // Check if token expired
                    if (decoded.exp * 1000 < Date.now()) {
                        logout();
                    } else {
                        const { data } = await api.get('/auth/me');
                        setUser(data.user);
                    }
                } catch {
                    logout();
                }
            }
            setLoading(false);
        };
        loadUser();
    }, []);

    const login = async (identifier, password) => {
        const { data } = await api.post('/auth/login', { identifier, password });
        localStorage.setItem('token', data.token);
        setUser(data.user);
    };

    const register = async (username, email, password) => {
        await api.post('/auth/register', { username, email, password });
        // After register, auto login
        await login(email, password);
    };

    const joinWorld = async (worldId) => {
        const { data } = await api.post(`/worlds/${worldId}/join`);
        setUser({ ...user, current_world_id: worldId });
        return data;
    };

    const leaveWorld = async () => {
        await api.post('/worlds/leave');
        setUser({ ...user, current_world_id: null });
    };

    return (
        <AuthContext.Provider value={{ user, loading, login, logout, register, joinWorld, leaveWorld }}>
            {loading ? <LoadingScreen /> : children}
        </AuthContext.Provider>
    );
};
