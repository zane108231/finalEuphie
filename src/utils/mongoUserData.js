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
        profileVisibility: 'public', // 'public' | 'private'
        profilePrivacy: {
            servers: true,
            friends: true,
            tracks: true,
        },
        avatarShape: 'circle', // 'circle' | 'square'
        avatarBorder: null, // hex string, 'none', or null (default)
        avatarBackground: null, // hex string or null
        serverVisibility: {}, // guildId -> 'public' | 'private'
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

/**
 * Save user custom background to MongoDB
 */
async function saveUserBackground(userId, imageBuffer, contentType = 'image/png') {
    if (!userId || !imageBuffer) return;
    const base64 = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : imageBuffer;
    
    if (!isDBConnected()) {
        if (!global.fallbackBgStore) global.fallbackBgStore = new Map();
        global.fallbackBgStore.set(userId, { base64, contentType, updatedAt: Date.now() });
        return;
    }

    const db = getDB();
    await db.collection('userBackgrounds').updateOne(
        { userId },
        { 
            $set: { 
                userId, 
                imageBase64: base64, 
                contentType, 
                updatedAt: Date.now() 
            } 
        },
        { upsert: true }
    );
    console.log(`[euphire] Saved custom background to MongoDB for user ${userId}`);
}

/**
 * Get user custom background from MongoDB
 */
async function getUserBackground(userId) {
    if (!userId) return null;
    
    if (!isDBConnected()) {
        if (global.fallbackBgStore && global.fallbackBgStore.has(userId)) {
            const entry = global.fallbackBgStore.get(userId);
            return Buffer.from(entry.base64, 'base64');
        }
        return null;
    }

    const db = getDB();
    const doc = await db.collection('userBackgrounds').findOne({ userId });
    if (!doc || !doc.imageBase64) return null;
    return Buffer.from(doc.imageBase64, 'base64');
}

/**
 * Delete user custom background from MongoDB
 */
async function deleteUserBackground(userId) {
    if (!userId) return;
    
    if (!isDBConnected()) {
        if (global.fallbackBgStore) {
            global.fallbackBgStore.delete(userId);
        }
        return;
    }

    const db = getDB();
    await db.collection('userBackgrounds').deleteOne({ userId });
    console.log(`[euphire] Deleted custom background from MongoDB for user ${userId}`);
}

module.exports = {
    getUserData,
    saveUserData,
    deleteUserData,
    saveUserBackground,
    getUserBackground,
    deleteUserBackground
};
