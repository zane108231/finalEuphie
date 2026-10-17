const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder, EmbedBuilder } = require("discord.js");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const { isDuplicateTrack, startIfIdle, ensurePlayer, setAnnounceChannel, getOccupiedVoiceChannel, replyAlreadyInUse } = require("../utils/playback");
const coordinator = require("../utils/mongoCoordinator");
const config = require("../../config");

// mm:ss, zero padded (03:07)
function fmt(ms) {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function shuffleArray(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

// Find album art on a track, trying every place a Lavalink/Riffy track can store it
function getArtwork(track) {
    const url =
        track?.info?.artworkUrl ||
        track?.info?.thumbnail ||
        track?.pluginInfo?.artworkUrl ||
        track?.pluginInfo?.thumbnail ||
        null;
    return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

// Time until a track at queue index `index` starts playing
function etaUntilIndex(player, index) {
    let eta = 0;
    if (player.current?.info?.length) {
        eta += Math.max(0, player.current.info.length - (player.position || 0));
    }
    for (let i = 0; i < index; i++) {
        eta += player.queue[i]?.info?.length || 0;
    }
    return eta;
}

// "Added Track" embed (matches the reference screenshot)
function buildAddedTrackEmbed(client, user, { trackValue, eta, length, upcomingPos, queuePos, thumbnail, extraField }) {
    const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setAuthor({
            name: "Added Track",
            iconURL: client.user.displayAvatarURL(),
        })
        .addFields(
            { name: "Track", value: trackValue, inline: false },
            // Row 1: two fields + blank 3rd column (keeps it 2 columns wide)
            { name: "Estimated time until played", value: eta, inline: true },
            { name: "Track Length", value: length, inline: true },
            { name: "\u200b", value: "\u200b", inline: true },
            // Row 2: two fields + blank 3rd column
            { name: "Position in upcoming", value: upcomingPos, inline: true },
            { name: "Position in queue", value: queuePos, inline: true },
            { name: "\u200b", value: "\u200b", inline: true }
        )
        .setFooter({
            text: `Requested by ${user.username}`,
            iconURL: user.displayAvatarURL(),
        });

    if (extraField) embed.addFields(extraField);
    if (thumbnail) embed.setThumbnail(thumbnail);

    return embed;
}

// Send publicly in the channel (the deferred reply is ephemeral), fall back to the reply if that fails
async function sendPublicEmbed(interaction, embed) {
    try {
        await interaction.channel.send({ embeds: [embed] });
        await interaction.deleteReply().catch(() => {});
    } catch (err) {
        await interaction.editReply({ embeds: [embed] });
    }
}

module.exports = {
    aliases: ["p"],
    data: new SlashCommandBuilder()
        .setName("play")
        .setDescription("Play a song or add it to the queue")
        .addStringOption((opt) =>
            opt.setName("query").setDescription("Song name or URL").setRequired(true)
        ),

    async execute(interaction, client) {
        const query = interaction.options.getString("query");
        if (!query) {
            return interaction.reply({
                content: "❌ Usage: `!play <song name or URL>`",
                flags: MessageFlags.Ephemeral,
            });
        }
        if (/(?:youtube\.com|youtu\.be)/i.test(query)) {
            return interaction.reply({
                content: "❌ YouTube links are currently not supported.",
                flags: MessageFlags.Ephemeral,
            });
        }
        const member = interaction.member;

        if (!member.voice?.channel) {
            return interaction.reply({
                content: "❌ You need to be in a voice channel!",
                flags: MessageFlags.Ephemeral,
            });
        }

        const voiceChannelId = member.voice.channel.id;
        const userId = interaction.user.id;

        // Check if there's an existing session for this voice channel
        const sessionOwner = coordinator.getSessionOwner(voiceChannelId);

        if (sessionOwner) {
            // Session exists - anyone can add songs
            // Only DJ restrictions apply to skip, stop, remove, etc.
            const ownerClient = coordinator.getClient(sessionOwner);
            if (ownerClient && ownerClient !== client) {
                // This command was handled by the wrong bot, but the router should have caught this
                // Just in case, return here to prevent duplicate handling
                return;
            }
        } else {
            // No session exists - reserve THIS bot if available
            console.log(`[euphire] No session exists for voice channel ${voiceChannelId}, checking if bot ${client.botId} is available...`);

            // First check if this bot is available
            if (coordinator.isBotAvailable(client.botId)) {
                // This bot is available - reserve it directly
                const reserved = await coordinator.reserveSpecificBot(voiceChannelId, userId, client.botId, interaction.guild.id);
                if (reserved) {
                    console.log(`[euphire] Reserved this bot ${client.botId} for voice channel ${voiceChannelId}`);
                    // Proceed with this bot
                } else {
                    // Failed to reserve (race condition or error)
                    console.log(`[euphire] Failed to reserve bot ${client.botId}`);
                    return interaction.reply({
                        content: "❌ Failed to allocate a bot. Please try again.",
                        flags: MessageFlags.Ephemeral,
                    });
                }
            } else {
                // This bot is not available - check if it's the designated main bot for this guild
                const firstBotInGuild = coordinator.getFirstBotInGuild(interaction.guild.id);
                if (client.botId === firstBotInGuild) {
                    // Designated bot should only show error if NO bots are available at all in this guild
                    const anyAvailable = coordinator.hasAnyAvailableBot(interaction.guild.id);
                    console.log(`[euphire] Guild bot ${client.botId} is not available, anyAvailable=${anyAvailable}`);

                    if (!anyAvailable) {
                        // No bots available - show error
                        console.log(`[euphire] NO bots available in guild ${interaction.guild.id}, showing error message`);
                        const embed = new EmbedBuilder()
                            .setColor(config.accentColor || 0x2b2d31)
                            .setDescription("There are no more bots available in this server, looks like I am popular 😎\nYou can invite 2 more bots for free! Check out the invite command for more information.");

                        return interaction.reply({
                            embeds: [embed],
                            flags: MessageFlags.Ephemeral,
                        });
                    } else {
                        // Other bots are available - they will handle it
                        console.log(`[euphire] Other bots are available (${anyAvailable}), primary bot returning silently`);
                        return;
                    }
                } else {
                    // Secondary bot - silently return
                    console.log(`[euphire] Secondary bot ${client.botId} is not available, returning silently`);
                    return;
                }
            }
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guildData = getGuildData(interaction.guild.id);

        let player;
        try {
            player = await ensurePlayer(client, {
                guildId: interaction.guild.id,
                voiceChannelId: voiceChannelId,
                textChannelId: interaction.channel.id,
                volume: guildData.volume,
                requesterId: interaction.user.id,
            });
            guildData.cannotSendPlayer = false;
            setAnnounceChannel(player, guildData, interaction.channel.id);

            // Mark bot as active once player is created
            await coordinator.markBotActive(client.botId, voiceChannelId);
            coordinator.setSessionChannel(voiceChannelId, interaction.channel.id);
            coordinator.setSessionDJ(voiceChannelId, interaction.user.id);

            // Force set DJ ownership in guildData to match coordinator
            guildData.djOwnerId = interaction.user.id;
            await saveGuildData(interaction.guild.id, guildData);
        } catch (err) {
            console.error("[euphire] Failed to create player:", err);
            coordinator.releaseBot(voiceChannelId);
            return interaction.editReply({ content: "❌ Could not join your voice channel. Try again in a moment." });
        }

        try {
            const result = await client.riffy.resolve({
                query: query.trim(),
                source: "spsearch",
                requester: interaction.user,
            });

            const { loadType, tracks, playlistInfo } = result;

            // Handle all Lavalink v3 + v4 loadType variants
            if (
                loadType === "playlist" ||
                loadType === "PLAYLIST_LOADED"
            ) {
                const duplicates = [];
                const addedTracks = [];
                let addedLength = 0;

                // Where the first added song will sit in the queue
                const startIndex = player.queue.length;
                const wasIdle = !player.playing && !player.paused;
                const tracksToProcess = guildData.shuffle ? shuffleArray(tracks) : tracks;

                for (const track of tracksToProcess) {
                    track.info.requester = interaction.user;

                    if (isDuplicateTrack(player, track)) {
                        duplicates.push(track.info.title || "Unknown");
                    } else {
                        player.queue.add(track);
                        addedTracks.push(track.info.title || "Unknown");
                        addedLength += track.info.length || 0;
                    }
                }

                const eta = wasIdle ? 0 : etaUntilIndex(player, startIndex);
                const upcomingPos = startIndex === 0 ? "Next" : String(startIndex + 1);
                const queuePos = String(startIndex + 1 + (wasIdle ? 0 : 1));

                const embed = buildAddedTrackEmbed(client, interaction.user, {
                    trackValue: `${playlistInfo?.name || "Unknown Playlist"} (${addedTracks.length} songs)`,
                    eta: fmt(eta),
                    length: fmt(addedLength),
                    upcomingPos,
                    queuePos,
                    thumbnail: playlistInfo?.artworkUrl || getArtwork(tracks[0]),
                    extraField: duplicates.length > 0
                        ? { name: "Duplicates Skipped", value: `${duplicates.length} songs already in queue`, inline: false }
                        : null,
                });

                await sendPublicEmbed(interaction, embed);

                await startIfIdle(player);
            } else if (
                loadType === "search" ||
                loadType === "track" ||
                loadType === "SEARCH_RESULT" ||
                loadType === "TRACK_LOADED"
            ) {
                const track = tracks[0];
                if (!track) {
                    return interaction.editReply({ content: "❌ No results found." });
                }

                if (isDuplicateTrack(player, track)) {
                    const container = new ContainerBuilder();
                    container.addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            "### ⚠️ Duplicate Detected\n\n" +
                            "**Track**\n" +
                            `-# ${track.info.title}\n\n` +
                            "**Status**\n" +
                            `-# Already in queue or currently playing`
                        )
                    );
                    return await interaction.editReply({
                        components: [container],
                        flags: MessageFlags.IsComponentsV2,
                    });
                }

                track.info.requester = interaction.user;
                const shouldStart = !player.playing && !player.paused;
                player.queue.add(track);

                await startIfIdle(player);

                // Only send a message if adding to existing queue, not when starting playback
                if (!shouldStart) {
                    const queueLength = player.queue.length; // includes the track just added

                    // Remaining time of current song + every queued song before the new one
                    const eta = etaUntilIndex(player, queueLength - 1);

                    const upcomingPos = queueLength === 1 ? "Next" : String(queueLength);
                    const queuePos = String(queueLength + 1); // +1 for the currently playing track

                    const embed = buildAddedTrackEmbed(client, interaction.user, {
                        trackValue: `[${track.info.title} by ${track.info.author}](${track.info.uri})`,
                        eta: fmt(eta),
                        length: fmt(track.info.length),
                        upcomingPos,
                        queuePos,
                        thumbnail: getArtwork(track),
                    });

                    await sendPublicEmbed(interaction, embed);
                } else {
                    await interaction.deleteReply().catch(() => {});
                }
            } else {
                console.log(`[euphire] Unhandled loadType: "${loadType}"`);
                return interaction.editReply({ content: `❌ No results found. (loadType: ${loadType})` });
            }
        } catch (error) {
            console.error("[euphire] Play error:", error);
            return interaction.editReply({ content: "❌ An error occurred while searching." });
        }
    },
};