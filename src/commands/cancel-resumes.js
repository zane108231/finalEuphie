const { MessageFlags, SlashCommandBuilder } = require("discord.js");
const { isDeveloper } = require("../utils/developerAccess");
const {
    cancelAllSavedResumeSessions,
} = require("../utils/playbackRecovery");

module.exports = {
    primaryOnly: true,
    aliases: ["cancelresumes"],
    data: new SlashCommandBuilder()
        .setName("cancel-resumes")
        .setDescription(
            "Clear all saved resume sessions and cancel pending restores"
        ),

    async execute(interaction) {
        if (!isDeveloper(interaction.user?.id)) {
            return interaction.reply({
                content: "❌ You are not authorized to use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const result = await cancelAllSavedResumeSessions();
            let content =
                `✅ Cleared **${result.snapshotsCleared}** saved resume snapshot(s) and cancelled **${result.pendingRestoresCancelled}** pending restore(s).\n` +
                `Returned **${result.botsReturnedToWaitingRoom}** bot(s) to their waiting room; disconnected **${result.botsDisconnected}** bot(s) where no waiting room was available.`;
            if (result.failures.length) {
                content += `\n\n⚠️ Some cleanup steps reported errors:\n${result.failures
                    .slice(0, 5)
                    .map(
                        ({ guildId, botId, error }) =>
                            `• ${botId} in guild ${guildId}: ${error}`
                    )
                    .join("\n")}`;
            }
            return interaction.editReply({ content });
        } catch (error) {
            console.error(
                "[euphire] Failed to cancel saved resume sessions:",
                error
            );
            return interaction.editReply({
                content: `❌ Could not cancel saved resume sessions: ${error.message}`,
            });
        }
    },
};
