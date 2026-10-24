const { getDB, isDBConnected } = require('./database');

const guildStore = new Map();

/**
 * Create default guild data structure
 */
function createDefaultGuildData() {
    return {
        playerMessageId: null,
        playerChannelId: null,
        autoplay: false,
        loop: "none",
        volume: 75,
        shuffle: false,
        previousTracks: [],
        suggestions: [],
        twentyFourSeven: false,
        queuePages: {},
        updateInterval: null,
        idleTimeout: null,
        voiceStateTimeout: null,
        wasPaused: false,
        recreatingPlayer: false,
        cannotSendPlayer: false,
        djOwnerId: null,
        musicAllowEveryone: new Set(),
        musicAllows: {},
        sessionPermissions: {
            allows: {},
            denies: {},
            allowEveryone: [],
            denyEveryone: []
        },
        serverPermissions: {
            allows: {},
            denies: {},
            allowEveryone: [],
            denyEveryone: []
        },
        queueEndTime: null,
        currentSessionId: null,
        leaveAfterQueueEnd: false,
        chatPlayChannelId: null,
        chatPlayMessageId: null,
        prefix: 'e!',
        queue: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
}

function normalizePermissions(data) {
    if (!data) return;
    if (!data.sessionPermissions || typeof data.sessionPermissions !== 'object') {
        data.sessionPermissions = { allows: {}, denies: {}, allowEveryone: [], denyEveryone: [] };
    }
    if (!data.serverPermissions || typeof data.serverPermissions !== 'object') {
        data.serverPermissions = { allows: {}, denies: {}, allowEveryone: [], denyEveryone: [] };
    }
    if (data.musicAllowEveryone) {
        if (Array.isArray(data.musicAllowEveryone)) {
            data.musicAllowEveryone = new Set(data.musicAllowEveryone);
        } else if (!(data.musicAllowEveryone instanceof Set)) {
            data.musicAllowEveryone = new Set();
        }
    } else {
        data.musicAllowEveryone = new Set();
    }
    if (data.musicAllows && typeof data.musicAllows === 'object') {
        for (const action in data.musicAllows) {
            if (data.musicAllows[action]) {
                if (Array.isArray(data.musicAllows[action])) {
                    data.musicAllows[action] = new Set(data.musicAllows[action]);
                } else if (!(data.musicAllows[action] instanceof Set)) {
                    data.musicAllows[action] = new Set();
                }
            } else {
                data.musicAllows[action] = new Set();
            }
        }
    } else {
        data.musicAllows = {};
    }
}

/**
 * Get guild data (synchronous with in-memory cache, synced with MongoDB)
 */
function getGuildData(guildId) {
    if (!guildId) return createDefaultGuildData();

    if (!guildStore.has(guildId)) {
        const defaultData = createDefaultGuildData();
        defaultData.guildId = guildId;
        guildStore.set(guildId, defaultData);

        // Load asynchronously from MongoDB in background
        if (isDBConnected()) {
            (async () => {
                try {
                    const db = getDB();
                    const doc = await db.collection('guildData').findOne({ guildId });
                    if (doc) {
                        normalizePermissions(doc);
                        const current = guildStore.get(guildId);
                        if (current) {
                            // Preserve active in-memory timers and state
                            const timers = {
                                updateInterval: current.updateInterval,
                                idleTimeout: current.idleTimeout,
                                voiceStateTimeout: current.voiceStateTimeout,
                                currentSessionId: current.currentSessionId || doc.currentSessionId,
                            };
                            Object.assign(current, doc, timers);
                        }
                    }
                } catch (err) {
                    console.warn(`[euphire] Background load of guildData failed for ${guildId}:`, err.message);
                }
            })();
        }
    }

    const data = guildStore.get(guildId);
    normalizePermissions(data);
    return data;
}

/**
 * Save guild data to in-memory store and MongoDB
 */
async function saveGuildData(guildId, data) {
    if (!guildId || !data) return;

    guildStore.set(guildId, data);
    data.updatedAt = Date.now();

    if (!isDBConnected()) {
        return;
    }

    try {
        const db = getDB();
        const dataToSave = { ...data };

        // Do not serialize active timer handles to MongoDB
        delete dataToSave.updateInterval;
        delete dataToSave.idleTimeout;
        delete dataToSave.voiceStateTimeout;

        // Convert Sets to arrays for MongoDB storage
        if (dataToSave.musicAllowEveryone instanceof Set) {
            dataToSave.musicAllowEveryone = Array.from(dataToSave.musicAllowEveryone);
        }
        if (dataToSave.musicAllows && typeof dataToSave.musicAllows === 'object') {
            const allows = {};
            for (const action in dataToSave.musicAllows) {
                if (dataToSave.musicAllows[action] instanceof Set) {
                    allows[action] = Array.from(dataToSave.musicAllows[action]);
                } else {
                    allows[action] = dataToSave.musicAllows[action];
                }
            }
            dataToSave.musicAllows = allows;
        }

        await db.collection('guildData').updateOne(
            { guildId },
            { $set: dataToSave },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[euphire] saveGuildData error for ${guildId}:`, err.message);
    }
}

/**
 * Clear update interval from guild data
 */
function clearUpdateInterval(guildData) {
    if (guildData?.updateInterval) {
        clearInterval(guildData.updateInterval);
        guildData.updateInterval = null;
    }
}

/**
 * Delete guild data
 */
async function deleteGuildData(guildId) {
    const guildData = guildStore.get(guildId);
    if (guildData) {
        clearUpdateInterval(guildData);
        if (guildData.idleTimeout) {
            clearTimeout(guildData.idleTimeout);
            guildData.idleTimeout = null;
        }
        if (guildData.voiceStateTimeout) {
            clearTimeout(guildData.voiceStateTimeout);
            guildData.voiceStateTimeout = null;
        }
    }
    guildStore.delete(guildId);

    if (isDBConnected()) {
        try {
            const db = getDB();
            await db.collection('guildData').deleteOne({ guildId });
        } catch (err) {
            console.error(`[euphire] deleteGuildData error for ${guildId}:`, err.message);
        }
    }
}

module.exports = {
    getGuildData,
    saveGuildData,
    deleteGuildData,
    clearUpdateInterval,
    createDefaultGuildData,
};
