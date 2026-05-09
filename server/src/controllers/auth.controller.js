const db = require('../config/database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { ACHIEVEMENTS } = require('../data/achievements.data');

const register = async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email and password are required' });
        }

        const database = db.getDb();
        
        // Check if user exists
        const existing = await database.collection('users').find({
            $or: [{ username }, { email }]
        }).toArray();

        if (existing.length > 0) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newId = await db.getNextId('users');

        await database.collection('users').insertOne({
            id: newId,
            username,
            email,
            password_hash: hashedPassword,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });

        res.status(201).json({ message: 'User registered successfully', userId: newId });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const login = async (req, res) => {
    try {
        const { email, password, identifier } = req.body;
        const loginIdentifier = (identifier || email || '').trim();

        if (!loginIdentifier || !password) {
            return res.status(400).json({ error: 'Username/email and password are required' });
        }

        const database = db.getDb();
        const user = await database.collection('users').findOne({
            $or: [{ email: loginIdentifier }, { username: loginIdentifier }]
        });

        if (user?.is_bot) {
            return res.status(403).json({ error: 'Bot accounts cannot sign in' });
        }

        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'Invalid username/email or password' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username },
            process.env.JWT_SECRET || 'super_secret_jwt_key_here',
            { expiresIn: '24h' }
        );

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                current_world_id: user.current_world_id,
                is_bot: Boolean(user.is_bot)
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const getMe = async (req, res) => {
    try {
        const database = db.getDb();
        const user = await database.collection('users').findOne({ id: Number(req.user.id) });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ 
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                current_world_id: user.current_world_id,
                is_bot: user.is_bot,
                created_at: user.created_at
            }
        });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const getMyAchievements = async (req, res) => {
    try {
        const database = db.getDb();
        
        const unlockedRows = await database.collection('user_achievements')
            .find({ user_id: Number(req.user.id) })
            .sort({ unlocked_at: -1 })
            .toArray();

        const progressRows = await database.collection('user_achievement_progress')
            .find({ user_id: Number(req.user.id) })
            .toArray();

        const unlockedByCode = new Map(unlockedRows.map((entry) => [entry.achievement_code, entry]));
        const progressByMetric = new Map(progressRows.map((entry) => [entry.metric_key, Number(entry.metric_value || 0)]));

        const achievements = ACHIEVEMENTS.map((definition) => {
            const unlocked = unlockedByCode.get(definition.code);
            const progress = Number(progressByMetric.get(definition.metricKey) || 0);

            return {
                code: definition.code,
                title: definition.title,
                description: definition.description,
                tier: definition.tier,
                category: definition.category,
                metric_key: definition.metricKey,
                threshold: definition.threshold,
                progress,
                progress_ratio: definition.threshold > 0 ? Math.min(1, progress / Number(definition.threshold)) : 1,
                unlocked: Boolean(unlocked),
                unlocked_at: unlocked?.unlocked_at || null,
                unlocked_world_id: unlocked?.unlocked_world_id || null,
                unlocked_value: unlocked?.unlocked_value || null
            };
        });

        res.json({
            achievements,
            unlockedCount: unlockedRows.length,
            totalCount: ACHIEVEMENTS.length
        });
    } catch (error) {
        console.error('Get achievements error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    register,
    login,
    getMe,
    getMyAchievements
};
