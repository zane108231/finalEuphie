const { PermissionFlagsBits } = require("discord.js");
const { getGuildData, getGuildDataAsync } = require("./mongoGuildData");
const coordinator = require("./mongoCoordinator");

function getWaitingRoomConfig(guildId) {
    const data = getGuildData(guildId);
    return {
        enabled: data.waitingRoomEnabled === true,
        channelId: data.waitingRoomChannelId || null,
    };
}

function isWaitingRoomChannel(guildId, channelId) {
    const config = getWaitingRoomConfig(guildId);
    return config.enabled && config.channelId === channelId;
}

async function getRoomChannel(client, guild, channelId) {
    let channel = guild.channels.cache.get(channelId);
    if (!channel) channel = await guild.channels.fetch(channelId);
    if (!channel || !channel.isVoiceBased?.()) {
        throw new Error("The configured waiting room is not a voice channel.");
    }

    const botMember =
        guild.members.me || (await guild.members.fetch(client.user.id));
    const permissions = channel.permissionsFor(botMember);
    const missing = [
        ["View Channel", PermissionFlagsBits.ViewChannel],
        ["Connect", PermissionFlagsBits.Connect],
    ].filter(([, permission]) => !permissions?.has(permission));
    if (missing.length) {
        throw new Error(
            `Euphie is missing ${missing.map(([name]) => name).join(" and ")} in the waiting room.`
        );
    }

    return channel;
}

async function joinClientToWaitingRoom(client, guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild || !client.isReady()) return { status: "unavailable" };

    const data = await getGuildDataAsync(guildId);
    if (!data.waitingRoomEnabled || !data.waitingRoomChannelId) {
        return { status: "disabled" };
    }

    const channel = await getRoomChannel(
        client,
        guild,
        data.waitingRoomChannelId
    );
    const player = client.riffy?.players?.get(guildId);
    const botMember =
        guild.members.cache.get(client.user.id) || guild.members.me;
    const actualChannelId =
        guild.voiceStates?.cache?.get(client.user.id)?.channelId ||
        botMember?.voice?.channelId ||
        null;
    const currentChannelId = actualChannelId || player?.voiceChannel || null;

    if (
        player &&
        !player._waitingRoom &&
        (player.playing ||
            player.paused ||
            player.queue?.length ||
            (player.voiceChannel &&
                coordinator.getSessionOwner(player.voiceChannel) === client.botId))
    ) {
        return { status: "busy" };
    }
    if (
        currentChannelId &&
        currentChannelId !== channel.id &&
        !player?._waitingRoom
    ) {
        return { status: "busy" };
    }

    if (player) {
        player._waitingRoom = true;
        player.voiceChannel = channel.id;
        if (actualChannelId !== channel.id) {
            player.connect({
                guildId,
                voiceChannel: channel.id,
                deaf: true,
                mute: false,
            });
        }
    } else {
        const { ensurePlayer } = require("./playback");
        const waitingPlayer = await ensurePlayer(client, {
            guildId,
            voiceChannelId: channel.id,
            voiceChannelObject: channel,
            volume: data.volume,
        });
        waitingPlayer._waitingRoom = true;
    }
    await require("./playbackRecovery")
        .removeSavedSession(guildId, client.botId)
        .catch((error) => {
            console.error(
                `[euphire] Failed to clear old playback snapshot for waiting bot ${client.botId} in guild ${guildId}:`,
                error.message
            );
        });
    try {
        await require("./guildBotProfile").setGuildBotAvailability(
            client,
            guildId,
            true
        );
    } catch (error) {
        console.error(
            `[euphire] Failed to mark ${client.botId} available in guild ${guildId}:`,
            error
        );
    }

    return {
        status: currentChannelId === channel.id ? "already" : "joined",
    };
}

async function leaveClientWaitingRoom(client, guildId, channelId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild || !client.isReady()) return { status: "unavailable" };

    const player = client.riffy?.players?.get(guildId);
    const currentChannelId =
        guild.voiceStates?.cache?.get(client.user.id)?.channelId ||
        guild.members.cache.get(client.user.id)?.voice?.channelId ||
        player?.voiceChannel ||
        null;
    if (!currentChannelId || currentChannelId !== channelId) {
        return { status: "not-in-room" };
    }
    if (
        player &&
        !player._waitingRoom &&
        (player.playing || player.paused || player.queue?.length)
    ) {
        return { status: "busy" };
    }
    if (
        coordinator.getSessionOwner(channelId) === client.botId &&
        !player?._waitingRoom
    ) {
        return { status: "busy" };
    }

    if (player) {
        player._waitingRoom = true;
        player._intentionalDisconnect = true;
        player.destroy();
        coordinator.markBotAvailable(client.botId);
    } else {
        const member =
            guild.members.cache.get(client.user.id) || guild.members.me;
        await member?.voice?.disconnect();
    }
    try {
        await require("./guildBotProfile").setGuildBotAvailability(
            client,
            guildId,
            false
        );
    } catch (error) {
        console.error(
            `[euphire] Failed to remove the available label from ${client.botId} in guild ${guildId}:`,
            error
        );
    }
    return { status: "left" };
}

async function reconcileGuildWaitingRoom(guildId) {
    const data = await getGuildDataAsync(guildId);
    const clients = coordinator
        .getAllClients()
        .filter((client) => client.guilds.cache.has(guildId));
    const results = [];

    for (const client of clients) {
        try {
            const result = data.waitingRoomEnabled && data.waitingRoomChannelId
                ? await joinClientToWaitingRoom(client, guildId)
                : data.waitingRoomChannelId
                  ? await leaveClientWaitingRoom(
                        client,
                        guildId,
                        data.waitingRoomChannelId
                    )
                  : { status: "disabled" };
            results.push({ botId: client.botId, ...result });
        } catch (error) {
            console.error(
                `[euphire] Waiting room setup failed for ${client.botId} in guild ${guildId}:`,
                error
            );
            results.push({
                botId: client.botId,
                status: "error",
                error: error.message,
            });
        }
    }
    try {
        await require("./waitingRoomStatus").updateWaitingRoomStatus(guildId);
    } catch (error) {
        console.error(
            `[euphire] Failed to update the waiting-room status message in guild ${guildId}:`,
            error
        );
    }
    return results;
}

async function restoreClientWaitingRooms(client) {
    for (const guild of client.guilds.cache.values()) {
        try {
            const data = await getGuildDataAsync(guild.id);
            if (data.waitingRoomEnabled && data.waitingRoomChannelId) {
                const result = await joinClientToWaitingRoom(client, guild.id);
                if (result.status === "joined") {
                    console.log(
                        `[euphire] ${client.botId} joined the waiting room in guild ${guild.id}`
                    );
                }
            }
        } catch (error) {
            console.error(
                `[euphire] Could not restore ${client.botId} to the waiting room in guild ${guild.id}:`,
                error
            );
        }
    }
}

async function returnPlayerToWaitingRoom(client, player) {
    if (!player?.guildId || player._waitingRoom) return false;
    const alreadyStopping = player._returningToWaitingRoom === true;
    const playerClient =
        coordinator
            .getAllClients()
            .find(
                (candidate) =>
                    candidate.riffy?.players?.get(player.guildId) === player
            ) || client;
    const data = await getGuildDataAsync(player.guildId);
    if (!data.waitingRoomEnabled || !data.waitingRoomChannelId) return false;

    const guild = playerClient.guilds.cache.get(player.guildId);
    if (!guild) return false;
    const channel = await getRoomChannel(
        playerClient,
        guild,
        data.waitingRoomChannelId
    );
    const previousVoiceChannel = player.voiceChannel;

    if (player.currentSessionId) {
        const sessionId = player.currentSessionId;
        const listenedMs = player.position ||
            (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);
        player.currentSessionId = null;
        try {
            await require("./mongoStats").endSession(
                sessionId,
                false,
                listenedMs
            );
        } catch (error) {
            console.error(
                `[euphire] Failed to end stats session ${sessionId} while returning ${client.botId} to the waiting room:`,
                error
            );
        }
    }

    if (player.idleTimeout) clearTimeout(player.idleTimeout);
    player.idleTimeout = null;
    player._idleTimeoutReason = null;
    if (player._clearQueueRestoreTimer) {
        clearTimeout(player._clearQueueRestoreTimer);
        delete player._clearQueueRestoreTimer;
        delete player._clearQueueRequested;
        delete player._clearQueueLoopMode;
    }

    player._waitingRoom = true;
    delete player._returningToWaitingRoom;
    player.queue?.clear?.();
    player.setLoop?.("none");
    try {
        if (!alreadyStopping) player.stop?.();
    } catch (error) {
        console.error(
            `[euphire] Could not stop playback before returning ${playerClient.botId} to the waiting room:`,
            error.message
        );
    }
    player.playing = false;
    player.paused = false;
    player.current = null;
    player.currentSessionId = null;
    player.requesterId = null;
    player.assignedTextChannel = null;
    player.textChannel = null;
    player.leaveAfterQueueEnd = false;
    player.voiceChannel = channel.id;
    if (previousVoiceChannel !== channel.id) {
        player.connect({
            guildId: player.guildId,
            voiceChannel: channel.id,
            deaf: true,
            mute: false,
        });
    }

    if (previousVoiceChannel) {
        await coordinator.releaseBot(previousVoiceChannel, playerClient.botId);
    }

    const anotherActivePlayer = coordinator.getAllClients().some((candidate) => {
        if (candidate === playerClient) return false;
        const otherPlayer = candidate.riffy?.players?.get(player.guildId);
        return Boolean(otherPlayer?.voiceChannel && !otherPlayer._waitingRoom);
    });
    if (!anotherActivePlayer) {
        try {
            await require("./permissions").resetSessionPermissions(player.guildId);
        } catch (error) {
            console.error(
                `[euphire] Failed to reset session permissions after ${playerClient.botId} stopped playback:`,
                error
            );
        }
    }

    await require("./playbackRecovery")
        .removeSavedSession(player.guildId, playerClient.botId)
        .catch((error) => {
            console.error(
                `[euphire] Failed to clear playback snapshot after returning ${playerClient.botId} to the waiting room:`,
                error.message
            );
        });
    try {
        await require("./guildBotProfile").setGuildBotAvailability(
            playerClient,
            player.guildId,
            true
        );
    } catch (error) {
        console.error(
            `[euphire] Failed to mark ${playerClient.botId} available in guild ${player.guildId}:`,
            error
        );
    }
    return true;
}

module.exports = {
    getWaitingRoomConfig,
    isWaitingRoomChannel,
    joinClientToWaitingRoom,
    leaveClientWaitingRoom,
    reconcileGuildWaitingRoom,
    restoreClientWaitingRooms,
    returnPlayerToWaitingRoom,
};
