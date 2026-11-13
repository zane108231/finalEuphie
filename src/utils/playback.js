const {
    MessageFlags,
    ContainerBuilder,
    TextDisplayBuilder,
    EmbedBuilder,
    PermissionFlagsBits,
} = require("discord.js");
const config = require("../../config");
const { isHumanVoiceMember } = require("./voiceMembers");

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

function buildAlreadyInUsePayload(channel) {
    const name = channel?.name || "a voice channel";
    const mention = channel?.id ? `<#${channel.id}>` : name;
    const container = new ContainerBuilder();
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `### 🎧 I am already in this ${name}\n\n` +
            "**Channel**\n" +
            `-# ${mention}\n\n` +
            "**Why**\n" +
            "-# First come, first served. Join that voice channel, or wait until I leave."
        )
    );
    return {
        containerPayload: {
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        },
        embedPayload: {
            embeds: [
                new EmbedBuilder()
                    .setColor(config.accentColor || 0x2b2d31)
                    .setTitle(`🎧 I am already in this ${name}`)
                    .setDescription(`I'm already connected to ${mention}. Join that channel, or wait until I'm not in a voice channel.`)
            ],
        },
    };
}

async function replyAlreadyInUse(interaction, channel) {
    const { containerPayload, embedPayload } = buildAlreadyInUsePayload(channel);
    try {
        if (interaction.deferred || interaction.replied) {
            return await interaction.editReply(containerPayload);
        }
        return await interaction.reply(containerPayload);
    } catch {
        try {
            if (interaction.deferred || interaction.replied) {
                return await interaction.editReply(embedPayload);
            }
            return await interaction.reply(embedPayload);
        } catch {
            return null;
        }
    }
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
    if (currentOccupied && currentOccupied.id !== voiceChannelId) {
        throw new Error(`Bot ${client.botId} is already occupied in voice channel ${currentOccupied.id}`);
    }

    const botMember = await getVoiceChannelBotMember(
        client,
        guildId,
        voiceChannelId,
        voiceChannelObject
    );
    let player = client.riffy.players.get(guildId);
    if (player) {
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
    clearPlayerIdleTimeout(player);
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

function clearPlayerIdleTimeout(player, guildData) {
    if (player?.idleTimeout) {
        clearTimeout(player.idleTimeout);
        player.idleTimeout = null;
    }
    if (guildData?.idleTimeout) {
        clearTimeout(guildData.idleTimeout);
        guildData.idleTimeout = null;
    }
}

function setPlayerIdleTimeout(client, player, guildData, reason = "idle") {
    if (!player || !client) return;
    if (guildData?.twentyFourSeven && reason !== "empty") return;

    clearPlayerIdleTimeout(player, guildData);

    console.log(`[euphire] Setting 3-minute idle timeout (${reason}) for bot ${client.botId} in VC ${player.voiceChannel}`);

    player.idleTimeout = setTimeout(async () => {
        // If track is playing or queue is not empty, do not leave (unless empty VC reason)
        if (reason !== "empty" && (player.playing || (player.queue && player.queue.length > 0))) {
            player.idleTimeout = null;
            return;
        }

        const coordinator = require("./mongoCoordinator");
        const { endSession } = require("./mongoStats");
        const { saveGuildData } = require("./mongoGuildData");
        const { EmbedBuilder } = require("discord.js");

        console.log(`[euphire] Idle timeout reached (${reason}), bot ${client.botId} leaving voice channel ${player.voiceChannel}`);

        // Check if bot is still in the voice channel
        const botMember = client.guilds.cache.get(player.guildId)?.members?.cache?.get(client.user.id);
        const currentVoiceChannel = botMember?.voice?.channel;

        if (!currentVoiceChannel || currentVoiceChannel.id !== player.voiceChannel) {
            player.idleTimeout = null;
            return;
        }

        // If reason is empty, verify channel is still empty of non-bot humans
        if (reason === "empty") {
            const humans = currentVoiceChannel.members.filter(isHumanVoiceMember);
            if (humans.size > 0) {
                console.log(`[euphire] Humans returned to VC ${player.voiceChannel}, cancelling empty-leave`);
                player.idleTimeout = null;
                return;
            }
        }

        // Send leaving message to text channel
        const channelId = player.assignedTextChannel || player.textChannel || guildData.playerChannelId;
        const targetLeaveChannel = channelId ? client.channels.cache.get(channelId) : null;
        if (targetLeaveChannel) {
            try {
                const leaveMsg =
                    reason === "empty"
                        ? "No human members left in voice channel, leaving :wave:"
                        : "No tracks have been playing for the past 3 minutes, leaving :wave:";
                const leaveEmbed = new EmbedBuilder().setColor(0xED4245).setDescription(leaveMsg);
                await targetLeaveChannel.send({ embeds: [leaveEmbed] });
            } catch (err) {
                console.error("[euphire] Failed to send leave message:", err.message);
            }
        }

        // End active session if any
        if (player.currentSessionId) {
            const listenedMs = player.position || (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);
            await endSession(player.currentSessionId, false, listenedMs).catch(() => {});
            player.currentSessionId = null;
        }

        // Release bot from coordinator
        markIntentionalDisconnect(player);
        if (player.voiceChannel) {
            await coordinator.releaseBot(player.voiceChannel);
        }
        if (coordinator.botSessions.has(client.botId)) {
            for (const vcId of [...coordinator.botSessions.get(client.botId)]) {
                await coordinator.releaseBot(vcId);
            }
        }
        coordinator.markBotAvailable(client.botId);
        guildData.djOwnerId = null;

        if (targetLeaveChannel && guildData.playerChannelId === targetLeaveChannel.id) {
            guildData.playerMessageId = null;
            guildData.playerChannelId = null;
        }
        await saveGuildData(player.guildId, guildData);

        try {
            player.destroy();
        } catch {}
        player.idleTimeout = null;
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
    replyAlreadyInUse,
    buildAlreadyInUsePayload,
};
