const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { requireMusicAction, getMusicDenial } = require("../utils/permissions");
const { persistPlayer } = require("../utils/playbackRecovery");

module.exports = {
    aliases: ["mix"],
    data: new SlashCommandBuilder()
        .setName("shuffle")
        .setDescription("Shuffle the current queue"),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "shuffle");
        if (!player) return;

        // Check if queue has tracks to shuffle
        if (!player.queue || player.queue.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setDescription("The queue is empty, nothing to shuffle.");
            return interaction.reply({
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }

        // Shuffle queue
        player.queue.shuffle();
        await persistPlayer(client, player);

        // Strictly follows reference image: Green outline + "The queue has been shuffled"
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setDescription("The queue has been shuffled");

        return interaction.reply({ embeds: [embed] });
    },
};
