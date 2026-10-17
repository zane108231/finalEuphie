const {
    SlashCommandBuilder,
    MessageFlags,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SectionBuilder,
    ThumbnailBuilder,
} = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("stats")
        .setDescription("Show euphire's statistics"),

    async execute(interaction, client) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const container = new ContainerBuilder();

        const header = new SectionBuilder()
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent("### <:euphire_Logo:1504329028356673536> Statistics")
            )
            .setThumbnailAccessory(
                new ThumbnailBuilder().setURL(
                    client.user.displayAvatarURL({ size: 128 })
                )
            );

        container.addSectionComponents(header);

        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

        const uptimeSeconds = process.uptime();
        const startTime = new Date(Date.now() - uptimeSeconds * 1000);
        const startTimestamp = Math.floor(startTime.getTime() / 1000);

        const mem = process.memoryUsage();
        const memUsed = (mem.heapUsed / 1024 / 1024).toFixed(1);
        const memTotal = (mem.heapTotal / 1024 / 1024).toFixed(1);
        const memRSS = (mem.rss / 1024 / 1024).toFixed(1);

        const totalGuilds = client.guilds.cache.size;
        const totalUsers = client.guilds.cache.reduce((a, g) => a + g.memberCount, 0);
        const totalChannels = client.channels.cache.size;
        const activePlayers = client.riffy.players?.size || 0;
        const totalNodes = client.riffy.nodes?.length || client.riffy.nodes?.size || 0;

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "**Uptime**\n" +
                `-# <t:${startTimestamp}:f> (<t:${startTimestamp}:R>)\n` +
                `-# *Times shown in your local timezone*\n` +
                "**Ping**\n" +
                `-# ${client.ws.ping}ms\n` +
                "**Runtime**\n" +
                `-# [Node.js ${process.version}](https://nodejs.org/) · [discord.js v${require("discord.js").version}](https://discord.js.org/)`
            )
        );

        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "**Guilds**\n" +
                `-# ${totalGuilds.toLocaleString()}\n` +
                "**Users**\n" +
                `-# ${totalUsers.toLocaleString()}\n` +
                "**Channels**\n" +
                `-# ${totalChannels.toLocaleString()}\n` +
                "**Active Players**\n" +
                `-# ${activePlayers}\n` +
                "**Lavalink Nodes**\n" +
                `-# ${totalNodes}`
            )
        );

        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "**Heap Used**\n" +
                `-# ${memUsed} MB\n` +
                "**Heap Total**\n" +
                `-# ${memTotal} MB\n` +
                "**RSS**\n" +
                `-# ${memRSS} MB`
            )
        );

        await interaction.editReply({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        });
    },
};
