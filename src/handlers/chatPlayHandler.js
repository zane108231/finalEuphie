const { MessageFlags } = require("discord.js");
const { getGuildData } = require("../utils/mongoGuildData");
const { createChatPlayLoadingContainer } = require("../utils/components");
const { isDuplicateTrack, startIfIdle, ensurePlayer, getOccupiedVoiceChannel, buildAlreadyInUsePayload } = require("../utils/playback");

async function sendChatPlayFeedback(channel, content, timeoutMs = 5000) {
    try {
        const feedback = await channel.send({ content });
        setTimeout(() => feedback.delete().catch(() => {}), timeoutMs);
    } catch (err) {
        // Can't send in channel — ignore
    }
}

/**
 * Handle ChatPlay messages
 * - Deletes user's message
 * - Resolves the song
 * - Plays in user's VC
 * - Edits the persistent ChatPlay message (never sends a new one)
 */
async function handleChatPlayMessage(client, message) {
    const guildData = getGuildData(message.guild.id);

    // Only handle messages in the ChatPlay channel when enabled
    if (!guildData.chatPlayChannelId || message.channel.id !== guildData.chatPlayChannelId) {
        return false;
    }

    // Check if ChatPlay is enabled
    if (!guildData.chatPlayEnabled) return false;

    // Ignore bot messages
    if (message.author.bot) return false;

    const query = message.content.trim();
    if (!query) return false;

    if (/(?:youtube\.com|youtu\.be)/i.test(query)) {
        try {
            await message.delete();
            const warn = await message.channel.send({
                content: "❌ YouTube links are currently not supported.",
            });
            setTimeout(() => warn.delete().catch(() => {}), 5000);
        } catch (err) {}
        return true;
    }

    // Delete the user's message immediately
    try {
        await message.delete();
    } catch (err) {
        console.error("[euphire ChatPlay] Failed to delete message:", err.message);
    }

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
        try {
            const warn = await message.channel.send({
                content: "❌ You need to join a voice channel first!",
            });
            setTimeout(() => warn.delete().catch(() => {}), 5000);
        } catch (err) {
            // Can't send in channel — ignore
        }
        return true;
    }

    const occupied = getOccupiedVoiceChannel(message.guild, client);
    if (occupied && occupied.id !== voiceChannel.id) {
        try {
            const { containerPayload, embedPayload } = buildAlreadyInUsePayload(occupied);
            await message.channel.send(containerPayload).catch(async () => {
                await message.channel.send(embedPayload);
            });
        } catch {
            // ignore
        }
        return true;
    }

    try {
        let player = await ensurePlayer(client, {
            guildId: message.guild.id,
            voiceChannelId: voiceChannel.id,
            textChannelId: message.channel.id,
            volume: guildData.volume,
            requesterId: message.author.id,
        });

        // Update ChatPlay message to show loading state (only for first song)
        if (!player.playing && !player.paused && !player.current) {
            try {
                const loadingContainer = createChatPlayLoadingContainer();
                const channel = client.channels.cache.get(guildData.chatPlayChannelId);
                if (channel && guildData.chatPlayMessageId) {
                    const msg = await channel.messages.fetch(guildData.chatPlayMessageId);
                    await msg.edit({
                        components: [loadingContainer],
                        flags: MessageFlags.IsComponentsV2,
                    });
                }
            } catch (err) {
                // Ignore if message edit fails
            }
        }

        // Resolve the query
        const result = await client.riffy.resolve({
            query: query.trim(),
            source: "spsearch",
            requester: message.author,
        });

        const { loadType, tracks, playlistInfo } = result;



        // Handle all loadType variants (v3 + v4)
        if (
            loadType === "playlist" ||
            loadType === "PLAYLIST_LOADED"
        ) {
            const duplicates = [];
            const addedTracks = [];
            
            for (const track of tracks) {
                track.info.requester = message.author;
                
                if (isDuplicateTrack(player, track)) {
                    duplicates.push(track.info.title || "Unknown");
                } else {
                    player.queue.add(track);
                    addedTracks.push(track.info.title || "Unknown");
                }
            }
            
            // Send feedback for playlist
            try {
                const playlistName = playlistInfo?.name || "Playlist";
                let feedbackMsg = `✅ Added **${addedTracks.length}** of **${tracks.length}** tracks from **${playlistName}**!`;
                if (duplicates.length > 0) {
                    feedbackMsg += `\n⚠️ Skipped ${duplicates.length} duplicates: ${duplicates.slice(0, 3).join(", ")}${duplicates.length > 3 ? "..." : ""}`;
                }
                await sendChatPlayFeedback(message.channel, feedbackMsg);
            } catch (err) {}
            await startIfIdle(player);
        } else if (
            loadType === "search" ||
            loadType === "track" ||
            loadType === "SEARCH_RESULT" ||
            loadType === "TRACK_LOADED"
        ) {
            const track = tracks[0];
            if (!track) {
                await sendChatPlayFeedback(message.channel, "❌ No results found for that search.");
                return true;
            }
            
            if (isDuplicateTrack(player, track)) {
                try {
                    const feedback = await message.channel.send({
                        content: `⚠️ **${track.info.title}** is already in the queue!`
                    });
                    setTimeout(() => feedback.delete().catch(() => {}), 3000);
                } catch (err) {}
                return true;
            }
            
            track.info.requester = message.author;
            player.queue.add(track);
            // Send feedback for single track
            try {
                const feedback = await message.channel.send({
                    content: `✅ Added **${track.info.title}** to queue!`
                });
                setTimeout(() => feedback.delete().catch(() => {}), 3000);
            } catch (err) {}
            await startIfIdle(player);
        } else if (loadType === "empty" || loadType === "EMPTY" || loadType === "NO_MATCHES") {
            await sendChatPlayFeedback(message.channel, "❌ No results found for that search.");
        } else {
            console.log(`[euphire ChatPlay] Unhandled loadType: "${loadType}"`);
            await sendChatPlayFeedback(message.channel, "❌ No results found for that search.");
        }
    } catch (error) {
        console.error("[euphire ChatPlay] Error:", error.message);
        await sendChatPlayFeedback(message.channel, "❌ Something went wrong while searching for that song.");
    }

    return true;
}

module.exports = { handleChatPlayMessage };
