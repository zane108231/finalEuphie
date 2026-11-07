const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");

module.exports = {
    aliases: ["info"],
    data: new SlashCommandBuilder()
        .setName("about")
        .setDescription("Learn more about euphire"),

    async execute(interaction, client) {
        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setAuthor({
                name: "About euphire",
                iconURL: client.user.displayAvatarURL({ size: 256 }),
            })
            .setDescription(
                "A music bot for your server, built to make listening together simple."
            )
            .addFields(
                {
                    name: "🎵 Playback",
                    value: "Play tracks and playlists, then manage what comes next.",
                    inline: true,
                },
                {
                    name: "🎛️ Controls",
                    value: "Use queue tools, audio filters, and interactive player controls.",
                    inline: true,
                },
                {
                    name: "✨ Listening experience",
                    value: "Enjoy clear now-playing cards and helpful track details.",
                    inline: false,
                },
                {
                    name: "👨‍💻 Developer",
                    value: "**Jiyu**",
                    inline: true,
                },
                {
                    name: "⚙️ Built with",
                    value: "[discord.js](https://discord.js.org/) · [Riffy](https://riffy.js.org/) · [Musicard](https://www.npmjs.com/package/musicard)",
                    inline: true,
                }
            )
            .setFooter({ text: "Made for good music and good company." });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel("Support Developer")
                .setURL("https://dsc.gg/duxceriao")
                .setStyle(ButtonStyle.Link)
        );

        await interaction.reply({
            embeds: [embed],
            components: [row],
        });
    },
};
