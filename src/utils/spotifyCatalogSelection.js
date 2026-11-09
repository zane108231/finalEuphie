const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require("discord.js");
const { randomUUID } = require("crypto");
const { getDB } = require("./database");
const config = require("../../config");

const PAGE_SIZE = 10;
const SEARCH_TTL_MS = 10 * 60 * 1000;

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}]`;
}

function getPages(items) {
    return Math.max(1, Math.ceil(items.length / PAGE_SIZE));
}

function buildTrackPayload(search, pageNumber) {
    const pageCount = getPages(search.items);
    const page = Math.min(Math.max(1, pageNumber), pageCount);
    const start = (page - 1) * PAGE_SIZE;
    const items = search.items.slice(start, start + PAGE_SIZE);
    let description = `Page ${page}/${pageCount}\n\n`;
    const options = items.map((item, index) => {
        const resultNumber = start + index + 1;
        const title = `${item.name} by ${item.artist || "Unknown artist"}`;
        const result = item.url
            ? `[${title.replace(/[\[\]]/g, "\\$&")}](${item.url})`
            : title;
        description += `${resultNumber}. \`${formatDuration(item.durationMs)}\` ${result}\n`;
        return new StringSelectMenuOptionBuilder()
            .setLabel(`${resultNumber}. ${item.name}`.slice(0, 100))
            .setDescription((item.artist || "Unknown artist").slice(0, 100))
            .setValue(String(start + index));
    });
    if (page < pageCount) {
        options.push(
            new StringSelectMenuOptionBuilder()
                .setLabel("next page")
                .setValue("next")
        );
    }
    if (page > 1) {
        options.push(
            new StringSelectMenuOptionBuilder()
                .setLabel("previous page")
                .setValue("previous")
        );
    }
    options.push(
        new StringSelectMenuOptionBuilder()
            .setLabel("cancel")
            .setValue("cancel")
    );
    description += "\nnext page | previous page | cancel";

    return {
        embeds: [
            new EmbedBuilder()
                .setColor(config.accentColor || 0x2b2d31)
                .setDescription(description),
        ],
        components: [
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`spotify_search_select:${search.token}`)
                    .setPlaceholder("Make a selection")
                    .addOptions(options)
            ),
        ],
    };
}

function buildAlbumPayload(search, pageNumber) {
    const pageCount = getPages(search.items);
    const page = Math.min(Math.max(1, pageNumber), pageCount);
    const start = (page - 1) * PAGE_SIZE;
    const items = search.items.slice(start, start + PAGE_SIZE);
    let description = `Page ${page}/${pageCount}\n\n`;
    const options = items.map((item, index) => {
        const resultNumber = start + index + 1;
        const label = `${item.name} by ${item.artist || "Unknown artist"}`;
        description += `${resultNumber}. \`[${item.trackCount}]\` [${label.replace(/[\[\]]/g, "\\$&")}](${item.url})\n`;
        return new StringSelectMenuOptionBuilder()
            .setLabel(`${resultNumber}. ${item.name}`.slice(0, 100))
            .setDescription(
                `${item.trackCount} tracks • ${item.artist || "Unknown artist"}`.slice(
                    0,
                    100
                )
            )
            .setValue(String(start + index));
    });
    options.push(
        new StringSelectMenuOptionBuilder()
            .setLabel("cancel")
            .setValue("cancel")
    );
    description += "\nnext page | previous page | go to page <page> | cancel";

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`spotify_album_page:${search.token}:first`)
            .setLabel("<<")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 1),
        new ButtonBuilder()
            .setCustomId(`spotify_album_page:${search.token}:prev`)
            .setLabel("<")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 1),
        new ButtonBuilder()
            .setCustomId(`spotify_album_page:${search.token}:next`)
            .setLabel(">")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === pageCount),
        new ButtonBuilder()
            .setCustomId(`spotify_album_page:${search.token}:last`)
            .setLabel(">>")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === pageCount)
    );

    return {
        embeds: [
            new EmbedBuilder()
                .setColor(config.accentColor || 0x2b2d31)
                .setDescription(description),
        ],
        components: [
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`spotify_album_select:${search.token}`)
                    .setPlaceholder("Make a selection")
                    .addOptions(options)
            ),
            buttons,
        ],
    };
}

async function createSearch(interaction, type, query, items) {
    const token = randomUUID();
    const search = {
        token,
        type,
        userId: interaction.user.id,
        guildId: interaction.guildId || interaction.guild?.id,
        query,
        page: 1,
        items,
        expiresAt: new Date(Date.now() + SEARCH_TTL_MS),
    };
    await getDB().collection("playlistSelections").insertOne(search);
    const payload =
        type === "spotify-track-search"
            ? buildTrackPayload(search, 1)
            : buildAlbumPayload(search, 1);
    return interaction.editReply(payload);
}

async function loadOwnedSearch(interaction, token, type) {
    const search = await getDB()
        .collection("playlistSelections")
        .findOne({ token, expiresAt: { $gt: new Date() } });
    if (
        !search ||
        search.type !== type ||
        search.guildId !== (interaction.guildId || interaction.guild?.id) ||
        search.userId !== interaction.user.id
    ) {
        return null;
    }
    return search;
}

async function runSelectedItem(interaction, client, search, item) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    interaction.queryOverride =
        item.url || item.query || `${item.name} ${item.artist || ""}`.trim();
    interaction.replacePlaylistSearchMessage = true;
    interaction.playlistSearchSelection = {
        name: item.name,
        url: item.url,
        artworkUrl: item.artworkUrl || null,
        trackCount: item.trackCount || 0,
    };

    try {
        await require("../commands/play").execute(interaction, client);
        if (interaction.playbackQueryQueued) {
            await getDB()
                .collection("playlistSelections")
                .deleteOne({ token: search.token });
            if (!interaction.playlistSearchMessageUpdated) {
                await interaction.message
                    .edit({ components: [] })
                    .catch((error) => {
                        console.error(
                            "[euphire] Could not disable completed Spotify search:",
                            error.message
                        );
                    });
            }
        }
    } finally {
        delete interaction.queryOverride;
        delete interaction.replacePlaylistSearchMessage;
        delete interaction.playlistSearchSelection;
        delete interaction.playlistSearchMessageUpdated;
        delete interaction.playbackQueryQueued;
    }
}

async function handleInteraction(interaction, client) {
    const [action, token, value] = interaction.customId.split(":");
    const type =
        action.startsWith("spotify_search")
            ? "spotify-track-search"
            : "spotify-album-search";
    const search = await loadOwnedSearch(interaction, token, type);
    if (!search) {
        return interaction.reply({
            content: "This Spotify search has expired or belongs to another user.",
            flags: MessageFlags.Ephemeral,
        });
    }

    if (action.endsWith("_page")) {
        const pageCount = getPages(search.items || []);
        const currentPage = Number(search.page) || 1;
        const nextPage =
            value === "first"
                ? 1
                : value === "last"
                  ? pageCount
                  : value === "prev"
                    ? currentPage - 1
                    : currentPage + 1;
        const page = Math.min(Math.max(nextPage, 1), pageCount);
        await getDB()
            .collection("playlistSelections")
            .updateOne({ token }, { $set: { page } });
        search.page = page;
        return interaction.update(
            type === "spotify-track-search"
                ? buildTrackPayload(search, page)
                : buildAlbumPayload(search, page)
        );
    }

    if (action.endsWith("_select")) {
        const selected = interaction.values?.[0];
        if (selected === "cancel") {
            await getDB()
                .collection("playlistSelections")
                .deleteOne({ token });
            return interaction.update({
                content: "Search cancelled.",
                embeds: [],
                components: [],
            });
        }
        if (selected === "next" || selected === "previous") {
            const pageCount = getPages(search.items || []);
            const page = Math.min(
                Math.max(
                    (Number(search.page) || 1) +
                        (selected === "next" ? 1 : -1),
                    1
                ),
                pageCount
            );
            await getDB()
                .collection("playlistSelections")
                .updateOne({ token }, { $set: { page } });
            search.page = page;
            return interaction.update(buildTrackPayload(search, page));
        }

        const item = search.items?.[Number(selected)];
        if (!item) {
            return interaction.reply({
                content: "That Spotify result is no longer available.",
                flags: MessageFlags.Ephemeral,
            });
        }
        return runSelectedItem(interaction, client, search, item);
    }
}

module.exports = {
    createSearch,
    handleInteraction,
    buildTrackPayload,
    buildAlbumPayload,
};
