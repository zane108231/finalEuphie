const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require("discord.js");
const { randomBytes } = require("crypto");
const { getDB } = require("../utils/database");
const { getGuildData } = require("../utils/mongoGuildData");
const { startIfIdle } = require("../utils/playback");
const {
    createNoBotInVoiceEmbed,
    replyNotInVoiceChannel,
} = require("../utils/permissions");
const coordinator = require("../utils/mongoCoordinator");
const { resolveSpotifyTrackAudio } = require("../utils/search");

const PAGE_SIZE = 10;
const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map();

function getTrackTitle(track) {
    return String(track.spotifyTitle || track.title || "Unknown track");
}

function getTrackArtist(track) {
    return String(track.spotifyArtist || track.author || "Unknown artist");
}

function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function buildRecentPayload(session, page) {
    const totalPages = Math.max(1, Math.ceil(session.tracks.length / PAGE_SIZE));
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const firstTrackIndex = (currentPage - 1) * PAGE_SIZE;
    const pageTracks = session.tracks.slice(
        firstTrackIndex,
        firstTrackIndex + PAGE_SIZE
    );
    const options = [];
    let description = `Page **${currentPage}/${totalPages}**\n\n`;

    pageTracks.forEach((track, pageIndex) => {
        const index = firstTrackIndex + pageIndex;
        const title = getTrackTitle(track);
        const artist = getTrackArtist(track);
        const rawUri = String(track.spotifyUrl || track.uri || "");
        const spotifyUri = rawUri.match(/^spotify:track:([a-z0-9]+)$/i);
        const uri = spotifyUri
            ? `https://open.spotify.com/track/${spotifyUri[1]}`
            : rawUri;
        const label = `${title} by ${artist}`;
        const linkedLabel = /^https?:\/\//i.test(String(uri || ""))
            ? `[**${label}**](${uri})`
            : `**${label}**`;
        description += `${index + 1}. \`[${formatDuration(track.length)}]\` ${linkedLabel}\n`;
        options.push(
            new StringSelectMenuOptionBuilder()
                .setLabel(title.slice(0, 100))
                .setDescription(
                    `[${formatDuration(track.length)}] ${artist}`.slice(0, 100)
                )
                .setValue(String(index))
        );
    });

    description += "\nnext page | previous page | go to page <page> | cancel";
    options.push(
        new StringSelectMenuOptionBuilder()
            .setLabel("cancel")
            .setDescription("Cancel selection")
            .setValue("cancel")
    );

    const embed = new EmbedBuilder()
        .setColor(0x36393f)
        .setDescription(description);
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`playrecent:select:${session.token}`)
        .setPlaceholder("Make a selection")
        .addOptions(options);
    const selectRow = new ActionRowBuilder().addComponents(menu);
    const firstButton = new ButtonBuilder()
        .setCustomId(`playrecent:page:${session.token}:1:first`)
        .setLabel("<<")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 1);
    const previousButton = new ButtonBuilder()
        .setCustomId(
            `playrecent:page:${session.token}:${currentPage - 1}:previous`
        )
        .setLabel("<")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 1);
    const nextButton = new ButtonBuilder()
        .setCustomId(
            `playrecent:page:${session.token}:${currentPage + 1}:next`
        )
        .setLabel(">")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === totalPages);
    const lastButton = new ButtonBuilder()
        .setCustomId(
            `playrecent:page:${session.token}:${totalPages}:last`
        )
        .setLabel(">>")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === totalPages);

    return {
        page: currentPage,
        payload: {
            embeds: [embed],
            components: [
                selectRow,
                new ActionRowBuilder().addComponents(
                    firstButton,
                    previousButton,
                    nextButton,
                    lastButton
                ),
            ],
        },
    };
}

function clearSession(token) {
    const session = sessions.get(token);
    if (!session) return null;
    clearTimeout(session.timeout);
    sessions.delete(token);
    return session;
}

async function removeSelectionMessage(session) {
    if (!session?.message) return;
    try {
        await session.message.delete();
    } catch (error) {
        if (error.code !== 10008) {
            console.error(
                `[euphire] Failed to delete playrecent selection message:`,
                error
            );
        }
    }
}

async function handleInteraction(interaction) {
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const token = parts[2];
    const session = sessions.get(token);
    if (!session) {
        return interaction.reply({
            content: "This recently played selection has expired.",
            flags: MessageFlags.Ephemeral,
        });
    }
    if (interaction.user.id !== session.userId) {
        return interaction.reply({
            content: "Only the person who opened this list can use it.",
            flags: MessageFlags.Ephemeral,
        });
    }

    if (action === "page") {
        const page = Number(parts[3]);
        const result = buildRecentPayload(session, page);
        session.page = result.page;
        return interaction.update(result.payload);
    }

    const selectedValue = interaction.values?.[0];
    if (selectedValue === "cancel") {
        await interaction.deferUpdate();
        clearSession(token);
        await removeSelectionMessage(session);
        return;
    }

    const selectedTrack = session.tracks[Number(selectedValue)];
    await interaction.deferUpdate();
    clearSession(token);
    await removeSelectionMessage(session);
    if (!selectedTrack) {
        return interaction.followUp({
            content: "That recently played track is no longer available.",
            flags: MessageFlags.Ephemeral,
        });
    }

    const voiceChannelId = interaction.member?.voice?.channel?.id;
    const ownerId = voiceChannelId
        ? coordinator.resolveSessionOwner(voiceChannelId, interaction.guild)
        : null;
    if (!voiceChannelId || ownerId !== session.botId) {
        return interaction.followUp({
            embeds: [createNoBotInVoiceEmbed()],
            flags: MessageFlags.Ephemeral,
        });
    }

    const targetClient = coordinator.getClient(session.botId);
    const player = targetClient?.riffy?.players?.get(session.guildId);
    if (!player || player.voiceChannel !== voiceChannelId) {
        return interaction.followUp({
            embeds: [createNoBotInVoiceEmbed()],
            flags: MessageFlags.Ephemeral,
        });
    }

    const query = selectedTrack.spotifyUrl || selectedTrack.uri;
    if (!query) {
        return interaction.followUp({
            content: "That recently played track does not have a playable link.",
            flags: MessageFlags.Ephemeral,
        });
    }

    try {
        const result = await targetClient.riffy.resolve({
            query,
            requester: interaction.user,
        });
        let track = result?.tracks?.[0] || null;
        if (track) {
            track = await resolveSpotifyTrackAudio(
                targetClient.riffy,
                track,
                interaction.user
            );
        }
        if (!track) {
            return interaction.followUp({
                content: `Could not play ${getTrackTitle(selectedTrack)} by ${getTrackArtist(selectedTrack)}.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        track.info.requester = interaction.user;
        player.textChannel = interaction.channel.id;
        player.assignedTextChannel = interaction.channel.id;
        coordinator.setSessionChannel(voiceChannelId, interaction.channel.id);
        player.queue.add(track);
        await startIfIdle(player);
        return interaction.followUp({
            content: `Added **${getTrackTitle(selectedTrack)} by ${getTrackArtist(selectedTrack)}** to the queue.`,
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        console.error("[euphire] Could not queue selected recently played track:", error);
        return interaction.followUp({
            content: `Could not play ${getTrackTitle(selectedTrack)} by ${getTrackArtist(selectedTrack)}.`,
            flags: MessageFlags.Ephemeral,
        });
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("playrecent")
        .setDescription("Browse and play one of your recently played tracks"),

    async execute(interaction, client) {
        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) {
            return replyNotInVoiceChannel(interaction);
        }

        const botId = coordinator.resolveSessionOwner(
            voiceChannel.id,
            interaction.guild
        );
        if (!botId) {
            return interaction.reply({
                embeds: [createNoBotInVoiceEmbed()],
                flags: MessageFlags.Ephemeral,
            });
        }

        const recent = await getDB()
            .collection("recentTracks")
            .findOne({ userId: interaction.user.id });
        const tracks = Array.isArray(recent?.tracks)
            ? [...recent.tracks].reverse()
            : [];
        if (!tracks.length) {
            return interaction.reply({
                content: "You don't have any recently played tracks saved yet.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const assignedClient = coordinator.getClient(botId) || client;
        const player = assignedClient.riffy?.players?.get(interaction.guild.id);
        if (!player || player.voiceChannel !== voiceChannel.id) {
            return interaction.reply({
                embeds: [createNoBotInVoiceEmbed()],
                flags: MessageFlags.Ephemeral,
            });
        }

        const token = randomBytes(8).toString("hex");
        const session = {
            token,
            tracks,
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            botId,
            page: 1,
            message: null,
            timeout: null,
        };
        const result = buildRecentPayload(session, 1);
        const response = await interaction.reply(result.payload);
        session.message = response?.id
            ? response
            : await interaction.fetchReply();
        session.timeout = setTimeout(async () => {
            const expired = clearSession(token);
            await removeSelectionMessage(expired);
        }, SESSION_TTL_MS);
        session.timeout.unref?.();
        sessions.set(token, session);
    },

    handleInteraction,
    buildRecentPayload,
};
