const { EmbedBuilder } = require("discord.js");

function createStopConfirmationEmbed() {
    return new EmbedBuilder()
        .setColor(0xd34b5e)
        .setDescription(
            "Thank you for using our service!\n\n" +
                "**Support Jiyu**\n" +
                "❤️"
        );
}

module.exports = { createStopConfirmationEmbed };
