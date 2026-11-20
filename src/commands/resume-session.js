const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require("discord.js");
const { resumeGuildSession } = require("../utils/playbackRecovery");

function replyNoSavedSession(interaction) {
    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(0xed4245)
                .setDescription("You have no saved session"),
        ],
        flags: MessageFlags.Ephemeral,
    });
}

module.exports = {
    aliases: ["resumesession"],
    data: new SlashCommandBuilder()
        .setName("resume-session")
        .setDescription("Resume your saved music session"),

    async execute(interaction) {
        if (!interaction.guild?.id) {
            return interaction.reply({
                content: "This command can only be used in a server.",
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            const player = await resumeGuildSession(
                interaction.guild.id,
                interaction.user.id,
                interaction.member?.voice?.channelId ||
                    interaction.member?.voice?.channel?.id ||
                    null
            );
            if (!player) {
                return replyNoSavedSession(interaction);
            }

            const embed = new EmbedBuilder()
                .setColor(0x57f287)
                .setTitle("Session Resumed")
                .setDescription("Your saved music session has been resumed.");

            return interaction.reply({
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            if (
                err.message ===
                "There is no saved music session for your current voice channel."
            ) {
                return replyNoSavedSession(interaction);
            }
            return interaction.reply({
                content: err.message,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
