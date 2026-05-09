const db = require('../config/database');
const wsHandler = require('../websocket/ws.handler');

const resolveMembership = async (userId, worldId) => {
    const database = db.getDb();
    const player = await database.collection('world_players').findOne({ user_id: userId, world_id: worldId });
    return player || null;
};

const listWorldUsers = async (req, res) => {
    try {
        const userId = req.user.id;
        const worldId = Number(req.query.worldId);

        if (!Number.isInteger(worldId)) {
            return res.status(400).json({ error: 'worldId is required' });
        }

        const membership = await resolveMembership(userId, worldId);
        if (!membership) {
            return res.status(403).json({ error: 'You are not part of this world' });
        }

        const database = db.getDb();
        const players = await database.collection('world_players').find({ world_id: worldId }).toArray();
        const userIds = players.map(p => p.user_id);
        const usersDocs = await database.collection('users').find({ id: { $in: userIds } }).toArray();
        const usersMap = new Map();
        for (const u of usersDocs) usersMap.set(u.id, u);

        const unreadPipeline = [
            { $match: { world_id: worldId, recipient_user_id: userId, is_read: false } },
            { $group: { _id: "$sender_user_id", count: { $sum: 1 } } }
        ];
        const unreadCounts = await database.collection('direct_messages').aggregate(unreadPipeline).toArray();
        const unreadMap = new Map(unreadCounts.map(u => [u._id, u.count]));

        const results = players.map(wp => {
            const u = usersMap.get(wp.user_id);
            return {
                id: wp.user_id,
                username: u ? u.username : 'Unknown',
                net_worth: Number(wp.net_worth || 0),
                cash_balance: Number(wp.cash_balance || 0),
                unread_count: unreadMap.get(wp.user_id) || 0
            };
        });

        results.sort((a, b) => {
            if (a.id === userId && b.id !== userId) return -1;
            if (a.id !== userId && b.id === userId) return 1;
            if (b.net_worth !== a.net_worth) return b.net_worth - a.net_worth;
            return a.username.localeCompare(b.username);
        });

        res.json({ users: results });
    } catch (error) {
        console.error('List world chat users error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const getWorldMessages = async (req, res) => {
    try {
        const userId = req.user.id;
        const worldId = Number(req.query.worldId);
        const limit = Math.min(Math.max(Number(req.query.limit || 80), 1), 200);

        if (!Number.isInteger(worldId)) {
            return res.status(400).json({ error: 'worldId is required' });
        }

        const membership = await resolveMembership(userId, worldId);
        if (!membership) {
            return res.status(403).json({ error: 'You are not part of this world' });
        }

        const database = db.getDb();
        const messages = await database.collection('world_chat_messages').aggregate([
            { $match: { world_id: worldId } },
            { $sort: { id: -1 } },
            { $limit: limit },
            {
                $lookup: {
                    from: "users",
                    localField: "sender_user_id",
                    foreignField: "id",
                    as: "sender"
                }
            },
            { $unwind: { path: "$sender", preserveNullAndEmptyArrays: true } }
        ]).toArray();

        const rows = messages.map(m => ({
            id: m.id,
            world_id: m.world_id,
            sender_user_id: m.sender_user_id,
            sender_username: m.sender ? m.sender.username : 'Unknown',
            message: m.message,
            created_at: m.created_at
        }));

        res.json({ messages: rows.reverse() });
    } catch (error) {
        console.error('Get world chat messages error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const postWorldMessage = async (req, res) => {
    try {
        const userId = req.user.id;
        const username = req.user.username;
        const worldId = Number(req.body.worldId);
        const message = String(req.body.message || '').trim();

        if (!Number.isInteger(worldId)) {
            return res.status(400).json({ error: 'worldId is required' });
        }

        if (!message) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }

        if (message.length > 500) {
            return res.status(400).json({ error: 'Message cannot exceed 500 characters' });
        }

        const membership = await resolveMembership(userId, worldId);
        if (!membership) {
            return res.status(403).json({ error: 'You are not part of this world' });
        }

        const database = db.getDb();
        const newId = await db.getNextId('world_chat_messages');
        const now = new Date().toISOString();

        await database.collection('world_chat_messages').insertOne({
            id: newId,
            world_id: worldId,
            sender_user_id: userId,
            message: message,
            created_at: now
        });

        const payload = {
            id: newId,
            world_id: worldId,
            sender_user_id: userId,
            sender_username: username,
            message,
            created_at: now
        };

        wsHandler.broadcastToWorld(worldId, {
            type: 'chat_world_message',
            message: payload
        });

        res.status(201).json({ message: payload });
    } catch (error) {
        console.error('Post world chat message error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const getDirectMessages = async (req, res) => {
    try {
        const userId = req.user.id;
        const worldId = Number(req.query.worldId);
        const withUserId = Number(req.query.withUserId);
        const limit = Math.min(Math.max(Number(req.query.limit || 80), 1), 200);

        if (!Number.isInteger(worldId) || !Number.isInteger(withUserId)) {
            return res.status(400).json({ error: 'worldId and withUserId are required' });
        }

        if (withUserId === userId) {
            return res.status(400).json({ error: 'Cannot open direct chat with yourself' });
        }

        const myMembership = await resolveMembership(userId, worldId);
        if (!myMembership) {
            return res.status(403).json({ error: 'You are not part of this world' });
        }

        const recipientMembership = await resolveMembership(withUserId, worldId);
        if (!recipientMembership) {
            return res.status(404).json({ error: 'Selected user is not in this world' });
        }

        const database = db.getDb();
        const messages = await database.collection('direct_messages').aggregate([
            {
                $match: {
                    world_id: worldId,
                    $or: [
                        { sender_user_id: userId, recipient_user_id: withUserId },
                        { sender_user_id: withUserId, recipient_user_id: userId }
                    ]
                }
            },
            { $sort: { id: -1 } },
            { $limit: limit },
            {
                $lookup: { from: "users", localField: "sender_user_id", foreignField: "id", as: "sender" }
            },
            {
                $lookup: { from: "users", localField: "recipient_user_id", foreignField: "id", as: "recipient" }
            },
            { $unwind: { path: "$sender", preserveNullAndEmptyArrays: true } },
            { $unwind: { path: "$recipient", preserveNullAndEmptyArrays: true } }
        ]).toArray();

        const rows = messages.map(m => ({
            id: m.id,
            world_id: m.world_id,
            sender_user_id: m.sender_user_id,
            sender_username: m.sender ? m.sender.username : 'Unknown',
            recipient_user_id: m.recipient_user_id,
            recipient_username: m.recipient ? m.recipient.username : 'Unknown',
            message: m.message,
            is_read: m.is_read,
            created_at: m.created_at
        }));

        await database.collection('direct_messages').updateMany(
            { world_id: worldId, sender_user_id: withUserId, recipient_user_id: userId, is_read: false },
            { $set: { is_read: true } }
        );

        res.json({ messages: rows.reverse() });
    } catch (error) {
        console.error('Get direct messages error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const postDirectMessage = async (req, res) => {
    try {
        const userId = req.user.id;
        const username = req.user.username;
        const worldId = Number(req.body.worldId);
        const recipientUserId = Number(req.body.recipientUserId);
        const message = String(req.body.message || '').trim();

        if (!Number.isInteger(worldId) || !Number.isInteger(recipientUserId)) {
            return res.status(400).json({ error: 'worldId and recipientUserId are required' });
        }

        if (recipientUserId === userId) {
            return res.status(400).json({ error: 'Cannot send a direct message to yourself' });
        }

        if (!message) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }

        if (message.length > 500) {
            return res.status(400).json({ error: 'Message cannot exceed 500 characters' });
        }

        const myMembership = await resolveMembership(userId, worldId);
        if (!myMembership) {
            return res.status(403).json({ error: 'You are not part of this world' });
        }

        const recipientMembership = await resolveMembership(recipientUserId, worldId);
        if (!recipientMembership) {
            return res.status(404).json({ error: 'Recipient is not in this world' });
        }

        const database = db.getDb();
        const newId = await db.getNextId('direct_messages');
        const now = new Date().toISOString();

        await database.collection('direct_messages').insertOne({
            id: newId,
            world_id: worldId,
            sender_user_id: userId,
            recipient_user_id: recipientUserId,
            message: message,
            is_read: false,
            created_at: now
        });

        const payload = {
            id: newId,
            world_id: worldId,
            sender_user_id: userId,
            sender_username: username,
            recipient_user_id: recipientUserId,
            message,
            is_read: false,
            created_at: now
        };

        wsHandler.broadcastToWorld(worldId, {
            type: 'chat_direct_message',
            message: payload
        });

        res.status(201).json({ message: payload });
    } catch (error) {
        console.error('Post direct message error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    listWorldUsers,
    getWorldMessages,
    postWorldMessage,
    getDirectMessages,
    postDirectMessage
};
