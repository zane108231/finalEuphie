const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder } = require("discord.js");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const { requireMusicAction } = require("../utils/permissions");
const { getMusicDenial } = require("../utils/permissions");

module.exports = {
    aliases: ["repeat"],
    data: new SlashCommandBuilder()
        .setName("loop")
        .setDescription("Set loop mode")
        .addStringOption((opt) =>
            opt
                .setName("mode")
                .setDescription("Loop mode")
                .setRequired(true)
                .addChoices(
                    { name: "Off", value: "none" },
                    { name: "Track", value: "track" },
                    { name: "Queue", value: "queue" }
                )
        ),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "loop");
        if (!player) return;

        const mode = (interaction.options.getString("mode") || "").toLowerCase();
        if (!["none", "off", "track", "queue"].includes(mode)) {
            return interaction.reply({
                content: "❌ Usage: `!loop none` · `!loop track` · `!loop queue`",
                flags: MessageFlags.Ephemeral,
            });
        }
        const resolvedMode = mode === "off" ? "none" : mode;
        const guildData = getGuildData(interaction.guild.id);
        guildData.loop = resolvedMode;
        player.setLoop(resolvedMode);
        await saveGuildData(interaction.guild.id, guildData);

        const labels = { none: "Off", track: "Track", queue: "Queue" };
        const emojis = { none: "➡️", track: "🔂", queue: "🔁" };

        const container = new ContainerBuilder();
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `### ${emojis[resolvedMode]} Loop Updated\n\n` +
                "**Mode**\n" +
                `-# ${labels[resolvedMode]}`
            )
        );
        await interaction.reply({
            components: [container],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });
    },
};
