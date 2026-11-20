const {
    EmbedBuilder,
    PermissionFlagsBits,
} = require("discord.js");
const { getHumanVoiceMembers } = require("./voiceMembers");

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isActivelyPlaying(player) {
    return Boolean(player && player.current && (player.playing || player.paused));
}

function isDuplicateTrack(player, track) {
    if (!player || !track?.info?.uri) return false;

    const inQueue = player.queue.some((existing) => existing.info?.uri === track.info.uri);
    if (inQueue) return true;

    if (isActivelyPlaying(player) && player.current.info?.uri === track.info.uri) {
        return true;
    }

    return false;
}

function markPlayerIdle(player) {
    if (!player) return;
    player.playing = false;
    player.paused = false;
}

function markIntentionalDisconnect(player) {
    if (player) player._intentionalDisconnect = true;
}

function catchRest(promise) {
    if (promise && typeof promise.catch === "function") {
        return promise.catch(() => null);
    }
    return promise;
}

function getConnectedNode(riffy) {
    return [...riffy.nodeMap.values()].find((node) => node.connected) || null;
}

async function waitForNode(riffy, timeoutMs = 10000) {
    let node = getConnectedNode(riffy);
    if (node) return node;

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        node = getConnectedNode(riffy);
        if (node) return node;
        await sleep(250);
    }

    throw new Error("Lavalink node is not available");
}

function getOccupiedVoiceChannel(guild, client) {
    if (!guild || !client) return null;

    // 1. Check guild voiceStates cache (always kept fresh by Discord Gateway)
    if (client.user) {
        const vs = guild.voiceStates?.cache?.get(client.user.id);
        if (vs?.channelId) {
            return guild.channels?.cache?.get(vs.channelId) || { id: vs.channelId, name: "another voice channel", guild };
        }
        const me = guild.members?.cache?.get(client.user.id) || guild.members?.me;
        if (me?.voice?.channelId) {
            return me.voice?.channel || guild.channels?.cache?.get(me.voice.channelId) || { id: me.voice.channelId, name: "another voice channel", guild };
        }
    }

    // 2. Check riffy player for this guild
    const player = client.riffy?.players?.get(guild.id);
    if (player?.voiceChannel) {
        return guild.channels?.cache?.get(player.voiceChannel) || { id: player.voiceChannel, name: "another voice channel", guild };
    }

    // 3. Check coordinator recorded channel if it exists in THIS guild
    const coordinator = require("./mongoCoordinator");
    const botId = client?.botId;
    if (botId && guild?.id) {
        const vcId = coordinator.getBotVoiceChannelInGuild
            ? coordinator.getBotVoiceChannelInGuild(botId, guild.id)
            : coordinator.getBotVoiceChannel(botId, guild.id);
        if (vcId) {
            const channel = guild.channels?.cache?.get(vcId);
            if (channel) return channel;
        }
    }

    return null;
}

function buildNoBotsAvailablePayload() {
    const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setDescription(
            "There are no more bots available in this server, looks like I am popular😎\n\n" +
                "**You can invite 3 more bots for free! Check out the invite command for more information.**"
        );

    return {
        embeds: [embed],
    };
}

async function replyNoBotsAvailable(interaction) {
    const payload = buildNoBotsAvailablePayload();
    if (interaction.deferred || interaction.replied) {
        return interaction.editReply(payload);
    }
    return interaction.reply(payload);
}

async function getVoiceChannelBotMember(
    client,
    guildId,
    voiceChannelId,
    voiceChannelObject
) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        throw new Error(`Euphie ${client.user?.username || client.botId} is not available in this server.`);
    }

    const botMember = guild.members.me || (await guild.members.fetchMe());
    if (botMember.voice?.channelId === voiceChannelId) return botMember;

    let voiceChannel =
        voiceChannelObject?.id === voiceChannelId &&
        voiceChannelObject.guild?.id === guildId
            ? voiceChannelObject
            : guild.channels.cache.get(voiceChannelId);
    if (!voiceChannel) {
        voiceChannel = await guild.channels.fetch(voiceChannelId);
    }
    if (!voiceChannel?.permissionsFor) {
        throw new Error(`Could not check permissions for voice channel ${voiceChannelId}.`);
    }

    const permissionMember =
        voiceChannel.guild?.members?.cache?.get(client.user.id) || botMember;
    const permissions = voiceChannel.permissionsFor(permissionMember);
    const missingPermissions = [
        ["View Channel", PermissionFlagsBits.ViewChannel],
        ["Connect", PermissionFlagsBits.Connect],
    ].filter(([, permission]) => !permissions?.has(permission));

    if (missingPermissions.length > 0) {
        const botLabel = client.user?.id
            ? `<@${client.user.id}>`
            : `Euphie ${client.botId}`;
        const missing = missingPermissions
            .map(([name]) => `**${name}**`)
            .join(" and ");
        const permissionLabel =
            missingPermissions.length === 1 ? "permission" : "permissions";
        const error = new Error(
            `I can't join <#${voiceChannelId}> because ${botLabel} is missing ${missing} ${permissionLabel}. ` +
                `Allow it in the temporary channel's permissions, or in your TempVoice category/template. ` +
                "For music playback, also allow **Speak**. Administrator permission is not required."
        );
        error.code = "VOICE_CHANNEL_PERMISSION_MISSING";
        throw error;
    }

    return botMember;
}

async function ensurePlayer(client, {
    guildId,
    voiceChannelId,
    voiceChannelObject = null,
    textChannelId,
    volume = 75,
    requesterId = null,
    restoringSession = false,
}) {
    const coordinator = require("./mongoCoordinator");
    const { installPlayerPersistence } = require("./playbackRecovery");

    // Anti-theft guard: if this bot is currently in a DIFFERENT voice channel in THIS guild, refuse to steal/move it
    const currentOccupied = getOccupiedVoiceChannel(client.guilds?.cache?.get(guildId), client);
    const existingPlayer = client.riffy.players.get(guildId);
    const currentVoiceSessionOwner = currentOccupied
        ? coordinator.getSessionOwner(currentOccupied.id)
        : null;
    const currentPlayerIsIdle =
        !existingPlayer ||
        existingPlayer._waitingRoom ||
        (!existingPlayer.playing &&
            !existingPlayer.paused &&
            !existingPlayer.queue?.length);
    const canLeaveWaitingRoom =
        currentOccupied &&
        require("./waitingRoom").isWaitingRoomChannel(
            guildId,
            currentOccupied.id
        ) &&
        currentVoiceSessionOwner !== client.botId &&
        currentPlayerIsIdle;
    if (
        currentOccupied &&
        currentOccupied.id !== voiceChannelId &&
        !canLeaveWaitingRoom
    ) {
        throw new Error(`Bot ${client.botId} is already occupied in voice channel ${currentOccupied.id}`);
    }

    const botMember = await getVoiceChannelBotMember(
        client,
        guildId,
        voiceChannelId,
        voiceChannelObject
    );
    let player = existingPlayer;
    if (player) {
        if (
            currentOccupied &&
            currentOccupied.id !== voiceChannelId &&
            canLeaveWaitingRoom
        ) {
            player._movingFromWaitingRoom = true;
        }
        player._waitingRoom = false;
        if (restoringSession) player._restoringSession = true;
        player.volume = volume;
        if (textChannelId) {
            player.textChannel = textChannelId;
            player.assignedTextChannel = textChannelId;
            if (voiceChannelId) {
                coordinator.setSessionChannel(voiceChannelId, textChannelId);
            }
        }
        if (voiceChannelId) player.voiceChannel = voiceChannelId;
        if (requesterId) {
            player.requesterId = requesterId;
            if (voiceChannelId) coordinator.setSessionDJ(voiceChannelId, requesterId);
        }

        if (voiceChannelId && botMember.voice?.channelId !== voiceChannelId) {
            player.connect({
                guildId,
                voiceChannel: voiceChannelId,
                deaf: true,
                mute: false,
            });
        }
        installPlayerPersistence(client, player);
        return player;
    }

    await waitForNode(client.riffy);

    player = client.riffy.createConnection({
        guildId,
        voiceChannel: voiceChannelId,
        textChannel: textChannelId,
        deaf: true,
    });
    player._movingFromWaitingRoom = Boolean(
        currentOccupied &&
        currentOccupied.id !== voiceChannelId &&
        canLeaveWaitingRoom
    );
    player._waitingRoom = false;
    if (restoringSession) player._restoringSession = true;
    player.volume = volume;
    if (textChannelId) {
        player.assignedTextChannel = textChannelId;
        if (voiceChannelId) {
            coordinator.setSessionChannel(voiceChannelId, textChannelId);
        }
    }
    if (requesterId) {
        player.requesterId = requesterId;
        if (voiceChannelId) coordinator.setSessionDJ(voiceChannelId, requesterId);
    }
    installPlayerPersistence(client, player);
    return player;
}

function setAnnounceChannel(player, guildData, channelId) {
    if (!channelId) return;
    const coordinator = require("./mongoCoordinator");
    if (player) {
        player.textChannel = channelId;
        player.assignedTextChannel = channelId;
        if (player.voiceChannel) {
            coordinator.setSessionChannel(player.voiceChannel, channelId);
        }
    }
    if (guildData) guildData.playerChannelId = channelId;
}

async function startIfIdle(player) {
    if (!player) return player;
    if (player._pendingResumeSnapshot) return player;
    clearPlayerIdleTimeout(player, null, true);
    if (player.playing || player.paused) return player;
    if (!player.queue.length) return player;

    try {
        const result = player.play();
        if (result && typeof result.catch === "function") {
            await result.catch((err) => {
                if (err?.message?.includes("Queue is empty")) return;
                console.error("[euphire] Failed to start playback:", err.message);
            });
        }
    } catch (err) {
        if (err?.message?.includes("Queue is empty")) return player;
        console.error("[euphire] Failed to start playback:", err.message);
    }

    return player;
}

function setVolumeSafe(player, volume) {
    if (!player) return;
    player.volume = volume;
    if (!player.playing && !player.paused) return;
    catchRest(
        player.node?.rest?.updatePlayer?.({
            guildId: player.guildId,
            data: { volume },
        })
    );
}

function clearPlayerIdleTimeout(player, guildData, preserveEmpty = false) {
    const keepEmptyTimeout =
        preserveEmpty &&
        player?._idleTimeoutReason === "empty" &&
        Boolean(player.idleTimeout);
    if (player && !keepEmptyTimeout) {
        if (player.idleTimeout) clearTimeout(player.idleTimeout);
        player.idleTimeout = null;
        player._idleTimeoutReason = null;
    }
}

function setPlayerIdleTimeout(client, player, guildData, reason = "idle") {
    if (!player || !client) return;
    if (player._idleTimeoutReason === "empty") {
        if (player.idleTimeout) return;
        player._idleTimeoutReason = null;
    }

    clearPlayerIdleTimeout(player, guildData);

    console.log(`[euphire] Setting 3-minute idle timeout (${reason}) for bot ${client.botId} in VC ${player.voiceChannel}`);

    player._idleTimeoutReason = reason;
    player.idleTimeout = setTimeout(async () => {
        const clearScheduledTimeout = () => {
            player.idleTimeout = null;
            player._idleTimeoutReason = null;
        };

        if (player._waitingRoom) {
            clearScheduledTimeout();
            return;
        }

        // If track is playing or queue is not empty, do not leave (unless empty VC reason)
        if (reason !== "empty" && (player.playing || (player.queue && player.queue.length > 0))) {
            clearScheduledTimeout();
            return;
        }

        const coordinator = require("./mongoCoordinator");
        const { endSession } = require("./mongoStats");
        const { EmbedBuilder } = require("discord.js");

        console.log(`[euphire] Idle timeout reached (${reason}), bot ${client.botId} leaving voice channel ${player.voiceChannel}`);

        // Check if bot is still in the voice channel
        const guild = client.guilds.cache.get(player.guildId);
        const botVoiceState = guild?.voiceStates?.cache?.get(client.user.id);
        const botMember =
            guild?.members?.cache?.get(client.user.id) || guild?.members?.me;
        const currentVoiceChannelId =
            botVoiceState?.channelId || botMember?.voice?.channelId;

        if (currentVoiceChannelId && currentVoiceChannelId !== player.voiceChannel) {
            console.log(
                `[euphire] Idle timeout for ${player.guildId} found bot in ${currentVoiceChannelId}, not ${player.voiceChannel}; cancelling`
            );
            clearScheduledTimeout();
            return;
        }

        let currentVoiceChannel =
            guild?.channels?.cache?.get(player.voiceChannel) || null;
        if (!currentVoiceChannel && guild?.channels?.fetch) {
            try {
                currentVoiceChannel = await guild.channels.fetch(
                    player.voiceChannel
                );
            } catch (error) {
                console.error(
                    `[euphire] Could not fetch voice channel ${player.voiceChannel} at idle timeout:`,
                    error.message
                );
            }
        }

        // If reason is empty, verify channel is still empty of non-bot humans
        if (reason === "empty" && currentVoiceChannel) {
            const humans = getHumanVoiceMembers(guild, currentVoiceChannel);
            if (humans.length > 0) {
                console.log(`[euphire] Humans returned to VC ${player.voiceChannel}, cancelling empty-leave`);
                clearScheduledTimeout();
                return;
            }
        }

        // Send leaving message to text channel
        const channelId = player.assignedTextChannel || player.textChannel;
        let targetLeaveChannel = channelId
            ? client.channels.cache.get(channelId)
            : null;
        if (!targetLeaveChannel && channelId) {
            try {
                targetLeaveChannel = await client.channels.fetch(channelId);
            } catch (error) {
                console.error(
                    `[euphire] Could not fetch leave-notice channel ${channelId}:`,
                    error.message
                );
            }
        }

        const currentSessionId = player.currentSessionId;
        const listenedMs =
            player.position ||
            (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);
        player.currentSessionId = null;
        let returnedToWaitingRoom = false;
        try {
            returnedToWaitingRoom =
                await require("./waitingRoom").returnPlayerToWaitingRoom(
                    client,
                    player
                );
        } catch (error) {
            console.error(
                `[euphire] Failed to return idle bot ${client.botId} to the waiting room:`,
                error.message
            );
        }
        if (!returnedToWaitingRoom) {
            markIntentionalDisconnect(player);
            try {
                player.destroy();
            } catch (error) {
                console.error(
                    `[euphire] Failed to destroy idle player in guild ${player.guildId}:`,
                    error.message
                );
            }
        }
        clearScheduledTimeout();

        if (targetLeaveChannel) {
            try {
                const leaveMsg =
                    reason === "empty"
                        ? returnedToWaitingRoom
                            ? "No one has been listening for the past 3 minutes, returning to the Euphie Waiting Room 👋"
                            : "No one has been listening for the past 3 minutes, leaving 👋"
                        : returnedToWaitingRoom
                          ? "No tracks have been playing for the past 3 minutes, returning to the Euphie Waiting Room 👋"
                          : "No tracks have been playing for the past 3 minutes, leaving :wave:";
                const leaveEmbed = new EmbedBuilder().setColor(0xED4245).setDescription(leaveMsg);
                await targetLeaveChannel.send({ embeds: [leaveEmbed] });
            } catch (err) {
                console.error("[euphire] Failed to send leave message:", err.message);
            }
        }

        // End active session if any
        if (currentSessionId) {
            try {
                await endSession(currentSessionId, false, listenedMs);
            } catch (error) {
                console.error(
                    `[euphire] Failed to end session ${currentSessionId} during idle leave:`,
                    error.message
                );
            }
        }

        // Release bot from coordinator
        try {
            if (!returnedToWaitingRoom && player.voiceChannel) {
                await coordinator.releaseBot(player.voiceChannel, client.botId);
            }
        } catch (error) {
            console.error(
                `[euphire] Failed to release bot ${client.botId} after idle leave:`,
                error.message
            );
        }
    }, 3 * 60 * 1000); // 3 minutes
}

module.exports = {
    isActivelyPlaying,
    isDuplicateTrack,
    startIfIdle,
    markPlayerIdle,
    markIntentionalDisconnect,
    ensurePlayer,
    setAnnounceChannel,
    setVolumeSafe,
    setPlayerIdleTimeout,
    clearPlayerIdleTimeout,
    waitForNode,
    getOccupiedVoiceChannel,
    replyNoBotsAvailable,
    buildNoBotsAvailablePayload,
};
