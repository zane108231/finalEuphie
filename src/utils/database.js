const { MongoClient } = require('mongodb');

// MongoDB connection
const uri = process.env.MONGODB_URI || "mongodb://jihyowoonjohn_db_user:3icvEm0NBfO0rOKS@ac-79ph0wc-shard-00-00.svsx6vk.mongodb.net:27017/?ssl=true&replicaSet=atlas-l5kk3s-shard-0&authSource=admin";
const client = new MongoClient(uri);
let db = null;
let isConnected = false;

async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("[euphire] Successfully connected to MongoDB!");
        
        // Get database name from URI or use default
        const dbName = uri.split('/').pop().split('?')[0] || 'euphire';
        db = client.db(dbName);
        isConnected = true;
        
        // Create indexes for performance
        await createIndexes();
        
        return client;
    } catch (err) {
        console.error("[euphire] MongoDB connection error:", err.message);
        throw err;
    }
}

async function disconnectFromMongoDB() {
    if (isConnected) {
        await client.close();
        isConnected = false;
        console.log("[euphire] Disconnected from MongoDB");
    }
}

async function createIndexes() {
    try {
        // Sessions collection indexes
        await db.collection('sessions').createIndex({ voiceChannelId: 1 }, { unique: true });
        await db.collection('sessions').createIndex({ botId: 1 });
        await db.collection('sessions').createIndex({ djUserId: 1 });
        await db.collection('sessions').createIndex({ guildId: 1 });
        
        // Guild data collection indexes
        await db.collection('guildData').createIndex({ guildId: 1 }, { unique: true });
        
        // User data collection indexes (for Last.fm)
        await db.collection('userData').createIndex({ userId: 1 }, { unique: true });
        
        // User stats collection indexes
        await db.collection('userStats').createIndex({ userId: 1 }, { unique: true });
        
        // Server stats collection indexes
        await db.collection('serverStats').createIndex({ userId: 1, guildId: 1 }, { unique: true });
        
        // Track stats collection indexes
        await db.collection('trackStats').createIndex({ userId: 1, trackId: 1 }, { unique: true });
        
        // Shared listening collection indexes
        await db.collection('sharedListening').createIndex({ userId: 1, friendId: 1, guildId: 1 }, { unique: true });
        
        // Active sessions collection indexes
        await db.collection('activeSessions').createIndex({ sessionId: 1 }, { unique: true });
        await db.collection('activeSessions').createIndex({ guildId: 1 });
        await db.collection('activeSessions').createIndex({ userId: 1 });

        // Music playback recovery and maintenance state
        await db.collection('playbackSessions').createIndex({ guildId: 1 }, { unique: true });
        await db.collection('playbackSessions').createIndex({ botId: 1 });
        await db.collection('recentTracks').createIndex({ userId: 1 }, { unique: true });
        await db.collection('playlistSelections').createIndex({ token: 1 }, { unique: true });
        await db.collection('playlistSelections').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        await db.collection('systemState').createIndex({ key: 1 }, { unique: true });
        
        // Session participants collection indexes
        await db.collection('sessionParticipants').createIndex({ sessionId: 1, userId: 1 }, { unique: true });
        
        console.log("[euphire] MongoDB indexes created successfully");
    } catch (err) {
        console.error("[euphire] Error creating indexes:", err.message);
    }
}

function getDB() {
    if (!isConnected || !db) {
        throw new Error("MongoDB not connected. Call connectToMongoDB() first.");
    }
    return db;
}

function isDBConnected() {
    return isConnected;
}

module.exports = {
    connectToMongoDB,
    disconnectFromMongoDB,
    getDB,
    isDBConnected,
};
