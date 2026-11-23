const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const { requireMusicAction } = require("../utils/permissions");

module.exports = {
    aliases: ["ap"],
    data: new SlashCommandBuilder()
        .setName("autoplay")
        .setDescription("Toggle autoplay mode"),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "autoplay");
        if (!player) return;

        const guildData = getGuildData(interaction.guild.id);
        guildData.autoplay = !guildData.autoplay;
        await saveGuildData(interaction.guild.id, guildData);

        const status = guildData.autoplay ? "enabled" : "disabled";

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setDescription(`Autoplay has been ${status}`);

        await interaction.reply({ embeds: [embed] });
    },
};
