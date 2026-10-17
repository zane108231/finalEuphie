const { getDB, isDBConnected } = require('./database');

/**
 * Get user data from MongoDB
 */
async function getUserData(userId) {
    if (!isDBConnected()) {
        // Fallback to in-memory if MongoDB not connected
        if (!global.fallbackUserStore) {
            global.fallbackUserStore = new Map();
        }
        if (!global.fallbackUserStore.has(userId)) {
            global.fallbackUserStore.set(userId, createDefaultUserData());
        }
        return global.fallbackUserStore.get(userId);
    }

    const db = getDB();
    let data = await db.collection('userData').findOne({ userId });

    if (!data) {
        data = createDefaultUserData();
        data.userId = userId;
        await db.collection('userData').updateOne(
            { userId },
            { $set: data },
            { upsert: true }
        );
    }

    return data;
}

/**
 * Save user data to MongoDB
 */
async function saveUserData(userId, data) {
    if (!isDBConnected()) {
        if (global.fallbackUserStore) {
            global.fallbackUserStore.set(userId, data);
        }
        return;
    }

    const db = getDB();
    data.updatedAt = Date.now();

    // Convert Sets to arrays for MongoDB
    const saveData = { ...data };
    if (saveData.musicAllowEveryone instanceof Set) {
        saveData.musicAllowEveryone = Array.from(saveData.musicAllowEveryone);
    }
    if (saveData.musicAllows && typeof saveData.musicAllows === 'object') {
        saveData.musicAllows = {};
        for (const [key, value] of Object.entries(data.musicAllows)) {
            if (value instanceof Set) {
                saveData.musicAllows[key] = Array.from(value);
            } else {
                saveData.musicAllows[key] = value;
            }
        }
    }

    await db.collection('userData').updateOne(
        { userId },
        { $set: saveData },
        { upsert: true }
    );
}

/**
 * Create default user data structure
 */
function createDefaultUserData() {
    return {
        userId: null,
        lastfmSessionKey: null,
        lastfmUsername: null,
        lastfmToken: null,
        lastfmTokenTimestamp: null,
        profileBackground: 'default',
        profileColor: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
}

/**
 * Delete user data
 */
async function deleteUserData(userId) {
    if (!isDBConnected()) {
        if (global.fallbackUserStore) {
            global.fallbackUserStore.delete(userId);
        }
        return;
    }

    const db = getDB();
    await db.collection('userData').deleteOne({ userId });
}

module.exports = {
    getUserData,
    saveUserData,
    deleteUserData
};
