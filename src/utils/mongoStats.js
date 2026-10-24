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
        console.log(`[euphire] endSession: session base duration: ${durationMs} ms for session: ${sessionId}, track: "${session.trackTitle}"`);
        
        // Collect all listeners: session owner (DJ) + all VC participants
        const listeners = new Map();
        if (session.userId && durationMs >= 5000) {
            listeners.set(session.userId, durationMs);
        }

        const participants = await db.collection('sessionParticipants')
            .find({ sessionId })
            .toArray();

        for (const p of participants) {
            let pDuration = p.listenedMs || 0;
            if (p.joinedAt) {
                pDuration += Math.max(0, now - p.joinedAt);
            }
            if (completedNaturally && pDuration >= Math.max(0, durationMs - 5000)) {
                pDuration = durationMs;
            } else {
                pDuration = Math.min(pDuration, durationMs);
            }
            pDuration = Math.max(0, Math.floor(pDuration));

            const cur = listeners.get(p.userId) || 0;
            listeners.set(p.userId, Math.max(cur, pDuration));
        }

        console.log(`[euphire] endSession: committing stats for ${listeners.size} listener(s):`, [...listeners.entries()]);

        // Commit stats for EVERY listener (requester + everyone in VC)
        for (const [listenerId, listenerMs] of listeners.entries()) {
            if (listenerMs < 5000) continue;

            await ensureUser(listenerId);

            const trackPlayedIncrement = (completedNaturally && listenerMs >= Math.min(30000, durationMs * 0.5)) || listenerMs >= 30000 ? 1 : 0;

            // 1. Update user total listening time and tracks played
            await db.collection('userStats').updateOne(
                { userId: listenerId },
                { 
                    $inc: { 
                        totalListeningMs: listenerMs,
                        tracksPlayed: trackPlayedIncrement
                    },
                    $set: { updatedAt: now }
                },
                { upsert: true }
            );

            // 2. Update server listening time (Top Servers!)
            await db.collection('serverStats').updateOne(
                { userId: listenerId, guildId: session.guildId },
                { 
                    $inc: { listeningMs: listenerMs },
                    $set: { guildName: session.guildName || "Unknown Server" }
                },
                { upsert: true }
            );

            // 3. Update track statistics (Top Tracks!)
            await db.collection('trackStats').updateOne(
                { userId: listenerId, trackId: session.trackId },
                { 
                    $inc: { 
                        listeningMs: listenerMs,
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
            console.log(`[euphire] endSession: updated stats for listener ${listenerId}: +${listenerMs}ms, +${trackPlayedIncrement} plays`);
        }

        // 4. Update shared listening time for all pairs of listeners (Top Friends!)
        const qualifiedListeners = [...listeners.entries()].filter(([_, ms]) => ms >= 5000);
        for (let i = 0; i < qualifiedListeners.length; i++) {
            for (let j = i + 1; j < qualifiedListeners.length; j++) {
                const [userA, msA] = qualifiedListeners[i];
                const [userB, msB] = qualifiedListeners[j];
                const sharedMs = Math.min(msA, msB);
                if (sharedMs >= 5000) {
                    await ensureUser(userA);
                    await ensureUser(userB);

                    await db.collection('sharedListening').updateOne(
                        { userId: userA, friendId: userB, guildId: session.guildId },
                        { $inc: { sharedMs: sharedMs } },
                        { upsert: true }
                    );

                    await db.collection('sharedListening').updateOne(
                        { userId: userB, friendId: userA, guildId: session.guildId },
                        { $inc: { sharedMs: sharedMs } },
                        { upsert: true }
                    );
                }
            }
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
    if (!sessionId || !userId || !isDBConnected()) return;
    
    const db = getDB();
    const now = Date.now();
    
    try {
        const existing = await db.collection('sessionParticipants').findOne({ sessionId, userId });
        if (existing) {
            await db.collection('sessionParticipants').updateOne(
                { sessionId, userId },
                { 
                    $set: { joinedAt: now },
                    $unset: { leftAt: "" }
                }
            );
        } else {
            await db.collection('sessionParticipants').updateOne(
                { sessionId, userId },
                { 
                    $setOnInsert: { 
                        sessionId, 
                        userId, 
                        listenedMs: 0 
                    },
                    $set: { joinedAt: now }
                },
                { upsert: true }
            );
        }
    } catch (err) {
        console.error("[euphire] Failed to add session participant:", err.message);
    }
}

/**
 * Remove a participant from an active session
 */
async function removeSessionParticipant(sessionId, userId) {
    if (!sessionId || !userId || !isDBConnected()) return;
    
    const db = getDB();
    const now = Date.now();
    
    try {
        const participant = await db.collection('sessionParticipants').findOne({ sessionId, userId });
        if (participant && participant.joinedAt) {
            const currentInterval = Math.max(0, now - participant.joinedAt);
            const totalMs = (participant.listenedMs || 0) + currentInterval;
            await db.collection('sessionParticipants').updateOne(
                { sessionId, userId },
                { 
                    $set: { leftAt: now, listenedMs: totalMs },
                    $unset: { joinedAt: "" }
                }
            );
        }
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
};
