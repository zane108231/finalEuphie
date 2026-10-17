/**
 * Per-guild data store for euphire
 * Stores: player message, loop/autoplay/volume settings
 */
class GuildData {
    constructor() {
        this.playerMessageId = null;
        this.playerChannelId = null;
        this.autoplay = false;
        this.loop = "none"; // "none" | "track" | "queue"
        this.volume = 75;
        this.shuffle = false;
        this.previousTracks = [];
        this.suggestions = [];
        this.twentyFourSeven = false;
        this.queuePages = new Map(); // per-user queue page state
        this.updateInterval = null; // 30s musicard auto-update timer
        this.idleTimeout = null; // 3min disconnect timeout
        this.voiceStateTimeout = null; // voice channel monitoring timeout
        this.wasPaused = false; // track if music was paused due to empty channel
        this.recreatingPlayer = false; // skip disconnect cleanup while replacing a stale node player
        this.cannotSendPlayer = false;
        this.djOwnerId = null;
        this.musicAllowEveryone = new Set();
        this.musicAllows = {};
        this.queueEndTime = null; // timestamp when queue ended
        this.lastProgress = null; // last musicard progress percentage (optimization)
        this.currentSessionId = null; // active statistics session ID
    }
}

function clearUpdateInterval(guildData) {
    if (guildData.updateInterval) {
        clearInterval(guildData.updateInterval);
        guildData.updateInterval = null;
    }
}

const guildStore = new Map();

function getGuildData(guildId) {
    if (!guildStore.has(guildId)) {
        guildStore.set(guildId, new GuildData());
    }
    return guildStore.get(guildId);
}

function deleteGuildData(guildId) {
    const guildData = guildStore.get(guildId);
    if (guildData) {
        // Clear all intervals to prevent memory leaks
        clearUpdateInterval(guildData);
        if (guildData.idleTimeout) {
            clearTimeout(guildData.idleTimeout);
            guildData.idleTimeout = null;
        }
        if (guildData.voiceStateTimeout) {
            clearTimeout(guildData.voiceStateTimeout);
            guildData.voiceStateTimeout = null;
        }
        // Clear large objects
        guildData.queuePages.clear();
        guildData.previousTracks = [];
        guildData.suggestions = [];
    }
    guildStore.delete(guildId);
}

module.exports = { getGuildData, deleteGuildData, clearUpdateInterval, GuildData };
