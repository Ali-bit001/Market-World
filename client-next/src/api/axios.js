import axios from 'axios';

const api = axios.create({
    baseURL: '/api',
    // Default timeout: 15 seconds. Prevents requests from hanging forever
    // when the server is busy with tick transactions.
    timeout: 15000,
});

// Auto-inject token
api.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// Convert timeout errors to a user-friendly message
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
            error.response = {
                data: { error: 'Request timed out. The market is busy — please try again in a moment.' }
            };
        }
        return Promise.reject(error);
    }
);

export default api;
