const { MessageFlags, SlashCommandBuilder } = require("discord.js");
const { removeProfileTrackWording } = require("../utils/mongoStats");

const DEVELOPER_ID = "766135407590244383";

module.exports = {
    primaryOnly: true,
    data: new SlashCommandBuilder()
        .setName("cleanprofile")
        .setDescription("Remove wording from a user's saved profile track names")
        .addStringOption((option) =>
            option
                .setName("user_id")
                .setDescription("The user's Discord ID")
                .setMinLength(17)
                .setMaxLength(20)
                .setRequired(true)
        )
        .addStringOption((option) =>
            option
                .setName("wording")
                .setDescription("Exact wording to remove from track names")
                .setMaxLength(100)
                .setRequired(true)
        ),

    async execute(interaction) {
        if (interaction.user?.id !== DEVELOPER_ID) {
            return interaction.reply({
                content: "❌ You are not authorized to use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const userId =
            interaction.options?.getString?.("user_id") ||
            interaction.args?.[0] ||
            "";
        const wording = (
            interaction.options?.getString?.("wording") ||
            interaction.args?.slice(1).join(" ") ||
            ""
        ).trim();

        if (!/^\d{17,20}$/.test(userId) || !wording || wording.length > 100) {
            return interaction.reply({
                content:
                    "❌ Provide a valid user ID and the exact wording to remove.\n" +
                    "Usage: `/cleanprofile user_id:<ID> wording:<text>` or `e!cleanprofile <ID> <text>`.",
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await removeProfileTrackWording(userId, wording);
            const displayWording = JSON.stringify(wording);
            const reply =
                result.modifiedTracks > 0
                    ? `✅ Removed ${displayWording} from ${result.modifiedTracks} saved track entr${result.modifiedTracks === 1 ? "y" : "ies"} for user \`${userId}\`. Updated ${result.modifiedFields} name field(s); listening time, play counts, and other profile stats were preserved.`
                    : `ℹ️ No saved track names for user \`${userId}\` contained ${displayWording}. Nothing was changed.`;
            return interaction.editReply({
                content: reply,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.error("[euphire] Clean profile command failed:", error);
            const reply =
                "❌ Could not update that user's saved profile track names. Please try again later.";
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
