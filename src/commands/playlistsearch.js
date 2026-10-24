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
const { randomUUID } = require("crypto");
const { getDB } = require("../utils/database");
const { searchSpotifyPlaylists } = require("../utils/spotifyPlaylistSearch");
const config = require("../../config");

const PAGE_SIZE = 10;
const SEARCH_LIMIT = 50;
const SEARCH_TTL_MS = 10 * 60 * 1000;

function buildPlaylistSearchPayload(search, page = 1) {
    const playlists = search.playlists || [];
    const totalPages = Math.max(1, Math.ceil(playlists.length / PAGE_SIZE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * PAGE_SIZE;
    const pagePlaylists = playlists.slice(startIndex, startIndex + PAGE_SIZE);
    const selectOptions = [];

    let description = `Page ${currentPage}/${totalPages}\n\n`;
    pagePlaylists.forEach((playlist, index) => {
        const resultIndex = startIndex + index;
        const label = playlist.name || "Untitled playlist";
        const url = playlist.url || "https://open.spotify.com";
        const count = Number.isInteger(playlist.trackCount)
            ? playlist.trackCount
            : 0;

        description += `${resultIndex + 1}. \`[ ${count} ]\` [${label.replace(/[\[\]]/g, "\\$&")}](${url})\n`;
        selectOptions.push(
            new StringSelectMenuOptionBuilder()
                .setLabel(`${resultIndex + 1}. ${label}`.slice(0, 100))
                .setDescription(
                    `${count} tracks${playlist.owner ? ` • ${playlist.owner}` : ""}`.slice(0, 100)
                )
                .setValue(String(resultIndex))
        );
    });
    selectOptions.push(
        new StringSelectMenuOptionBuilder()
            .setLabel("cancel")
            .setDescription("Cancel playlist search")
            .setValue("cancel")
    );

    description +=
        "\nnext page | previous page | go to page <page> | cancel";

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setDescription(description);

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`playlist_search_select:${search.token}`)
        .setPlaceholder("Make a selection")
        .addOptions(selectOptions);
    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    const firstButton = new ButtonBuilder()
        .setCustomId(`playlist_search_page:${search.token}:first`)
        .setLabel("<<")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 1);
    const previousButton = new ButtonBuilder()
        .setCustomId(`playlist_search_page:${search.token}:prev`)
        .setLabel("<")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 1);
    const nextButton = new ButtonBuilder()
        .setCustomId(`playlist_search_page:${search.token}:next`)
        .setLabel(">")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === totalPages);
    const lastButton = new ButtonBuilder()
        .setCustomId(`playlist_search_page:${search.token}:last`)
        .setLabel(">>")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === totalPages);
    const paginationRow = new ActionRowBuilder().addComponents(
        firstButton,
        previousButton,
        nextButton,
        lastButton
    );

    return { embeds: [embed], components: [selectRow, paginationRow] };
}

async function getOwnedSearch(interaction, token) {
    const search = await getDB()
        .collection("playlistSelections")
        .findOne({ token, expiresAt: { $gt: new Date() } });
    if (
        !search ||
        search.type !== "spotify-playlist-search" ||
        search.guildId !== interaction.guildId ||
        search.userId !== interaction.user.id
    ) {
        return null;
    }
    return search;
}

async function handleInteraction(interaction, client) {
    const [action, token, value] = interaction.customId.split(":");
    const search = await getOwnedSearch(interaction, token);
    if (!search) {
        return interaction.reply({
            content: "This playlist search has expired or belongs to another user.",
            flags: MessageFlags.Ephemeral,
        });
    }

    if (action === "playlist_search_page") {
        const pageCount = Math.max(
            1,
            Math.ceil((search.playlists?.length || 0) / PAGE_SIZE)
        );
        const currentPage = Number(search.page) || 1;
        const nextPage =
            value === "first"
                ? 1
                : value === "last"
                  ? pageCount
                  : value === "prev"
                    ? currentPage - 1
                    : currentPage + 1;
        const payload = buildPlaylistSearchPayload(search, nextPage);
        await getDB()
            .collection("playlistSelections")
            .updateOne(
                { token },
                { $set: { page: Math.min(Math.max(1, nextPage), pageCount) } }
            );
        return interaction.update(payload);
    }

    if (action !== "playlist_search_select") return;
    if (interaction.values?.[0] === "cancel") {
        await getDB().collection("playlistSelections").deleteOne({ token });
        return interaction.update({
            content: "Playlist search cancelled.",
            embeds: [],
            components: [],
        });
    }
    const selectedIndex = Number(interaction.values?.[0]);
    const selectedPlaylist = search.playlists?.[selectedIndex];
    if (!Number.isInteger(selectedIndex) || !selectedPlaylist) {
        return interaction.reply({
            content: "That playlist is no longer available in these results.",
            flags: MessageFlags.Ephemeral,
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    interaction.queryOverride = selectedPlaylist.url;
    interaction.playlistSearchSelection = {
        name: selectedPlaylist.name,
        url: selectedPlaylist.url,
        artworkUrl: selectedPlaylist.artworkUrl,
        trackCount: selectedPlaylist.trackCount,
    };
    interaction.replacePlaylistSearchMessage = true;

    try {
        await require("./play").execute(interaction, client);
        if (interaction.playbackQueryQueued) {
            await getDB()
                .collection("playlistSelections")
                .deleteOne({ token });
            if (!interaction.playlistSearchMessageUpdated) {
                await interaction.message
                    .edit({ components: [] })
                    .catch((error) => {
                        console.error(
                            "[euphire] Could not disable the completed playlist search menu:",
                            error.message
                        );
                    });
            }
        }
    } finally {
        delete interaction.queryOverride;
        delete interaction.playlistSearchSelection;
        delete interaction.replacePlaylistSearchMessage;
        delete interaction.playlistSearchMessageUpdated;
        delete interaction.playbackQueryQueued;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("playlistsearch")
        .setDescription("Search Spotify playlists and choose one to play")
        .addStringOption((option) =>
            option
                .setName("query")
                .setDescription("Playlist search term")
                .setRequired(true)
        ),

    async execute(interaction, client) {
        const query =
            interaction.options?.getString("query") ||
            interaction.args?.join(" ").trim();
        if (!query) {
            return interaction.reply({
                content: "Usage: `e!playlistsearch <search term>`",
                flags: MessageFlags.Ephemeral,
            });
        }

        if (/^https?:\/\//i.test(query)) {
            interaction.queryOverride = query;
            try {
                return await require("./play").execute(interaction, client);
            } finally {
                delete interaction.queryOverride;
            }
        }

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }

        try {
            const playlists = await searchSpotifyPlaylists(query, SEARCH_LIMIT);
            if (!playlists.length) {
                return interaction.editReply({
                    content: `No Spotify playlists found for **${query}**.`,
                    components: [],
                });
            }

            const search = {
                token: randomUUID(),
                type: "spotify-playlist-search",
                userId: interaction.user.id,
                guildId: interaction.guildId || interaction.guild.id,
                query,
                page: 1,
                playlists,
                expiresAt: new Date(Date.now() + SEARCH_TTL_MS),
            };
            await getDB().collection("playlistSelections").insertOne(search);

            return interaction.editReply(buildPlaylistSearchPayload(search));
        } catch (error) {
            console.error("[euphire] Spotify playlist search failed:", error);
            const message =
                error.code === "SPOTIFY_CREDENTIALS_MISSING"
                    ? "Spotify playlist search is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the bot environment."
                    : "Spotify playlist search is temporarily unavailable. Please try again later.";
            return interaction.editReply({ content: message, components: [] });
        }
    },

    handleInteraction,
};
