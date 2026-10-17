const { getDB, isDBConnected } = require('./database');

/**
 * MongoDB-based bot coordinator
 * Stores session ownership, DJ assignments, and bot status in MongoDB
 */
class MongoCoordinator {
    constructor() {
        this.botPriority = [];
        this.primaryBotId = null;
        this.clients = new Map(); // botId -> client
        this.riffyInstances = new Map(); // botId -> riffy
        this.botConfigs = [];
        
        // In-memory cache for fast lookups (synced with MongoDB)
        this.sessionOwners = new Map(); // voiceChannelId -> botId
        this.sessionDJs = new Map(); // voiceChannelId -> userId
        this.sessionChannels = new Map(); // voiceChannelId -> textChannelId
        this.botSessions = new Map(); // botId -> Set<voiceChannelId>
        this.botStatus = new Map(); // botId -> status
    }

    /**
     * Initialize the coordinator with bot configurations
     */
    async initialize(botConfigs, clientCreator, riffyAccessor) {
        this.botConfigs = botConfigs;
        
        // Sort by isPrimary flag, then by order in config
        const sorted = [...botConfigs].sort((a, b) => {
            if (a.isPrimary && !b.isPrimary) return -1;
            if (!a.isPrimary && b.isPrimary) return 1;
            return 0;
        });
        
        // Initialize all bots as available
        for (const config of sorted) {
            this.botPriority.push(config.id);
            this.botStatus.set(config.id, 'available');
            this.botSessions.set(config.id, new Set());
            
            if (config.isPrimary) {
                this.primaryBotId = config.id;
            }
            
            // Create client and riffy instance
            const client = clientCreator(config.token, config.id);
            const riffy = riffyAccessor(client);
            
            this.clients.set(config.id, client);
            this.riffyInstances.set(config.id, riffy);
        }
        
        // Load existing sessions from MongoDB
        if (isDBConnected()) {
            await this.loadSessionsFromDB();
        }

        // Start periodic check for orphaned bots (in non-existent channels)
        this.startOrphanedBotCheck();

        console.log(`[euphire] Bot coordinator initialized with ${this.botPriority.length} bots`);
        console.log(`[euphire] Primary bot: ${this.primaryBotId}`);
        console.log(`[euphire] Bot priority order: ${this.botPriority.join(' -> ')}`);
    }

    /**
     * Load existing sessions from MongoDB on startup
     */
    async loadSessionsFromDB() {
        if (!isDBConnected()) return;
        
        const db = getDB();
        const sessions = await db.collection('sessions').find({}).toArray();
        
        for (const session of sessions) {
            this.sessionOwners.set(session.voiceChannelId, session.botId);
            if (session.userId) {
                this.sessionDJs.set(session.voiceChannelId, String(session.userId));
            }
            if (session.channelId) {
                this.sessionChannels.set(session.voiceChannelId, String(session.channelId));
            }
            
            if (!this.botSessions.has(session.botId)) {
                this.botSessions.set(session.botId, new Set());
            }
            this.botSessions.get(session.botId).add(session.voiceChannelId);
        }
        
        console.log(`[euphire] Loaded ${sessions.length} sessions from MongoDB`);
    }

    /**
     * Save session to MongoDB
     */
    async saveSessionToDB(voiceChannelId, botId, guildId, userId = null, channelId = null) {
        if (!isDBConnected()) return;
        
        const db = getDB();
        const updateDoc = {
            voiceChannelId,
            botId,
            updatedAt: Date.now()
        };
        if (guildId) updateDoc.guildId = guildId;
        if (userId) updateDoc.userId = String(userId);
        if (channelId) updateDoc.channelId = String(channelId);

        await db.collection('sessions').updateOne(
            { voiceChannelId },
            { $set: updateDoc },
            { upsert: true }
        );
    }

    /**
     * Delete session from MongoDB
     */
    async deleteSessionFromDB(voiceChannelId) {
        if (!isDBConnected()) return;
        
        const db = getDB();
        await db.collection('sessions').deleteOne({ voiceChannelId });
    }

    setSessionDJ(voiceChannelId, userId) {
        if (!voiceChannelId || !userId) return;
        this.sessionDJs.set(voiceChannelId, String(userId));
    }

    getSessionDJ(voiceChannelId) {
        if (!voiceChannelId) return null;
        return this.sessionDJs.get(voiceChannelId) || null;
    }

    setSessionChannel(voiceChannelId, channelId) {
        if (!voiceChannelId || !channelId) return;
        this.sessionChannels.set(voiceChannelId, String(channelId));
    }

    getSessionChannel(voiceChannelId) {
        if (!voiceChannelId) return null;
        return this.sessionChannels.get(voiceChannelId) || null;
    }

    /**
     * Reserve a bot for a voice channel
     */
    async reserveBot(voiceChannelId, userId, guildId) {
        // Find first available bot in priority order
        for (const botId of this.botPriority) {
            if (this.isBotAvailable(botId)) {
                return await this.reserveSpecificBot(voiceChannelId, userId, botId, guildId);
            }
        }
        return false;
    }

    /**
     * Reserve a specific bot for a voice channel
     */
    async reserveSpecificBot(voiceChannelId, userId, botId, guildId, force = false) {
        // Prevent reserving any bot that is already occupied in a DIFFERENT voice channel
        const currentVc = this.getBotVoiceChannel(botId);
        if (currentVc && currentVc !== voiceChannelId) {
            console.log(`[euphire] Cannot reserve bot ${botId} for VC ${voiceChannelId} - already occupied in VC ${currentVc}`);
            return false;
        }

        if (!force && !this.isBotAvailable(botId)) {
            return false;
        }
        
        // Update in-memory maps
        this.sessionOwners.set(voiceChannelId, botId);
        if (userId) {
            this.sessionDJs.set(voiceChannelId, String(userId));
        }
        if (!this.botSessions.has(botId)) {
            this.botSessions.set(botId, new Set());
        }
        this.botSessions.get(botId).add(voiceChannelId);

        // Update status
        this.markBotReserved(botId);

        // Save to MongoDB
        await this.saveSessionToDB(voiceChannelId, botId, guildId, userId);

        return true;
    }

    /**
     * Release a bot from a voice channel
     */
    async releaseBot(voiceChannelId) {
        const botId = this.sessionOwners.get(voiceChannelId);
        if (!botId) return;

        console.log(`[euphire] Releasing bot ${botId} from voice channel ${voiceChannelId}`);

        // Update in-memory maps
        this.sessionOwners.delete(voiceChannelId);
        this.sessionDJs.delete(voiceChannelId);
        this.sessionChannels.delete(voiceChannelId);
        if (this.botSessions.has(botId)) {
            this.botSessions.get(botId).delete(voiceChannelId);
        }

        // Mark bot as available if no more sessions
        if (!this.botSessions.has(botId) || this.botSessions.get(botId).size === 0) {
            this.markBotAvailable(botId);
            console.log(`[euphire] Bot ${botId} marked as available (no more sessions)`);
        }

        // Delete from MongoDB
        await this.deleteSessionFromDB(voiceChannelId);

        console.log(`[euphire] Released bot ${botId} from voice channel ${voiceChannelId}`);
    }

    /**
     * Get the session owner for a voice channel
     */
    getSessionOwner(voiceChannelId) {
        return this.sessionOwners.get(voiceChannelId);
    }

    /**
     * Resolve session owner for a voice channel, with fallback to active bot voice states and players.
     */
     resolveSessionOwner(voiceChannelId, guild = null) {
        if (!voiceChannelId) return null;
        let owner = this.sessionOwners.get(voiceChannelId);
        if (owner) {
            const client = this.getClient(owner);
            if (client && client.user) {
                const targetGuild = (guild && client.guilds?.cache?.get(guild.id)) ||
                    client.channels?.cache?.get(voiceChannelId)?.guild ||
                    client.guilds?.cache?.find(g => g.channels.cache.has(voiceChannelId));
                const myMember = targetGuild?.members?.cache?.get(client.user.id) || targetGuild?.members?.me;
                const isVoiceConnected = myMember?.voice?.channelId === voiceChannelId;
                const riffyPlayer = client.riffy?.players?.get(targetGuild?.id);
                const hasRiffyVoice = riffyPlayer && riffyPlayer.voiceChannel === voiceChannelId;

                if (isVoiceConnected || hasRiffyVoice) {
                    return owner;
                }
            }
            // Stale session detected! Release and continue search
            console.log(`[euphire] Stale session owner ${owner} for VC ${voiceChannelId}, clearing`);
            this.releaseBot(voiceChannelId);
            owner = null;
        }

        // Check if any bot client is physically connected to this voice channel
        for (const client of this.getAllClients()) {
            if (!client.user) continue;

            let isConnected = false;

            // 1. Check voice channel members if cached
            const vc = client.channels?.cache?.get(voiceChannelId);
            if (vc?.members?.has(client.user.id)) {
                isConnected = true;
            }

            // 2. Check guild member me voice state
            if (!isConnected) {
                const targetGuild = (guild && client.guilds?.cache?.get(guild.id)) ||
                    (vc?.guild) ||
                    client.guilds?.cache?.find(g => g.channels.cache.has(voiceChannelId));
                const myMember = targetGuild?.members?.cache?.get(client.user.id) || targetGuild?.members?.me;
                if (myMember?.voice?.channelId === voiceChannelId) {
                    isConnected = true;
                }
            }

            // 3. Check riffy player
            if (!isConnected && client.riffy?.players) {
                for (const [, p] of client.riffy.players) {
                    if (p && p.voiceChannel === voiceChannelId) {
                        isConnected = true;
                        break;
                    }
                }
            }

            if (isConnected) {
                owner = client.botId;
                this.sessionOwners.set(voiceChannelId, owner);
                if (!this.botSessions.has(owner)) {
                    this.botSessions.set(owner, new Set());
                }
                this.botSessions.get(owner).add(voiceChannelId);
                this.botStatus.set(owner, 'active');
                if (guild?.id) {
                    this.saveSessionToDB(voiceChannelId, owner, guild.id).catch(() => {});
                }
                return owner;
            }
        }

        return null;
    }

    /**
     * Get the client for a bot
     */
    getClient(botId) {
        return this.clients.get(botId);
    }

    /**
     * Get the riffy instance for a bot
     */
    getRiffy(botId) {
        return this.riffyInstances.get(botId);
    }

    /**
     * Get the voice channel ID a bot is currently connected to (if any)
     */
    getBotVoiceChannel(botId) {
        const client = this.getClient(botId);
        if (!client || !client.user) return null;

        // 1. Check Discord voice states across all guilds (always kept fresh by Gateway)
        if (client.guilds?.cache) {
            for (const [, guild] of client.guilds.cache) {
                const vs = guild.voiceStates?.cache?.get(client.user.id);
                if (vs?.channelId) return vs.channelId;

                const me = guild.members?.cache?.get(client.user.id) || guild.members?.me;
                if (me?.voice?.channelId) return me.voice.channelId;
            }
        }

        // 2. Check coordinator recorded sessions
        const sessions = this.botSessions.get(botId);
        if (sessions && sessions.size > 0) {
            for (const vcId of sessions) {
                return vcId;
            }
        }
        for (const [vcId, ownerId] of this.sessionOwners.entries()) {
            if (ownerId === botId) {
                return vcId;
            }
        }

        // 3. Check riffy players
        if (client.riffy?.players) {
            for (const [, p] of client.riffy.players) {
                if (p && p.voiceChannel) {
                    return p.voiceChannel;
                }
            }
        }

        return null;
    }

    /**
     * Check if a bot is available (must have status 'available' AND not be in any voice channel)
     */
    isBotAvailable(botId) {
        if (this.botStatus.get(botId) !== 'available') {
            return false;
        }

        // If bot is in ANY voice channel, it is NEVER available to be allocated elsewhere
        const currentVc = this.getBotVoiceChannel(botId);
        if (currentVc) {
            return false;
        }

        return true;
    }

    /**
     * Check if any bot is available in a guild
     */
    hasAnyAvailableBot(guildId = null) {
        for (const botId of this.botPriority) {
            if (this.isBotAvailable(botId)) {
                if (guildId) {
                    const client = this.getClient(botId);
                    if (client && client.guilds.cache.has(guildId)) {
                        return true;
                    }
                } else {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Get the first bot present in a guild (by priority order)
     */
    getFirstBotInGuild(guildId) {
        if (!guildId) return this.primaryBotId;
        for (const botId of this.botPriority) {
            const client = this.getClient(botId);
            if (client && client.guilds.cache.has(guildId)) {
                return botId;
            }
        }
        return this.primaryBotId;
    }

    /**
     * Get the first available bot present in a guild (by priority order)
     */
    getAvailableBotInGuild(guildId) {
        for (const botId of this.botPriority) {
            if (this.isBotAvailable(botId)) {
                if (guildId) {
                    const client = this.getClient(botId);
                    if (client && client.guilds.cache.has(guildId)) {
                        return botId;
                    }
                } else {
                    return botId;
                }
            }
        }
        return null;
    }

    /**
     * Check if a bot should handle a command.
     * Supports both (botId, guildId, voiceChannelId, isMusicCommand)
     * and legacy (botId, voiceChannelId, isMusicCommand)
     */
    shouldHandleCommand(botId, arg2, arg3, arg4) {
        let guildId = null;
        let voiceChannelId = null;
        let isMusicCommand = false;

        if (typeof arg4 === "boolean") {
            // New signature: (botId, guildId, voiceChannelId, isMusicCommand)
            guildId = arg2;
            voiceChannelId = arg3;
            isMusicCommand = arg4;
        } else {
            // Legacy signature: (botId, voiceChannelId, isMusicCommand)
            voiceChannelId = arg2;
            isMusicCommand = Boolean(arg3);
        }

        // 1. If guildId is provided, this bot MUST be in the guild to handle commands in it
        if (guildId) {
            const client = this.getClient(botId);
            if (client && !client.guilds.cache.has(guildId)) {
                return false;
            }
        }

        // 2. If user is in a voice channel with an active session, only that session owner responds
        if (voiceChannelId) {
            const guild = guildId ? this.getClient(botId)?.guilds?.cache?.get(guildId) : null;
            const sessionOwner = this.resolveSessionOwner(voiceChannelId, guild);
            if (sessionOwner) {
                return botId === sessionOwner;
            }
        }

        // 3. For music commands when user is in a voice channel:
        if (isMusicCommand && voiceChannelId) {
            const availableBotId = this.getAvailableBotInGuild(guildId);
            if (availableBotId) {
                return botId === availableBotId;
            }
            // No bot available in this guild - let the first bot present in this guild handle it to report the error
            const firstBotInGuild = this.getFirstBotInGuild(guildId);
            return botId === firstBotInGuild;
        }

        // 4. For non-music commands (e!profile, e!help, etc.) or when user is not in VC:
        // The first bot present in this guild handles it
        const firstBotInGuild = this.getFirstBotInGuild(guildId);
        return botId === firstBotInGuild;
    }

    /**
     * Mark a bot as reserved
     */
    markBotReserved(botId) {
        const oldStatus = this.botStatus.get(botId);
        this.botStatus.set(botId, 'reserved');
        // console.log(`[euphire] Bot ${botId} marked as reserved (was: ${oldStatus})`);
    }

    /**
     * Mark a bot as active
     */
    async markBotActive(botId, voiceChannelId) {
        const oldStatus = this.botStatus.get(botId);
        this.botStatus.set(botId, 'active');

        // Update session in MongoDB with active status
        if (voiceChannelId) {
            await this.saveSessionToDB(voiceChannelId, botId, null);
        }

        // console.log(`[euphire] Bot ${botId} marked as active for voice channel ${voiceChannelId} (was: ${oldStatus})`);
    }

    /**
     * Mark a bot as available
     */
    markBotAvailable(botId) {
        const currentVc = this.getBotVoiceChannel(botId);
        if (currentVc) {
            console.log(`[euphire] Cannot mark bot ${botId} as available - still in voice channel ${currentVc}`);
            return;
        }
        const oldStatus = this.botStatus.get(botId);
        this.botStatus.set(botId, 'available');
        // console.log(`[euphire] Bot ${botId} marked as available (was: ${oldStatus})`);
    }

    /**
     * Mark a bot as disconnected
     */
    markBotDisconnected(botId) {
        const oldStatus = this.botStatus.get(botId);
        this.botStatus.set(botId, 'disconnected');
        // console.log(`[euphire] Bot ${botId} marked as disconnected (was: ${oldStatus})`);
        
        // Release all sessions for this bot
        const sessions = this.botSessions.get(botId);
        if (sessions) {
            for (const voiceChannelId of sessions) {
                this.releaseBot(voiceChannelId);
            }
        }
    }

    /**
     * Mark a bot as reconnected
     */
    markBotReconnected(botId) {
        const currentVc = this.getBotVoiceChannel(botId);
        if (!currentVc) {
            this.botStatus.set(botId, 'available');
        } else {
            this.botStatus.set(botId, 'active');
        }
        // console.log(`[euphire] Bot ${botId} marked as reconnected`);
    }

    /**
     * Reset all bots to available state (only if not currently in voice)
     */
    resetAllBotsToAvailable() {
        for (const botId of this.botPriority) {
            const currentVc = this.getBotVoiceChannel(botId);
            if (!currentVc) {
                this.botStatus.set(botId, 'available');
                console.log(`[euphire] Force reset bot ${botId} to available`);
            } else {
                this.botStatus.set(botId, 'active');
                console.log(`[euphire] Bot ${botId} is in voice channel ${currentVc}, keeping active`);
            }
        }
    }

    /**
     * Get all clients (for monitoring/status)
     */
    getAllClients() {
        return Array.from(this.clients.values());
    }

    /**
     * Start periodic check for orphaned bots (in non-existent channels or disconnected)
     */
    startOrphanedBotCheck() {
        setInterval(async () => {
            for (const [voiceChannelId, botId] of this.sessionOwners.entries()) {
                const client = this.getClient(botId);
                if (client && client.isReady()) {
                    let inVoice = false;
                    for (const [, g] of client.guilds.cache) {
                        const me = g.members?.cache?.get(client.user.id) || g.members?.me;
                        if (me?.voice?.channelId === voiceChannelId) {
                            inVoice = true;
                            break;
                        }
                    }
                    if (!inVoice) {
                        const player = client.riffy?.players?.get(client.channels?.cache?.get(voiceChannelId)?.guild?.id);
                        if (player && player.voiceChannel === voiceChannelId) {
                            inVoice = true;
                        }
                    }
                    if (!inVoice) {
                        console.log(`[euphire] Orphaned session detected: bot ${botId} not in VC ${voiceChannelId}, releasing`);
                        await this.releaseBot(voiceChannelId);
                    }
                }
            }
        }, 30000); // Check every 30 seconds
    }
}

module.exports = new MongoCoordinator();
