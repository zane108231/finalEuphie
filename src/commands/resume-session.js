const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { resumeGuildSession } = require("../utils/playbackRecovery");

module.exports = {
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
                interaction.user.id
            );
            if (!player) {
                return interaction.reply({
                    content: "There is no saved music session for this server.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            return interaction.reply({
                content: "Your saved music session has been resumed.",
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
