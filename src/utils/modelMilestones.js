const { getDB, isDBConnected } = require("./database");
const { applyGuildBotProfile } = require("./guildBotProfile");
const coordinator = require("./mongoCoordinator");

const MODEL_THRESHOLD_MS = 100 * 60 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 5000;
const MAX_SAMPLE_DELTA_MS = 15000;
const playerTrackers = new WeakMap();

function requireDatabase() {
    if (!isDBConnected()) {
        throw new Error("Statistics database is not connected.");
    }
    return getDB();
}

async function seedLegacyGuildStats(guildId) {
    const db = requireDatabase();
    const legacyStats = await db.collection("serverStats")
        .find({ guildId, listeningMs: { $gt: 0 } }, { projection: { userId: 1, listeningMs: 1 } })
        .toArray();
    const modelStats = db.collection("modelListeningStats");

    for (const entry of legacyStats) {
        await modelStats.updateOne(
            { guildId, userId: entry.userId },
            {
                $setOnInsert: {
                    guildId,
                    userId: entry.userId,
                    listeningMs: entry.listeningMs,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            },
            { upsert: true }
        );
    }
}

async function findGuildMember(guildId, userId) {
    for (const client of coordinator.getAllClients()) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        return guild.members.fetch(userId);
    }
    throw new Error(`No Euphie bot is in server ${guildId}.`);
}

async function getModelChannelId(guildId) {
    const data = await requireDatabase()
        .collection("guildData")
        .findOne({ guildId }, { projection: { modelNotificationChannelId: 1 } });
    return data?.modelNotificationChannelId || null;
}

async function notifyModel(guildId, userId, channelId) {
    if (!channelId) return false;

    let channel = null;
    for (const client of coordinator.getAllClients()) {
        if (!client.guilds.cache.has(guildId)) continue;
        channel = client.channels.cache.get(channelId)
            || await client.channels.fetch(channelId).catch(() => null);
        if (channel) break;
    }

    if (!channel?.isTextBased?.() || !channel.send) {
        throw new Error(`Configured model notification channel ${channelId} is unavailable.`);
    }

    await channel.send({
        content: `<@${userId}> has hit 100 hours using Euphie. You are now the model.`,
        allowedMentions: { users: [userId] },
    });
    return true;
}

async function applyModel(guildId, targetMember, channelId = null) {
    const result = await applyGuildBotProfile(guildId, targetMember, { copyAvatar: false });
    if (!result.updated.length) {
        throw new Error(`Could not update any Euphie profiles in server ${guildId}.`);
    }

    await requireDatabase().collection("guildData").updateOne(
        { guildId },
        {
            $set: {
                guildId,
                botModelUserId: targetMember.id,
                botModelSince: Date.now(),
            },
        },
        { upsert: true }
    );

    if (result.errors.length) {
        return {
            ...result,
            notified: false,
            profileError: new Error(`Could not update: ${result.errors.map(({ botName }) => botName).join(", ")}.`),
        };
    }

    const configuredChannelId = channelId || await getModelChannelId(guildId);
    try {
        const notified = await notifyModel(guildId, targetMember.id, configuredChannelId);
        return { ...result, notified, notificationChannelId: configuredChannelId };
    } catch (notificationError) {
        return { ...result, notified: false, notificationError, notificationChannelId: configuredChannelId };
    }
}

async function processQualifiedUser(guildId, userId) {
    const db = requireDatabase();
    const stats = db.collection("modelListeningStats");
    const config = await db.collection("guildData").findOne(
        { guildId },
        { projection: { modelNotificationChannelId: 1 } }
    );
    if (!config?.modelNotificationChannelId) {
        await stats.updateOne(
            { guildId, userId, listeningMs: { $gte: MODEL_THRESHOLD_MS }, milestoneStatus: { $nin: ["complete", "processing"] } },
            { $set: { milestoneStatus: "awaiting-channel" } }
        );
        return;
    }

    const now = Date.now();
    const claim = await stats.updateOne(
        {
            guildId,
            userId,
            listeningMs: { $gte: MODEL_THRESHOLD_MS },
            $or: [
                { milestoneStatus: { $exists: false } },
                { milestoneStatus: { $in: ["pending", "awaiting-channel"] } },
                { milestoneStatus: "retry", retryAt: { $lte: now } },
            ],
        },
        { $set: { milestoneStatus: "processing" } }
    );
    if (!claim.modifiedCount) return;

    try {
        const targetMember = await findGuildMember(guildId, userId);
        const result = await applyModel(guildId, targetMember, config.modelNotificationChannelId);
        if (result.profileError) throw result.profileError;
        if (result.notificationError) throw result.notificationError;
        await stats.updateOne(
            { guildId, userId, milestoneStatus: "processing" },
            { $set: { milestoneStatus: "complete", milestoneCompletedAt: Date.now() }, $unset: { retryAt: "" } }
        );
    } catch (error) {
        await stats.updateOne(
            { guildId, userId, milestoneStatus: "processing" },
            { $set: { milestoneStatus: "retry", retryAt: Date.now() + 60000 } }
        );
        console.error(`[euphire] Failed to apply 100-hour model milestone for ${userId} in ${guildId}:`, error);
    }
}

async function recordListeningTime(guildId, userId, durationMs) {
    if (!guildId || !userId || !Number.isFinite(durationMs) || durationMs <= 0) return;

    const db = requireDatabase();
    const stats = db.collection("modelListeningStats");
    const existing = await stats.findOne({ guildId, userId }, { projection: { _id: 1 } });
    if (!existing) {
        const legacy = await db.collection("serverStats").findOne(
            { guildId, userId },
            { projection: { listeningMs: 1 } }
        );
        await stats.updateOne(
            { guildId, userId },
            {
                $setOnInsert: {
                    guildId,
                    userId,
                    listeningMs: legacy?.listeningMs || 0,
                    createdAt: Date.now(),
                },
            },
            { upsert: true }
        );
    }

    await stats.updateOne(
        { guildId, userId },
        {
            $inc: { listeningMs: Math.floor(durationMs) },
            $set: { updatedAt: Date.now() },
            $setOnInsert: { guildId, userId, createdAt: Date.now() },
        },
        { upsert: true }
    );

    const userStats = await stats.findOne(
        { guildId, userId },
        { projection: { listeningMs: 1, milestoneStatus: 1, retryAt: 1 } }
    );
    const retryReady = userStats?.milestoneStatus !== "retry" || userStats.retryAt <= Date.now();
    if (
        userStats?.listeningMs >= MODEL_THRESHOLD_MS &&
        !["complete", "awaiting-channel", "processing"].includes(userStats.milestoneStatus) &&
        retryReady
    ) {
        await processQualifiedUser(guildId, userId);
    }
}

async function samplePlayer(client, player, state) {
    if (state.busy) return;
    state.busy = true;

    try {
        const info = player.current?.info;
        const now = Date.now();
        if (!player.playing || player.paused || !info?.title) {
            state.trackKey = null;
            state.position = null;
            state.sampledAt = now;
            return;
        }

        const trackKey = info.identifier || info.uri || info.title;
        const position = Number(player.position);
        let listenedMs = 0;

        if (
            state.trackKey === trackKey &&
            Number.isFinite(position) &&
            Number.isFinite(state.position)
        ) {
            const positionDelta = position - state.position;
            if (positionDelta > 0 && positionDelta <= MAX_SAMPLE_DELTA_MS) {
                listenedMs = positionDelta;
            } else if (!info.length && now > state.sampledAt) {
                listenedMs = Math.min(now - state.sampledAt, SAMPLE_INTERVAL_MS + 2000);
            }
        }

        state.trackKey = trackKey;
        state.position = Number.isFinite(position) ? position : null;
        state.sampledAt = now;

        if (!listenedMs) return;
        await recordCurrentListeners(client, player, listenedMs);
    } finally {
        state.busy = false;
    }
}

async function recordCurrentListeners(client, player, listenedMs) {
    const voiceChannel = client.channels.cache.get(player.voiceChannel);
    if (!voiceChannel?.members) return;

    const listeners = [...voiceChannel.members.values()]
        .filter((member) => !member.user?.bot)
        .map((member) => member.id);

    await Promise.all(listeners.map((userId) =>
        recordListeningTime(player.guildId, userId, listenedMs)
    ));
}

function startPlayerTracking(client, player) {
    const existing = playerTrackers.get(player);
    if (existing) return;

    const state = {
        client,
        busy: false,
        trackKey: null,
        position: null,
        sampledAt: Date.now(),
        timer: null,
        pending: null,
    };
    state.timer = setInterval(() => {
        if (state.pending) return;
        state.pending = samplePlayer(client, player, state)
            .catch((error) => {
                console.error(`[euphire] Failed to record model listening time in ${player.guildId}:`, error);
            })
            .finally(() => {
                state.pending = null;
            });
    }, SAMPLE_INTERVAL_MS);
    playerTrackers.set(player, state);
}

async function stopPlayerTracking(player, flush = false) {
    const state = playerTrackers.get(player);
    if (!state) return;
    clearInterval(state.timer);
    playerTrackers.delete(player);

    if (state.pending) await state.pending;
    if (!flush) return;

    const info = player.current?.info;
    const trackKey = info?.identifier || info?.uri || info?.title;
    const position = Number(player.position);
    if (
        !info?.title ||
        trackKey !== state.trackKey ||
        !Number.isFinite(position) ||
        !Number.isFinite(state.position)
    ) {
        return;
    }

    const finalDelta = position - state.position;
    if (finalDelta > 0 && finalDelta <= MAX_SAMPLE_DELTA_MS) {
        try {
            await recordCurrentListeners(state.client, player, finalDelta);
        } catch (error) {
            console.error(`[euphire] Failed to flush final model listening sample in ${player.guildId}:`, error);
        }
    }
}

async function setNotificationChannel(guildId, channelId) {
    await requireDatabase().collection("guildData").updateOne(
        { guildId },
        { $set: { guildId, modelNotificationChannelId: channelId } },
        { upsert: true }
    );

    await seedLegacyGuildStats(guildId);
    const pending = await requireDatabase()
        .collection("modelListeningStats")
        .find({
            guildId,
            listeningMs: { $gte: MODEL_THRESHOLD_MS },
            milestoneStatus: { $nin: ["complete", "processing"] },
        })
        .sort({ updatedAt: 1 })
        .toArray();
    for (const entry of pending) {
        await processQualifiedUser(guildId, entry.userId);
    }

    return pending.length;
}

async function getGuildModelStats(guildId, limit = 10) {
    await seedLegacyGuildStats(guildId);
    return requireDatabase()
        .collection("modelListeningStats")
        .find({ guildId, listeningMs: { $gt: 0 } })
        .sort({ listeningMs: -1 })
        .limit(limit)
        .toArray();
}

async function getCurrentModelUserId(guildId) {
    const data = await requireDatabase()
        .collection("guildData")
        .findOne({ guildId }, { projection: { botModelUserId: 1 } });
    return data?.botModelUserId || null;
}

async function manuallySetModel(guildId, targetMember) {
    const channelId = await getModelChannelId(guildId);
    if (!channelId) {
        throw new Error("Set this server's model notification channel first with /modelchannel.");
    }

    await seedLegacyGuildStats(guildId);
    const result = await applyModel(guildId, targetMember, channelId);
    const stats = requireDatabase().collection("modelListeningStats");
    const existing = await stats.findOne(
        { guildId, userId: targetMember.id },
        { projection: { listeningMs: 1, milestoneStatus: 1 } }
    );
    if (
        result.notified &&
        !result.profileError &&
        !result.notificationError &&
        existing?.listeningMs >= MODEL_THRESHOLD_MS &&
        existing.milestoneStatus !== "complete"
    ) {
        await stats.updateOne(
            { guildId, userId: targetMember.id },
            { $set: { milestoneStatus: "complete", milestoneCompletedAt: Date.now() } }
        );
    }
    return result;
}

module.exports = {
    MODEL_THRESHOLD_MS,
    startPlayerTracking,
    stopPlayerTracking,
    setNotificationChannel,
    getGuildModelStats,
    getCurrentModelUserId,
    manuallySetModel,
};
