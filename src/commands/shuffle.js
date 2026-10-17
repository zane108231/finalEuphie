const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { requireMusicAction, getMusicDenial } = require("../utils/permissions");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");

module.exports = {
    aliases: ["mix"],
    data: new SlashCommandBuilder()
        .setName("shuffle")
        .setDescription("Shuffle the current queue"),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "shuffle");
        if (!player) return;

        // Correctly await permission denial
        const denial = await getMusicDenial(interaction.member, player, "shuffle");
        if (denial) {
            return interaction.reply({ content: denial, flags: MessageFlags.Ephemeral });
        }

        const guildId = interaction.guild?.id;
        const guildData = await getGuildData(guildId);

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
        guildData.shuffle = true;
        await saveGuildData(guildId, guildData);

        // Strictly follows reference image: Green outline + "The queue has been shuffled"
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setDescription("The queue has been shuffled");

        return interaction.reply({ embeds: [embed] });
    },
};
