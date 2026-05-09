const db = require('../config/database');
const { getAchievementByCode, getAchievementsByMetricKey } = require('../data/achievements.data');

const toNumber = (value) => Number(value || 0);

const getAchievementProgress = async (session, userId, metricKey) => {
    const database = db.getDb();
    const doc = await database.collection('user_achievement_progress').findOne(
        { user_id: userId, metric_key: metricKey },
        { session }
    );
    return toNumber(doc?.metric_value || 0);
};

const incrementAchievementProgress = async (session, userId, metricKey, delta) => {
    const database = db.getDb();
    const normalizedDelta = toNumber(delta);

    await database.collection('user_achievement_progress').updateOne(
        { user_id: userId, metric_key: metricKey },
        { 
            $inc: { metric_value: normalizedDelta },
            $set: { updated_at: new Date().toISOString() }
        },
        { upsert: true, session }
    );

    return getAchievementProgress(session, userId, metricKey);
};

const setAchievementProgressMax = async (session, userId, metricKey, value) => {
    const database = db.getDb();
    const normalizedValue = toNumber(value);

    await database.collection('user_achievement_progress').updateOne(
        { user_id: userId, metric_key: metricKey },
        { 
            $max: { metric_value: normalizedValue },
            $set: { updated_at: new Date().toISOString() }
        },
        { upsert: true, session }
    );

    return getAchievementProgress(session, userId, metricKey);
};

const unlockAchievementByCode = async (session, {
    userId,
    worldId,
    achievementCode,
    unlockedValue,
    username
}) => {
    const database = db.getDb();
    const definition = getAchievementByCode(achievementCode);
    if (!definition) {
        return null;
    }

    const existing = await database.collection('user_achievements').findOne(
        { user_id: userId, achievement_code: definition.code },
        { session }
    );

    if (existing) {
        return null;
    }

    const achievementId = await db.getNextId('user_achievements', session);
    await database.collection('user_achievements').insertOne(
        {
            id: achievementId,
            user_id: userId,
            achievement_code: definition.code,
            achievement_title: definition.title,
            tier: definition.tier,
            threshold_value: definition.threshold,
            unlocked_world_id: worldId || null,
            unlocked_value: unlockedValue == null ? null : toNumber(unlockedValue),
            created_at: new Date().toISOString()
        },
        { session }
    );

    return {
        type: 'achievement',
        worldId: worldId || null,
        userId,
        username,
        achievementCode: definition.code,
        achievementTitle: definition.title,
        title: definition.title,
        description: definition.description,
        tier: definition.tier,
        threshold: definition.threshold,
        unlockedValue: unlockedValue == null ? null : toNumber(unlockedValue),
        severity: 'major'
    };
};

const unlockThresholdAchievementsForMetric = async (session, {
    userId,
    worldId,
    metricKey,
    metricValue,
    username
}) => {
    const unlockedNotifications = [];
    const value = toNumber(metricValue);

    const targets = getAchievementsByMetricKey(metricKey)
        .filter((achievement) => value >= toNumber(achievement.threshold));

    for (const achievement of targets) {
        const notification = await unlockAchievementByCode(session, {
            userId,
            worldId,
            achievementCode: achievement.code,
            unlockedValue: value,
            username
        });

        if (notification) {
            unlockedNotifications.push(notification);
        }
    }

    return unlockedNotifications;
};

module.exports = {
    getAchievementProgress,
    incrementAchievementProgress,
    setAchievementProgressMax,
    unlockAchievementByCode,
    unlockThresholdAchievementsForMetric
};
