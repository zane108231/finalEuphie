const { SlashCommandBuilder } = require("discord.js");
const profileCommand = require("./profile");

module.exports = {
    aliases: [],
    data: new SlashCommandBuilder()
        .setName("set")
        .setDescription("Configuration and profile customization commands"),

    async execute(interaction, client) {
        const rawArgs = interaction.args || [];
        const target = (rawArgs[0] || "").toLowerCase();

        // Forward e!set profile ... to profile command
        if (target === "profile") {
            interaction.args = rawArgs.slice(1);
            return await profileCommand.execute(interaction, client);
        }

        // Forward e!set background ... to profile set background
        if (target === "background" || target === "bg") {
            return await profileCommand.handleSetBackground(interaction, client, rawArgs.slice(1));
        }

        return await interaction.reply({
            content: "Usage:\n• `e!profile set background <image url | default | avatar | color>`\n• `e!set profile background <image url | default | avatar | color>`\n• `e!profile set color <hex>`",
        });
    },
};
