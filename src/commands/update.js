const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { broadcastToActiveSessions } = require("../utils/sessionBroadcast");

const DEVELOPER_ID = "766135407590244383";

module.exports = {
    primaryOnly: true,
    data: new SlashCommandBuilder()
        .setName("update")
        .setDescription("Announce an Euphie update to active music sessions"),

    async execute(interaction) {
        if (interaction.user?.id !== DEVELOPER_ID) {
            return interaction.reply({
                content: "This command is restricted to the bot developer.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const embed = new EmbedBuilder()
                .setColor(0xfacc15)
                .setTitle("Euphie Update")
                .setDescription(
                    "An Euphie update announcement is being shared. This command does not restart the bot or interrupt playback."
                );
            const result = await broadcastToActiveSessions({ embeds: [embed] });
            const summary =
                `Update announcement sent to ${result.deliveredCount} active session channel(s).` +
                (result.failedCount
                    ? ` ${result.failedCount} channel(s) could not be reached; see the bot console.`
                    : "") +
                (!result.targetCount
                    ? " There are no active sessions with an announcement channel."
                    : "");
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: summary });
            }
            return interaction.reply({ content: summary });
        } catch (error) {
            console.error("[euphire] Update announcement failed:", error);
            const reply = "Could not send the update announcement. Please check the bot console.";
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: reply });
            }
            return interaction.reply({
                content: reply,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
