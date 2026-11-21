const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { requireMusicAction } = require("../utils/permissions");
const { createStopConfirmationPayload } = require("../utils/stopConfirmation");
const {
    initiatePlayerStop,
    finishPlayerStop,
} = require("../utils/stopPlayer");

module.exports = {
    aliases: ["dc"],
    data: new SlashCommandBuilder()
        .setName("leave")
        .setDescription("Force the bot to leave the voice channel (ignores 24/7 mode)"),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "stop");
        if (!player) return;

        const session = initiatePlayerStop(player);
        const payload = createStopConfirmationPayload();
        finishPlayerStop(
            client,
            player,
            interaction.guild.id,
            "leave command",
            session
        ).catch((error) => {
            console.error(
                `[euphire] Leave cleanup failed for ${client.botId} in guild ${interaction.guild.id}:`,
                error
            );
        });

        if (interaction.replied || interaction.deferred) {
            await interaction.editReply(payload);
        } else {
            await interaction.reply({
                ...payload,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
