const { getDB, isDBConnected } = require('./database');
const crypto = require("crypto");

/**
 * Generate a unique session ID
 */
function generateSessionId() {
    return crypto.randomBytes(16).toString("hex");
}

/**
 * Ensure a user exists in the database
 */
async function ensureUser(userId) {
    if (!isDBConnected()) return;
    
    const db = getDB();
    await db.collection('userStats').updateOne(
        { userId },
        { 
            $setOnInsert: { 
                userId,
                totalListeningMs: 0,
                tracksPlayed: 0,
                createdAt: Date.now(),
                updatedAt: Date.now()
            }
        },
        { upsert: true }
    );
}

/**
 * Start a new listening session
 */
/**
 * Start a new listening session
 */
async function startSession(guildId, userId, track, client, voiceChannelId = null) {
    if (!isDBConnected()) {
        console.warn("[euphire] MongoDB not connected, using fallback");
        return generateSessionId();
    }
    
    await ensureUser(userId);
    
    const sessionId = generateSessionId();
    const now = Date.now();
    const trackDuration = track.info.length || 0;
    const db = getDB();
    
    // Get guild name for better tracking (search across all bot clients)
    let guildName = "Unknown Server";
    try {
        let guild = client?.guilds?.cache?.get(guildId);
        if (!guild) {
            const coordinator = require('./mongoCoordinator');
            for (const c of coordinator.getAllClients()) {
                guild = c?.guilds?.cache?.get(guildId);
                if (guild) break;
            }
        }
        if (guild) {
            guildName = guild.name;
        }
    } catch (err) {
        console.warn("[euphire] Could not fetch guild name:", err.message);
    }
    
    console.log(`[euphire] startSession [${client?.botId}]: guildId: ${guildId}, guildName: ${guildName}, voiceChannelId: ${voiceChannelId}`);
    
    await db.collection('activeSessions').insertOne({
        sessionId,
        guildId,
        guildName,
        userId,
        botId: client?.botId || null,
        voiceChannelId: voiceChannelId || null,
        trackId: track.info.uri || track.info.identifier || "unknown",
        trackTitle: track.info.title || "Unknown",
        trackArtist: track.info.author || null,
        trackUri: track.info.uri || null,
        startedAt: now,
        lastPositionMs: trackDuration,
        isPaused: false
    });
    
    console.log(`[euphire] Session saved to MongoDB: ${sessionId} for guild: ${guildName}, track: ${track.info.title}`);
    return sessionId;
}

/**
 * Update session progress (called periodically for shared listening tracking)
 */
async function updateSessionProgress(sessionId, positionMs, isPaused = false) {
    if (!sessionId || !isDBConnected()) return;
    
    const db = getDB();
    
    const session = await db.collection('activeSessions').findOne({ sessionId });
    if (!session) return;
    
    const timeDiffMs = positionMs - (session.lastPositionMs || 0);
    
    if (!isPaused && timeDiffMs > 0) {
        try {
            await updateSharedListening(sessionId, session.guildId, session.userId, timeDiffMs);
        } catch (error) {
            console.error("[euphire] Failed to update shared listening:", error.message);
        }
    }
    
    await db.collection('activeSessions').updateOne(
        { sessionId },
        { $set: { lastPositionMs: positionMs, isPaused } }
    );
}

/**
 * End a session and commit the listening time to statistics.
 * @param {string} sessionId
 * @param {boolean} completedNaturally - Track finished without manual skip/stop
 * @param {number|null} actualPositionMs - Time listened before track ended/skipped
 */
async function endSession(sessionId, completedNaturally = false, actualPositionMs = null) {
    if (!sessionId) return;
    if (!isDBConnected()) {
        console.log("[euphire] endSession: MongoDB not connected, skipping");
        return;
    }
    
    const db = getDB();
    
    try {
        const session = await db.collection('activeSessions').findOne({ sessionId });
        if (!session) {
            console.log("[euphire] endSession: session not found:", sessionId);
            return;
        }
        
        console.log(`[euphire] endSession: found session: ${sessionId}, track: "${session.trackTitle}", user: ${session.userId}`);
        console.log(`[euphire] endSession: completedNaturally: ${completedNaturally}, actualPositionMs: ${actualPositionMs}`);
        
        const now = Date.now();
        let durationMs = 0;
        
        if (completedNaturally) {
            durationMs = session.lastPositionMs || (now - session.startedAt);
            console.log(`[euphire] endSession: using track duration (natural completion): ${durationMs} ms`);
        } else {
            if (actualPositionMs && actualPositionMs > 0) {
                durationMs = Math.min(actualPositionMs, session.lastPositionMs || actualPositionMs);
            } else {
                const elapsed = now - session.startedAt;
                durationMs = Math.min(elapsed, session.lastPositionMs || elapsed);
            }
            console.log(`[euphire] endSession: track ended early, counted actual listened time: ${durationMs} ms`);
        }
        
        durationMs = Math.max(0, Math.floor(durationMs));
        console.log(`[euphire] endSession: committing ${durationMs} ms for user: ${session.userId}, track: "${session.trackTitle}"`);
        
        // Count listening time if user listened for at least 5 seconds
        if (durationMs >= 5000) {
            await ensureUser(session.userId);
            
            // Count track as played if completed naturally or listened to for at least 30 seconds
            const trackPlayedIncrement = (completedNaturally || durationMs >= 30000) ? 1 : 0;
            
            // Update user total listening time
            const userResult = await db.collection('userStats').updateOne(
                { userId: session.userId },
                { 
                    $inc: { 
                        totalListeningMs: durationMs,
                        tracksPlayed: trackPlayedIncrement
                    },
                    $set: { updatedAt: now }
                }
            );
            console.log(`[euphire] endSession: userStats update result: ${userResult.modifiedCount} modified`);
            
            // Update server listening time
            await db.collection('serverStats').updateOne(
                { userId: session.userId, guildId: session.guildId },
                { 
                    $inc: { listeningMs: durationMs },
                    $set: { guildName: session.guildName || "Unknown Server" }
                },
                { upsert: true }
            );
            
            // Update track statistics
            await db.collection('trackStats').updateOne(
                { userId: session.userId, trackId: session.trackId },
                { 
                    $inc: { 
                        listeningMs: durationMs,
                        playCount: trackPlayedIncrement
                    },
                    $set: { 
                        trackTitle: session.trackTitle || "Unknown Track",
                        trackArtist: session.trackArtist,
                        trackUri: session.trackUri
                    }
                },
                { upsert: true }
            );
            
            // Update shared listening time for all participants
            const participants = await db.collection('sessionParticipants')
                .find({ sessionId, userId: { $ne: session.userId } })
                .toArray();
            
            for (const participant of participants) {
                await ensureUser(participant.userId);
                
                await db.collection('sharedListening').updateOne(
                    { userId: session.userId, friendId: participant.userId, guildId: session.guildId },
                    { $inc: { sharedMs: durationMs } },
                    { upsert: true }
                );
                
                await db.collection('sharedListening').updateOne(
                    { userId: participant.userId, friendId: session.userId, guildId: session.guildId },
                    { $inc: { sharedMs: durationMs } },
                    { upsert: true }
                );
            }
        } else {
            console.log("[euphire] endSession: duration is less than 5 seconds, not committing stats");
        }
        
        // Delete session and participants from active sessions
        await db.collection('sessionParticipants').deleteMany({ sessionId });
        await db.collection('activeSessions').deleteOne({ sessionId });
        
        console.log(`[euphire] endSession: session ${sessionId} closed successfully`);
    } catch (error) {
        console.error("[euphire] Failed to end stats session:", error.message);
    }
}

/**
 * Add a participant to an active session
 */
async function addSessionParticipant(sessionId, userId) {
    if (!isDBConnected()) return;
    
    const db = getDB();
    const now = Date.now();
    
    await db.collection('sessionParticipants').updateOne(
        { sessionId, userId },
        { $set: { joinedAt: now } },
        { upsert: true }
    );
}

/**
 * Remove a participant from an active session
 */
async function removeSessionParticipant(sessionId, userId) {
    if (!isDBConnected()) return;
    
    const db = getDB();
    
    try {
        await db.collection('sessionParticipants').deleteOne({ sessionId, userId });
    } catch (error) {
        console.error("[euphire] Failed to remove session participant:", error.message);
    }
}

/**
 * Update shared listening time for all current participants
 */
async function updateSharedListening(sessionId, guildId, ownerId, durationMs) {
    if (!isDBConnected()) return;
    
    const db = getDB();
    
    const participants = await db.collection('sessionParticipants')
        .find({ sessionId, userId: { $ne: ownerId } })
        .toArray();
    
    for (const participant of participants) {
        await ensureUser(participant.userId);
        
        if (durationMs > 0) {
            await db.collection('sharedListening').updateOne(
                { userId: ownerId, friendId: participant.userId, guildId },
                { $inc: { sharedMs: durationMs } },
                { upsert: true }
            );
            
            await db.collection('sharedListening').updateOne(
                { userId: participant.userId, friendId: ownerId, guildId },
                { $inc: { sharedMs: durationMs } },
                { upsert: true }
            );
        }
    }
}

/**
 * Get user statistics for profile
 */
async function getUserStats(userId) {
    if (!isDBConnected()) {
        return { total_listening_ms: 0, tracks_played: 0 };
    }
    
    const db = getDB();
    await ensureUser(userId);
    
    const user = await db.collection('userStats').findOne({ userId });
    
    console.log("[euphire] getUserStats for userId:", userId, "found:", user);
    
    return user ? { total_listening_ms: user.totalListeningMs, tracks_played: user.tracksPlayed } 
                : { total_listening_ms: 0, tracks_played: 0 };
}

/**
 * Get top servers for a user
 */
async function getTopServers(userId, limit = 3) {
    if (!isDBConnected()) return [];
    
    const db = getDB();
    
    const results = await db.collection('serverStats')
        .find({ userId, listeningMs: { $gt: 0 } })
        .sort({ listeningMs: -1 })
        .limit(limit)
        .toArray();
    
    console.log("[euphire] getTopServers for userId:", userId, "found:", results.length, "servers");
    console.log("[euphire] Server data:", JSON.stringify(results, null, 2));
    
    return results;
}

/**
 * Get top friends for a user
 */
async function getTopFriends(userId, limit = 3) {
    if (!isDBConnected()) return [];
    
    const db = getDB();
    
    const results = await db.collection('sharedListening')
        .aggregate([
            { $match: { userId, sharedMs: { $gt: 0 } } },
            { $group: { _id: "$friendId", totalSharedMs: { $sum: "$sharedMs" } } },
            { $sort: { totalSharedMs: -1 } },
            { $limit: limit }
        ])
        .toArray();
    
    // Map aggregate results to match expected format
    return results.map(r => ({
        friendId: r._id,
        totalSharedMs: r.totalSharedMs
    }));
}

/**
 * Get top tracks for a user
 */
async function getTopTracks(userId, limit = 3) {
    if (!isDBConnected()) return [];
    
    const db = getDB();
    
    return await db.collection('trackStats')
        .find({ userId, listeningMs: { $gt: 0 } })
        .sort({ listeningMs: -1 })
        .limit(limit)
        .toArray();
}

/**
 * Clean up orphaned sessions (called on bot startup)
 */
async function cleanupOrphanedSessions() {
    if (!isDBConnected()) return;
    
    const db = getDB();
    const now = Date.now();
    const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours
    
    const staleSessions = await db.collection('activeSessions')
        .find({ startedAt: { $lt: now - staleThreshold } })
        .toArray();
    
    for (const session of staleSessions) {
        try {
            await endSession(session.sessionId);
        } catch (err) {
            console.error("[euphire] Failed to cleanup session:", err.message);
        }
    }
    
    console.log(`[euphire] Cleaned up ${staleSessions.length} orphaned sessions.`);
}

/**
 * Reset profile statistics in MongoDB (e!profile only)
 * Scope: all users or a specific userId
 * Deletes from: userStats, serverStats, trackStats, sharedListening, activeSessions, sessionParticipants
 * Preserves: guildData (server settings), userData (Last.fm), sessions (bot DJ assignments)
 */
async function resetAllProfileStats(targetUserId = null) {
    if (!isDBConnected()) {
        throw new Error("MongoDB is not connected.");
    }
    
    const db = getDB();
    
    // Clear active in-memory player session references
    try {
        const coordinator = require('./mongoCoordinator');
        const allClients = coordinator.getAllClients();
        for (const client of allClients) {
            if (client?.riffy?.players) {
                for (const player of client.riffy.players.values()) {
                    if (!targetUserId || player.sessionUserId === targetUserId) {
                        player.currentSessionId = null;
                        player.sessionStartedAt = null;
                        player.sessionUserId = null;
                    }
                }
            }
        }
    } catch (err) {
        console.warn("[euphire] Warning clearing in-memory player sessions:", err.message);
    }
    
    if (targetUserId) {
        const userStats = await db.collection('userStats').deleteMany({ userId: targetUserId });
        const serverStats = await db.collection('serverStats').deleteMany({ userId: targetUserId });
        const trackStats = await db.collection('trackStats').deleteMany({ userId: targetUserId });
        const shared1 = await db.collection('sharedListening').deleteMany({ userId: targetUserId });
        const shared2 = await db.collection('sharedListening').deleteMany({ friendId: targetUserId });
        const activeSessions = await db.collection('activeSessions').deleteMany({ userId: targetUserId });
        const sessionParticipants = await db.collection('sessionParticipants').deleteMany({ userId: targetUserId });

        return {
            scope: targetUserId,
            userStats: userStats.deletedCount || 0,
            serverStats: serverStats.deletedCount || 0,
            trackStats: trackStats.deletedCount || 0,
            sharedListening: (shared1.deletedCount || 0) + (shared2.deletedCount || 0),
            activeSessions: activeSessions.deletedCount || 0,
            sessionParticipants: sessionParticipants.deletedCount || 0,
        };
    } else {
        const userStats = await db.collection('userStats').deleteMany({});
        const serverStats = await db.collection('serverStats').deleteMany({});
        const trackStats = await db.collection('trackStats').deleteMany({});
        const sharedListening = await db.collection('sharedListening').deleteMany({});
        const activeSessions = await db.collection('activeSessions').deleteMany({});
        const sessionParticipants = await db.collection('sessionParticipants').deleteMany({});

        return {
            scope: 'everyone',
            userStats: userStats.deletedCount || 0,
            serverStats: serverStats.deletedCount || 0,
            trackStats: trackStats.deletedCount || 0,
            sharedListening: sharedListening.deletedCount || 0,
            activeSessions: activeSessions.deletedCount || 0,
            sessionParticipants: sessionParticipants.deletedCount || 0,
        };
    }
}

module.exports = {
    generateSessionId,
    startSession,
    updateSessionProgress,
    endSession,
    addSessionParticipant,
    removeSessionParticipant,
    getUserStats,
    getTopServers,
    getTopFriends,
    getTopTracks,
    cleanupOrphanedSessions,
    resetAllProfileStats,
};
