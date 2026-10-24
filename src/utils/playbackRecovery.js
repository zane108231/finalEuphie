const { getDB } = require("./database");
const { waitForNode } = require("./playback");
const coordinator = require("./mongoCoordinator");
const { getGuildData } = require("./mongoGuildData");

const PERSIST_DEBOUNCE_MS = 300;
const CHECKPOINT_INTERVAL_MS = 10000;

function getRequesterId(track) {
    const requester = track?.info?.requester;
    return requester?.id || (typeof requester === "string" ? requester : null);
}

function getRequesterName(track) {
    const requester = track?.info?.requester;
    return requester?.username || requester?.user?.username || null;
}

function serializeTrack(track) {
    const info = track?.info;
    if (!info?.uri) return null;

    return {
        uri: info.uri,
        identifier: info.identifier || null,
        title: info.title || "Unknown",
        author: info.author || "Unknown Artist",
        length: Number(info.length) || 0,
        requesterId: getRequesterId(track),
        requesterName: getRequesterName(track),
    };
}

async function removeSavedSession(guildId) {
    if (!guildId) return;
    await getDB().collection("playbackSessions").deleteOne({ guildId });
}

async function saveRecentlyPlayedTrack(track) {
    const requesterId = getRequesterId(track);
    const savedTrack = serializeTrack(track);
    if (!requesterId || !savedTrack) return;

    await getDB().collection("recentTracks").updateOne(
        { userId: requesterId },
        {
            $set: { userId: requesterId, updatedAt: Date.now() },
            $push: { tracks: { $each: [savedTrack], $slice: -20 } },
        },
        { upsert: true }
    );
}

async function persistPlayer(client, player) {
    if (!client || !player?.guildId) return;

    const queue = Array.from(player.queue || [])
        .map(serializeTrack)
        .filter(Boolean);
    const current =
        player.playing || player.paused ? serializeTrack(player.current) : null;

    if (!current && queue.length === 0) {
        await removeSavedSession(player.guildId);
        return;
    }

    const snapshot = {
        guildId: player.guildId,
        botId: client.botId,
        voiceChannelId: player.voiceChannel || null,
        textChannelId:
            player.assignedTextChannel || player.textChannel || null,
        sessionOwnerId:
            coordinator.getSessionDJ(player.voiceChannel) ||
            current?.requesterId ||
            null,
        currentTrack: current,
        queue,
        positionMs: Math.max(0, Number(player.position) || 0),
        volume: Number.isFinite(Number(player.volume))
            ? Math.max(0, Number(player.volume))
            : 75,
        savedAt: Date.now(),
    };

    await getDB()
        .collection("playbackSessions")
        .updateOne(
            { guildId: player.guildId },
            { $set: snapshot },
            { upsert: true }
        );
}

function schedulePersist(client, player) {
    if (player._restoringSession) return;

    clearTimeout(player._sessionPersistTimeout);
    player._sessionPersistTimeout = setTimeout(() => {
        player._sessionPersistTimeout = null;
        persistPlayer(client, player).catch((err) => {
            console.error(
                `[euphire] Failed to persist playback session for ${player.guildId}:`,
                err.message
            );
        });
    }, PERSIST_DEBOUNCE_MS);
}

function installPlayerPersistence(client, player) {
    if (!player?.queue || player._sessionPersistenceInstalled) return;

    player._sessionPersistenceInstalled = true;
    const queue = player.queue;
    const mutators = [
        "add",
        "push",
        "pop",
        "shift",
        "unshift",
        "splice",
        "clear",
        "remove",
        "move",
        "shuffle",
    ];

    for (const name of mutators) {
        const original = queue[name];
        if (typeof original !== "function") continue;

        queue[name] = function (...args) {
            const result = original.apply(this, args);
            schedulePersist(client, player);
            return result;
        };
    }
}

async function checkpointClient(client) {
    const players = Array.from(client?.riffy?.players?.values?.() || []);
    for (const player of players) {
        await persistPlayer(client, player);
    }
}

async function checkpointAllClients(clients) {
    for (const client of clients) {
        await checkpointClient(client);
    }
}

function resolveSavedTrack(client, savedTrack) {
    if (!savedTrack?.uri) return Promise.resolve(null);

    return client.riffy
        .resolve({
            query: savedTrack.uri,
            requester: savedTrack.requesterId
                ? { id: savedTrack.requesterId }
                : null,
        })
        .then((result) => {
            const tracks = result?.tracks || [];
            const track =
                tracks.find(
                    (candidate) =>
                        candidate.info?.identifier === savedTrack.identifier
                ) ||
                tracks.find(
                    (candidate) => candidate.info?.uri === savedTrack.uri
                ) ||
                tracks[0];

            if (track && savedTrack.requesterId) {
                track.info.requester = {
                    id: savedTrack.requesterId,
                    username: savedTrack.requesterName || "Unknown",
                };
            }
            return track || null;
        });
}

async function restoreSnapshot(client, snapshot) {
    if (!client?.isReady?.()) {
        throw new Error("The session's bot is not connected to Discord yet.");
    }
    if (!snapshot.voiceChannelId) {
        throw new Error("The saved session has no voice channel.");
    }
    if (!client.guilds.cache.has(snapshot.guildId)) {
        throw new Error("The saved guild is not available to this bot.");
    }

    await waitForNode(client.riffy);

    const guildData = getGuildData(snapshot.guildId);
    const guildDoc = await getDB()
        .collection("guildData")
        .findOne({ guildId: snapshot.guildId });
    if (guildDoc) Object.assign(guildData, guildDoc);

    const userId =
        snapshot.sessionOwnerId ||
        coordinator.getSessionDJ(snapshot.voiceChannelId) ||
        snapshot.currentTrack?.requesterId ||
        snapshot.queue?.[0]?.requesterId;

    await coordinator.reserveSpecificBot(
        snapshot.voiceChannelId,
        userId,
        client.botId,
        snapshot.guildId,
        true
    );

    const { ensurePlayer } = require("./playback");
    const player = await ensurePlayer(client, {
        guildId: snapshot.guildId,
        voiceChannelId: snapshot.voiceChannelId,
        textChannelId: snapshot.textChannelId,
        volume: Number.isFinite(Number(snapshot.volume))
            ? Number(snapshot.volume)
            : guildData.volume || 75,
        requesterId: userId,
    });

    player.assignedTextChannel = snapshot.textChannelId || null;
    player._restoringSession = true;
    player.queue.clear();

    const tracksToRestore = [
        snapshot.currentTrack,
        ...(Array.isArray(snapshot.queue) ? snapshot.queue : []),
    ].filter(Boolean);
    const resolvedTracks = [];
    let currentTrackRestored = false;
    for (let index = 0; index < tracksToRestore.length; index += 1) {
        const savedTrack = tracksToRestore[index];
        try {
            const track = await resolveSavedTrack(client, savedTrack);
            if (track) {
                resolvedTracks.push(track);
                if (index === 0 && snapshot.currentTrack) {
                    currentTrackRestored = true;
                }
            } else {
                console.warn(
                    `[euphire] Could not resolve saved track "${savedTrack.title}" in guild ${snapshot.guildId}`
                );
            }
        } catch (err) {
            console.error(
                `[euphire] Failed to resolve saved track "${savedTrack.title}" in guild ${snapshot.guildId}:`,
                err.message
            );
        }
    }

    for (const track of resolvedTracks) {
        player.queue.add(track);
    }
    player._restoringSession = false;

    if (resolvedTracks.length === 0) {
        await removeSavedSession(snapshot.guildId);
        await coordinator.releaseBot(snapshot.voiceChannelId);
        player.destroy();
        throw new Error("None of the saved tracks are available anymore.");
    }

    await player.play();
    if (
        currentTrackRestored &&
        snapshot.positionMs > 0 &&
        player.current
    ) {
        const trackLength = Number(player.current.info.length);
        if (trackLength > 0) {
            player.seek(
                Math.min(snapshot.positionMs, Math.max(0, trackLength - 1000))
            );
        }
    }

    await persistPlayer(client, player);
    console.log(
        `[euphire] Restored playback session for guild ${snapshot.guildId} (${resolvedTracks.length} track(s))`
    );
    return player;
}

async function restoreClientSessions(client) {
    await waitForNode(client.riffy, 60000);
    const snapshots = await getDB()
        .collection("playbackSessions")
        .find({ botId: client.botId })
        .toArray();

    for (const snapshot of snapshots) {
        try {
            await restoreSnapshot(client, snapshot);
        } catch (err) {
            console.error(
                `[euphire] Could not automatically restore guild ${snapshot.guildId}:`,
                err.message
            );
        }
    }
}

function startCheckpointing(client) {
    if (client._playbackCheckpointInterval) return;

    client._playbackCheckpointInterval = setInterval(() => {
        checkpointClient(client).catch((err) => {
            console.error(
                `[euphire] Playback checkpoint failed for ${client.botId}:`,
                err.message
            );
        });
    }, CHECKPOINT_INTERVAL_MS);
}

async function resumeGuildSession(guildId, userId) {
    const snapshot = await getDB()
        .collection("playbackSessions")
        .findOne({ guildId });
    if (!snapshot) return null;
    if (
        snapshot.sessionOwnerId &&
        String(snapshot.sessionOwnerId) !== String(userId)
    ) {
        throw new Error("Only the session owner can resume this session.");
    }

    const client = coordinator.getClient(snapshot.botId);
    if (!client) {
        throw new Error("The bot assigned to this saved session is unavailable.");
    }

    const existingPlayer = client.riffy?.players?.get(guildId);
    if (existingPlayer?.playing || existingPlayer?.paused) {
        return existingPlayer;
    }
    return restoreSnapshot(client, snapshot);
}

module.exports = {
    checkpointAllClients,
    installPlayerPersistence,
    persistPlayer,
    removeSavedSession,
    resumeGuildSession,
    restoreClientSessions,
    saveRecentlyPlayedTrack,
    startCheckpointing,
};
