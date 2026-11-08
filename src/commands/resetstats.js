const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { resetUserProfileStats } = require("../utils/mongoStats");

const DEVELOPER_ID = "766135407590244383";

module.exports = {
    primaryOnly: true,
    aliases: ["resetprofile", "clearstats", "statreset"],
    data: new SlashCommandBuilder()
        .setName("resetstats")
        .setDescription("Reset one user's music listening statistics")
        .addStringOption((opt) =>
            opt.setName("user_id")
                .setDescription("The specific user's Discord ID or mention")
                .setRequired(true)
        ),

    async execute(interaction) {
        if (interaction.user?.id !== DEVELOPER_ID) {
            return interaction.reply({
                content: "❌ Only the bot developer can reset a user's profile statistics.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const rawTarget = String(
            interaction.args?.[0] ||
            interaction.options?.getString?.("user_id") ||
            ""
        ).trim();

        const mentionMatch = rawTarget.match(/^<@!?(\d{17,20})>$/);
        const targetUserId = mentionMatch ? mentionMatch[1] : rawTarget;
        if (!/^\d{17,20}$/.test(targetUserId)) {
            return interaction.reply({
                content:
                    "❌ Provide one specific user ID or mention. Global and all-user resets are disabled.\n" +
                    "Usage: `e!resetstats <user ID>` or `/resetstats user_id:<ID>`.",
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await resetUserProfileStats(targetUserId);

            const summaryText =
                "### 🧹 Profile Database Reset\n\n" +
                `**Scope**: <@${targetUserId}> (\`${targetUserId}\`)\n` +
                `• **User Stats cleared**: \`${result.userStats}\`\n` +
                `• **Server Stats cleared**: \`${result.serverStats}\`\n` +
                `• **Track Stats cleared**: \`${result.trackStats}\`\n` +
                `• **Shared Listening cleared**: \`${result.sharedListening}\`\n` +
                `• **Active Sessions cleared**: \`${result.activeSessions}\`\n` +
                `• **Session Participants cleared**: \`${result.sessionParticipants}\`\n\n` +
                "-# ℹ️ Only listening statistics (`e!profile`) were wiped. Server settings (`guildData`), Last.fm accounts (`userData`), and active bot playback assignments were preserved.";

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({
                    content: summaryText,
                    allowedMentions: { parse: [] },
                });
            } else {
                return interaction.reply({
                    content: summaryText,
                    allowedMentions: { parse: [] },
                });
            }
        } catch (err) {
            console.error("[euphire] Reset stats command error:", err);
            const errText = "❌ Could not reset profile statistics. Please try again later.";
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: errText });
            } else {
                return interaction.reply({ content: errText });
            }
        }
    },
};
