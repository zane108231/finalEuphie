const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { resolvePlaylistSelection } = require("../utils/playlistSelection");
const playCommand = require("./play");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("playingsingle")
        .setDescription("Queue a single track from a playlist URL")
        .addStringOption((option) =>
            option
                .setName("url")
                .setDescription("Playlist URL")
                .setRequired(true)
        )
        .addIntegerOption((option) =>
            option
                .setName("track")
                .setDescription("Track number in the playlist (defaults to 1)")
                .setMinValue(1)
                .setRequired(false)
        ),

    async execute(interaction, client) {
        const query =
            interaction.args?.[0] ||
            interaction.options.getString("url");
        const rawTrackNumber = interaction.args?.[1];
        const requestedIndex =
            rawTrackNumber == null
                ? interaction.options.getInteger("track") || 1
                : Number(rawTrackNumber);

        if (!query) {
            return interaction.reply({
                content: "Usage: `e!playingsingle <playlist URL> [track number]`",
                flags: MessageFlags.Ephemeral,
            });
        }
        if (!Number.isInteger(requestedIndex) || requestedIndex < 1) {
            return interaction.reply({
                content: "Track number must be a positive whole number.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const selection = await resolvePlaylistSelection(
            client,
            interaction,
            query
        );
        if (!selection.tracks.length) {
            return interaction.reply({
                content: "No playable tracks were found in that playlist.",
                flags: MessageFlags.Ephemeral,
            });
        }
        const selectedTrack = selection.tracks[requestedIndex - 1];
        if (!selectedTrack) {
            return interaction.reply({
                content: `Track number must be between 1 and ${selection.tracks.length}.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        interaction.queryOverride = selectedTrack.uri;
        try {
            return await playCommand.execute(interaction, client);
        } finally {
            delete interaction.queryOverride;
        }
    },
};
