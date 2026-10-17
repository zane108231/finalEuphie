const {
    SlashCommandBuilder,
    MessageFlags,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SectionBuilder,
    ThumbnailBuilder,
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
        const container = new ContainerBuilder();

        const botAvatar = client.user.displayAvatarURL({ size: 256 });

        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        "# <:euphire_Logo:1504329028356673536> About euphire"
                    )
                )
                .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL(botAvatar)
                )
        );

        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "**What is euphire?**\n" +
                "-# A ChatPlay-focused Discord music bot that delivers high-quality\n" +
                "-# music streaming directly to your voice channels.\n\n" +
                "**Powered By**\n" +
                "-# [discord.js](https://discord.js.org/) · [Riffy](https://riffy.js.org/) · [Musicard](https://www.npmjs.com/package/musicard)\n\n" +
                "**Features**\n" +
                "-# • **Rich now-playing cards** with progress bars\n" +
                "-# • **10+ audio filter** presets\n" +
                "-# • **Smart queue management** with pagination\n" +
                "-# • **ChatPlay** — instant song requests\n" +
                "-# • **Interactive button-based** controls"
            )
        );

        container.addSeparatorComponents(new SeparatorBuilder().setDivider(false));

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel("Support Developer")
                .setURL("https://dsc.gg/duxceriao")
                .setStyle(ButtonStyle.Link),
        );

        container.addActionRowComponents(row);

        await interaction.reply({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        });
    },
};