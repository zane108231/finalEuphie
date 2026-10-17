const { getStatsDB } = require("./statsDB");
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
function ensureUser(userId) {
    const db = getStatsDB();
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO user_stats (user_id, total_listening_ms, tracks_played)
        VALUES (?, 0, 0)
    `);
    stmt.run(userId);
}

/**
 * Start a new listening session
 */
function startSession(guildId, userId, track) {
    const db = getStatsDB();
    ensureUser(userId);

    const sessionId = generateSessionId();
    const now = Date.now();
    const trackDuration = track.info.length || 0;

    const stmt = db.prepare(`
        INSERT INTO active_sessions
        (session_id, guild_id, user_id, track_id, track_title, track_artist, track_uri, started_at, last_position_ms, is_paused)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    stmt.run(
        sessionId,
        guildId,
        userId,
        track.info.uri || track.info.identifier || "unknown",
        track.info.title || "Unknown",
        track.info.author || null,
        track.info.uri || null,
        now,
        trackDuration
    );

    return sessionId;
}

/**
 * Update session progress (called periodically for shared listening tracking)
 * NO LONGER commits time to database - time is committed at track end using duration
 * Only tracks shared listening time for participants
 */
function updateSessionProgress(sessionId, positionMs, isPaused = false) {
    const db = getStatsDB();

    // Get current session state
    const session = db.prepare(`
        SELECT guild_id, user_id, track_id, track_title, track_artist, track_uri,
               last_position_ms, started_at
        FROM active_sessions
        WHERE session_id = ?
    `).get(sessionId);

    if (!session) return;

    // Calculate time difference since last update
    const timeDiffMs = positionMs - session.last_position_ms;

    // Only update shared listening time incrementally (participants join/leave during playback)
    if (!isPaused && timeDiffMs > 0) {
        try {
            updateSharedListening(sessionId, session.guild_id, session.user_id, timeDiffMs);
        } catch (error) {
            console.error("[euphire] Failed to update shared listening:", error.message);
        }
    }

    // Update session position (needed for shared listening calculations)
    const stmt = db.prepare(`
        UPDATE active_sessions
        SET last_position_ms = ?, is_paused = ?
        WHERE session_id = ?
    `);

    stmt.run(positionMs, isPaused ? 1 : 0, sessionId);
}

/**
 * End a session and commit the listening time to statistics
 * @param {string} sessionId - The session ID
 * @param {boolean} completedNaturally - Whether the track completed naturally (not skipped/stopped)
 */
function endSession(sessionId, completedNaturally = false) {
    const db = getStatsDB();

    try {
        // Get session details
        const sessionStmt = db.prepare(`
            SELECT guild_id, user_id, track_id, track_title, track_artist, track_uri,
                   started_at, last_position_ms
            FROM active_sessions
            WHERE session_id = ?
        `);

        const session = sessionStmt.get(sessionId);
        if (!session) {
            console.log("[euphire] endSession: session not found:", sessionId);
            return;
        }

        const now = Date.now();
        
        // Determine actual listening time:
        // - If completed naturally: use the stored track duration (exact)
        // - If skipped/stopped: use 0 (or we could use current position if we tracked it)
        let durationMs;
        if (completedNaturally) {
            durationMs = session.last_position_ms; // This is the track duration we stored at start
            console.log("[euphire] endSession: using track duration (natural completion):", durationMs, "ms");
        } else {
            durationMs = 0; // Skipped/stopped tracks don't count toward stats
            console.log("[euphire] endSession: track skipped/stopped, not counting time");
        }

        console.log("[euphire] endSession: committing", durationMs, "ms for user:", session.user_id, "track:", session.track_title);

        // Commit the listening time
        if (durationMs > 0) {
            ensureUser(session.user_id);
            
            // Update user total listening time
            const userStmt = db.prepare(`
                UPDATE user_stats
                SET total_listening_ms = total_listening_ms + ?,
                    tracks_played = tracks_played + 1,
                    updated_at = ?
                WHERE user_id = ?
            `);
            userStmt.run(durationMs, now, session.user_id);

            // Update server listening time
            const serverStmt = db.prepare(`
                INSERT INTO server_stats (user_id, guild_id, listening_ms)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id, guild_id)
                DO UPDATE SET listening_ms = listening_ms + ?
            `);
            serverStmt.run(session.user_id, session.guild_id, durationMs, durationMs);

            // Update track statistics
            const trackStmt = db.prepare(`
                INSERT INTO track_stats (user_id, track_id, track_title, track_artist, track_uri, listening_ms, play_count)
                VALUES (?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(user_id, track_id)
                DO UPDATE SET
                    listening_ms = listening_ms + ?,
                    play_count = play_count + 1,
                    track_title = ?,
                    track_artist = ?,
                    track_uri = ?
            `);
            trackStmt.run(
                session.user_id,
                session.track_id,
                session.track_title,
                session.track_artist,
                session.track_uri,
                durationMs,
                durationMs,
                session.track_title,
                session.track_artist,
                session.track_uri
            );

            // Update shared listening time for all participants using track duration
            const participants = db.prepare(`
                SELECT user_id FROM session_participants
                WHERE session_id = ? AND user_id != ?
            `).all(sessionId, session.user_id);

            const updateShared = db.prepare(`
                INSERT INTO shared_listening (user_id, friend_id, guild_id, shared_ms)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, friend_id, guild_id)
                DO UPDATE SET shared_ms = shared_ms + ?
            `);

            for (const participant of participants) {
                ensureUser(participant.user_id);
                // Update shared time for owner -> participant
                updateShared.run(session.user_id, participant.user_id, session.guild_id, durationMs, durationMs);
                // Update shared time for participant -> owner
                updateShared.run(participant.user_id, session.user_id, session.guild_id, durationMs, durationMs);
            }
        }

        // Delete session and participants
        db.prepare("DELETE FROM session_participants WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM active_sessions WHERE session_id = ?").run(sessionId);
        
        console.log("[euphire] endSession: session deleted successfully");
    } catch (error) {
        console.error("[euphire] Failed to end stats session:", error.message);
    }
}

/**
 * Add a participant to an active session
 */
function addSessionParticipant(sessionId, userId) {
    const db = getStatsDB();
    const now = Date.now();

    // Use INSERT OR REPLACE to ensure joined_at is updated if already exists
    const stmt = db.prepare(`
        INSERT INTO session_participants (session_id, user_id, joined_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id, user_id)
        DO UPDATE SET joined_at = ?
    `);
    stmt.run(sessionId, userId, now, now);
}

/**
 * Remove a participant from an active session
 */
function removeSessionParticipant(sessionId, userId) {
    const db = getStatsDB();

    try {
        // When removing a participant, we don't need to add extra time
        // because the time has already been added incrementally via updateSharedListening
        // during the session updates. Just remove them from the session.
        db.prepare("DELETE FROM session_participants WHERE session_id = ? AND user_id = ?").run(sessionId, userId);
    } catch (error) {
        console.error("[euphire] Failed to remove session participant:", error.message);
    }
}

/**
 * Update shared listening time for all current participants
 * NOTE: This is now UNUSED since we removed periodic position tracking
 * Shared listening should be updated at session end using track duration
 */
function updateSharedListening(sessionId, guildId, ownerId, durationMs) {
    const db = getStatsDB();

    // Get all participants (excluding the owner)
    const participants = db.prepare(`
        SELECT user_id FROM session_participants
        WHERE session_id = ? AND user_id != ?
    `).all(sessionId, ownerId);

    const updateShared = db.prepare(`
        INSERT INTO shared_listening (user_id, friend_id, guild_id, shared_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, friend_id, guild_id)
        DO UPDATE SET shared_ms = shared_ms + ?
    `);

    for (const participant of participants) {
        // Ensure participant exists in database
        ensureUser(participant.user_id);
        
        if (durationMs > 0) {
            // Update shared time for owner -> participant
            updateShared.run(ownerId, participant.user_id, guildId, durationMs, durationMs);
            // Update shared time for participant -> owner
            updateShared.run(participant.user_id, ownerId, guildId, durationMs, durationMs);
        }
    }
}

/**
 * Get user statistics for profile
 */
function getUserStats(userId) {
    const db = getStatsDB();
    ensureUser(userId);

    const user = db.prepare(`
        SELECT total_listening_ms, tracks_played
        FROM user_stats
        WHERE user_id = ?
    `).get(userId);

    return user || { total_listening_ms: 0, tracks_played: 0 };
}

/**
 * Get top servers for a user
 */
function getTopServers(userId, limit = 3) {
    const db = getStatsDB();

    const stmt = db.prepare(`
        SELECT guild_id, listening_ms
        FROM server_stats
        WHERE user_id = ? AND listening_ms > 0
        ORDER BY listening_ms DESC
        LIMIT ?
    `);

    return stmt.all(userId, limit);
}

/**
 * Get top friends for a user
 */
function getTopFriends(userId, limit = 3) {
    const db = getStatsDB();

    const stmt = db.prepare(`
        SELECT friend_id, SUM(shared_ms) as total_shared_ms
        FROM shared_listening
        WHERE user_id = ? AND shared_ms > 0
        GROUP BY friend_id
        ORDER BY total_shared_ms DESC
        LIMIT ?
    `);

    return stmt.all(userId, limit);
}

/**
 * Get top tracks for a user
 */
function getTopTracks(userId, limit = 3) {
    const db = getStatsDB();

    const stmt = db.prepare(`
        SELECT track_title, track_artist, listening_ms, play_count
        FROM track_stats
        WHERE user_id = ? AND listening_ms > 0
        ORDER BY listening_ms DESC
        LIMIT ?
    `);

    return stmt.all(userId, limit);
}

/**
 * Clean up orphaned sessions (called on bot startup)
 */
function cleanupOrphanedSessions() {
    const db = getStatsDB();
    const now = Date.now();
    const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours

    // Find sessions older than 24 hours
    const staleSessions = db.prepare(`
        SELECT session_id FROM active_sessions
        WHERE started_at < ?
    `).all(now - staleThreshold);

    for (const session of staleSessions) {
        try {
            endSession(session.session_id);
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
