/**
 * Bot Coordinator for Multi-Bot Music System
 * 
 * Manages:
 * - 4 Discord bot clients (Euphie, Euphie (1), Euphie (2), Euphie (3))
 * - Session ownership (voice channel -> bot ID mapping)
 * - DJ ownership (user ID -> bot ID mapping) - ONE BOT = ONE DJ
 * - Bot availability and reservation system
 * - Atomic allocation to prevent race conditions
 * - Bot priority ordering
 */

class BotCoordinator {
    constructor() {
        // Map of bot ID to Discord client
        this.clients = new Map();
        
        // Map of bot ID to Riffy instance
        this.riffyInstances = new Map();
        
        // Map of voice channel ID to bot ID (session ownership)
        this.sessionOwners = new Map();
        
        // Map of bot ID to Set of voice channel IDs (sessions owned by bot)
        this.botSessions = new Map();
        
        // Map of user ID to bot ID (DJ ownership - one bot = one DJ)
        this.djOwners = new Map();
        
        // Map of bot ID to user ID (reverse DJ mapping)
        this.botDjs = new Map();
        
        // Bot availability status: 'available', 'reserved', 'active', 'disconnected'
        this.botStatus = new Map();
        
        // Bot priority order (lower index = higher priority)
        this.botPriority = [];
        
        // Primary bot ID (handles general commands)
        this.primaryBotId = null;
        
        // Reservation lock for atomic allocation
        this.allocationLock = false;
    }

    /**
     * Initialize the coordinator with bot clients
     * @param {Array} botConfigs - Array of { id, token, name, isPrimary }
     * @param {Function} createClientFn - Function to create Discord client (token, botId) => client
     * @param {Function} createRiffyFn - Function to create Riffy instance
     */
    initialize(botConfigs, createClientFn, createRiffyFn) {
        // Sort by priority: primary bot first, then secondary bots in order
        const sortedConfigs = [...botConfigs].sort((a, b) => {
            if (a.isPrimary && !b.isPrimary) return -1;
            if (!a.isPrimary && b.isPrimary) return 1;
            return 0;
        });

        sortedConfigs.forEach((config, index) => {
            const client = createClientFn(config.token, config.id);
            const riffy = createRiffyFn(client);
            
            this.clients.set(config.id, client);
            this.riffyInstances.set(config.id, riffy);
            this.botStatus.set(config.id, 'available');
            this.botSessions.set(config.id, new Set());
            this.botPriority.push(config.id);
            
            if (config.isPrimary) {
                this.primaryBotId = config.id;
            }
            
            console.log(`[euphire] Bot initialized: ${config.name} (ID: ${config.id})`);
        });

        console.log(`[euphire] Bot coordinator initialized with ${this.clients.size} bots`);
        console.log(`[euphire] Primary bot: ${this.primaryBotId}`);
        console.log(`[euphire] Bot priority order: ${this.botPriority.map(id => this.getClient(id)?.user?.tag || id).join(' -> ')}`);
    }

    /**
     * Get a Discord client by bot ID
     */
    getClient(botId) {
        return this.clients.get(botId);
    }

    /**
     * Get a Riffy instance by bot ID
     */
    getRiffy(botId) {
        return this.riffyInstances.get(botId);
    }

    /**
     * Get the primary bot client
     */
    getPrimaryClient() {
        return this.getClient(this.primaryBotId);
    }

    /**
     * Get all bot clients
     */
    getAllClients() {
        return Array.from(this.clients.values());
    }

    /**
     * Get all bot IDs
     */
    getAllBotIds() {
        return Array.from(this.clients.keys());
    }

    /**
     * Check if a bot is available for new sessions
     * A bot is available if it's not 'active' (currently playing music)
     */
    isBotAvailable(botId) {
        const status = this.botStatus.get(botId);
        // Bot is available if it's 'available' or 'reserved' (but not 'active' or 'disconnected')
        return status === 'available' || status === 'reserved';
    }

    /**
     * Check if any bot is available
     * @param {string} guildId - The guild ID to check bot membership
     */
    hasAnyAvailableBot(guildId = null) {
        for (const botId of this.botPriority) {
            if (this.isBotAvailable(botId)) {
                // If guildId is provided, check if bot is in that guild
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
     * Get the bot that owns a voice channel session
     */
    getSessionOwner(voiceChannelId) {
        return this.sessionOwners.get(voiceChannelId);
    }

    /**
     * Reserve a bot for a voice channel (atomic allocation)
     * @param {string} voiceChannelId - The voice channel ID
     * @param {string} userId - The user ID who will be the DJ
     * @returns {string|null} Bot ID if successful, null if no bots available
     */
    reserveBot(voiceChannelId, userId) {
        // Wait for allocation lock to prevent race conditions
        while (this.allocationLock) {
            // Simple spinlock - in production, use proper async locking
        }
        
        this.allocationLock = true;
        
        try {
            // Check if this voice channel already has a session
            const existingOwner = this.sessionOwners.get(voiceChannelId);
            if (existingOwner) {
                // Reuse existing session - update DJ ownership if different user
                const currentDj = this.botDjs.get(existingOwner);
                if (currentDj !== userId) {
                    // Release old DJ ownership
                    if (currentDj) {
                        this.djOwners.delete(currentDj);
                    }
                    // Set new DJ ownership
                    this.djOwners.set(userId, existingOwner);
                    this.botDjs.set(existingOwner, userId);
                    console.log(`[euphire] Updated DJ ownership for bot ${existingOwner} from ${currentDj} to ${userId}`);
                }
                return existingOwner;
            }

            // Check if this user is already a DJ of another bot
            const existingBotForUser = this.djOwners.get(userId);
            if (existingBotForUser) {
                // User already owns a bot - return that bot
                console.log(`[euphire] User ${userId} already owns bot ${existingBotForUser}, reusing it`);
                return existingBotForUser;
            }

            // Find the next available bot according to priority
            for (const botId of this.botPriority) {
                if (this.isBotAvailable(botId)) {
                    // Reserve the bot
                    this.botStatus.set(botId, 'reserved');
                    this.sessionOwners.set(voiceChannelId, botId);
                    this.botSessions.get(botId).add(voiceChannelId);
                    
                    // Set DJ ownership
                    this.djOwners.set(userId, botId);
                    this.botDjs.set(botId, userId);
                    
                    console.log(`[euphire] Reserved bot ${botId} for voice channel ${voiceChannelId} (DJ: ${userId})`);
                    return botId;
                }
            }

            // No bots available
            console.log(`[euphire] No bots available for voice channel ${voiceChannelId}`);
            return null;
        } finally {
            this.allocationLock = false;
        }
    }

    /**
     * Reserve a specific bot for a voice channel session
     * @param {string} voiceChannelId - The voice channel ID
     * @param {string} userId - The user ID requesting the session
     * @param {string} botId - The specific bot ID to reserve
     * @returns {boolean} True if successfully reserved, false otherwise
     */
    reserveSpecificBot(voiceChannelId, userId, botId) {
        // Wait for allocation lock to prevent race conditions
        while (this.allocationLock) {
            // Simple spinlock - in production, use proper async locking
        }
        
        this.allocationLock = true;
        
        try {
            // Check if this voice channel already has a session
            const existingOwner = this.sessionOwners.get(voiceChannelId);
            if (existingOwner) {
                console.warn(`[euphire] Voice channel ${voiceChannelId} already has a session with bot ${existingOwner}`);
                return false;
            }

            // Check if the specific bot is available
            if (!this.isBotAvailable(botId)) {
                console.warn(`[euphire] Bot ${botId} is not available`);
                return false;
            }

            // Reserve this bot
            this.botStatus.set(botId, 'reserved');
            this.sessionOwners.set(voiceChannelId, botId);
            this.botSessions.get(botId).add(voiceChannelId);
            
            // Set DJ ownership
            this.djOwners.set(userId, botId);
            this.botDjs.set(botId, userId);
            
            console.log(`[euphire] Reserved specific bot ${botId} for voice channel ${voiceChannelId} (DJ: ${userId})`);
            return true;
        } finally {
            this.allocationLock = false;
        }
    }

    /**
     * Mark a bot as active (playing music)
     */
    markBotActive(botId, voiceChannelId) {
        const oldStatus = this.botStatus.get(botId);
        this.botStatus.set(botId, 'active');
        console.log(`[euphire] Bot ${botId} marked as active for voice channel ${voiceChannelId} (was: ${oldStatus})`);
    }

    /**
     * Mark a bot as available (when it leaves or stops)
     */
    markBotAvailable(botId) {
        const oldStatus = this.botStatus.get(botId);
        this.botStatus.set(botId, 'available');
        console.log(`[euphire] Bot ${botId} marked as available (was: ${oldStatus})`);
    }

    /**
     * Release a bot from a voice channel session
     */
    releaseBot(voiceChannelId) {
        const botId = this.sessionOwners.get(voiceChannelId);
        if (!botId) {
            console.warn(`[euphire] No bot found for voice channel ${voiceChannelId}`);
            return;
        }

        this.sessionOwners.delete(voiceChannelId);
        this.botSessions.get(botId).delete(voiceChannelId);
        
        // Clear DJ ownership
        const userId = this.botDjs.get(botId);
        if (userId) {
            this.djOwners.delete(userId);
            this.botDjs.delete(botId);
            console.log(`[euphire] Released DJ ownership for user ${userId} from bot ${botId}`);
        }
        
        // Mark bot as available if it has no more sessions
        if (this.botSessions.get(botId).size === 0) {
            this.markBotAvailable(botId);
            console.log(`[euphire] Bot ${botId} released and marked as available`);
        } else {
            console.log(`[euphire] Bot ${botId} still has ${this.botSessions.get(botId).size} active sessions`);
        }
    }

    /**
     * Get the bot that a user is DJ of
     */
    getBotByUser(userId) {
        return this.djOwners.get(userId);
    }

    /**
     * Get the DJ user ID for a bot
     */
    getDjForBot(botId) {
        return this.botDjs.get(botId);
    }

    /**
     * Get the bot ID for a specific user (DJ)
     */
    getBotByUserId(userId) {
        return this.djOwners.get(String(userId));
    }

    /**
     * Get the voice channel for a bot
     */
    getVoiceChannelForBot(botId) {
        const sessions = this.botSessions.get(botId);
        if (sessions && sessions.size > 0) {
            return sessions.values().next().value;
        }
        return null;
    }

    /**
     * Check if a specific bot should handle a command
     * @param {string} botId - The bot ID checking
     * @param {string} voiceChannelId - The voice channel ID (for music commands)
     * @param {boolean} isMusicCommand - Whether this is a music command
     * @returns {boolean} True if this bot should handle the command
     */
    shouldHandleCommand(botId, voiceChannelId, isMusicCommand) {
        if (isMusicCommand && voiceChannelId) {
            // Music commands: only the session owner should respond
            const sessionOwner = this.getSessionOwner(voiceChannelId);
            console.log(`[euphire] shouldHandleCommand: botId=${botId}, voiceChannelId=${voiceChannelId}, sessionOwner=${sessionOwner}, primaryBotId=${this.primaryBotId}, isPrimary=${botId === this.primaryBotId}`);
            if (sessionOwner) {
                console.log(`[euphire] Session exists, returning ${botId === sessionOwner}`);
                return botId === sessionOwner;
            }
            // No session exists yet - this is a new play command
            // Follow priority order: only the first available bot in priority should handle
            for (const priorityBotId of this.botPriority) {
                if (priorityBotId === botId) {
                    // This is the bot we're checking
                    // It should handle if it's the first available in priority
                    // Or if it's the primary bot (fallback for stale state)
                    if (this.isBotAvailable(priorityBotId) || botId === this.primaryBotId) {
                        console.log(`[euphire] No session, bot ${botId} should handle (available=${this.isBotAvailable(priorityBotId)}, primary=${botId === this.primaryBotId})`);
                        return true;
                    }
                    console.log(`[euphire] No session, bot ${botId} is not available and not primary`);
                    return false;
                }
                // If we reach here, a higher-priority bot exists
                // Check if that bot is available
                if (this.isBotAvailable(priorityBotId)) {
                    // Higher-priority bot is available, this bot should not handle
                    console.log(`[euphire] No session, higher-priority bot ${priorityBotId} is available, ${botId} should not handle`);
                    return false;
                }
                // Higher-priority bot is not available, continue to next
            }
            // Should not reach here, but if it does, don't handle
            return false;
        } else {
            // General commands: only primary bot should respond
            return botId === this.primaryBotId;
        }
    }

    /**
     * Get the appropriate bot to handle a command
     * @param {string} voiceChannelId - The voice channel ID (for music commands)
     * @param {boolean} isMusicCommand - Whether this is a music command
     * @returns {string|null} Bot ID that should handle the command
     */
    getCommandHandler(voiceChannelId, isMusicCommand) {
        if (isMusicCommand && voiceChannelId) {
            const sessionOwner = this.getSessionOwner(voiceChannelId);
            if (sessionOwner) {
                return sessionOwner;
            }
            // No session exists - primary bot will coordinate allocation
            return this.primaryBotId;
        } else {
            // General commands
            return this.primaryBotId;
        }
    }

    /**
     * Get all active sessions for a bot
     */
    getBotSessions(botId) {
        return this.botSessions.get(botId) || new Set();
    }

    /**
     * Get bot status
     */
    getBotStatus(botId) {
        return this.botStatus.get(botId);
    }

    /**
     * Mark a bot as disconnected
     */
    markBotDisconnected(botId) {
        this.botStatus.set(botId, 'disconnected');
        // Release all sessions for this bot
        const sessions = this.getBotSessions(botId);
        sessions.forEach(voiceChannelId => {
            this.sessionOwners.delete(voiceChannelId);
        });
        this.botSessions.get(botId).clear();
        console.log(`[euphire] Bot ${botId} marked as disconnected, all sessions released`);
    }

    /**
     * Mark a bot as reconnected
     */
    markBotReconnected(botId) {
        this.botStatus.set(botId, 'available');
        console.log(`[euphire] Bot ${botId} marked as reconnected and available`);
    }

    /**
     * Force reset all bots to available state (for startup or cleanup)
     */
    resetAllBotsToAvailable() {
        for (const botId of this.botPriority) {
            this.botStatus.set(botId, 'available');
            console.log(`[euphire] Force reset bot ${botId} to available`);
        }
    }

    /**
     * Get statistics about bot usage
     */
    getStats() {
        const stats = {
            totalBots: this.clients.size,
            primaryBotId: this.primaryBotId,
            bots: {}
        };

        this.botPriority.forEach(botId => {
            stats.bots[botId] = {
                status: this.botStatus.get(botId),
                activeSessions: this.botSessions.get(botId).size,
                isPrimary: botId === this.primaryBotId
            };
        });

        return stats;
    }
}

// Singleton instance
const coordinator = new BotCoordinator();

module.exports = coordinator;
