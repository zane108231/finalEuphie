const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require("discord.js");
const { createNoBotInVoiceEmbed } = require("../utils/permissions");
const coordinator = require("../utils/mongoCoordinator");
const config = require("../../config");

// Store active queue sessions: sessionId -> { guildId, voiceChannelId, userId, currentPage, createdAt }
const queueSessions = new Map();

// Periodic cleanup every 5 minutes for sessions older than 15 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, data] of queueSessions) {
        if (now - data.createdAt > 15 * 60 * 1000) {
            queueSessions.delete(id);
        }
    }
}, 5 * 60 * 1000);

const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/**
 * Format milliseconds to [mm:ss] or [hh:mm:ss] with leading zeroes
 */
function formatDurationLeadingZero(ms) {
    if (!ms || isNaN(ms)) return "00:00";
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const mm = minutes.toString().padStart(2, "0");
    const ss = seconds.toString().padStart(2, "0");
    if (hours > 0) {
        return `${hours.toString().padStart(2, "0")}:${mm}:${ss}`;
    }
    return `${mm}:${ss}`;
}

/**
 * Find active player for a guild / voice channel
 */
function findPlayer(guildId, voiceChannelId) {
    if (voiceChannelId) {
        const sessionOwner = coordinator.getSessionOwner(voiceChannelId);
        if (sessionOwner) {
            const r = coordinator.getRiffy(sessionOwner);
            const p = r?.players?.get(guildId);
            if (p) return p;
        }
        for (const c of coordinator.getAllClients()) {
            const p = c.riffy?.players?.get(guildId);
            if (p && p.voiceChannel === voiceChannelId) return p;
        }
    }
    for (const c of coordinator.getAllClients()) {
        const p = c.riffy?.players?.get(guildId);
        if (p) return p;
    }
    return null;
}

/**
 * Gather all tracks starting from current track followed by queue
 */
function getAllTracks(player) {
    const tracks = [];
    if (player?.current) {
        tracks.push(player.current);
    }
    if (player?.queue && player.queue.length > 0) {
        for (const t of player.queue) {
            tracks.push(t);
        }
    }
    return tracks;
}

/**
 * Build queue embed, dropdown selection, and pagination buttons strictly matching Image 1
 */
function buildQueuePayload(allTracks, page = 1, sessionId) {
    const PAGE_SIZE = 10;
    const totalTracks = allTracks.length;
    const totalPages = Math.max(1, Math.ceil(totalTracks / PAGE_SIZE));
    const currentPage = Math.max(1, Math.min(page, totalPages));

    const startIndex = (currentPage - 1) * PAGE_SIZE;
    const pageTracks = allTracks.slice(startIndex, startIndex + PAGE_SIZE);

    let description = `Page **${currentPage}/${totalPages}**\n\n`;

    const selectOptions = [];

    pageTracks.forEach((track, idx) => {
        const queueNumber = startIndex + idx + 1;
        const duration = formatDurationLeadingZero(track.info?.length);
        const title = track.info?.title || "Unknown Title";
        const author = track.info?.author || "Unknown Artist";
        const uri = track.info?.uri || "https://open.spotify.com";

        // Strictly follows Image 1: 1. `[03:59]` [Heat Waves by Glass Animals](uri)
        description += `${queueNumber}. \`[${duration}]\` [${title} by ${author}](${uri})\n`;

        const option = new StringSelectMenuOptionBuilder()
            .setLabel(title.slice(0, 100))
            .setDescription(`[${duration}] ${author}`.slice(0, 100))
            .setValue(`${sessionId}:${startIndex + idx}`);

        if (NUMBER_EMOJIS[idx]) {
            option.setEmoji(NUMBER_EMOJIS[idx]);
        }

        selectOptions.push(option);
    });

    description += `\ncancel`;

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setDescription(description);

    selectOptions.push(
        new StringSelectMenuOptionBuilder()
            .setLabel("cancel")
            .setDescription("Cancel selection")
            .setValue(`${sessionId}:cancel`)
    );

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("queue_select")
        .setPlaceholder("Make a selection")
        .addOptions(selectOptions);

    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    const prevButton = new ButtonBuilder()
        .setCustomId(`queue_page_prev:${sessionId}:${currentPage - 1}`)
        .setLabel("◀")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(currentPage <= 1);

    const pageIndicator = new ButtonBuilder()
        .setCustomId(`queue_page_info:${sessionId}`)
        .setLabel(`${currentPage}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true);

    const nextButton = new ButtonBuilder()
        .setCustomId(`queue_page_next:${sessionId}:${currentPage + 1}`)
        .setLabel("▶")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(currentPage >= totalPages);

    const paginationRow = new ActionRowBuilder().addComponents(prevButton, pageIndicator, nextButton);

    return {
        embeds: [embed],
        components: [selectRow, paginationRow],
    };
}

/**
 * Build Track Information embed strictly matching Image 2
 */
function buildTrackInfoPayload(client, player, allTracks, trackIndex) {
    const track = allTracks[trackIndex];
    if (!track) return null;

    const title = track.info?.title || "Unknown Title";
    const author = track.info?.author || "Unknown Artist";
    const uri = track.info?.uri || "https://open.spotify.com";
    const artwork = track.info?.artworkUrl || track.info?.thumbnail || null;
    const lengthStr = formatDurationLeadingZero(track.info?.length);

    // Calculate Estimated time until played
    let estimatedTimeStr = "00:00";
    if (trackIndex === 0) {
        estimatedTimeStr = "Currently playing";
    } else {
        const currentRemaining = Math.max(0, (player?.current?.info?.length || 0) - (player?.position || 0));
        let queueMsBefore = 0;
        for (let i = 1; i < trackIndex; i++) {
            queueMsBefore += allTracks[i]?.info?.length || 0;
        }
        const totalEstimatedMs = currentRemaining + queueMsBefore;
        estimatedTimeStr = formatDurationLeadingZero(totalEstimatedMs);
    }

    // Position in upcoming
    let positionInUpcoming = "-";
    if (trackIndex === 1) {
        positionInUpcoming = "Next";
    } else if (trackIndex > 1) {
        positionInUpcoming = String(trackIndex);
    }

    // Position in queue (1-based index)
    const positionInQueue = String(trackIndex + 1);

    // Requester info
    const rawRequester = track.info?.requester || track.requester;
    let requesterName = "Unknown";
    let requesterAvatar = null;
    if (rawRequester) {
        if (typeof rawRequester === "string") {
            const u = client.users?.cache?.get(rawRequester);
            requesterName = u ? (u.username || u.tag) : rawRequester;
            requesterAvatar = u?.displayAvatarURL?.({ dynamic: true });
        } else {
            requesterName = rawRequester.username || rawRequester.tag || "Unknown";
            requesterAvatar = rawRequester.displayAvatarURL ? rawRequester.displayAvatarURL({ dynamic: true }) : null;
        }
    }

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setAuthor({
            name: "Track Information",
            iconURL: client.user?.displayAvatarURL?.({ dynamic: true }) || undefined,
        })
        .addFields(
            {
                name: "Track",
                value: `[${title} by ${author}](${uri})`,
                inline: false,
            },
            {
                name: "Estimated time until played",
                value: estimatedTimeStr,
                inline: true,
            },
            {
                name: "Length",
                value: lengthStr,
                inline: true,
            },
            {
                name: "Position in upcoming",
                value: positionInUpcoming,
                inline: true,
            },
            {
                name: "Position in queue",
                value: positionInQueue,
                inline: true,
            }
        );

    if (artwork) {
        embed.setThumbnail(artwork);
    }

    if (requesterAvatar) {
        embed.setFooter({
            text: `Requested by ${requesterName}`,
            iconURL: requesterAvatar,
        });
    } else {
        embed.setFooter({
            text: `Requested by ${requesterName}`,
        });
    }

    embed.setTimestamp();

    return {
        embeds: [embed],
    };
}

/**
 * Open queue UI helper
 */
async function openQueueUI(interaction, client, player, requestedPage = 1) {
    const allTracks = getAllTracks(player);

    if (allTracks.length === 0) {
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setDescription("The queue is currently empty.");
        return interaction.reply({
            embeds: [embed],
        });
    }

    const sessionId = `qs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const totalPages = Math.max(1, Math.ceil(allTracks.length / 10));
    const page = Math.max(1, Math.min(requestedPage, totalPages));

    queueSessions.set(sessionId, {
        guildId: interaction.guild?.id,
        voiceChannelId: interaction.member?.voice?.channel?.id,
        userId: interaction.user.id,
        currentPage: page,
        createdAt: Date.now(),
    });

    const payload = buildQueuePayload(allTracks, page, sessionId);
    return await interaction.reply(payload);
}

module.exports = {
    aliases: ["q", "list"],
    data: new SlashCommandBuilder()
        .setName("queue")
        .setDescription("Show the current queue")
        .addIntegerOption((opt) =>
            opt
                .setName("page")
                .setDescription("Page number")
                .setRequired(false)
                .setMinValue(1)
        ),

    async execute(interaction, client) {
        const voiceChannelId = interaction.member?.voice?.channel?.id;
        const guildId = interaction.guild?.id;

        // Check voice channel
        if (!voiceChannelId) {
            return interaction.reply({
                embeds: [createNoBotInVoiceEmbed()],
                flags: MessageFlags.Ephemeral,
            });
        }

        const player = findPlayer(guildId, voiceChannelId);
        if (!player) {
            return interaction.reply({
                embeds: [createNoBotInVoiceEmbed()],
                flags: MessageFlags.Ephemeral,
            });
        }

        let requestedPage = 1;
        if (typeof interaction.options?.getInteger === "function") {
            requestedPage = interaction.options.getInteger("page") || 1;
        } else if (interaction.args && interaction.args.length > 0) {
            const parsed = parseInt(interaction.args[0], 10);
            if (!isNaN(parsed) && parsed > 0) {
                requestedPage = parsed;
            }
        }

        return await openQueueUI(interaction, client, player, requestedPage);
    },

    openQueueUI,

    async handleInteraction(interaction, client) {
        const guildId = interaction.guild?.id;

        // Handle Dropdown selection
        if (interaction.isStringSelectMenu() && interaction.customId === "queue_select") {
            const selectedValue = interaction.values[0];
            const [sessionId, selectedIndex] = selectedValue.split(":");

            if (selectedIndex === "cancel") {
                queueSessions.delete(sessionId);
                try {
                    return await interaction.message.delete();
                } catch {
                    return await interaction.update({
                        content: "Selection cancelled.",
                        embeds: [],
                        components: [],
                    });
                }
            }

            const session = queueSessions.get(sessionId);
            const voiceChannelId = interaction.member?.voice?.channel?.id || session?.voiceChannelId;
            const player = findPlayer(guildId, voiceChannelId);

            if (!player) {
                return await interaction.reply({
                    content: "❌ No music player active.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            const allTracks = getAllTracks(player);
            const trackIndex = parseInt(selectedIndex, 10);

            if (isNaN(trackIndex) || !allTracks[trackIndex]) {
                return await interaction.reply({
                    content: "❌ Selected track is no longer in the queue.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            const payload = buildTrackInfoPayload(client, player, allTracks, trackIndex);
            if (!payload) {
                return await interaction.reply({
                    content: "❌ Unable to display track information.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Send track information strictly following Image 2
            return await interaction.reply(payload);
        }

        // Handle Pagination buttons
        if (interaction.isButton() && interaction.customId.startsWith("queue_page_")) {
            const parts = interaction.customId.split(":");
            const actionWithPrefix = parts[0];
            const sessionId = parts[1];
            const targetPage = parts[2] ? parseInt(parts[2], 10) : null;

            const session = queueSessions.get(sessionId);
            const voiceChannelId = interaction.member?.voice?.channel?.id || session?.voiceChannelId;
            const player = findPlayer(guildId, voiceChannelId);

            if (!player) {
                return await interaction.reply({
                    content: "❌ No music player active.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            const allTracks = getAllTracks(player);
            if (allTracks.length === 0) {
                return await interaction.update({
                    content: "The queue is currently empty.",
                    embeds: [],
                    components: [],
                });
            }

            const totalPages = Math.max(1, Math.ceil(allTracks.length / 10));
            let currentPage = session?.currentPage || 1;

            if (targetPage !== null && !isNaN(targetPage)) {
                currentPage = Math.max(1, Math.min(targetPage, totalPages));
            } else if (actionWithPrefix === "queue_page_prev") {
                currentPage = Math.max(1, currentPage - 1);
            } else if (actionWithPrefix === "queue_page_next") {
                currentPage = Math.min(totalPages, currentPage + 1);
            }

            if (session) {
                session.currentPage = currentPage;
            }

            const payload = buildQueuePayload(allTracks, currentPage, sessionId);
            return await interaction.update(payload);
        }
    },
};
