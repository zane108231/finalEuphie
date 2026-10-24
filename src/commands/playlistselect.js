const {
    SlashCommandBuilder,
    MessageFlags,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require("discord.js");
const { createPlaylistSelection } = require("../utils/playlistSelection");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("playlistselect")
        .setDescription("Select and queue one track from a playlist URL")
        .addStringOption((option) =>
            option
                .setName("url")
                .setDescription("Playlist URL")
                .setRequired(true)
        ),

    async execute(interaction, client) {
        const query =
            interaction.options.getString("url") ||
            interaction.args?.join(" ").trim();
        if (!query) {
            return interaction.reply({
                content: "Usage: `e!playlistselect <playlist URL>`",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const selection = await createPlaylistSelection(client, interaction, query);
        if (!selection.tracks.length) {
            return interaction.editReply({
                content: "No playable tracks were found in that playlist.",
            });
        }

        const menu = new StringSelectMenuBuilder()
            .setCustomId(`playlist_track_select:${selection.token}`)
            .setPlaceholder("Select a track to queue")
            .addOptions(
                selection.tracks.slice(0, 25).map((track, index) =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel((track.title || `Track ${index + 1}`).slice(0, 100))
                        .setDescription((track.author || "Unknown artist").slice(0, 100))
                        .setValue(String(index))
                )
            );

        const row = new ActionRowBuilder().addComponents(menu);
        return interaction.editReply({
            content: `Select one track from **${selection.name || "the playlist"}** (showing up to 25 tracks).`,
            components: [row],
        });
    },
};
