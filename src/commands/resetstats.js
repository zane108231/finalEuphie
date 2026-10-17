const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { resetAllProfileStats } = require("../utils/mongoStats");
const { isServerAdmin } = require("../utils/permissions");

module.exports = {
    aliases: ["resetprofile", "clearstats", "statreset"],
    data: new SlashCommandBuilder()
        .setName("resetstats")
        .setDescription("Reset music listening statistics (e!profile only)")
        .addStringOption((opt) =>
            opt.setName("target")
                .setDescription("Target: 'all'/'everyone' (default for admins), 'me', or mention a user")
                .setRequired(false)
        ),

    async execute(interaction, client) {
        const isAdmin =
            !interaction.guild ||
            interaction.guild?.ownerId === interaction.user?.id ||
            isServerAdmin(interaction.member);

        const rawTarget = (
            interaction.args?.[0] ||
            interaction.options?.getString?.("target") ||
            ""
        ).trim();

        let targetUserId = null;
        let targetLabel = "Everyone (All users & servers)";

        if (!rawTarget || ["all", "everyone", "global", "*"].includes(rawTarget.toLowerCase())) {
            if (!isAdmin) {
                return interaction.reply({
                    content: "❌ Only server administrators can reset profile statistics for everyone. Use `e!resetstats me` to reset only your own statistics.",
                    flags: MessageFlags.Ephemeral,
                });
            }
            targetUserId = null;
            targetLabel = "Everyone (All users & servers)";
        } else if (["me", "self"].includes(rawTarget.toLowerCase())) {
            targetUserId = interaction.user.id;
            targetLabel = `<@${interaction.user.id}> (${interaction.user.tag || interaction.user.username})`;
        } else {
            const mentionMatch = rawTarget.match(/^<@!?(\d{17,20})>$/);
            const rawId = mentionMatch ? mentionMatch[1] : (/^\d{17,20}$/.test(rawTarget) ? rawTarget : null);

            if (rawId) {
                if (!isAdmin && rawId !== interaction.user.id) {
                    return interaction.reply({
                        content: "❌ Only server administrators can reset profile statistics for other users.",
                        flags: MessageFlags.Ephemeral,
                    });
                }
                targetUserId = rawId;
                targetLabel = `<@${rawId}>`;
            } else {
                return interaction.reply({
                    content: "❌ Invalid target. Usage:\n• `e!resetstats` or `e!resetstats all` (Admin only: resets everyone)\n• `e!resetstats me` (Resets your own stats)\n• `e!resetstats @user` (Admin only: resets specific user)",
                    flags: MessageFlags.Ephemeral,
                });
            }
        }

        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } catch {
            // Ignore if defer fails
        }

        try {
            const result = await resetAllProfileStats(targetUserId);

            const summaryText =
                "### 🧹 Profile Database Reset\n\n" +
                `**Scope**: ${targetLabel}\n` +
                `• **User Stats cleared**: \`${result.userStats}\`\n` +
                `• **Server Stats cleared**: \`${result.serverStats}\`\n` +
                `• **Track Stats cleared**: \`${result.trackStats}\`\n` +
                `• **Shared Listening cleared**: \`${result.sharedListening}\`\n` +
                `• **Active Sessions cleared**: \`${result.activeSessions}\`\n` +
                `• **Session Participants cleared**: \`${result.sessionParticipants}\`\n\n` +
                "-# ℹ️ Only listening statistics (`e!profile`) were wiped. Server settings (`guildData`), Last.fm accounts (`userData`), and active bot playback assignments were preserved.";

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: summaryText });
            } else {
                return interaction.reply({ content: summaryText });
            }
        } catch (err) {
            console.error("[euphire] Reset stats command error:", err);
            const errText = `❌ Failed to reset profile database: ${err.message}`;
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: errText });
            } else {
                return interaction.reply({ content: errText });
            }
        }
    },
};
