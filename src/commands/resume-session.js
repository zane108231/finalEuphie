const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require("discord.js");
const { resumeGuildSession } = require("../utils/playbackRecovery");

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
                return interaction.reply({
                    content: "There is no saved music session for this server.",
                    flags: MessageFlags.Ephemeral,
                });
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
            return interaction.reply({
                content: err.message,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
