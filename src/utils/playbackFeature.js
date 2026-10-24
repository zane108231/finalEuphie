const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const playCommand = require("../commands/play");

function createPlaybackFeature({ name, description, transformQuery, afterPlay }) {
    return {
        data: new SlashCommandBuilder()
            .setName(name)
            .setDescription(description)
            .addStringOption((option) =>
                option
                    .setName("query")
                    .setDescription("Search term or supported URL")
                    .setRequired(true)
            ),

        async execute(interaction, client) {
            const rawQuery =
                interaction.options.getString("query") ||
                interaction.args?.join(" ").trim();
            if (!rawQuery) {
                return interaction.reply({
                    content: `Usage: \`e!${name} <search term or URL>\``,
                    flags: MessageFlags.Ephemeral,
                });
            }

            interaction.queryOverride = transformQuery
                ? transformQuery(rawQuery)
                : rawQuery;
            interaction.playbackQueryQueued = false;
            interaction.onPlaybackQueued = afterPlay;
            try {
                const result = await playCommand.execute(interaction, client);
                return result;
            } finally {
                delete interaction.queryOverride;
                delete interaction.playbackQueryQueued;
                delete interaction.onPlaybackQueued;
            }
        },
    };
}

module.exports = { createPlaybackFeature };
