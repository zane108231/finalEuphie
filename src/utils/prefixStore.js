const config = require("../../config");
const { getDB, isDBConnected } = require("./database");

const DEFAULT_PREFIX = config.prefix || "e!";

// In-memory cache for ultra-fast synchronous lookup during messageCreate
// guildId -> Set<string>
const serverPrefixCache = new Map();
// userId -> { prefixes: Set<string>, combine: boolean }
const userPrefixCache = new Map();

let mongoSynced = false;

/**
 * Validate prefix syntax
 */
function isValidPrefix(val) {
    if (!val || typeof val !== "string") return false;
    const trimmed = val.trim();
    if (!trimmed.length || trimmed.length > 10) return false;
    if (/\s/.test(trimmed)) return false;
    if (/@everyone|@here|<@/i.test(trimmed)) return false;
    return true;
}

/**
 * Sync all prefixes from MongoDB collection 'prefixes'
 */
async function syncFromMongo() {
    if (!isDBConnected() || mongoSynced) return;
    try {
        const db = getDB();
        const docs = await db.collection("prefixes").find({}).toArray();

        for (const doc of docs) {
            if (doc.type === "server" && doc.targetId && Array.isArray(doc.prefixes)) {
                serverPrefixCache.set(String(doc.targetId), new Set(doc.prefixes));
            } else if (doc.type === "user" && doc.targetId) {
                userPrefixCache.set(String(doc.targetId), {
                    prefixes: new Set(Array.isArray(doc.prefixes) ? doc.prefixes : []),
                    combine: doc.combineWithServer !== false,
                });
            }
        }
        mongoSynced = true;
    } catch (err) {
        console.warn("[euphire] Failed to sync prefixes from MongoDB:", err.message);
    }
}

/**
 * Get server prefixes (array of strings)
 */
function getServerPrefixes(guildId) {
    if (isDBConnected() && !mongoSynced) {
        syncFromMongo().catch(() => {});
    }
    if (!guildId) return [DEFAULT_PREFIX];
    const cached = serverPrefixCache.get(String(guildId));
    if (cached && cached.size > 0) {
        return Array.from(cached);
    }
    return [DEFAULT_PREFIX];
}

/**
 * Get personal prefixes for user
 */
function getUserPrefixData(userId) {
    if (isDBConnected() && !mongoSynced) {
        syncFromMongo().catch(() => {});
    }
    if (!userId) return { prefixes: [], combine: true };
    const cached = userPrefixCache.get(String(userId));
    if (cached) {
        return {
            prefixes: Array.from(cached.prefixes),
            combine: cached.combine !== false,
        };
    }
    return { prefixes: [], combine: true };
}

/**
 * Get all valid prefixes for a given message context (guild + user)
 * Sorted by length descending so longer prefixes match first
 */
function getAllValidPrefixes(guildId, userId) {
    const serverPrefs = getServerPrefixes(guildId);
    const userPrefs = getUserPrefixData(userId);

    let combined = [];
    if (userPrefs.combine) {
        combined = [...serverPrefs, ...userPrefs.prefixes];
    } else {
        combined = userPrefs.prefixes.length > 0 ? userPrefs.prefixes : serverPrefs;
    }

    // Always include DEFAULT_PREFIX as fallback if empty
    if (!combined.length) {
        combined.push(DEFAULT_PREFIX);
    }

    // Deduplicate and sort by length descending
    const unique = Array.from(new Set(combined));
    return unique.sort((a, b) => b.length - a.length);
}

/**
 * Get primary prefix for display purposes
 */
function getPrefix(guildId, userId = null) {
    if (userId) {
        const userPrefs = getUserPrefixData(userId);
        if (userPrefs.prefixes.length > 0) {
            return userPrefs.prefixes[0];
        }
    }
    const serverPrefs = getServerPrefixes(guildId);
    return serverPrefs[0] || DEFAULT_PREFIX;
}

// ----------------------------------------------------------------------
// SERVER PREFIX ACTIONS (MongoDB)
// ----------------------------------------------------------------------

async function addServerPrefix(guildId, prefix) {
    if (!guildId || !isValidPrefix(prefix)) return false;
    const gId = String(guildId);
    let set = serverPrefixCache.get(gId);
    if (!set) {
        set = new Set([DEFAULT_PREFIX]);
        serverPrefixCache.set(gId, set);
    }
    set.add(prefix);

    if (isDBConnected()) {
        const db = getDB();
        await db.collection("prefixes").updateOne(
            { type: "server", targetId: gId },
            {
                $set: {
                    type: "server",
                    targetId: gId,
                    prefixes: Array.from(set),
                    updatedAt: Date.now(),
                },
            },
            { upsert: true }
        );
    }
    return true;
}

async function setServerPrefix(guildId, prefix) {
    if (!guildId || !isValidPrefix(prefix)) return false;
    const gId = String(guildId);
    serverPrefixCache.set(gId, new Set([prefix]));

    if (isDBConnected()) {
        const db = getDB();
        await db.collection("prefixes").updateOne(
            { type: "server", targetId: gId },
            {
                $set: {
                    type: "server",
                    targetId: gId,
                    prefixes: [prefix],
                    updatedAt: Date.now(),
                },
            },
            { upsert: true }
        );
    }
    return true;
}

async function removeServerPrefix(guildId, prefix) {
    if (!guildId) return false;
    const gId = String(guildId);
    const set = serverPrefixCache.get(gId);
    if (set) {
        set.delete(prefix);
        if (set.size === 0) set.add(DEFAULT_PREFIX);
    }

    if (isDBConnected()) {
        const db = getDB();
        const finalArray = set ? Array.from(set) : [DEFAULT_PREFIX];
        await db.collection("prefixes").updateOne(
            { type: "server", targetId: gId },
            {
                $set: {
                    type: "server",
                    targetId: gId,
                    prefixes: finalArray,
                    updatedAt: Date.now(),
                },
            },
            { upsert: true }
        );
    }
    return true;
}

async function resetServerPrefixes(guildId) {
    if (!guildId) return false;
    const gId = String(guildId);
    serverPrefixCache.delete(gId);

    if (isDBConnected()) {
        const db = getDB();
        await db.collection("prefixes").deleteOne({ type: "server", targetId: gId });
    }
    return true;
}

// ----------------------------------------------------------------------
// SELF (USER) PREFIX ACTIONS (MongoDB)
// ----------------------------------------------------------------------

async function addUserPrefix(userId, prefix) {
    if (!userId || !isValidPrefix(prefix)) return false;
    const uId = String(userId);
    let entry = userPrefixCache.get(uId);
    if (!entry) {
        entry = { prefixes: new Set(), combine: true };
        userPrefixCache.set(uId, entry);
    }
    entry.prefixes.add(prefix);

    if (isDBConnected()) {
        const db = getDB();
        await db.collection("prefixes").updateOne(
            { type: "user", targetId: uId },
            {
                $set: {
                    type: "user",
                    targetId: uId,
                    prefixes: Array.from(entry.prefixes),
                    combineWithServer: entry.combine,
                    updatedAt: Date.now(),
                },
            },
            { upsert: true }
        );
    }
    return true;
}

async function setUserPrefix(userId, prefix) {
    if (!userId || !isValidPrefix(prefix)) return false;
    const uId = String(userId);
    let entry = userPrefixCache.get(uId);
    const combine = entry ? entry.combine : true;
    userPrefixCache.set(uId, { prefixes: new Set([prefix]), combine });

    if (isDBConnected()) {
        const db = getDB();
        await db.collection("prefixes").updateOne(
            { type: "user", targetId: uId },
            {
                $set: {
                    type: "user",
                    targetId: uId,
                    prefixes: [prefix],
                    combineWithServer: combine,
                    updatedAt: Date.now(),
                },
            },
            { upsert: true }
        );
    }
    return true;
}

async function removeUserPrefix(userId, prefix) {
    if (!userId) return false;
    const uId = String(userId);
    const entry = userPrefixCache.get(uId);
    if (entry) {
        entry.prefixes.delete(prefix);
    }

    if (isDBConnected()) {
        const db = getDB();
        const finalArray = entry ? Array.from(entry.prefixes) : [];
        await db.collection("prefixes").updateOne(
            { type: "user", targetId: uId },
            {
                $set: {
                    type: "user",
                    targetId: uId,
                    prefixes: finalArray,
                    updatedAt: Date.now(),
                },
            },
            { upsert: true }
        );
    }
    return true;
}

async function resetUserPrefixes(userId) {
    if (!userId) return false;
    const uId = String(userId);
    userPrefixCache.delete(uId);

    if (isDBConnected()) {
        const db = getDB();
        await db.collection("prefixes").deleteOne({ type: "user", targetId: uId });
    }
    return true;
}

async function toggleUserCombine(userId) {
    if (!userId) return true;
    const uId = String(userId);
    let entry = userPrefixCache.get(uId);
    if (!entry) {
        entry = { prefixes: new Set(), combine: false };
        userPrefixCache.set(uId, entry);
    } else {
        entry.combine = !entry.combine;
    }

    if (isDBConnected()) {
        const db = getDB();
        await db.collection("prefixes").updateOne(
            { type: "user", targetId: uId },
            {
                $set: {
                    type: "user",
                    targetId: uId,
                    prefixes: Array.from(entry.prefixes),
                    combineWithServer: entry.combine,
                    updatedAt: Date.now(),
                },
            },
            { upsert: true }
        );
    }
    return entry.combine;
}

module.exports = {
    DEFAULT_PREFIX,
    isValidPrefix,
    syncFromMongo,
    getServerPrefixes,
    getUserPrefixData,
    getAllValidPrefixes,
    getPrefix,
    addServerPrefix,
    setServerPrefix,
    removeServerPrefix,
    resetServerPrefixes,
    addUserPrefix,
    setUserPrefix,
    removeUserPrefix,
    resetUserPrefixes,
    toggleUserCombine,
};
