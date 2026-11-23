const { MessageFlags, AttachmentBuilder, ContainerBuilder, TextDisplayBuilder, EmbedBuilder } = require("discord.js");
const { getGuildData, saveGuildData, clearUpdateInterval } = require("../utils/mongoGuildData");
const { getUserData } = require("../utils/mongoUserData");
const {
    createNowPlayingContainer,
    createCouldNotPlayEmbed,
    getCouldNotPlayDescription,
    getSpotifyEmoji,
} = require("../utils/components");
const { recordIncident } = require("../utils/incidents");
const { scheduleStatusUpdate } = require("../services/statusMonitor");
const {
    markPlayerIdle,
    markIntentionalDisconnect,
    clearPlayerIdleTimeout,
    setPlayerIdleTimeout,
} = require("../utils/playback");
const { getHumanVoiceMembers } = require("../utils/voiceMembers");
const { resetSessionPermissions } = require("../utils/permissions");
const { startSession, updateSessionProgress, endSession, addSessionParticipant, removeSessionParticipant } = require("../utils/mongoStats");
const { startPlayerTracking, stopPlayerTracking } = require("../utils/modelMilestones");
const { updateNowPlaying, scrobble } = require("../utils/lastfm");
const {
    getSpotifyTrackDisplayName,
    getSpotifyTrackFailureName,
    getSpotifyTrackUrl,
    findSpotifyTrackMetadata,
    applySpotifyTrackMetadata,
} = require("../utils/search");
const coordinator = require("../utils/mongoCoordinator");
const config = require("../../config");

// Store scrobble timers per user (userId -> timeout)
const scrobbleTimers = new Map();
const trackErrorNotices = new Map();
const lastfmLoginPromptCooldowns = new Map();
const LASTFM_LOGIN_PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const UPDATE_INTERVAL_MS = 30 * 1000; // Increased to 30 seconds to reduce CPU load
const voiceChannelMonitoringIntervals = new Map();
const VOICE_CHANNEL_MONITOR_INTERVAL_MS = 5000;

function queueTrackErrorNotice(channel, guildId, track) {
    let notice = trackErrorNotices.get(guildId);
    if (!notice) {
        notice = { tracks: [], timer: null };
        trackErrorNotices.set(guildId, notice);
    }

    const trackName = track ? getSpotifyTrackFailureName(track) : null;
    const spotifyUrl = track ? getSpotifyTrackUrl(track) : null;
    const trackKey = spotifyUrl || trackName;
    if (
        trackKey &&
        !notice.tracks.some(
            (failedTrack) =>
                (getSpotifyTrackUrl(failedTrack) ||
                    getSpotifyTrackFailureName(failedTrack)) === trackKey
        )
    ) {
        notice.tracks.push(track);
    }
    clearTimeout(notice.timer);
    notice.timer = setTimeout(() => {
        trackErrorNotices.delete(guildId);
        const failures = notice.tracks
            .slice(0, 5)
            .map(getCouldNotPlayDescription);
        if (!failures.length) {
            failures.push("Could not find any audio source");
        }
        const omittedCount = Math.max(0, notice.tracks.length - 5);
        if (omittedCount) {
            failures.push(
                `Could not find any audio source for ${omittedCount} more track(s)`
            );
        }
        const embed = createCouldNotPlayEmbed(notice.tracks[0]);
        embed.setDescription(failures.join("\n"));
        channel.send({ embeds: [embed] }).catch((error) => {
            console.error("[euphire] Failed to send track error summary:", error.message);
        });
    }, 5000);
    notice.timer.unref?.();
}

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
        .setColor(0xED4245)
        .setDescription("There are no more tracks");

    try {
        await channel.send({ embeds: [embed] });
    } catch {
        // Channel has no send permission
    }
}

async function sendQueueLoopRestartNotice(client, player, guildData) {
    const sessionOwner = coordinator.resolveSessionOwner(
        player.voiceChannel,
        client.guilds.cache.get(player.guildId)
    );
    if (sessionOwner && sessionOwner !== client.botId) return;

    const channel = resolveAssignedChannel(client, player, guildData);
    if (!channel) return;

    const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setDescription("There are no more tracks, starting over 🔁");

    try {
        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error(
            `[euphire] Failed to send queue-loop restart notice in guild ${player.guildId}:`,
            error.message
        );
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

async function sendLastfmLoginPrompt(client, player, guildData, userId) {
    const now = Date.now();
    for (const [id, timestamp] of lastfmLoginPromptCooldowns) {
        if (now - timestamp >= LASTFM_LOGIN_PROMPT_COOLDOWN_MS) {
            lastfmLoginPromptCooldowns.delete(id);
        }
    }
    if (lastfmLoginPromptCooldowns.has(userId)) return;

    const channel = resolveAssignedChannel(client, player, guildData);
    if (!channel) return;

    const embed = new EmbedBuilder()
        .setColor(0xf5a623)
        .setDescription(
            "Want to connect Euphie to fmbot?\n" +
            "Run `e!login` to connect your account and have your music scrobbled automatically."
        );

    try {
        await channel.send({ embeds: [embed] });
        lastfmLoginPromptCooldowns.set(userId, now);
    } catch (error) {
        console.error("[Last.fm] Failed to send login prompt:", error.message);
    }
}

function buildStartedPlayingEmbed(client, player, track) {
    const displayName = getSpotifyTrackDisplayName(track)
        .replace(/[\[\]]/g, "\\$&")
        .slice(0, 512);
    const spotifyUrl = getSpotifyTrackUrl(track);
    const trackText = spotifyUrl
        ? `[**${displayName}**](${spotifyUrl})`
        : `**${displayName}**`;

    return new EmbedBuilder()
        .setColor(0x4f545c)
        .setDescription(
            `${getSpotifyEmoji(client, player)} Started playing ${trackText}`
        );
}

function shouldAnnounceTrackStart(player, track) {
    const trackId =
        track?.info?.identifier ||
        track?.info?.uri ||
        track?.track;
    if (!trackId) return true;

    const isRepeatedTrackLoop =
        player.loop === "track" &&
        player._lastAnnouncedTrackId === trackId;
    player._lastAnnouncedTrackId = trackId;
    return !isRepeatedTrackLoop;
}

function isQueueLoopRestart(player, track, payload) {
    if (
        player?.loop !== "queue" ||
        player._clearQueueRequested ||
        String(payload?.reason || "").toLowerCase() !== "finished" ||
        !track
    ) {
        return false;
    }

    const queuedTracks = Array.from(player.queue || []);
    if (!queuedTracks.length) return false;

    if (!(player._queueLoopPlayedTracks instanceof Set)) {
        player._queueLoopPlayedTracks = new Set();
    }
    player._queueLoopPlayedTracks.add(track);

    const cycleFinished = queuedTracks.every((queuedTrack) =>
        player._queueLoopPlayedTracks.has(queuedTrack)
    );
    if (cycleFinished) player._queueLoopPlayedTracks.clear();
    return cycleFinished;
}

async function sendNowPlayingPayload(channel, client, player, track) {
    try {
        return await channel.send({
            embeds: [buildStartedPlayingEmbed(client, player, track)],
        });
    } catch (error) {
        console.error("[euphire] Failed to send started-playing embed:", error);
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
    const currentTrack = player.current;
    const announcementTrack =
        currentTrack &&
        (currentTrack.track === track?.track ||
            currentTrack.info?.identifier === track?.info?.identifier)
            ? currentTrack
            : track;
    if (announcementTrack !== track && track?.info?.spotifyTitle) {
        applySpotifyTrackMetadata(announcementTrack, {
            url: track.info.spotifyUrl,
            artworkUrl: track.info.spotifyArtworkUrl,
            title: track.info.spotifyTitle,
            artist: track.info.spotifyArtist,
        });
    }
    const channel = resolveNowPlayingChannel(client, player, guildData);

    if (!channel) {
        console.warn(`[euphire] No channel available to send now playing for guild ${player.guildId}`);
        return;
    }

    const newMsg = await sendNowPlayingPayload(
        channel,
        client,
        player,
        announcementTrack
    );
    if (!newMsg) return;

    player.playerMessageId = newMsg.id;
    player.playerChannelId = channel.id;
    player.assignedTextChannel = channel.id;
    if (player.voiceChannel) {
        coordinator.setSessionChannel(player.voiceChannel, channel.id);
    }
    guildData.playerMessageId = newMsg.id;
    guildData.playerChannelId = channel.id;
    guildData.cannotSendPlayer = false;

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
                await coordinator.releaseBot(player.voiceChannel, client.botId);
                player.destroy();
                return;
            }

            const guildData = getGuildData(player.guildId);
            await require("../utils/playbackRecovery")
                .saveRecentlyPlayedTrack(track)
                .catch((err) => {
                    console.error(
                        `[euphire] Failed to save recently played track for guild ${player.guildId}:`,
                        err.message
                    );
                });
            await require("../utils/playbackRecovery")
                .persistPlayer(client, player)
                .catch((err) => {
                    console.error(
                        `[euphire] Failed to persist playback session for ${player.guildId}:`,
                        err.message
                    );
                });
            guildData.cannotSendPlayer = false;
            player.skipVotes = new Set();
            clearPlayerIdleTimeout(player, guildData, true);

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

            // Last.fm scrobbling: update now playing for all users in VC (including temp VCs and requester)
            try {
                let voiceChannel = client.channels.cache.get(player.voiceChannel);
                if (!voiceChannel && player.voiceChannel) {
                    voiceChannel = await client.channels.fetch(player.voiceChannel).catch(() => null);
                }

                const trackInfo = track.info || {};
                let artist = trackInfo.author || "Unknown";
                let trackName = trackInfo.title || "Unknown";
                if ((artist === "Unknown" || artist.includes("- Topic")) && trackName.includes(" - ")) {
                    const parts = trackName.split(" - ");
                    if (parts.length >= 2) {
                        artist = parts[0].trim();
                        trackName = parts.slice(1).join(" - ").trim();
                    }
                }
                const album = trackInfo.album || null;
                const duration = trackInfo.length || 0;

                // Collect all listeners in VC (temp VC safe) plus requester
                const targetUserIds = new Set();
                if (voiceChannel?.members) {
                    for (const [mId, m] of voiceChannel.members) {
                        if (!m.user?.bot) targetUserIds.add(mId);
                    }
                }
                if (voiceChannel?.guild?.voiceStates?.cache) {
                    for (const [vId, vs] of voiceChannel.guild.voiceStates.cache) {
                        if (vs.channelId === player.voiceChannel) {
                            const member = vs.member || voiceChannel.guild.members.cache.get(vId);
                            if (!member?.user?.bot) targetUserIds.add(vId);
                        }
                    }
                }
                const reqId = track?.info?.requester?.id || (typeof track?.info?.requester === 'string' ? track?.info?.requester : null) || player.requesterId;
                if (reqId) targetUserIds.add(reqId);

                for (const memberId of targetUserIds) {
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
                        console.log(`[Last.fm] Updated now playing for ${userData.lastfmUsername}: ${trackName} by ${artist}`);

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
                    } else if (String(memberId) === String(reqId)) {
                        await sendLastfmLoginPrompt(
                            client,
                            player,
                            guildData,
                            String(memberId)
                        );
                    }
                }
            } catch (err) {
                console.error("[Last.fm] Failed to update now playing:", err.message);
            }

            // Clear queue end time since a new track started
            guildData.queueEndTime = null;

            if (!track?.info?.spotifyTitle) {
                const requester =
                    track?.info?.requester ||
                    (player.requesterId ? { id: player.requesterId } : null);
                const spotifyMetadata = await findSpotifyTrackMetadata(
                    client.riffy,
                    track,
                    requester
                );
                applySpotifyTrackMetadata(track, spotifyMetadata);
            }

            // Start statistics tracking session
            try {
                const requester = track.info.requester;
                const userId = requester?.id || (typeof requester === "string" ? requester : null);
                if (userId) {
                    const sessionId = await startSession(player.guildId, userId, track, client, player.voiceChannel);
                    player.currentSessionId = sessionId;
                    player.sessionStartedAt = Date.now();
                    player.sessionUserId = userId;
                    console.log(`[euphire] [${client.botId}] Started stats session:`, sessionId, "for user:", userId, "track:", track.info.title, "duration:", track.info.length);

                    // Add current voice channel members as participants
                    const voiceChannel = client.channels.cache.get(player.voiceChannel);
                    if (voiceChannel) {
                        const participantIds = new Set();
                        if (voiceChannel.members) {
                            voiceChannel.members.forEach((member) => {
                                if (!member.user?.bot) {
                                    participantIds.add(member.id);
                                }
                            });
                        }
                        const guild = client.guilds.cache.get(player.guildId);
                        if (guild?.voiceStates?.cache) {
                            guild.voiceStates.cache.forEach((vs, memberId) => {
                                if (vs.channelId === player.voiceChannel && memberId !== client.user?.id) {
                                    const m = vs.member || guild.members.cache.get(memberId);
                                    if (!m?.user?.bot) {
                                        participantIds.add(memberId);
                                    }
                                }
                            });
                        }
                        await Promise.all(
                            [...participantIds].map((pId) =>
                                addSessionParticipant(sessionId, pId)
                            )
                        );
                    }
                } else {
                    console.log(`[euphire] [${client.botId}] No requester found for track, not starting stats session`);
                }
            } catch (err) {
                console.error("[euphire] Failed to start stats session:", err.message);
                console.error("[euphire] Stack:", err.stack);
            }

            startPlayerTracking(client, player);

            // Start voice channel monitoring
            startVoiceChannelMonitoring(client, player.guildId);

            if (shouldAnnounceTrackStart(player, track)) {
                await announceNowPlaying(client, player, track, guildData);
            }

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
            const queueRestarting = isQueueLoopRestart(player, track, payload);
            await stopPlayerTracking(player, true);

            console.log("[euphire] trackEnd event fired for track:", track?.info?.title);
            let queueUpdated = false;
            if (
                guildData.removeAfterPlayed &&
                player.loop !== "queue" &&
                String(payload?.reason || "").toLowerCase() === "finished" &&
                track?.info?.uri
            ) {
                const repeatedIndex = Array.from(player.queue || []).findIndex(
                    (queuedTrack) => queuedTrack.info?.uri === track.info.uri
                );
                if (repeatedIndex !== -1) {
                    player.queue.splice(repeatedIndex, 1);
                    queueUpdated = true;
                }
            }
            if (guildData.shuffleRepeat && player.loop === "queue" && player.queue?.length > 1) {
                player.queue.shuffle();
                queueUpdated = true;
            }
            if (queueUpdated) {
                await require("../utils/playbackRecovery").persistPlayer(client, player);
            }
            if (queueRestarting) {
                await sendQueueLoopRestartNotice(client, player, guildData);
            }

            // Last.fm scrobbling: scrobble for all users in VC
            try {
                let voiceChannel = client.channels.cache.get(player.voiceChannel);
                if (!voiceChannel && player.voiceChannel) {
                    voiceChannel = await client.channels.fetch(player.voiceChannel).catch(() => null);
                }

                if (track) {
                    const trackInfo = track.info || {};
                    let artist = trackInfo.author || "Unknown";
                    let trackName = trackInfo.title || "Unknown";
                    if ((artist === "Unknown" || artist.includes("- Topic")) && trackName.includes(" - ")) {
                        const parts = trackName.split(" - ");
                        if (parts.length >= 2) {
                            artist = parts[0].trim();
                            trackName = parts.slice(1).join(" - ").trim();
                        }
                    }
                    const album = trackInfo.album || null;
                    const duration = trackInfo.length || 0;

                    const targetUserIds = new Set();
                    if (voiceChannel?.members) {
                        for (const [mId, m] of voiceChannel.members) {
                            if (!m.user?.bot) targetUserIds.add(mId);
                        }
                    }
                    if (voiceChannel?.guild?.voiceStates?.cache) {
                        for (const [vId, vs] of voiceChannel.guild.voiceStates.cache) {
                            if (vs.channelId === player.voiceChannel) {
                                const member = vs.member || voiceChannel.guild.members.cache.get(vId);
                                if (!member?.user?.bot) targetUserIds.add(vId);
                            }
                        }
                    }
                    const reqId = track?.info?.requester?.id || (typeof track?.info?.requester === 'string' ? track?.info?.requester : null) || player.requesterId;
                    if (reqId) targetUserIds.add(reqId);

                    for (const memberId of targetUserIds) {
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

            // Only completed tracks should count as natural completions.
            try {
                const sessionIdToEnd = player.currentSessionId;
                if (sessionIdToEnd) {
                    player.currentSessionId = null;
                    const completedNaturally =
                        String(payload?.reason || "").toLowerCase() === "finished";
                    console.log(
                        `[euphire] [${client.botId}] trackEnd: ending session (${completedNaturally ? "natural completion" : payload?.reason || "early end"}), sessionId:`,
                        sessionIdToEnd
                    );
                    await endSession(
                        sessionIdToEnd,
                        completedNaturally,
                        completedNaturally ? null : player.position
                    );
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
            if (player._waitingRoom || player._returningToWaitingRoom) return;
            if (player._restoringSession || player._pendingResumeSnapshot) {
                console.log(
                    `[euphire] Ignoring queueEnd while restoring saved session for guild ${player.guildId}`
                );
                return;
            }

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
                await coordinator.releaseBot(player.voiceChannel, client.botId);
                player.destroy();
                return;
            }

            const guildData = getGuildData(player.guildId);
            const queueWasCleared = player._clearQueueRequested === true;
            if (queueWasCleared) {
                clearTimeout(player._clearQueueRestoreTimer);
                player._clearQueueRequested = false;
                player.setLoop(player._clearQueueLoopMode || "none");
                delete player._clearQueueLoopMode;
                delete player._clearQueueRestoreTimer;
            }
            await stopPlayerTracking(player, true);

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
                const sessionIdToEnd = player.currentSessionId;
                if (sessionIdToEnd) {
                    console.log(`[euphire] [${client.botId}] queueEnd: ending session (natural completion), sessionId:`, sessionIdToEnd);
                    await endSession(sessionIdToEnd, true);
                    player.currentSessionId = null;
                    console.log("[euphire] queueEnd: session ended successfully");
                }
            } catch (err) {
                console.error("[euphire] Failed to end stats session:", err.message);
                console.error("[euphire] Stack:", err.stack);
            }

            // Stop the auto-update interval
            if (!hasOtherActivePlayer(client, player.guildId)) {
                clearUpdateInterval(guildData);
            }

            // Stop voice channel monitoring
            stopVoiceChannelMonitoring(player.guildId, client.botId);

            // Riffy leaves player.current on the finished track. Clear it so
            // the next !play starts playback instead of only enqueueing.
            markPlayerIdle(player);

            // Resolve the specific channel assigned to this bot and its DJ
            const assignedChannel = resolveAssignedChannel(client, player, guildData);

            if (player.leaveAfterQueueEnd) {
                player.leaveAfterQueueEnd = false;
                await require("../utils/playbackRecovery")
                    .removeSavedSession(player.guildId, client.botId)
                    .catch((err) => {
                        console.error(
                            `[euphire] Failed to clear playback snapshot after playleave for ${player.guildId}:`,
                            err.message
                        );
                    });
                stopVoiceChannelMonitoring(player.guildId, client.botId);
                const returnedToWaitingRoom = await require("../utils/waitingRoom")
                    .returnPlayerToWaitingRoom(client, player)
                    .catch((error) => {
                        console.error(
                            `[euphire] Failed to return ${client.botId} to the waiting room after playleave in guild ${player.guildId}:`,
                            error
                        );
                        return false;
                    });
                if (!returnedToWaitingRoom) {
                    await coordinator.releaseBot(player.voiceChannel, client.botId);
                    markIntentionalDisconnect(player);
                    player.destroy();
                }
                return;
            }

            // Autoplay check: if autoplay is enabled, generate and play recommendation
            if (!queueWasCleared && guildData.autoplay) {
                const { handleAutoplay } = require("../utils/autoplay");
                const autoplayStarted = await handleAutoplay(client, player, guildData, resolveAssignedChannel);
                if (autoplayStarted) {
                    console.log(`[euphire] Autoplay successfully queued and started next track in guild ${player.guildId}`);
                    return;
                }
            }

            // Set 3-minute idle timeout before leaving
            const { setPlayerIdleTimeout } = require("../utils/playback");
            await require("../utils/playbackRecovery")
                .removeSavedSession(player.guildId, client.botId)
                .catch((err) => {
                    console.error(
                        `[euphire] Failed to clear completed playback session for ${player.guildId}:`,
                        err.message
                    );
                });
            setPlayerIdleTimeout(client, player, guildData, "idle");

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
                // Keep the started-playing announcement in channel history.
                player.playerMessageId = null;
                if (assignedChannel && guildData.playerChannelId === assignedChannel.id) {
                    guildData.playerMessageId = null;
                }
            }

            if (assignedChannel) {
                await sendQueueEmptyNotice(assignedChannel, player.guildId, player.voiceChannel, client);
            }

            if (!hasOtherActivePlayer(client, player.guildId)) {
                guildData.suggestions = [];
            }
        } catch (error) {
            console.error("[euphire] queueEnd error:", error);
        }
    });

    // --- Player Disconnect ---
    client.riffy.on("playerDisconnect", async (player) => {
        const guildData = getGuildData(player.guildId);
        if (player._waitingRoom) {
            if (player.idleTimeout) clearTimeout(player.idleTimeout);
            return;
        }
        await stopPlayerTracking(player, true);
        if (guildData.recreatingPlayer) return;

        console.log(`[euphire] playerDisconnect fired for bot ${client.botId} in guild ${player.guildId}`);

        // Release bot reservation so it becomes available immediately
        if (!player._waitingRoom && player.voiceChannel) {
            await coordinator.releaseBot(player.voiceChannel, client.botId);
        }

        // End this player's statistics session without touching another bot's session.
        try {
            if (player.currentSessionId) {
                updateSessionProgress(player.currentSessionId, player.position || 0);
                await endSession(player.currentSessionId);
                player.currentSessionId = null;
            }
        } catch (err) {
            console.error("[euphire] Failed to end stats session on disconnect:", err.message);
        }

        stopVoiceChannelMonitoring(player.guildId, client.botId);
        
        // Keep started-playing announcements in channel history.
        player.playerMessageId = null;
        player.playerChannelId = null;
        if (player.idleTimeout) {
            clearTimeout(player.idleTimeout);
            player.idleTimeout = null;
        }
        
        if (!hasOtherActivePlayer(client, player.guildId)) {
            clearUpdateInterval(guildData);
        }
        if (player.voiceChannel) {
            try {
                await resetSessionPermissions(player.guildId, player.voiceChannel);
            } catch (error) {
                console.error(
                    `[euphire] Failed to reset session permissions after ${client.botId} disconnected:`,
                    error.message
                );
            }
        }
    });

    // --- Track Error / Stuck ---
    client.riffy.on("trackError", async (player, track, payload) => {
        console.error(
            `[euphire] Track error in ${player.guildId} for "${track?.info?.title || "Unknown track"}":`,
            payload?.exception || payload?.error || payload
        );
        stopPlayerTracking(player);
        const guildData = getGuildData(player.guildId);
        
        // End statistics session (error - not natural completion)
        const sessionIdToEnd = player.currentSessionId;
        player.currentSessionId = null;
        if (sessionIdToEnd) {
            try {
                console.log("[euphire] trackError: ending session (error)");
                await endSession(sessionIdToEnd, false, player.position);
            } catch (err) {
                console.error("[euphire] Failed to end stats session on track error:", err.message);
            }
        }
        
        const assignedChannel = resolveAssignedChannel(client, player, guildData);
        if (assignedChannel) {
            queueTrackErrorNotice(assignedChannel, player.guildId, track);
        }
    });

    client.riffy.on("trackStuck", async (player, track, payload) => {
        console.warn(`[euphire] Track stuck in ${player.guildId} for "${track.info.title}" (${payload.thresholdMs}ms)`);
        stopPlayerTracking(player);
        
        // End statistics session (stuck - not natural completion)
        try {
            if (player.currentSessionId) {
                console.log("[euphire] trackStuck: ending session (stuck)");
                await endSession(player.currentSessionId, false);
                player.currentSessionId = null;
            }
        } catch (err) {
            console.error("[euphire] Failed to end stats session on track stuck:", err.message);
        }
        
        const assignedChannel = resolveAssignedChannel(
            client,
            player,
            getGuildData(player.guildId)
        );
        if (assignedChannel) {
            const embed = createCouldNotPlayEmbed(track);
            assignedChannel.send({ embeds: [embed] }).catch((error) => {
                console.error("[euphire] Failed to send track status:", error.message);
            });
        }
    });
}

/**
 * Start monitoring voice-channel occupancy for automatic disconnects.
 */
function startVoiceChannelMonitoring(client, guildId) {
    const player = client.riffy?.players?.get(guildId);
    if (!player?.voiceChannel) return;

    const monitorKey = `${client.botId}:${guildId}`;
    if (voiceChannelMonitoringIntervals.has(monitorKey)) return;

    checkVoiceChannelState(client, guildId);
    const interval = setInterval(() => {
        try {
            checkVoiceChannelState(client, guildId);
        } catch (error) {
            console.error(
                `[euphire] Voice-channel monitor failed for ${guildId}:`,
                error.message
            );
        }
    }, VOICE_CHANNEL_MONITOR_INTERVAL_MS);
    interval.unref?.();
    voiceChannelMonitoringIntervals.set(monitorKey, {
        botId: client.botId,
        guildId,
        interval,
    });
}

/**
 * Keep the empty-channel leave timer active during playback.
 */
function checkVoiceChannelState(client, guildId) {
    const player = client.riffy?.players?.get(guildId);
    if (!player?.voiceChannel) {
        stopVoiceChannelMonitoring(guildId, client.botId);
        return;
    }
    if (player._waitingRoom) {
        stopVoiceChannelMonitoring(guildId, client.botId);
        return;
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const voiceChannel =
        guild.channels.cache.get(player.voiceChannel) ||
        { id: player.voiceChannel };
    const humans = getHumanVoiceMembers(guild, voiceChannel);
    const guildData = getGuildData(guildId);

    if (humans.length === 0) {
        setPlayerIdleTimeout(client, player, guildData, "empty");
        return;
    }

    if (player._idleTimeoutReason === "empty") {
        clearPlayerIdleTimeout(player, guildData);
        if (
            !player.playing &&
            !player.paused &&
            !(player.queue && player.queue.length > 0)
        ) {
            setPlayerIdleTimeout(client, player, guildData, "idle");
        }
    }
}

/**
 * Stop voice channel monitoring
 */
function stopVoiceChannelMonitoring(guildId, botId) {
    for (const [monitorKey, monitor] of voiceChannelMonitoringIntervals) {
        if (
            monitor.guildId !== guildId ||
            (botId && monitor.botId !== botId)
        ) continue;
        clearInterval(monitor.interval);
        voiceChannelMonitoringIntervals.delete(monitorKey);
    }
}

function hasOtherActivePlayer(client, guildId) {
    return coordinator.getAllClients().some((otherClient) => {
        if (otherClient === client) return false;
        const otherPlayer = otherClient.riffy?.players?.get(guildId);
        return Boolean(otherPlayer?.voiceChannel && !otherPlayer._waitingRoom);
    });
}

module.exports = {
    setupPlayerHandler,
    startVoiceChannelMonitoring,
    stopVoiceChannelMonitoring,
    shouldAnnounceTrackStart,
    isQueueLoopRestart,
};
