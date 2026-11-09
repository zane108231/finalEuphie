const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder } = require("discord.js");
const { requireMusicAction } = require("../utils/permissions");

module.exports = {
    aliases: ["purge"],
    data: new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Clear the queue without stopping the current track"),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "clear");
        if (!player) return;

        player.queue.clear();

        const container = new ContainerBuilder();
        container.setAccentColor(0x00ff00);
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "The queue has been cleared"
            )
        );

        await interaction.reply({
            components: [container],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });
    },
};
