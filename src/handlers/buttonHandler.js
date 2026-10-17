const { MessageFlags, AttachmentBuilder } = require("discord.js");
const { getGuildData, saveGuildData, clearUpdateInterval } = require("../utils/mongoGuildData");
const { createNowPlayingContainer, createChatPlayNowPlayingContainer, createQueueContainer, createChatPlayIdleContainer } = require("../utils/components");
const { generateMusicCard } = require("../utils/musicard");
const { addNodeDetails } = require("../utils/nodeDetails");
const { canControlMusic, canUseMusicAction, denyMusicMessage, VOICE_CHANNEL_DENIAL } = require("../utils/permissions");
const { startIfIdle, setVolumeSafe } = require("../utils/playback");
const { endSession, startSession, addSessionParticipant } = require("../utils/mongoStats");
const coordinator = require("../utils/mongoCoordinator");
const config = require("../../config");

/**
 * Handle all button and select menu interactions from the player container
 */
async function handleButtonInteraction(client, interaction) {
    // Handle help menu interactions
    if (interaction.customId === 'help_command_select' || interaction.customId === 'help_back') {
        const helpCommand = require('../commands/help');
        await helpCommand.handleInteraction(interaction, client);
        return;
    }

    // Handle Last.fm verification
    if (interaction.customId === 'lastfm_verify') {
        const loginCommand = require('../commands/login');
        await loginCommand.handleVerify(interaction);
        return;
    }

    // Handle Lyrics dropdown and pagination interactions
    if (interaction.customId === 'lyrics_select' || interaction.customId?.startsWith('lyrics_page_')) {
        const lyricsCommand = require('../commands/lyrics');
        await lyricsCommand.handleInteraction(interaction, client);
        return;
    }

    // Handle Queue dropdown and pagination interactions
    if (interaction.customId === 'queue_select' || interaction.customId?.startsWith('queue_page_')) {
        const queueCommand = require('../commands/queue');
        await queueCommand.handleInteraction(interaction, client);
        return;
    }

    if (!client.riffy) {
        console.warn('[euphire] Riffy client not initialized; button handler ignored.');
        return;
    }

    const { formatCmd } = require("../utils/prefix");
    const getCmd = (name, subcommand = null) => formatCmd(name, subcommand, interaction.guild.id);
    const guildId = interaction.guild.id;
    
    // Get the session owner for this voice channel
    const voiceChannelId = interaction.member?.voice?.channel?.id;
    const sessionOwner = coordinator.resolveSessionOwner(voiceChannelId, interaction.guild) || coordinator.getSessionOwner(voiceChannelId);
    
    // Get the correct riffy instance
    const targetRiffy = sessionOwner ? coordinator.getRiffy(sessionOwner) : client.riffy;
    
    let player = targetRiffy?.players?.get(guildId);
    if (!player) {
        for (const c of coordinator.getAllClients()) {
            if (c.riffy?.players) {
                for (const [, p] of c.riffy.players) {
                    if (p && p.voiceChannel === voiceChannelId) {
                        player = p;
                        break;
                    }
                }
            }
            if (player) break;
        }
    }
    const guildData = getGuildData(guildId);

    // If no player exists but ChatPlay was active, try to recreate it
    if (!player && guildData.chatPlayChannelId && guildData.chatPlayEnabled) {
        const voiceChannel = interaction.member?.voice?.channel;
        if (voiceChannel) {
            try {
                player = targetRiffy.createConnection({
                    guildId: guildId,
                    voiceChannel: voiceChannel.id,
                    textChannel: guildData.chatPlayChannelId,
                    deaf: true,
                });
                // Restore volume
                player.volume = guildData.volume;
                console.log(`[euphire] Recreated player for guild ${guildId} after restart`);
            } catch (err) {
                console.error(`[euphire] Failed to recreate player for guild ${guildId}:`, err.message);
            }
        }
    }

    // Handle status back button - return to main status view
    if (interaction.isButton() && interaction.customId === "status_back") {
        await interaction.deferUpdate();

        const { ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
        const { formatIncidents } = require("../utils/incidents");

        const nodes = client.riffy.nodeMap;
        const nodeList = Array.isArray(nodes)
            ? nodes
            : nodes instanceof Map
              ? [...nodes.values()]
              : Object.values(nodes || {});

        const connectedNodes = nodeList.filter(n => n.connected || n.isConnected).length;
        const botPing = client.ws?.ping ?? 0;
        const uptimeSeconds = process.uptime();
        const startTime = new Date(Date.now() - uptimeSeconds * 1000);

        let statusEmoji = "🟢";
        let statusText = "All systems operational";
        if (connectedNodes === 0 || botPing > 300) {
            statusEmoji = "🔴";
            statusText = "Major system issues detected";
        } else if (botPing > 100) {
            statusEmoji = "🟡";
            statusText = "Some systems experiencing issues";
        }

        const container = new ContainerBuilder();

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`## ${statusEmoji} ${statusText}`)
        );

        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `**Recent Incidents**\n` +
                formatIncidents(4)
            )
        );

        container.addSeparatorComponents(new SeparatorBuilder().setDivider(false));

        const supportButton = new ButtonBuilder()
            .setLabel("Known Outages")
            .setURL("https://discord.gg/MRjEUhDCpZ")
            .setStyle(ButtonStyle.Link);

        const voteButton = new ButtonBuilder()
            .setLabel("⭐ Vote")
            .setURL("https://top.gg/bot/1502977716196999309/vote")
            .setStyle(ButtonStyle.Link);

        container.addActionRowComponents(new ActionRowBuilder().addComponents(supportButton, voteButton));

        container.addSeparatorComponents(new SeparatorBuilder().setDivider(false));

        const startTimestamp = Math.floor(startTime.getTime() / 1000);

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `**Uptime**\n` +
                `-# 🕒 <t:${startTimestamp}:f> (<t:${startTimestamp}:R>)\n` +
                `-# *Times shown in your local timezone*`
            )
        );

        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

        const node = nodeList[0];
        const connected = node?.connected || node?.isConnected || false;
        const nodeStatusEmoji = connected ? "🟢" : "🔴";

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "### Lavalink Node Status\n" +
                `-# ${nodeStatusEmoji} ${connected ? "Connected" : "Disconnected"}`
            )
        );

        try {
            await interaction.editReply({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
            });
        } catch (err) {
            console.error("[euphire] Status back error:", err.message);
        }
        return;
    }

    // Handle help dropdown navigation
    if (interaction.isStringSelectMenu() && interaction.customId === "help_select") {
        await interaction.deferUpdate();

        const selectedPage = interaction.values[0];
        const { buildHelpPage } = require("../commands/help");
        client._helpGuildId = interaction.guild.id;
        const container = await buildHelpPage(client, selectedPage);

        try {
            await interaction.editReply({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
            });
        } catch (err) {
            console.error("[euphire] Help select error:", err.message);
        }
        return;
    }

    // Handle song suggestion select menu
    if (interaction.isStringSelectMenu() && interaction.customId === "song_suggestion") {
        if (!player) {
            return interaction.reply({ content: `❌ No music playing. Start with ${getCmd("play")} or ChatPlay!`, flags: MessageFlags.Ephemeral });
        }
        if (!canControlMusic(interaction.member, player)) {
            return interaction.reply({ content: VOICE_CHANNEL_DENIAL, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferUpdate();

        const selectedUri = interaction.values[0];
        const suggestion = guildData.suggestions.find(
            (s) => (s.info?.uri || s.info?.title) === selectedUri
        );

        if (suggestion) {
            suggestion.info.requester = interaction.user;
            player.queue.add(suggestion);
            await startIfIdle(player);
        }

        return;
    }

    // Handle buttons
    if (!interaction.isButton()) return;

    const customId = interaction.customId;

    // Queue button opens the queue UI
    if (customId === "queue") {
        if (!player || (!player.current && (!player.queue || player.queue.length === 0))) {
            return interaction.reply({ content: `❌ No music playing. Start with ${getCmd("play")} or ChatPlay!`, flags: MessageFlags.Ephemeral });
        }
        if (!canControlMusic(interaction.member, player)) {
            return interaction.reply({ content: VOICE_CHANNEL_DENIAL, flags: MessageFlags.Ephemeral });
        }
        const queueCommand = require("../commands/queue");
        return queueCommand.openQueueUI(interaction, client, player);
    }

    // Queue pagination buttons
    if (customId.startsWith("queue_") && customId !== "queue") {
        if (!player || !player.current) {
            return interaction.reply({ content: `❌ No music playing. Start with ${getCmd("play")} or ChatPlay!`, flags: MessageFlags.Ephemeral });
        }
        if (!canControlMusic(interaction.member, player)) {
            return interaction.reply({ content: VOICE_CHANNEL_DENIAL, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferUpdate();

        const totalTracks = player.queue.length;
        const pageSize = 10;
        const totalPages = Math.max(1, Math.ceil(totalTracks / pageSize));
        if (!guildData.queuePages) guildData.queuePages = new Map();
        let currentPage = guildData.queuePages.get(interaction.user.id) || 0;

        switch (customId) {
            case "queue_first":
                currentPage = 0;
                break;
            case "queue_prev":
                currentPage = Math.max(0, currentPage - 1);
                break;
            case "queue_next":
                currentPage = Math.min(totalPages - 1, currentPage + 1);
                break;
            case "queue_last":
                currentPage = totalPages - 1;
                break;
        }

        guildData.queuePages.set(interaction.user.id, currentPage);

        const queueContainer = createQueueContainer(
            player.queue,
            player.current,
            currentPage
        );

        try {
            await interaction.editReply({
                components: [queueContainer],
                flags: MessageFlags.IsComponentsV2,
            });
        } catch (err) {
            console.error("[euphire] Queue pagination error:", err.message);
        }
        return;
    }

    // Most buttons need an active player — send ephemeral if not
    const needsPlayer = ["pause_resume", "skip", "previous", "stop", "shuffle", "loop", "autoplay", "vol_up", "vol_down"];
    if (needsPlayer.includes(customId) && !player) {
        return interaction.reply({ content: `❌ No music playing. Start with ${getCmd("play")} or ChatPlay!`, flags: MessageFlags.Ephemeral });
    }

    if (needsPlayer.includes(customId) && !canControlMusic(interaction.member, player)) {
        return interaction.reply({ content: VOICE_CHANNEL_DENIAL, flags: MessageFlags.Ephemeral });
    }

    const buttonActionMap = {
        skip: "skip",
        previous: "skip",
        stop: "stop",
        shuffle: "shuffle",
        loop: "loop",
        vol_up: "volume",
        vol_down: "volume",
    };
    const requiredAction = buttonActionMap[customId];
    if (requiredAction && !(await canUseMusicAction(interaction.member, player, requiredAction))) {
        return interaction.reply({
            content: denyMusicMessage(interaction.guild.id, requiredAction),
            flags: MessageFlags.Ephemeral,
        });
    }

    // Defer immediately to avoid 3s timeout
    await interaction.deferUpdate();

    let needsVisualUpdate = false;

    switch (customId) {
        case "pause_resume": {
            if (player.paused) {
                // Resuming - start new session
                player.pause(false);
                try {
                    const requester = player.current?.info?.requester;
                    const userId = requester?.id || (typeof requester === "string" ? requester : null);
                    if (userId) {
                        const sessionId = await startSession(player.guildId, userId, player.current, client, player.voiceChannel);
                        player.currentSessionId = sessionId;
                        player.sessionStartedAt = Date.now();
                        player.sessionUserId = userId;
                        guildData.currentSessionId = sessionId;
                        
                        // Add current voice channel members as participants
                        const voiceChannel = client.channels.cache.get(player.voiceChannel);
                        if (voiceChannel) {
                            voiceChannel.members.forEach((member) => {
                                if (!member.user.bot && member.id !== userId) {
                                    addSessionParticipant(sessionId, member.id);
                                }
                            });
                        }
                    }
                } catch (err) {
                    console.error("[euphire] Failed to start stats session on resume:", err.message);
                }
            } else {
                // Pausing - commit time listened so far
                try {
                    const sessionId = player.currentSessionId || guildData.currentSessionId;
                    if (sessionId) {
                        console.log("[euphire] pause button: ending session (manual pause)");
                        const listenedMs = player.position || (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);
                        await endSession(sessionId, false, listenedMs);
                        player.currentSessionId = null;
                        guildData.currentSessionId = null;
                    }
                } catch (err) {
                    console.error("[euphire] Failed to end stats session on pause:", err.message);
                }
                player.pause(true);
            }
            needsVisualUpdate = true;
            break;
        }

        case "skip": {
            player.textChannel = interaction.channel.id;
            player.assignedTextChannel = interaction.channel.id;
            if (player.voiceChannel) {
                coordinator.setSessionChannel(player.voiceChannel, interaction.channel.id);
            }
            guildData.playerChannelId = interaction.channel.id;
            
            // End statistics session (skipped manually)
            try {
                const sessionId = player.currentSessionId || guildData.currentSessionId;
                if (sessionId) {
                    console.log("[euphire] skip button: ending session (manual skip)");
                    const listenedMs = player.position || (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);
                    await endSession(sessionId, false, listenedMs);
                    player.currentSessionId = null;
                    guildData.currentSessionId = null;
                }
            } catch (err) {
                console.error("[euphire] Failed to end stats session on skip:", err.message);
            }
            
            player.stop();
            break;
        }

        case "previous": {
            if (guildData.previousTracks.length > 0) {
                const prevTrack = guildData.previousTracks.pop();
                if (player.current) {
                    player.queue.unshift(player.current);
                }
                player.queue.unshift(prevTrack);
                player.stop();
            }
            break;
        }

        case "stop": {
            // If ChatPlay and 5+ songs in queue, ask for confirmation first
            const queueLength = player.queue?.length || 0;
            const isChatPlay = guildData.chatPlayChannelId && guildData.chatPlayMessageId;
            if (isChatPlay && queueLength >= 5 && !guildData.stopConfirmPending) {
                guildData.stopConfirmPending = interaction.user.id;
                // Clear confirmation after 15 seconds
                setTimeout(() => {
                    if (guildData.stopConfirmPending === interaction.user.id) {
                        guildData.stopConfirmPending = null;
                    }
                }, 15000);
                return interaction.followUp({
                    content: `⚠️ There are **${queueLength} songs** in the queue. Click stop again within 15 seconds to confirm.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            guildData.stopConfirmPending = null;

            // Release bot reservation (DJ releases ownership)
            if (player.voiceChannel) {
                const botId = coordinator.resolveSessionOwner(player.voiceChannel, interaction.guild) || coordinator.getSessionOwner(player.voiceChannel);
                await coordinator.releaseBot(player.voiceChannel);
                if (botId) {
                    coordinator.markBotAvailable(botId);
                }
            }

            // Clear DJ ownership from guildData
            guildData.djOwnerId = null;

            clearUpdateInterval(guildData);
            if (player.idleTimeout) {
                clearTimeout(player.idleTimeout);
                player.idleTimeout = null;
            }
            if (guildData.idleTimeout) {
                clearTimeout(guildData.idleTimeout);
                guildData.idleTimeout = null;
            }
            guildData.suggestions = [];
            guildData.previousTracks = [];

            // If ChatPlay, edit message back to idle state
            if (guildData.chatPlayChannelId && guildData.chatPlayMessageId) {
                try {
                    const container = createChatPlayIdleContainer();
                    const channel = client.channels.cache.get(guildData.chatPlayChannelId);
                    if (channel) {
                        const msg = await channel.messages.fetch(guildData.chatPlayMessageId);
                        await msg.edit({
                            components: [container],
                            attachments: [],
                            flags: MessageFlags.IsComponentsV2,
                        });
                    }
                } catch (err) {
                    console.error("[euphire] Failed to edit ChatPlay message on stop:", err.message);
                }
            } else if (guildData.playerMessageId && guildData.playerChannelId) {
                try {
                    const channel = client.channels.cache.get(guildData.playerChannelId);
                    if (channel) {
                        const msg = await channel.messages.fetch(guildData.playerMessageId);
                        await msg.delete();
                    }
                } catch (err) {
                    // message already deleted
                }
                guildData.playerMessageId = null;
                guildData.playerChannelId = null;
            }

            player.queue.clear();
            player.stop();

            // Always destroy player to release voice connection
            player.destroy();
            return;
        }

        case "shuffle": {
            if (player.queue.length > 0) {
                player.queue.shuffle();
                guildData.shuffle = true;
            }
            needsVisualUpdate = true;
            break;
        }

        case "loop": {
            if (guildData.loop === "none") {
                guildData.loop = "track";
                player.setLoop("track");
            } else if (guildData.loop === "track") {
                guildData.loop = "queue";
                player.setLoop("queue");
            } else {
                guildData.loop = "none";
                player.setLoop("none");
            }
            needsVisualUpdate = true;
            break;
        }

        case "autoplay": {
            guildData.autoplay = !guildData.autoplay;
            needsVisualUpdate = true;
            break;
        }

        case "vol_down": {
            guildData.volume = Math.max(0, guildData.volume - 10);
            setVolumeSafe(player, guildData.volume);
            needsVisualUpdate = true;
            break;
        }


        case "vol_up": {
            guildData.volume = Math.min(100, guildData.volume + 10);
            setVolumeSafe(player, guildData.volume);
            needsVisualUpdate = true;
            break;
        }

        default:
            break;
    }

    // If the button needs a visual update, edit the message directly
    if (needsVisualUpdate) {
        await editPlayerMessageDirectly(client, player, guildData);
    }
}

/**
 * Edit the player message directly (not via interaction.update)
 * This avoids the 3-second interaction timeout
 */
async function editPlayerMessageDirectly(client, player, guildData) {
    try {
        if (!player || !player.current) return;

        const musicardBuffer = await generateMusicCard(player.current, player, guildData);
        // Use ChatPlay container if in ChatPlay channel for consistent formatting
        const container = guildData.chatPlayChannelId && guildData.chatPlayMessageId
            ? createChatPlayNowPlayingContainer(player.current, player, guildData, musicardBuffer)
            : createNowPlayingContainer(player.current, player, guildData, musicardBuffer);

        const files = [];
        if (musicardBuffer) {
            files.push(new AttachmentBuilder(musicardBuffer, { name: "musicard.png" }));
        }

        const channelId = guildData.chatPlayChannelId || guildData.playerChannelId || player.textChannel;
        const channel = client.channels.cache.get(channelId);
        if (!channel) {
            guildData.chatPlayMessageId = null;
            guildData.playerMessageId = null;
            guildData.playerChannelId = null;
            return;
        }

        const messageId = guildData.chatPlayMessageId || guildData.playerMessageId;
        if (!messageId) return;

        const msg = await channel.messages.fetch(messageId);
        await msg.edit({
            components: [container],
            files: files,
            flags: MessageFlags.IsComponentsV2,
        });
    } catch (error) {
        // Message was deleted — clear stale IDs so next action sends a fresh one
        guildData.chatPlayMessageId = null;
        guildData.playerMessageId = null;
        guildData.playerChannelId = null;
        guildData.updateInterval && clearInterval(guildData.updateInterval);
        guildData.updateInterval = null;
        console.error("[euphire] Button edit error:", error.message);
    }
}


module.exports = { handleButtonInteraction };
