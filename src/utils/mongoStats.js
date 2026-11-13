const { getDB, getMongoClient, isDBConnected } = require('./database');
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
async function ensureUser(userId, session = null) {
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
        { upsert: true, ...(session ? { session } : {}) }
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
        trackTitle:
            track.info.spotifyTitle ||
            track.info.displayTitle ||
            track.info.title ||
            "Unknown",
        trackArtist:
            track.info.spotifyArtist ||
            track.info.displayAuthor ||
            track.info.author ||
            null,
        trackArtistSource: track.info.spotifyArtist
            ? "spotify"
            : track.info.displayAuthor
              ? "parsed"
              : "source",
        trackSourceName: track.info.sourceName || null,
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
    const mongoSession = getMongoClient().startSession();

    try {
        await mongoSession.withTransaction(async () => {
            // Serialize overlapping trackEnd/queueEnd finalizers for this session.
            const claim = await db.collection('activeSessions').updateOne(
                { sessionId },
                { $set: { finalizing: true } },
                { session: mongoSession }
            );
            if (claim.matchedCount === 0) {
                console.log("[euphire] endSession: session already finalized or not found:", sessionId);
                return;
            }

            const activeSession = await db.collection('activeSessions').findOne(
                { sessionId },
                { session: mongoSession }
            );
            if (!activeSession) return;

            console.log(`[euphire] endSession: found session: ${sessionId}, track: "${activeSession.trackTitle}", user: ${activeSession.userId}`);
            console.log(`[euphire] endSession: completedNaturally: ${completedNaturally}, actualPositionMs: ${actualPositionMs}`);

            const now = Date.now();
            let durationMs = 0;

            if (completedNaturally) {
                durationMs = activeSession.lastPositionMs || (now - activeSession.startedAt);
                console.log(`[euphire] endSession: using track duration (natural completion): ${durationMs} ms`);
            } else {
                if (actualPositionMs && actualPositionMs > 0) {
                    durationMs = Math.min(
                        actualPositionMs,
                        activeSession.lastPositionMs || actualPositionMs
                    );
                } else {
                    const elapsed = now - activeSession.startedAt;
                    durationMs = Math.min(
                        elapsed,
                        activeSession.lastPositionMs || elapsed
                    );
                }
                console.log(`[euphire] endSession: track ended early, counted actual listened time: ${durationMs} ms`);
            }

            durationMs = Math.max(0, Math.floor(durationMs));
            console.log(`[euphire] endSession: session base duration: ${durationMs} ms for session: ${sessionId}, track: "${activeSession.trackTitle}"`);

            const listeners = new Map();
            const participants = await db.collection('sessionParticipants')
                .find({ sessionId }, { session: mongoSession })
                .toArray();

            for (const participant of participants) {
                let listenedMs = participant.listenedMs || 0;
                if (participant.joinedAt) {
                    listenedMs += Math.max(0, now - participant.joinedAt);
                }
                if (
                    completedNaturally &&
                    listenedMs >= Math.max(0, durationMs - 5000)
                ) {
                    listenedMs = durationMs;
                } else {
                    listenedMs = Math.min(listenedMs, durationMs);
                }
                listenedMs = Math.max(0, Math.floor(listenedMs));

                const current = listeners.get(participant.userId) || 0;
                listeners.set(
                    participant.userId,
                    Math.max(current, listenedMs)
                );
            }

            console.log(`[euphire] endSession: committing stats for ${listeners.size} listener(s):`, [...listeners.entries()]);

            for (const [listenerId, listenerMs] of listeners.entries()) {
                if (listenerMs < 5000) continue;

                await ensureUser(listenerId, mongoSession);

                const trackPlayedIncrement =
                    (completedNaturally &&
                        listenerMs >= Math.min(30000, durationMs * 0.5)) ||
                    listenerMs >= 30000
                        ? 1
                        : 0;

                await db.collection('userStats').updateOne(
                    { userId: listenerId },
                    {
                        $inc: {
                            totalListeningMs: listenerMs,
                            tracksPlayed: trackPlayedIncrement,
                        },
                        $set: { updatedAt: now },
                    },
                    { upsert: true, session: mongoSession }
                );

                await db.collection('serverStats').updateOne(
                    { userId: listenerId, guildId: activeSession.guildId },
                    {
                        $inc: { listeningMs: listenerMs },
                        $set: {
                            guildName: activeSession.guildName || "Unknown Server",
                        },
                    },
                    { upsert: true, session: mongoSession }
                );

                await db.collection('trackStats').updateOne(
                    { userId: listenerId, trackId: activeSession.trackId },
                    {
                        $inc: {
                            listeningMs: listenerMs,
                            playCount: trackPlayedIncrement,
                        },
                        $set: {
                            trackTitle: activeSession.trackTitle || "Unknown Track",
                            trackArtist: activeSession.trackArtist,
                            trackArtistSource: activeSession.trackArtistSource,
                            trackSourceName: activeSession.trackSourceName,
                            trackUri: activeSession.trackUri,
                        },
                    },
                    { upsert: true, session: mongoSession }
                );
                console.log(`[euphire] endSession: updated stats for listener ${listenerId}: +${listenerMs}ms, +${trackPlayedIncrement} plays`);
            }

            const qualifiedListeners = [...listeners.entries()]
                .filter(([_, listenedMs]) => listenedMs >= 5000);
            for (let i = 0; i < qualifiedListeners.length; i++) {
                for (let j = i + 1; j < qualifiedListeners.length; j++) {
                    const [userA, durationA] = qualifiedListeners[i];
                    const [userB, durationB] = qualifiedListeners[j];
                    const sharedMs = Math.min(durationA, durationB);
                    if (sharedMs < 5000) continue;

                    await ensureUser(userA, mongoSession);
                    await ensureUser(userB, mongoSession);

                    await db.collection('sharedListening').updateOne(
                        { userId: userA, friendId: userB, guildId: activeSession.guildId },
                        { $inc: { sharedMs } },
                        { upsert: true, session: mongoSession }
                    );

                    await db.collection('sharedListening').updateOne(
                        { userId: userB, friendId: userA, guildId: activeSession.guildId },
                        { $inc: { sharedMs } },
                        { upsert: true, session: mongoSession }
                    );
                }
            }

            await db.collection('sessionParticipants').deleteMany(
                { sessionId },
                { session: mongoSession }
            );
            await db.collection('activeSessions').deleteOne(
                { sessionId },
                { session: mongoSession }
            );

            console.log(`[euphire] endSession: session ${sessionId} closed successfully`);
        });
    } catch (error) {
        console.error("[euphire] Failed to end stats session:", error.message);
        throw error;
    } finally {
        await mongoSession.endSession();
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
async function updateSharedListening(
    sessionId,
    guildId,
    ownerId,
    durationMs,
    mongoSession = null
) {
    if (!isDBConnected()) return;
    
    const db = getDB();
    
    const participants = await db.collection('sessionParticipants')
        .find(
            { sessionId, userId: { $ne: ownerId } },
            mongoSession ? { session: mongoSession } : undefined
        )
        .toArray();
    
    for (const participant of participants) {
        await ensureUser(participant.userId, mongoSession);
        
        if (durationMs > 0) {
            await db.collection('sharedListening').updateOne(
                { userId: ownerId, friendId: participant.userId, guildId },
                { $inc: { sharedMs: durationMs } },
                { upsert: true, ...(mongoSession ? { session: mongoSession } : {}) }
            );
            
            await db.collection('sharedListening').updateOne(
                { userId: participant.userId, friendId: ownerId, guildId },
                { $inc: { sharedMs: durationMs } },
                { upsert: true, ...(mongoSession ? { session: mongoSession } : {}) }
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

async function removeProfileTrackWording(userId, wording) {
    if (!isDBConnected()) {
        throw new Error("MongoDB is not connected.");
    }

    const targetUserId = String(userId || "");
    const normalizedWording = String(wording || "").trim();
    if (!/^\d{17,20}$/.test(targetUserId)) {
        throw new Error("A valid Discord user ID is required.");
    }
    if (!normalizedWording) {
        throw new Error("Wording to remove is required.");
    }

    const escapedWording = normalizedWording.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
    );
    const wordingPattern = new RegExp(escapedWording, "i");
    const trackStats = getDB().collection("trackStats");
    const matchingTracks = await trackStats
        .find({
            userId: targetUserId,
            $or: [
                { trackTitle: { $regex: wordingPattern } },
                { trackArtist: { $regex: wordingPattern } },
            ],
        })
        .toArray();

    const updates = [];
    let modifiedFields = 0;
    for (const track of matchingTracks) {
        const changes = {};
        for (const field of ["trackTitle", "trackArtist"]) {
            if (typeof track[field] !== "string") continue;

            const cleanedValue = track[field]
                .replace(new RegExp(escapedWording, "gi"), "")
                .replace(/\s+/g, " ")
                .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, "")
                .replace(/\s+([,.;:!?])/g, "$1")
                .replace(/([([{\-–—|:])\s+/g, "$1")
                .replace(/\s+([)\]}])/g, "$1")
                .replace(/^[\s\-–—|,:;]+|[\s\-–—|,:;]+$/g, "")
                .trim();
            const replacement =
                field === "trackTitle" ? cleanedValue || "Unknown Track" : cleanedValue;

            if (replacement !== track[field]) {
                changes[field] = replacement;
                modifiedFields++;
            }
        }

        if (Object.keys(changes).length) {
            updates.push({
                updateOne: {
                    filter: { _id: track._id, userId: targetUserId },
                    update: { $set: changes },
                },
            });
        }
    }

    if (!updates.length) {
        return { modifiedTracks: 0, modifiedFields: 0 };
    }

    const result = await trackStats.bulkWrite(updates, { ordered: true });
    return {
        modifiedTracks: result.modifiedCount,
        modifiedFields,
    };
}

async function resetUserProfileStats(userId) {
    if (!isDBConnected()) {
        throw new Error("MongoDB is not connected.");
    }

    const targetUserId = String(userId || "");
    if (!/^\d{17,20}$/.test(targetUserId)) {
        throw new Error("A specific valid Discord user ID is required.");
    }

    const db = getDB();
    const userFilter = { userId: targetUserId };
    const sharedListeningFilter = {
        $or: [{ userId: targetUserId }, { friendId: targetUserId }],
    };

    const ownedSessions = await db.collection("activeSessions")
        .find(userFilter, { projection: { sessionId: 1 } })
        .toArray();
    const ownedSessionIds = ownedSessions.map((session) => session.sessionId);
    const participantFilter = {
        $or: [
            { userId: targetUserId },
            ...(ownedSessionIds.length
                ? [{ sessionId: { $in: ownedSessionIds } }]
                : []),
        ],
    };

    const [
        userStats,
        serverStats,
        trackStats,
        sharedListening,
        activeSessions,
        sessionParticipants,
    ] = await Promise.all([
        db.collection("userStats").deleteMany(userFilter),
        db.collection("serverStats").deleteMany(userFilter),
        db.collection("trackStats").deleteMany(userFilter),
        db.collection("sharedListening").deleteMany(sharedListeningFilter),
        db.collection("activeSessions").deleteMany(userFilter),
        db.collection("sessionParticipants").deleteMany(participantFilter),
    ]);

    return {
        userStats: userStats.deletedCount,
        serverStats: serverStats.deletedCount,
        trackStats: trackStats.deletedCount,
        sharedListening: sharedListening.deletedCount,
        activeSessions: activeSessions.deletedCount,
        sessionParticipants: sessionParticipants.deletedCount,
    };
}

async function clearGlobalProfileStats() {
    if (!isDBConnected()) {
        throw new Error("MongoDB is not connected.");
    }

    const db = getDB();
    const [
        userStats,
        serverStats,
        trackStats,
        sharedListening,
        activeSessions,
        sessionParticipants,
    ] = await Promise.all([
        db.collection("userStats").deleteMany({}),
        db.collection("serverStats").deleteMany({}),
        db.collection("trackStats").deleteMany({}),
        db.collection("sharedListening").deleteMany({}),
        db.collection("activeSessions").deleteMany({}),
        db.collection("sessionParticipants").deleteMany({}),
    ]);

    return {
        userStats: userStats.deletedCount,
        serverStats: serverStats.deletedCount,
        trackStats: trackStats.deletedCount,
        sharedListening: sharedListening.deletedCount,
        activeSessions: activeSessions.deletedCount,
        sessionParticipants: sessionParticipants.deletedCount,
    };
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
    clearGlobalProfileStats,
    getTopServers,
    getTopFriends,
    getTopTracks,
    removeProfileTrackWording,
    resetUserProfileStats,
    cleanupOrphanedSessions,
};
