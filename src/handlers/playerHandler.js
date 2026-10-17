const { MessageFlags, AttachmentBuilder, ContainerBuilder, TextDisplayBuilder, EmbedBuilder } = require("discord.js");
const { getGuildData, saveGuildData, clearUpdateInterval } = require("../utils/mongoGuildData");
const { getUserData } = require("../utils/mongoUserData");
const { createNowPlayingContainer, safeArtworkUrl } = require("../utils/components");
const { recordIncident } = require("../utils/incidents");
const { scheduleStatusUpdate } = require("../services/statusMonitor");
const { markPlayerIdle } = require("../utils/playback");
const { resetSessionPermissions } = require("../utils/permissions");
const { startSession, updateSessionProgress, endSession, addSessionParticipant, removeSessionParticipant } = require("../utils/mongoStats");
const { updateNowPlaying, scrobble } = require("../utils/lastfm");
const coordinator = require("../utils/mongoCoordinator");
const config = require("../../config");

// Store scrobble timers per user (userId -> timeout)
const scrobbleTimers = new Map();

const UPDATE_INTERVAL_MS = 30 * 1000; // Increased to 30 seconds to reduce CPU load

/**
 * Helper: edit the existing player message or send a new one (never duplicates)
 */
function isMissingPermissions(err) {
    const code = err?.code;
    const msg = String(err?.message || "");
    return code === 50013 || msg.includes("Missing Permissions") || msg.includes("Missing Access");
}

async function sendQueueEmptyNotice(channel, guildId, voiceChannelId, client) {
    if (!channel) return;
    
    // Check if this bot is the session owner for this voice channel
    const sessionOwner = coordinator.resolveSessionOwner(voiceChannelId, client.guilds.cache.get(guildId));
    if (sessionOwner && sessionOwner !== client.botId) {
        // Another bot owns this session, don't send duplicate message
        console.log(`[euphire] Skipping queue empty notice - bot ${client.botId} is not the session owner (owner: ${sessionOwner})`);
        return;
    }
    
    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setTitle("There are no more tracks");

    try {
        await channel.send({ embeds: [embed] });
    } catch {
        // Channel has no send permission
    }
}

async function editOrSendPlayerMessage(client, guildData, channelId, container, files, voiceChannelId) {
    if (guildData.cannotSendPlayer) return;

    // Check if this bot is the session owner for this voice channel
    if (voiceChannelId) {
        const sessionOwner = coordinator.getSessionOwner(voiceChannelId);
        if (sessionOwner && sessionOwner !== client.botId) {
            // Another bot owns this session, don't send duplicate message
            return;
        }
    }

    const channel = client.channels.cache.get(channelId);
    if (!channel) {
        // Channel no longer exists; clear stale IDs
        guildData.chatPlayMessageId = null;
        guildData.playerMessageId = null;
        guildData.playerChannelId = null;
        return;
    }

    const messageId = guildData.playerMessageId;

    if (messageId) {
        try {
            const msg = await channel.messages.fetch(messageId);
            await msg.edit({
                components: [container],
                files: files,
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        } catch (err) {
            console.log(`[euphire] Failed to edit player message: ${err.message}`);
            if (isMissingPermissions(err)) {
                guildData.cannotSendPlayer = true;
                clearUpdateInterval(guildData);
                return;
            }
            // Message or channel no longer exists — clear stale IDs and send a new one
            console.log(`[euphire] Clearing stale player message ID and sending new message`);
            guildData.chatPlayMessageId = null;
            guildData.playerMessageId = null;
            guildData.playerChannelId = null;
            guildData.updateInterval && clearInterval(guildData.updateInterval);
            guildData.updateInterval = null;
        }
    }

    try {
        const newMsg = await channel.send({
            components: [container],
            files: files,
            flags: MessageFlags.IsComponentsV2,
        });

        guildData.playerMessageId = newMsg.id;
        guildData.playerChannelId = channel.id;

        // Save to MongoDB
        const { saveGuildData } = require('../utils/mongoGuildData');
        await saveGuildData(client.guilds.cache.get(channel.guildId)?.id, guildData);
    } catch (sendErr) {
        if (isMissingPermissions(sendErr)) {
            guildData.cannotSendPlayer = true;
            clearUpdateInterval(guildData);
            return;
        }
        console.error("[euphire] Failed to send player message:", sendErr.message);
    }
}

function canSendToChannel(channel) {
    return Boolean(channel && typeof channel.send === "function");
}

function resolveAssignedChannel(client, player, guildData) {
    const ids = [
        player?.assignedTextChannel,
        player?.textChannel,
        player?.voiceChannel ? coordinator.getSessionChannel(player.voiceChannel) : null,
        player?.playerChannelId,
        guildData?.playerChannelId,
        player?.voiceChannel,
    ].filter(Boolean);

    const seen = new Set();
    for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const channel = client.channels.cache.get(id);
        if (canSendToChannel(channel)) return channel;
    }
    return null;
}

function resolveNowPlayingChannel(client, player, guildData) {
    return resolveAssignedChannel(client, player, guildData);
}

function requesterMention(track) {
    const requester = track?.info?.requester;
    const id = requester?.id || (typeof requester === "string" ? requester : null);
    return id ? `<@${id}>` : "Unknown";
}

function buildNowPlayingEmbedPayload(track, files) {
    const title = (track?.info?.title || "Unknown").substring(0, 256);
    const author = track?.info?.author || "Unknown Artist";
    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setTitle(`Now Playing — ${title}`)
        .setDescription(`By ${author}\nRequested by ${requesterMention(track)}`)
        .setThumbnail(safeArtworkUrl(track));
    if (files?.length) {
        embed.setImage("attachment://musicard.png");
    }
    return { embeds: [embed], files: files || [] };
}

async function sendNowPlayingPayload(channel, container, files, track) {
    try {
        return await channel.send({
            components: [container],
            files: files,
            flags: MessageFlags.IsComponentsV2,
        });
    } catch (err) {
        console.error("[euphire] Now playing (components) failed:", err.message);
    }

    try {
        return await channel.send(buildNowPlayingEmbedPayload(track, files));
    } catch (err) {
        console.error("[euphire] Now playing (embed) failed:", err.message);
    }

    try {
        const title = track?.info?.title || "Unknown";
        const author = track?.info?.author || "Unknown Artist";
        return await channel.send({
            content: `**Now Playing — ${title}**\nBy ${author}\nRequested by ${requesterMention(track)}`,
            files: files?.length ? files : undefined,
        });
    } catch (err) {
        console.error("[euphire] Now playing (text) failed:", err.message);
        return null;
    }
}

/**
 * Always post a new now-playing card in the play/skip text channel
 * (or the voice channel chat) so people can see the current track.
 */
async function announceNowPlaying(client, player, track, guildData) {
    // Check if this bot is the session owner for this voice channel
    const sessionOwner = coordinator.getSessionOwner(player.voiceChannel);
    if (sessionOwner && sessionOwner !== client.botId) {
        // Another bot owns this session, don't send duplicate message
        console.log(`[euphire] Skipping now playing - bot ${client.botId} is not the session owner (owner: ${sessionOwner})`);
        return;
    }

    // No musicard generation - removed
    const container = createNowPlayingContainer(track, player, guildData, null);
    const channel = resolveNowPlayingChannel(client, player, guildData);

    if (!channel) {
        console.warn(`[euphire] No channel available to send now playing for guild ${player.guildId}`);
        return;
    }

    const newMsg = await sendNowPlayingPayload(channel, container, [], track);
    if (!newMsg) return;

    const oldId = player.playerMessageId || guildData.playerMessageId;
    const oldChannelId = player.playerChannelId || guildData.playerChannelId;
    player.playerMessageId = newMsg.id;
    player.playerChannelId = channel.id;
    player.assignedTextChannel = channel.id;
    if (player.voiceChannel) {
        coordinator.setSessionChannel(player.voiceChannel, channel.id);
    }
    guildData.playerMessageId = newMsg.id;
    guildData.playerChannelId = channel.id;
    guildData.cannotSendPlayer = false;

    if (oldId && oldId !== newMsg.id) {
        const oldChannel = client.channels.cache.get(oldChannelId) || channel;
        oldChannel?.messages?.fetch(oldId).then((msg) => msg.delete()).catch(() => {});
    }

    if (guildData.chatPlayChannelId && guildData.chatPlayMessageId) {
        try {
            const chatChannel = client.channels.cache.get(guildData.chatPlayChannelId);
            const chatContainer = createChatPlayNowPlayingContainer(track, player, guildData, null);
            if (chatChannel && guildData.chatPlayMessageId !== newMsg.id) {
                const chatMsg = await chatChannel.messages.fetch(guildData.chatPlayMessageId);
                await chatMsg.edit({
                    components: [chatContainer],
                    flags: MessageFlags.IsComponentsV2,
                });
            }
        } catch {
            // ChatPlay panel is optional; the public now-playing already posted
        }
    }
}

/**
 * Refresh the player message with an updated musicard image
 * DISABLED: Since we removed the progress bar, we don't need periodic updates
 */
async function refreshPlayerMessage(client, guildId) {
    // Disabled - no longer needed since we don't have progress bars
    return;
}

/**
 * Start the 15-second auto-update interval for a guild
 */
function startUpdateInterval(client, guildId) {
    // Disabled - no longer needed since we don't have progress bars
    return;
}

/**
 * Set up all riffy player event handlers
 */
function setupPlayerHandler(client) {
    if (!client.riffy) {
        console.warn('[euphire] Riffy client not initialized; player handlers not attached.');
        return;
    }

    // Initialize statistics database
    (async () => {
        try {
            const { cleanupOrphanedSessions } = require("../utils/mongoStats");
            await cleanupOrphanedSessions();
        } catch (err) {
            console.error("[euphire] Failed to initialize statistics database:", err.message);
        }
    })();
    // --- Node Connected ---
    client.riffy.on("nodeConnect", (node) => {
        console.log(`[euphire] Lavalink node "${node.name}" connected.`);
        scheduleStatusUpdate(client, true);
    });

    // --- Node Error ---
    client.riffy.on("nodeError", (node, error) => {
        console.error(`[euphire] Node "${node.name}" error:`, error.message);
        recordIncident("Lavalink", `Node error: ${error.message.substring(0, 50)}`);
        scheduleStatusUpdate(client, true);
    });

    client.riffy.on("nodeDestroy", (node) => {
        console.warn(`[euphire] Node "${node.name}" was removed.`);
        scheduleStatusUpdate(client, true);
    });

    // --- Node Disconnect ---
    client.riffy.on("nodeDisconnect", (node) => {
        console.warn(`[euphire] Node "${node.name}" disconnected.`);
        recordIncident("Lavalink", "Node disconnected");
        scheduleStatusUpdate(client, true);
    });

    // --- Node Reconnected (Riffy built-in auto-reconnect) ---
    client.riffy.on("nodeReconnect", (node) => {
        console.log(`[euphire] Node "${node.name}" reconnected successfully.`);
        scheduleStatusUpdate(client, true);
    });

    // --- Track Start ---
    client.riffy.on("trackStart", async (player, track) => {
        try {
            // Check if this bot is the session owner for this voice channel
            const sessionOwner = coordinator.getSessionOwner(player.voiceChannel);
            if (sessionOwner && sessionOwner !== client.botId) {
                // Another bot owns this session, don't handle duplicate events
                console.log(`[euphire] Skipping trackStart - bot ${client.botId} is not the session owner (owner: ${sessionOwner})`);
                return;
            }

            // Check if the voice channel still exists
            const channel = client.channels.cache.get(player.voiceChannel);
            if (!channel) {
                console.log(`[euphire] Voice channel ${player.voiceChannel} no longer exists, releasing bot ${client.botId}`);
                await coordinator.releaseBot(player.voiceChannel);
                player.destroy();
                return;
            }

            const guildData = getGuildData(player.guildId);
            guildData.cannotSendPlayer = false;

            // Fallback: if previous track session was still open (e.g. trackEnd didn't fire), commit it naturally now!
            if (player.currentSessionId) {
                console.log(`[euphire] [${client.botId}] trackStart: ending previous track session ${player.currentSessionId} (completed naturally)`);
                try {
                    await endSession(player.currentSessionId, true);
                } catch (err) {
                    console.error("[euphire] Error ending previous session in trackStart:", err.message);
                }
                player.currentSessionId = null;
            }

            // Save the previous track for the "Previous" button
            if (player.previous) {
                if (!Array.isArray(guildData.previousTracks)) {
                    guildData.previousTracks = [];
                }
                guildData.previousTracks.push(player.previous);
                // Keep history limited to 20 tracks to prevent memory bloat
                if (guildData.previousTracks.length > 20) {
                    guildData.previousTracks.shift();
                }
            }

            // Last.fm scrobbling: update now playing for all users in VC
            try {
                const voiceChannel = client.channels.cache.get(player.voiceChannel);
                if (voiceChannel) {
                    const trackInfo = track.info;
                    const artist = trackInfo.author || "Unknown";
                    const trackName = trackInfo.title || "Unknown";
                    const album = trackInfo.album || null;
                    const duration = trackInfo.length || 0;

                    // Get all non-bot users in the voice channel
                    const members = voiceChannel.members.filter(m => !m.user.bot);
                    for (const [memberId, member] of members) {
                        const userData = await getUserData(memberId);
                        if (userData.lastfmSessionKey) {
                            // Update now playing
                            await updateNowPlaying(
                                userData.lastfmSessionKey,
                                artist,
                                trackName,
                                album,
                                duration
                            );
                            console.log(`[Last.fm] Updated now playing for ${userData.lastfmUsername}: ${trackName}`);

                            // Set up scrobble timer (50% of duration or 4 minutes, whichever comes first)
                            const scrobbleDelay = Math.min(
                                duration * 0.5,
                                4 * 60 * 1000 // 4 minutes
                            );

                            // Clear existing timer for this user
                            if (scrobbleTimers.has(memberId)) {
                                clearTimeout(scrobbleTimers.get(memberId));
                            }

                            // Set new scrobble timer
                            const timer = setTimeout(async () => {
                                try {
                                    await scrobble(
                                        userData.lastfmSessionKey,
                                        artist,
                                        trackName,
                                        album,
                                        Date.now(),
                                        duration
                                    );
                                    console.log(`[Last.fm] Scrobbled for ${userData.lastfmUsername}: ${trackName}`);
                                } catch (err) {
                                    console.error(`[Last.fm] Scrobble failed for ${userData.lastfmUsername}:`, err.message);
                                }
                            }, scrobbleDelay);

                            scrobbleTimers.set(memberId, timer);
                        }
                    }
                }
            } catch (err) {
                console.error("[Last.fm] Failed to update now playing:", err.message);
            }

            // Clear any idle timeout
            if (player.idleTimeout) {
                clearTimeout(player.idleTimeout);
                player.idleTimeout = null;
            }
            if (guildData.idleTimeout) {
                clearTimeout(guildData.idleTimeout);
                guildData.idleTimeout = null;
            }

            // Clear queue end time since a new track started
            guildData.queueEndTime = null;

            // Start statistics tracking session
            try {
                const requester = track.info.requester;
                const userId = requester?.id || (typeof requester === "string" ? requester : null);
                if (userId) {
                    const sessionId = await startSession(player.guildId, userId, track, client, player.voiceChannel);
                    player.currentSessionId = sessionId;
                    player.sessionStartedAt = Date.now();
                    player.sessionUserId = userId;
                    guildData.currentSessionId = sessionId;
                    console.log(`[euphire] [${client.botId}] Started stats session:`, sessionId, "for user:", userId, "track:", track.info.title, "duration:", track.info.length);
                    
                    // Save guildData to persist state
                    await saveGuildData(player.guildId, guildData);

                    // Add current voice channel members as participants
                    const voiceChannel = client.channels.cache.get(player.voiceChannel);
                    if (voiceChannel) {
                        voiceChannel.members.forEach((member) => {
                            if (!member.user.bot && member.id !== userId) {
                                addSessionParticipant(sessionId, member.id);
                            }
                        });
                    }
                } else {
                    console.log(`[euphire] [${client.botId}] No requester found for track, not starting stats session`);
                }
            } catch (err) {
                console.error("[euphire] Failed to start stats session:", err.message);
                console.error("[euphire] Stack:", err.stack);
            }

            // Start voice channel monitoring
            startVoiceChannelMonitoring(client, player.guildId);

            await announceNowPlaying(client, player, track, guildData);

            // Auto-update interval disabled (no progress bars)
        } catch (error) {
            console.error("[euphire] trackStart error:", error);
        }
    });

    // --- Track End (natural completion) ---
    // NOTE: Riffy doesn't reliably emit trackEnd, so we use trackStart fallback and queueEnd instead
    client.riffy.on("trackEnd", async (player, track, payload) => {
        try {
            const guildData = getGuildData(player.guildId);

            console.log("[euphire] trackEnd event fired for track:", track?.info?.title);

            // Last.fm scrobbling: scrobble for all users in VC
            try {
                const voiceChannel = client.channels.cache.get(player.voiceChannel);
                if (voiceChannel && track) {
                    const trackInfo = track.info;
                    const artist = trackInfo.author || "Unknown";
                    const trackName = trackInfo.title || "Unknown";
                    const album = trackInfo.album || null;
                    const duration = trackInfo.length || 0;

                    // Get all non-bot users in the voice channel
                    const members = voiceChannel.members.filter(m => !m.user.bot);
                    for (const [memberId, member] of members) {
                        const userData = await getUserData(memberId);
                        if (userData.lastfmSessionKey) {
                            // Clear pending scrobble timer
                            if (scrobbleTimers.has(memberId)) {
                                clearTimeout(scrobbleTimers.get(memberId));
                                scrobbleTimers.delete(memberId);
                            }

                            // Scrobble immediately on track end
                            await scrobble(
                                userData.lastfmSessionKey,
                                artist,
                                trackName,
                                album,
                                Date.now(),
                                duration
                            );
                            console.log(`[Last.fm] Scrobbled on track end for ${userData.lastfmUsername}: ${trackName}`);
                        }
                    }
                }
            } catch (err) {
                console.error("[Last.fm] Failed to scrobble on track end:", err.message);
            }

            // End statistics tracking session (natural completion)
            try {
                const sessionIdToEnd = player.currentSessionId || guildData.currentSessionId;
                if (sessionIdToEnd) {
                    console.log(`[euphire] [${client.botId}] trackEnd: ending session (natural completion), sessionId:`, sessionIdToEnd);
                    await endSession(sessionIdToEnd, true);
                    player.currentSessionId = null;
                    guildData.currentSessionId = null;
                    await saveGuildData(player.guildId, guildData);
                }
            } catch (err) {
                console.error("[euphire] Failed to end stats session on track end:", err.message);
            }
        } catch (error) {
            console.error("[euphire] trackEnd error:", error);
        }
    });

    // --- Queue End ---
    client.riffy.on("queueEnd", async (player) => {
        try {
            // Check if this bot is the session owner for this voice channel
            const sessionOwner = coordinator.getSessionOwner(player.voiceChannel);
            if (sessionOwner && sessionOwner !== client.botId) {
                // Another bot owns this session, don't handle duplicate events
                console.log(`[euphire] Skipping queueEnd - bot ${client.botId} is not the session owner (owner: ${sessionOwner})`);
                return;
            }

            // Check if the voice channel still exists
            const channel = client.channels.cache.get(player.voiceChannel);
            if (!channel) {
                console.log(`[euphire] Voice channel ${player.voiceChannel} no longer exists, releasing bot ${client.botId}`);
                await coordinator.releaseBot(player.voiceChannel);
                player.destroy();
                return;
            }

            const guildData = getGuildData(player.guildId);

            // Last.fm scrobbling: clear all pending scrobble timers for this session
            try {
                const voiceChannel = client.channels.cache.get(player.voiceChannel);
                if (voiceChannel) {
                    const members = voiceChannel.members.filter(m => !m.user.bot);
                    for (const [memberId, member] of members) {
                        if (scrobbleTimers.has(memberId)) {
                            clearTimeout(scrobbleTimers.get(memberId));
                            scrobbleTimers.delete(memberId);
                        }
                    }
                }
            } catch (err) {
                console.error("[Last.fm] Failed to clear scrobble timers:", err.message);
            }

            // End statistics tracking session (natural completion)
            try {
                const sessionIdToEnd = player.currentSessionId || guildData.currentSessionId;
                if (sessionIdToEnd) {
                    console.log(`[euphire] [${client.botId}] queueEnd: ending session (natural completion), sessionId:`, sessionIdToEnd);
                    await endSession(sessionIdToEnd, true);
                    player.currentSessionId = null;
                    guildData.currentSessionId = null;
                    await saveGuildData(player.guildId, guildData);
                    console.log("[euphire] queueEnd: session ended successfully");
                }
            } catch (err) {
                console.error("[euphire] Failed to end stats session:", err.message);
                console.error("[euphire] Stack:", err.stack);
            }

            // Stop the auto-update interval
            clearUpdateInterval(guildData);

            // Stop voice channel monitoring
            stopVoiceChannelMonitoring(player.guildId);

            // Riffy leaves player.current on the finished track. Clear it so
            // the next !play starts playback instead of only enqueueing.
            markPlayerIdle(player);

            // Resolve the specific channel assigned to this bot and its DJ
            const assignedChannel = resolveAssignedChannel(client, player, guildData);

            // Clear any previous idle timeout
            if (player.idleTimeout) {
                clearTimeout(player.idleTimeout);
                player.idleTimeout = null;
            }
            if (guildData.idleTimeout) {
                clearTimeout(guildData.idleTimeout);
                guildData.idleTimeout = null;
            }

            // Set 3-minute idle timeout before leaving
            console.log(`[euphire] Queue ended, setting 3-minute idle timeout for bot ${client.botId} in voice channel ${player.voiceChannel}`);
            player.idleTimeout = setTimeout(async () => {
                console.log(`[euphire] Idle timeout reached, bot ${client.botId} leaving voice channel ${player.voiceChannel}`);

                // Check if bot is still in the voice channel
                const botMember = client.guilds.cache.get(player.guildId)?.members.cache.get(client.user.id);
                const currentVoiceChannel = botMember?.voice?.channel;

                if (!currentVoiceChannel || currentVoiceChannel.id !== player.voiceChannel) {
                    console.log(`[euphire] Bot ${client.botId} is no longer in the expected voice channel, skipping idle disconnect`);
                    player.idleTimeout = null;
                    return;
                }

                // Send leaving message to the assigned channel with the DJ
                const targetLeaveChannel = resolveAssignedChannel(client, player, guildData);
                if (targetLeaveChannel) {
                    try {
                        const leaveEmbed = new EmbedBuilder()
                            .setColor(0xED4245)
                            .setDescription("No tracks have been playing for the past 3 minutes, leaving :wave:");

                        await targetLeaveChannel.send({
                            embeds: [leaveEmbed],
                        });
                    } catch (err) {
                        console.error("[euphire] Failed to send leaving message:", err.message);
                    }
                }

                // End session if still active
                if (player.currentSessionId) {
                    const listenedMs = player.position || (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);
                    await endSession(player.currentSessionId, false, listenedMs).catch(() => {});
                    player.currentSessionId = null;
                }

                // Release bot and leave
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
                player.destroy();
                player.idleTimeout = null;

                // Clear player message if it belonged to this channel
                if (targetLeaveChannel && guildData.playerChannelId === targetLeaveChannel.id) {
                    guildData.playerMessageId = null;
                    guildData.playerChannelId = null;
                    await saveGuildData(player.guildId, guildData);
                }
            }, 3 * 60 * 1000); // 3 minutes

            // If this is a ChatPlay session, edit the message to idle state
            if (guildData.chatPlayChannelId && guildData.chatPlayMessageId) {
                const container = createChatPlayIdleContainer();
                const channel = client.channels.cache.get(guildData.chatPlayChannelId);
                if (channel) {
                    try {
                        const msg = await channel.messages.fetch(guildData.chatPlayMessageId);
                        await msg.edit({
                            components: [container],
                            attachments: [],
                            flags: MessageFlags.IsComponentsV2,
                        });
                    } catch (err) {
                        // message deleted
                    }
                }
            } else {
                // For regular play: delete this player's old now-playing card, then announce idle to its assigned channel
                const oldMsgId = player.playerMessageId || (assignedChannel && guildData.playerChannelId === assignedChannel.id ? guildData.playerMessageId : null);
                if (assignedChannel && oldMsgId) {
                    try {
                        const msg = await assignedChannel.messages.fetch(oldMsgId);
                        await msg.delete();
                    } catch (err) {
                        // message already deleted
                    }
                }
                player.playerMessageId = null;
                if (assignedChannel && guildData.playerChannelId === assignedChannel.id) {
                    guildData.playerMessageId = null;
                }

                if (assignedChannel) {
                    await sendQueueEmptyNotice(assignedChannel, player.guildId, player.voiceChannel, client);
                }
            }

            // Clear suggestions
            guildData.suggestions = [];
        } catch (error) {
            console.error("[euphire] queueEnd error:", error);
        }
    });

    // --- Player Disconnect ---
    client.riffy.on("playerDisconnect", async (player) => {
        const guildData = getGuildData(player.guildId);
        if (guildData.recreatingPlayer) return;

        console.log(`[euphire] playerDisconnect fired for bot ${client.botId} in guild ${player.guildId}`);

        // Release bot reservation so it becomes available immediately
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

        // End statistics tracking session
        try {
            if (guildData.currentSessionId) {
                updateSessionProgress(guildData.currentSessionId, player.position || 0);
                await endSession(guildData.currentSessionId);
                guildData.currentSessionId = null;
            }
        } catch (err) {
            console.error("[euphire] Failed to end stats session on disconnect:", err.message);
        }

        clearUpdateInterval(guildData);
        stopVoiceChannelMonitoring(player.guildId);
        
        // Delete regular player message if it exists
        if (guildData.playerMessageId && guildData.playerChannelId) {
            try {
                const channel = client.channels.cache.get(guildData.playerChannelId);
                if (channel) {
                    const msg = await channel.messages.fetch(guildData.playerMessageId);
                    await msg.delete();
                }
            } catch (err) {
                // message already deleted
            }
        }
        
        guildData.playerMessageId = null;
        guildData.playerChannelId = null;
        guildData.suggestions = [];
        guildData.previousTracks = [];
        if (guildData.queuePages && typeof guildData.queuePages.clear === 'function') {
            guildData.queuePages.clear();
        } else {
            guildData.queuePages = {};
        }
        if (player.idleTimeout) {
            clearTimeout(player.idleTimeout);
            player.idleTimeout = null;
        }
        if (guildData.idleTimeout) clearTimeout(guildData.idleTimeout);
        guildData.idleTimeout = null;

        // End statistics session on player disconnect (not natural completion)
        try {
            if (guildData.currentSessionId) {
                console.log("[euphire] playerDisconnect: ending session (disconnect)");
                await endSession(guildData.currentSessionId, false);
                guildData.currentSessionId = null;
            }
        } catch (err) {
            console.error("[euphire] Failed to end stats session on disconnect:", err.message);
        }
        
        resetSessionPermissions(player.guildId);
    });

    // --- Track Error / Stuck ---
    client.riffy.on("trackError", async (player, track, payload) => {
        console.error(`[euphire] Track error in ${player.guildId} for "${track.info.title}":`, payload.error || payload);
        const guildData = getGuildData(player.guildId);
        
        // End statistics session (error - not natural completion)
        try {
            if (guildData.currentSessionId) {
                console.log("[euphire] trackError: ending session (error)");
                await endSession(guildData.currentSessionId, false);
                guildData.currentSessionId = null;
            }
        } catch (err) {
            console.error("[euphire] Failed to end stats session on track error:", err.message);
        }
        
        const assignedChannel = resolveAssignedChannel(client, player, guildData);
        if (assignedChannel) {
            assignedChannel.send(`❌ Failed to play **${track.info.title}** (Lavalink Error). Skipping...`).catch(() => {});
        }
    });

    client.riffy.on("trackStuck", async (player, track, payload) => {
        console.warn(`[euphire] Track stuck in ${player.guildId} for "${track.info.title}" (${payload.thresholdMs}ms)`);
        
        // End statistics session (stuck - not natural completion)
        try {
            const freshGuildData = await getGuildData(player.guildId);
            if (freshGuildData.currentSessionId) {
                console.log("[euphire] trackStuck: ending session (stuck)");
                await endSession(freshGuildData.currentSessionId, false);
                guildData.currentSessionId = null;
                await saveGuildData(player.guildId, guildData);
            }
        } catch (err) {
            console.error("[euphire] Failed to end stats session on track stuck:", err.message);
        }
        
        const assignedChannel = resolveAssignedChannel(client, player, guildData);
        if (assignedChannel) {
            assignedChannel.send(`⚠️ Track stuck: **${track.info.title}**. Skipping...`).catch(() => {});
        }
    });
}

/**
 * Start monitoring voice channel for auto-pause/resume functionality
 */
function startVoiceChannelMonitoring(client, guildId) {
    // Music continues playing even when voice channel is empty
}

/**
 * Check voice channel state and pause/resume accordingly
 */
function checkVoiceChannelState(client, guildId) {
    // Music continues playing even when voice channel is empty
}

/**
 * Stop voice channel monitoring
 */
function stopVoiceChannelMonitoring(guildId) {
    const guildData = getGuildData(guildId);
    if (guildData.voiceStateTimeout) {
        clearTimeout(guildData.voiceStateTimeout);
        guildData.voiceStateTimeout = null;
    }
}

module.exports = { setupPlayerHandler, startVoiceChannelMonitoring, stopVoiceChannelMonitoring };
