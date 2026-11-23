const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require("discord.js");
const {
    ensurePlayer,
    markIntentionalDisconnect,
    replyNoBotsAvailable,
    setAnnounceChannel,
    startIfIdle,
} = require("../utils/playback");
const {
    replyNotInVoiceChannel,
    canUseMusicAction,
    buildMissingPermissionResponse,
} = require("../utils/permissions");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const coordinator = require("../utils/mongoCoordinator");
const { searchYoutubeTrack, resolveSpotifyTrackAudio } = require("../utils/search");
const { getSpotifyPlaylistMetadata } = require("../utils/spotifyPlaylistSearch");
const { createCouldNotPlayEmbed } = require("../utils/components");
const {
    getSpotifyTrackDisplayName,
    setTrackDisplayMetadata,
    findSpotifyTrackMetadata,
    applySpotifyTrackMetadata,
} = require("../utils/search");

const SPOTIFY_ICON_URL = "https://cdn.discordapp.com/emojis/1570011075167002674.png";

function formatDurationLeadingZero(ms) {
    if (!ms || isNaN(ms)) return "00:00";
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

async function sendPublicEmbed(interaction, embed) {
    try {
        await interaction.channel.send({ embeds: [embed] });
        await interaction.deleteReply().catch(() => {});
    } catch (err) {
        await interaction.editReply({ embeds: [embed] });
    }
}

function buildSearchErrorEmbed(track = null) {
    return createCouldNotPlayEmbed(track);
}

module.exports = {
    aliases: ["ins"],
    data: new SlashCommandBuilder()
        .setName("insert")
        .setDescription("Insert a track right after the one that is currently playing")
        .addStringOption((opt) =>
            opt.setName("query").setDescription("Song name or URL").setRequired(true)
        ),

    async execute(interaction, client) {
        const query = interaction.options.getString("query");
        if (!query) {
            return interaction.reply({
                content: "❌ Usage: `e!insert <song name or URL>`",
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
            return replyNotInVoiceChannel(interaction);
        }

        const voiceChannelId = member.voice.channel.id;
        const guildId = interaction.guild.id;
        let sessionOwner = coordinator.resolveSessionOwner(
            voiceChannelId,
            interaction.guild
        );
        let newlyReserved = false;
        if (!sessionOwner) {
            const availableBotId = coordinator.getAvailableBotInGuild(guildId);
            if (!availableBotId) {
                return replyNoBotsAvailable(interaction);
            }

            const reserved = await coordinator.reserveSpecificBot(
                voiceChannelId,
                interaction.user.id,
                availableBotId,
                guildId
            );
            if (reserved) {
                sessionOwner = availableBotId;
                newlyReserved = true;
            } else {
                sessionOwner = coordinator.resolveSessionOwner(
                    voiceChannelId,
                    interaction.guild
                );
                if (!sessionOwner) {
                    return interaction.reply({
                        content: "❌ Failed to allocate a bot. Please try again.",
                        flags: MessageFlags.Ephemeral,
                    });
                }
            }
        }

        const targetClient = coordinator.getClient(sessionOwner) || client;
        const targetRiffy = targetClient.riffy;
        let player = targetRiffy.players.get(guildId) || null;
        const existingPlayer = player;
        const guildData = getGuildData(guildId);
        const releaseNewReservation = async () => {
            if (!newlyReserved) return;
            if (!existingPlayer && player) {
                markIntentionalDisconnect(player);
                player.destroy();
            } else if (existingPlayer) {
                try {
                    await require("../utils/waitingRoom")
                        .returnPlayerToWaitingRoom(targetClient, existingPlayer);
                } catch (error) {
                    console.error(
                        `[euphire] Failed to return ${targetClient.botId} to the waiting room after insert failure:`,
                        error
                    );
                }
            }
            await coordinator.releaseBot(voiceChannelId, targetClient.botId);
        };

        let playerReady = false;
        let failureTrack = null;
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            player = await ensurePlayer(targetClient, {
                guildId,
                voiceChannelId,
                voiceChannelObject: member.voice.channel,
                textChannelId: interaction.channel.id,
                volume: guildData.volume,
                requesterId: interaction.user.id,
            });
            playerReady = true;
            guildData.cannotSendPlayer = false;
            setAnnounceChannel(player, guildData, interaction.channel.id);
            await coordinator.markBotActive(sessionOwner, voiceChannelId);
            coordinator.setSessionChannel(voiceChannelId, interaction.channel.id);
            if (newlyReserved) {
                coordinator.setSessionDJ(voiceChannelId, interaction.user.id);
                guildData.djOwnerId = interaction.user.id;
                await saveGuildData(guildId, guildData);
            }

            const result = await targetRiffy.resolve({
                query: query.trim(),
                source: "spsearch",
                requester: interaction.user,
            });

            const { loadType, tracks, playlistInfo } = result;
            if (
                loadType === "playlist" ||
                loadType === "playlist_loaded" ||
                loadType === "PLAYLIST_LOADED"
            ) {
                if (!(await canUseMusicAction(member, player, "add playlist"))) {
                    await releaseNewReservation();
                    return interaction.editReply(
                        buildMissingPermissionResponse("add playlist", "session")
                    );
                }
                const playlistUrl = query.trim();
                let spotifyPlaylistMetadata = null;
                if (/^https?:\/\/(?:www\.)?open\.spotify\.com\/.*playlist\//i.test(playlistUrl)) {
                    try {
                        spotifyPlaylistMetadata =
                            await getSpotifyPlaylistMetadata(playlistUrl);
                    } catch (error) {
                        console.warn(
                            `[euphire] Could not fetch Spotify playlist artwork for "${playlistUrl}":`,
                            error.message
                        );
                    }
                }

                const playableTracks = [];
                let failedTrackCount = 0;
                for (const track of tracks || []) {
                    let playableTrack = track;
                    if (
                        String(track?.info?.sourceName || "").toLowerCase() ===
                        "spotify"
                    ) {
                        try {
                            const youtubeTrack = await searchYoutubeTrack(
                                targetRiffy,
                                track,
                                interaction.user
                            );
                            if (!youtubeTrack) {
                                failedTrackCount += 1;
                                continue;
                            }
                            track.track = youtubeTrack.track;
                        } catch (error) {
                            failedTrackCount += 1;
                            console.warn(
                                `[euphire] Could not resolve inserted Spotify playlist track "${track.info?.title || "Unknown"}":`,
                                error.message
                            );
                            continue;
                        }
                    }

                    playableTrack.info.requester = interaction.user;
                    const spotifyMetadata = await findSpotifyTrackMetadata(
                        targetRiffy,
                        playableTrack,
                        interaction.user
                    );
                    applySpotifyTrackMetadata(playableTrack, spotifyMetadata);
                    if (!playableTrack.info.spotifyTitle) {
                        setTrackDisplayMetadata(playableTrack, null);
                    }
                    playableTracks.push(playableTrack);
                }

                if (!playableTracks.length) {
                    await releaseNewReservation();
                    return interaction.editReply({
                        content: tracks?.length
                            ? `❌ None of the ${tracks.length} playlist tracks could be matched to playable audio.`
                            : "❌ This playlist has no tracks.",
                    });
                }

                const existingQueue = [...player.queue];
                const wasIdle = !player.playing && !player.paused;
                const etaMs = wasIdle
                    ? 0
                    : Math.max(
                          0,
                          (player.current?.info?.length || 0) -
                              (player.position || 0)
                      );
                player.queue.clear();
                for (const track of playableTracks) {
                    player.queue.add(track);
                }
                for (const track of existingQueue) {
                    player.queue.add(track);
                }
                await startIfIdle(player);

                const playlistName =
                    spotifyPlaylistMetadata?.name ||
                    playlistInfo?.name ||
                    "Spotify Playlist";
                const playlistUrlForCard =
                    spotifyPlaylistMetadata?.url ||
                    playlistInfo?.url ||
                    playlistUrl;
                const playlistArtwork =
                    spotifyPlaylistMetadata?.artworkUrl ||
                    (!spotifyPlaylistMetadata &&
                    !/^https?:\/\/(?:www\.)?open\.spotify\.com\/.*playlist\//i.test(
                        playlistUrl
                    )
                        ? playlistInfo?.artworkUrl || playlistInfo?.thumbnail
                        : null);
                const playlistLength = tracks.reduce(
                    (total, track) =>
                        total + (Number(track?.info?.length) || 0),
                    0
                );
                const playlistTrackCount =
                    spotifyPlaylistMetadata?.trackCount ||
                    Number(playlistInfo?.trackCount) ||
                    Number(playlistInfo?.tracks?.total) ||
                    tracks.length;
                const unavailableTrackCount = Math.max(
                    failedTrackCount,
                    playlistTrackCount - playableTracks.length
                );
                const embed = new EmbedBuilder()
                    .setColor(0x2b2d31)
                    .setAuthor({
                        name: "Added Playlist",
                        iconURL: targetClient.user?.displayAvatarURL?.(),
                    })
                    .addFields(
                        {
                            name: "Playlist",
                            value: `[${playlistName.replace(/[\[\]]/g, "\\$&")}](${playlistUrlForCard})`,
                            inline: false,
                        },
                        {
                            name: "Playlist Length",
                            value: formatDurationLeadingZero(playlistLength),
                            inline: true,
                        },
                        {
                            name: "Tracks",
                            value: String(playlistTrackCount),
                            inline: true,
                        },
                        {
                            name: "Estimated time until played",
                            value: formatDurationLeadingZero(etaMs),
                            inline: false,
                        },
                        {
                            name: "Position in upcoming",
                            value: wasIdle ? "Now" : "Next",
                            inline: true,
                        },
                        {
                            name: "Position in queue",
                            value: wasIdle ? "1" : "2",
                            inline: true,
                        }
                    )
                    .setFooter({
                        text: `Requested by ${interaction.user.tag || interaction.user.username}`,
                        iconURL: interaction.user.displayAvatarURL(),
                    });
                if (playlistArtwork) embed.setThumbnail(playlistArtwork);
                if (unavailableTrackCount > 0) {
                    embed.addFields({
                        name: "Unavailable tracks",
                        value: String(unavailableTrackCount),
                        inline: true,
                    });
                }
                return sendPublicEmbed(interaction, embed);
            }

            if (
                loadType === "search" ||
                loadType === "track" ||
                loadType === "SEARCH_RESULT" ||
                loadType === "TRACK_LOADED"
            ) {
                if (!(await canUseMusicAction(member, player, "add track"))) {
                    await releaseNewReservation();
                    return interaction.editReply(
                        buildMissingPermissionResponse("add track", "session")
                    );
                }
                let track = tracks[0];
                failureTrack = track || null;
                if (!track) {
                    await releaseNewReservation();
                    return interaction.editReply({
                        embeds: [buildSearchErrorEmbed()],
                    });
                }

                track = await resolveSpotifyTrackAudio(
                    targetRiffy,
                    track,
                    interaction.user
                );
                if (!track) {
                    await releaseNewReservation();
                    return interaction.editReply({
                        embeds: [buildSearchErrorEmbed(failureTrack)],
                    });
                }
                failureTrack = track;

                setTrackDisplayMetadata(track, query);
                const spotifyMetadata = await findSpotifyTrackMetadata(
                    targetRiffy,
                    track,
                    interaction.user
                );
                applySpotifyTrackMetadata(track, spotifyMetadata);
                track.info.requester = interaction.user;

                const wasIdle = !player.playing && !player.paused;
                const queueArray = [...player.queue];
                player.queue.clear();
                player.queue.add(track);
                queueArray.forEach((queuedTrack) => player.queue.add(queuedTrack));

                const etaMs = wasIdle
                    ? 0
                    : Math.max(
                          0,
                          (player.current?.info?.length || 0) -
                              (player.position || 0)
                      );
                const eta = formatDurationLeadingZero(etaMs);
                const trackLength = formatDurationLeadingZero(track.info.length || 0);
                const displayName = getSpotifyTrackDisplayName(track);
                const trackValue = track.info.spotifyUrl
                    ? `[${displayName}](${track.info.spotifyUrl})`
                    : displayName;
                const thumbnail = track.info.spotifyArtworkUrl || null;

                // Build Added Track Embed strictly matching Image #1
                const embed = new EmbedBuilder()
                    .setColor(0x2b2d31)
                    .setAuthor({
                        name: "Added Track",
                        iconURL: SPOTIFY_ICON_URL,
                    })
                    .addFields(
                        { name: "Track", value: trackValue, inline: false },
                        { name: "Estimated time until played", value: eta, inline: true },
                        { name: "Track Length", value: trackLength, inline: true },
                        { name: "\u200b", value: "\u200b", inline: true },
                        { name: "Position in upcoming", value: wasIdle ? "Now" : "Next", inline: true },
                        { name: "Position in queue", value: wasIdle ? "1" : "2", inline: true },
                        { name: "\u200b", value: "\u200b", inline: true }
                    )
                    .setFooter({
                        text: `Requested by ${interaction.user.tag || interaction.user.username}`,
                        iconURL: interaction.user.displayAvatarURL(),
                    });

                if (thumbnail) {
                    embed.setThumbnail(thumbnail);
                }

                await startIfIdle(player);
                await sendPublicEmbed(interaction, embed);
            } else {
                await releaseNewReservation();
                return interaction.editReply({
                    embeds: [buildSearchErrorEmbed(failureTrack)],
                });
            }
        } catch (error) {
            await releaseNewReservation();
            console.error("[euphire] Insert error:", error);
            if (error?.code === "VOICE_CHANNEL_PERMISSION_MISSING") {
                return interaction.editReply({ content: error.message });
            }
            if (!playerReady) {
                return interaction.editReply({
                    content: "❌ Could not join your voice channel. Try again in a moment.",
                });
            }
            return interaction.editReply({
                embeds: [buildSearchErrorEmbed()],
            });
        }
    },
};
