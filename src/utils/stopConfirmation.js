const path = require("path");
const { AttachmentBuilder, EmbedBuilder } = require("discord.js");

function createStopConfirmationPayload() {
    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setDescription(
            "Thanks for listening to Euphie!\n\n" +
                "**Enjoying the bot?**\n" +
                "Join our [Discord server](https://discord.gg/mCCyM8Msxm) to support Euphie, get help, and follow future updates. ❤️"
        )
        .setImage("attachment://euphie-banner.png");

    const banner = new AttachmentBuilder(
        path.join(__dirname, "..", "assets", "euphie-banner.png"),
        { name: "euphie-banner.png" }
    );

    return { embeds: [embed], files: [banner] };
}

module.exports = { createStopConfirmationPayload };
