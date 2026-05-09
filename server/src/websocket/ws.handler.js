const WebSocket = require('ws');

let wss;
const clients = new Map(); // ws => worldId

const initWebSocket = (serverWss) => {
    wss = serverWss;

    wss.on('connection', (ws) => {
        console.log('Client connected to WebSocket');
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                // Expecting client to subscribe to a world: { type: 'subscribe', worldId: 1 }
                if (data.type === 'subscribe' && data.worldId) {
                    clients.set(ws, data.worldId);
                    ws.send(JSON.stringify({ type: 'subscribed', worldId: data.worldId }));
                }
            } catch (err) {
                console.error('WS MSG Error:', err);
            }
        });

        ws.on('close', () => {
            clients.delete(ws);
            console.log('Client disconnected');
        });
    });
};

const broadcastToWorld = (worldId, payload) => {
    if (!wss) return;

    const message = JSON.stringify(payload);
    for (const [client, cWorldId] of clients.entries()) {
        if (cWorldId === worldId && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
};

module.exports = {
    initWebSocket,
    broadcastToWorld
};
