const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { broadcastToActiveSessions } = require("../utils/sessionBroadcast");

const DEVELOPER_ID = "766135407590244383";

module.exports = {
    primaryOnly: true,
    data: new SlashCommandBuilder()
        .setName("announce")
        .setDescription("Broadcast a developer announcement to active music sessions")
        .addStringOption((option) =>
            option
                .setName("message")
                .setDescription("Message to include in the announcement")
                .setMaxLength(4000)
                .setRequired(true)
        ),

    async execute(interaction) {
        if (interaction.user?.id !== DEVELOPER_ID) {
            return interaction.reply({
                content: "❌ You are not authorized to use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const message = String(
            interaction.options?.getString?.("message") || ""
        ).trim();
        if (!message) {
            return interaction.reply({
                content: "❌ The announcement message cannot be empty.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const embed = new EmbedBuilder()
                .setColor(0x2ecc71)
                .setDescription(message);
            const result = await broadcastToActiveSessions({ embeds: [embed] });
            const summary =
                `Announcement sent to ${result.deliveredCount} active session channel(s).` +
                (result.failedCount
                    ? ` ${result.failedCount} channel(s) could not be reached; see the bot console.`
                    : "") +
                (!result.targetCount
                    ? " There are no active sessions with an announcement channel."
                    : "");
            return interaction.editReply({ content: summary });
        } catch (error) {
            console.error("[euphire] Developer announcement failed:", error);
            return interaction.editReply({
                content: "❌ Could not send the announcement. Please check the bot console.",
            });
        }
    },
};
