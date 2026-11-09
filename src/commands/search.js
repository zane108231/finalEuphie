const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { resolveTracks, getSpotifyTrackUrl } = require("../utils/search");
const { createSearch } = require("../utils/spotifyCatalogSelection");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("search")
        .setDescription("Search Spotify tracks and choose one to play")
        .addStringOption((option) =>
            option
                .setName("query")
                .setDescription("Track name, artist, or both")
                .setRequired(true)
        ),

    async execute(interaction, client) {
        const query = (
            interaction.options?.getString("query") ||
            interaction.args?.join(" ") ||
            ""
        ).trim();
        if (!query) {
            return interaction.reply({
                content: "Usage: `e!search <track or artist>`",
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
            const result = await resolveTracks(client.riffy, {
                query,
                source: "spsearch",
                strictSource: true,
                requester: interaction.user,
            });
            const tracks = result.tracks.map((track) => ({
                name:
                    track.info.spotifyTitle ||
                    track.info.title ||
                    "Unknown track",
                artist:
                    track.info.spotifyArtist ||
                    track.info.author ||
                    "Unknown artist",
                url: getSpotifyTrackUrl(track),
                query: `${track.info.spotifyTitle || track.info.title || ""} ${track.info.spotifyArtist || track.info.author || ""}`.trim(),
                durationMs: track.info.length || 0,
            }));
            if (!tracks.length) {
                return interaction.editReply({
                    content: `No Spotify tracks found for **${query}**.`,
                    components: [],
                });
            }
            return await createSearch(
                interaction,
                "spotify-track-search",
                query,
                tracks
            );
        } catch (error) {
            console.error("[euphire] Spotify track search failed:", error);
            return interaction.editReply({
                content:
                    "Spotify track search is temporarily unavailable. Please try again later.",
                components: [],
            });
        }
    },
};
