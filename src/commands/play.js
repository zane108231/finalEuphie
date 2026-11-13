const {
    SlashCommandBuilder,
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const { startIfIdle, ensurePlayer, setAnnounceChannel, getOccupiedVoiceChannel, replyAlreadyInUse } = require("../utils/playback");
const coordinator = require("../utils/mongoCoordinator");
const { getPrefix } = require("../utils/prefixStore");
const { replyNotInVoiceChannel } = require("../utils/permissions");
const {
    getSpotifyTrackDisplayName,
    setTrackDisplayMetadata,
    findSpotifyTrackMetadata,
    applySpotifyTrackMetadata,
    resolveSpotifyTrackAudio,
} = require("../utils/search");
const config = require("../../config");
const { getSpotifyPlaylistMetadata } = require("../utils/spotifyPlaylistSearch");

// mm:ss, zero padded (03:07)
function fmt(ms) {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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

function getPlaylistQueueDetails(player, startIndex, wasIdle) {
    if (wasIdle && startIndex === 0) return {};

    const positionIndex =
        wasIdle && startIndex > 0 ? startIndex - 1 : startIndex;
    return {
        eta: formatPlaylistDuration(etaUntilIndex(player, positionIndex)),
        upcomingPosition: positionIndex + 1,
        queuePosition: positionIndex + (player.current ? 2 : 1),
    };
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
    if (interaction.replacePlaylistSearchMessage && interaction.message?.edit) {
        try {
            const message = await interaction.message.edit({
                embeds: [embed],
                components: [],
            });
            interaction.playlistSearchMessageUpdated = true;
            await interaction.deleteReply().catch(() => {});
            return message;
        } catch (error) {
            console.error(
                "[euphire] Could not replace playlist search results with the added playlist card:",
                error.message
            );
        }
    }

    try {
        const message = await interaction.channel.send({ embeds: [embed] });
        await interaction.deleteReply().catch(() => {});
        return message;
    } catch (err) {
        await interaction.editReply({ embeds: [embed] });
        return interaction.fetchReply();
    }
}

async function updatePublicEmbed(interaction, message, embed) {
    if (message?.edit) {
        await message.edit({ embeds: [embed], components: [] });
    } else if (interaction.playlistSearchMessageUpdated && interaction.message?.edit) {
        await interaction.message.edit({ embeds: [embed], components: [] });
    } else {
        await interaction.editReply({ embeds: [embed] });
    }
}

function formatPlaylistDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getLoadFailureMessage(exception) {
    if (typeof exception === "string") return exception;
    if (!exception || typeof exception !== "object") return "";
    return [exception.severity, exception.message, exception.cause]
        .filter((value) => typeof value === "string" && value.trim())
        .join(": ")
        .slice(0, 500);
}

function buildPlayErrorEmbed() {
    return new EmbedBuilder()
        .setColor(0xed4245)
        .setDescription("Could not find song");
}

function buildAddedPlaylistEmbed(
    client,
    playlist,
    playlistInfo,
    tracks,
    length,
    {
        trackCount = playlist?.trackCount || tracks.length,
        unavailableTrackCount = 0,
        eta,
        upcomingPosition,
        queuePosition,
    } = {}
) {
    const name =
        playlistInfo?.name || playlist?.name || "Unknown Playlist";
    const url = playlist?.url || playlistInfo?.url || "https://open.spotify.com";
    const isSpotifyPlaylist = /open\.spotify\.com\/playlist\//i.test(url);
    const artwork =
        playlist?.artworkUrl ||
        (!isSpotifyPlaylist
            ? playlistInfo?.artworkUrl ||
              playlistInfo?.thumbnail ||
              getArtwork(tracks[0])
            : null);
    const escapedName = name.replace(/[\[\]]/g, "\\$&");
    const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setAuthor({
            name: "Added Playlist",
            iconURL: client.user?.displayAvatarURL?.(),
        })
        .addFields(
            {
                name: "Playlist",
                value: `[${escapedName}](${url})`,
                inline: false,
            },
            {
                name: "Playlist Length",
                value: formatPlaylistDuration(length),
                inline: true,
            },
            {
                name: "Tracks",
                value: String(trackCount),
                inline: true,
            }
        );
    if (eta !== undefined) {
        embed.addFields(
            {
                name: "Estimated time until played",
                value: eta,
                inline: false,
            },
            {
                name: "Position in upcoming",
                value: String(upcomingPosition),
                inline: true,
            },
            {
                name: "Position in queue",
                value: String(queuePosition),
                inline: true,
            }
        );
    }
    if (unavailableTrackCount > 0) {
        embed.addFields({
            name: "Unavailable tracks",
            value: String(unavailableTrackCount),
            inline: true,
        });
    }
    if (artwork && /^https?:\/\//i.test(artwork)) {
        embed.setThumbnail(artwork);
    }
    return embed;
}

async function resolveSpotifyTracksAudio(riffy, tracks, requester, onBatch) {
    for (let offset = 0; offset < tracks.length; offset += 4) {
        const batch = await Promise.all(
            tracks.slice(offset, offset + 4).map((track) =>
                resolveSpotifyTrackAudio(riffy, track, requester)
            )
        );
        const playableBatch = batch.filter(Boolean);
        const batchFailedCount = batch.length - playableBatch.length;
        if (onBatch) await onBatch(playableBatch, batchFailedCount);
    }
}

async function resolveInitialPlaylistTracks(riffy, tracks, requester) {
    const playableTracks = [];
    let failedTrackCount = 0;
    let nextIndex = 0;

    while (nextIndex < tracks.length && playableTracks.length < 4) {
        const batch = tracks.slice(nextIndex, nextIndex + 4);
        const resolvedBatch = await Promise.all(
            batch.map((track) =>
                resolveSpotifyTrackAudio(riffy, track, requester)
            )
        );
        nextIndex += batch.length;
        failedTrackCount += resolvedBatch.filter((track) => !track).length;

        for (const track of resolvedBatch.filter(Boolean)) {
            track.info.requester = requester;
            setTrackDisplayMetadata(track, null);
            playableTracks.push(track);
        }
    }

    return { playableTracks, failedTrackCount, nextIndex };
}

module.exports = {
    aliases: ["p"],
    resolveInitialPlaylistTracks,
    resolveSpotifyTrackAudio,
    data: new SlashCommandBuilder()
        .setName("play")
        .setDescription("Play a song or add it to the queue")
        .addStringOption((opt) =>
            opt.setName("query").setDescription("Song name or URL").setRequired(true)
        ),

    async execute(interaction, client) {
        const query =
            interaction.queryOverride || interaction.options.getString("query");
        if (!query) {
            const prefix = getPrefix(interaction.guild?.id, interaction.user?.id);
            const helpEmbed = new EmbedBuilder()
                .setColor(0x2b2d31)
                .setAuthor({
                    name: "Help",
                    iconURL: client.user.displayAvatarURL(),
                })
                .setDescription(
                    `**Usage:** ${prefix}play <search term | url>\n` +
                        "**Description:** Queue a track or playlist from a search term or url"
                );
            const helpButton = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId("help_open")
                    .setLabel("Help")
                    .setStyle(ButtonStyle.Success)
            );

            return interaction.reply({
                embeds: [helpEmbed],
                components: [helpButton],
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

            // First check if this bot is available in this guild
            if (coordinator.isBotAvailable(client.botId, interaction.guild.id)) {
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

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        }

        const guildData = getGuildData(interaction.guild.id);

        let player;
        try {
            player = await ensurePlayer(client, {
                guildId: interaction.guild.id,
                voiceChannelId: voiceChannelId,
                voiceChannelObject: member.voice.channel,
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
            return interaction.editReply({
                content:
                    err.code === "VOICE_CHANNEL_PERMISSION_MISSING"
                        ? err.message
                        : "❌ Could not join your voice channel. Try again in a moment.",
            });
        }

        try {
            const trimmedQuery = query.trim();
            const isSpotifyUrl =
                /^https?:\/\/(?:www\.)?open\.spotify\.com\//i.test(trimmedQuery);
            const isUrl = /^https?:\/\//i.test(trimmedQuery);
            const result = await client.riffy.resolve({
                query: trimmedQuery,
                source: isUrl && !isSpotifyUrl ? "ytsearch" : "spsearch",
                requester: interaction.user,
            });

            const { loadType, tracks, playlistInfo, exception } = result;

            // Handle all Lavalink v3 + v4 loadType variants
            if (
                loadType === "playlist" ||
                loadType === "playlist_loaded" ||
                loadType === "PLAYLIST_LOADED"
            ) {
                const addedTracks = [];
                let failedTrackCount = 0;
                const playlistLength = tracks.reduce(
                    (total, track) => total + (track.info.length || 0),
                    0
                );

                const wasIdle = !player.playing && !player.paused;
                const startIndex = player.queue.length;
                const orderedTracks = tracks;
                const initialPlaylistBatch =
                    await resolveInitialPlaylistTracks(
                        client.riffy,
                        orderedTracks,
                        interaction.user
                    );
                failedTrackCount = initialPlaylistBatch.failedTrackCount;
                for (const track of initialPlaylistBatch.playableTracks) {
                    player.queue.add(track);
                    addedTracks.push(track.info.title || "Unknown");
                }

                if (initialPlaylistBatch.playableTracks.length === 0) {
                    return interaction.editReply({
                        content: tracks.length > 0
                            ? `❌ None of the ${tracks.length} Spotify tracks had a matching YouTube result.`
                            : "❌ This playlist has no tracks to play.",
                    });
                }

                interaction.playbackQueryQueued = addedTracks.length > 0;
                if (interaction.playbackQueryQueued && interaction.onPlaybackQueued) {
                    await interaction.onPlaybackQueued(interaction, client);
                }
                await startIfIdle(player);

                const selectedPlaylist = interaction.playlistSearchSelection;
                let spotifyPlaylistMetadata = null;
                if (isSpotifyUrl && !selectedPlaylist?.artworkUrl) {
                    try {
                        spotifyPlaylistMetadata =
                            await getSpotifyPlaylistMetadata(trimmedQuery);
                    } catch (error) {
                        console.warn(
                            `[euphire] Could not fetch Spotify playlist artwork for "${trimmedQuery}":`,
                            error.message
                        );
                    }
                }
                const playlistCardData = {
                    name:
                        selectedPlaylist?.name ||
                        spotifyPlaylistMetadata?.name ||
                        playlistInfo?.name ||
                        "Unknown Playlist",
                    url:
                        selectedPlaylist?.url ||
                        spotifyPlaylistMetadata?.url ||
                        playlistInfo?.url ||
                        (isSpotifyUrl ? trimmedQuery : "https://open.spotify.com"),
                    artworkUrl:
                        selectedPlaylist?.artworkUrl ||
                        spotifyPlaylistMetadata?.artworkUrl ||
                        (!isSpotifyUrl
                            ? playlistInfo?.artworkUrl ||
                              playlistInfo?.thumbnail ||
                              getArtwork(orderedTracks[0])
                            : null),
                    trackCount:
                        selectedPlaylist?.trackCount ||
                        spotifyPlaylistMetadata?.trackCount ||
                        tracks.length,
                };
                const initialEmbed = buildAddedPlaylistEmbed(
                    client,
                    playlistCardData,
                    playlistInfo,
                    orderedTracks,
                    playlistLength,
                    getPlaylistQueueDetails(player, startIndex, wasIdle)
                );
                const progressMessage = await sendPublicEmbed(
                    interaction,
                    initialEmbed
                );

                const remainingTracks = orderedTracks.slice(
                    initialPlaylistBatch.nextIndex
                );
                const playlistResolution = (async () => {
                    try {
                        await resolveSpotifyTracksAudio(
                            client.riffy,
                            remainingTracks,
                            interaction.user,
                            async (playableBatch, batchFailedCount) => {
                                failedTrackCount += batchFailedCount;
                                for (const track of playableBatch) {
                                    track.info.requester = interaction.user;
                                    setTrackDisplayMetadata(track, null);
                                    player.queue.add(track);
                                    addedTracks.push(track.info.title || "Unknown");
                                }
                            }
                        );

                        if (failedTrackCount) {
                            console.warn(
                                `[euphire] Spotify playlist "${playlistCardData.name}" had ${failedTrackCount} track(s) without a matching YouTube result.`
                            );
                        }
                        const finalEmbed = buildAddedPlaylistEmbed(
                            client,
                            playlistCardData,
                            playlistInfo,
                            orderedTracks,
                            playlistLength,
                            {
                                ...getPlaylistQueueDetails(
                                    player,
                                    startIndex,
                                    wasIdle
                                ),
                                trackCount: playlistCardData.trackCount,
                                unavailableTrackCount: Math.max(
                                    failedTrackCount,
                                    playlistCardData.trackCount -
                                        addedTracks.length
                                ),
                            }
                        );
                        await updatePublicEmbed(
                            interaction,
                            progressMessage,
                            finalEmbed
                        );
                    } catch (error) {
                        console.error(
                            `[euphire] Failed to finish queueing Spotify playlist "${playlistInfo?.name || playlistCardData.name}":`,
                            error
                        );
                        const failedEmbed = buildAddedPlaylistEmbed(
                            client,
                            playlistCardData,
                            playlistInfo,
                            orderedTracks,
                            playlistLength,
                            {
                                ...getPlaylistQueueDetails(
                                    player,
                                    startIndex,
                                    wasIdle
                                ),
                                trackCount: playlistCardData.trackCount,
                                unavailableTrackCount: Math.max(
                                    failedTrackCount,
                                    playlistCardData.trackCount -
                                        addedTracks.length
                                ),
                            }
                        );
                        await updatePublicEmbed(
                            interaction,
                            progressMessage,
                            failedEmbed
                        ).catch((editError) => {
                            console.error(
                                "[euphire] Could not update playlist queue status:",
                                editError.message
                            );
                        });
                    }
                })();
                if (!client._pendingPlaybackTasks) {
                    client._pendingPlaybackTasks = new Set();
                }
                client._pendingPlaybackTasks.add(playlistResolution);
                playlistResolution.then(
                    () => client._pendingPlaybackTasks.delete(playlistResolution),
                    () => client._pendingPlaybackTasks.delete(playlistResolution)
                );
            } else if (
                loadType === "search" ||
                loadType === "track" ||
                loadType === "SEARCH_RESULT" ||
                loadType === "TRACK_LOADED"
            ) {
                let track = tracks[0];
                if (!track) {
                    return interaction.editReply({
                        embeds: [buildPlayErrorEmbed()],
                    });
                }

                track = await resolveSpotifyTrackAudio(
                    client.riffy,
                    track,
                    interaction.user
                );
                if (!track) {
                    return interaction.editReply({
                        embeds: [buildPlayErrorEmbed()],
                    });
                }

                setTrackDisplayMetadata(
                    track,
                    isSpotifyUrl ? null : trimmedQuery
                );
                if (!isUrl || isSpotifyUrl) {
                    const spotifyMetadata = await findSpotifyTrackMetadata(
                        client.riffy,
                        track,
                        interaction.user
                    );
                    applySpotifyTrackMetadata(track, spotifyMetadata);
                }

                track.info.requester = interaction.user;
                const shouldStart = !player.playing && !player.paused;
                player.queue.add(track);
                interaction.playbackQueryQueued = true;
                if (interaction.onPlaybackQueued) {
                    await interaction.onPlaybackQueued(interaction, client);
                }

                await startIfIdle(player);

                // Search selections replace their result list even when playback starts immediately.
                if (!shouldStart || interaction.replacePlaylistSearchMessage) {
                    const queueLength = player.queue.length; // includes the track just added

                    // Remaining time of current song + every queued song before the new one
                    const eta = etaUntilIndex(player, queueLength - 1);

                    const upcomingPos = queueLength === 1 ? "Next" : String(queueLength);
                    const queuePos = String(queueLength + 1); // +1 for the currently playing track
                    const displayName = getSpotifyTrackDisplayName(track);

                    const embed = buildAddedTrackEmbed(client, interaction.user, {
                        trackValue: track.info.spotifyUrl
                            ? `[${displayName}](${track.info.spotifyUrl})`
                            : displayName,
                        eta: fmt(eta),
                        length: fmt(track.info.length),
                        upcomingPos,
                        queuePos,
                        thumbnail:
                            track.info.spotifyArtworkUrl ||
                            (isSpotifyUrl ? getArtwork(track) : null),
                    });

                    await sendPublicEmbed(interaction, embed);
                } else {
                    await interaction.deleteReply().catch(() => {});
                }
            } else {
                const failure = getLoadFailureMessage(exception);
                console.warn(
                    `[euphire] No playable results for "${query}" (loadType: ${loadType})${failure ? `: ${failure}` : ""}`
                );
                return interaction.editReply({
                    embeds: [buildPlayErrorEmbed()],
                });
            }
        } catch (error) {
            console.error("[euphire] Play error:", error.message);
            return interaction.editReply({
                embeds: [buildPlayErrorEmbed()],
            });
        }
    },
};