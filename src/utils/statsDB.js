const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = path.join(__dirname, "..", "..", "data", "statistics.db");
let db = null;

/**
 * Initialize the statistics database with all required tables
 */
function initStatsDB() {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(DB_PATH);

    // Disable foreign key constraints
    db.pragma("foreign_keys = OFF");

    // Enable WAL mode for better performance
    db.pragma("journal_mode = WAL");

    // Create user statistics table
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_stats (
            user_id TEXT PRIMARY KEY,
            total_listening_ms INTEGER DEFAULT 0,
            tracks_played INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
            updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        )
    `);

    // Create server statistics table (listening time per server per user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS server_stats (
            user_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            listening_ms INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, guild_id)
        )
    `);

    // Create track statistics table (listening time per track per user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS track_stats (
            user_id TEXT NOT NULL,
            track_id TEXT NOT NULL,
            track_title TEXT NOT NULL,
            track_artist TEXT,
            track_uri TEXT,
            listening_ms INTEGER DEFAULT 0,
            play_count INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, track_id)
        )
    `);

    // Create shared listening table (time spent listening together)
    db.exec(`
        CREATE TABLE IF NOT EXISTS shared_listening (
            user_id TEXT NOT NULL,
            friend_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            shared_ms INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, friend_id, guild_id)
        )
    `);

    // Create active sessions table (for tracking ongoing sessions)
    db.exec(`
        CREATE TABLE IF NOT EXISTS active_sessions (
            session_id TEXT PRIMARY KEY,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            track_id TEXT NOT NULL,
            track_title TEXT NOT NULL,
            track_artist TEXT,
            track_uri TEXT,
            started_at INTEGER NOT NULL,
            last_position_ms INTEGER DEFAULT 0,
            is_paused INTEGER DEFAULT 0
        )
    `);

    // Create shared session participants table
    db.exec(`
        CREATE TABLE IF NOT EXISTS session_participants (
            session_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            joined_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, user_id),
            FOREIGN KEY (session_id) REFERENCES active_sessions(session_id) ON DELETE CASCADE
        )
    `);

    // Create indexes for performance
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_server_stats_user ON server_stats(user_id);
        CREATE INDEX IF NOT EXISTS idx_server_stats_guild ON server_stats(guild_id);
        CREATE INDEX IF NOT EXISTS idx_track_stats_user ON track_stats(user_id);
        CREATE INDEX IF NOT EXISTS idx_track_stats_id ON track_stats(track_id);
        CREATE INDEX IF NOT EXISTS idx_shared_user ON shared_listening(user_id);
        CREATE INDEX IF NOT EXISTS idx_shared_friend ON shared_listening(friend_id);
        CREATE INDEX IF NOT EXISTS idx_shared_guild ON shared_listening(guild_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_guild ON active_sessions(guild_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON active_sessions(user_id);
    `);

    console.log("[euphire] Statistics database initialized.");
    return db;
}

/**
 * Get the database instance (initializes if needed)
 */
function getStatsDB() {
    if (!db) {
        return initStatsDB();
    }
    return db;
}

/**
 * Close the database connection
 */
function closeStatsDB() {
    if (db) {
        db.close();
        db = null;
    }
}

module.exports = {
    initStatsDB,
    getStatsDB,
    closeStatsDB,
};
