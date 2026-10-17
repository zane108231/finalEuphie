const { MessageFlags, ContainerBuilder, TextDisplayBuilder, EmbedBuilder } = require("discord.js");
const config = require("../../config");

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
    const coordinator = require("./mongoCoordinator");
    
    // 1. Check coordinator recorded channel
    const botId = client?.botId;
    if (botId) {
        const vcId = coordinator.getBotVoiceChannel(botId);
        if (vcId) {
            const channel = guild?.channels?.cache?.get(vcId) || client.channels?.cache?.get(vcId);
            if (channel) return channel;
            return { id: vcId, name: "another voice channel" };
        }
    }

    // 2. Check guild voiceStates cache (always kept fresh by Discord Gateway)
    if (guild && client.user) {
        const vs = guild.voiceStates?.cache?.get(client.user.id);
        if (vs?.channelId) {
            return guild.channels?.cache?.get(vs.channelId) || { id: vs.channelId, name: "another voice channel" };
        }
    }

    // 3. Check across all client guilds for voice connection
    if (client.guilds?.cache) {
        for (const [, g] of client.guilds.cache) {
            const vs = g.voiceStates?.cache?.get(client.user?.id);
            if (vs?.channelId) {
                return g.channels?.cache?.get(vs.channelId) || { id: vs.channelId, name: "another voice channel" };
            }
            const me = g.members?.cache?.get(client.user?.id) || g.members?.me;
            if (me?.voice?.channelId) {
                return me.voice.channel || g.channels?.cache?.get(me.voice.channelId) || { id: me.voice.channelId, name: "another voice channel" };
            }
        }
    }

    // 4. Check riffy player
    if (guild) {
        const player = client.riffy?.players?.get(guild.id);
        if (player?.voiceChannel) {
            return guild.channels?.cache?.get(player.voiceChannel) || { id: player.voiceChannel, name: "another voice channel" };
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

async function ensurePlayer(client, { guildId, voiceChannelId, textChannelId, volume = 75, requesterId = null }) {
    const coordinator = require("./mongoCoordinator");

    // Anti-theft guard: if this bot is currently in a DIFFERENT voice channel, refuse to steal/move it
    const currentOccupied = getOccupiedVoiceChannel(client.guilds?.cache?.get(guildId), client);
    if (currentOccupied && currentOccupied.id !== voiceChannelId) {
        throw new Error(`Bot ${client.botId} is already occupied in voice channel ${currentOccupied.id}`);
    }

    let player = client.riffy.players.get(guildId);
    if (player) {
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

        let me = client.guilds.cache.get(guildId)?.members?.me;
        if (!me) {
            try {
                me = await client.guilds.cache.get(guildId)?.members?.fetchMe();
            } catch {}
        }
        if (voiceChannelId && me?.voice?.channelId !== voiceChannelId) {
            player.connect({
                guildId,
                voiceChannel: voiceChannelId,
                deaf: true,
                mute: false,
            });
        }
        return player;
    }

    await waitForNode(client.riffy);

    player = client.riffy.createConnection({
        guildId,
        voiceChannel: voiceChannelId,
        textChannel: textChannelId,
        deaf: true,
    });
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

module.exports = {
    isActivelyPlaying,
    isDuplicateTrack,
    startIfIdle,
    markPlayerIdle,
    ensurePlayer,
    setAnnounceChannel,
    setVolumeSafe,
    waitForNode,
    getOccupiedVoiceChannel,
    replyAlreadyInUse,
    buildAlreadyInUsePayload,
};
