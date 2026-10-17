const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder } = require("discord.js");
const { getGuildData } = require("../utils/mongoGuildData");
const { setVolumeSafe } = require("../utils/playback");
const { requireMusicAction } = require("../utils/permissions");

module.exports = {
    aliases: ["vol", "v"],
    data: new SlashCommandBuilder()
        .setName("volume")
        .setDescription("Set the playback volume")
        .addIntegerOption((opt) =>
            opt
                .setName("level")
                .setDescription("Volume level (0-100)")
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(100)
        ),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "volume");
        if (!player) return;

        const rawLevel = interaction.options.getInteger("level");
        if (rawLevel == null) {
            return interaction.reply({
                content: "❌ Usage: `!volume <0-100>`",
                flags: MessageFlags.Ephemeral,
            });
        }
        const level = Math.min(100, Math.max(0, rawLevel));

        const guildData = getGuildData(interaction.guild.id);
        guildData.volume = level;
        setVolumeSafe(player, level);

        // Build a simple volume bar
        const filled = Math.round(level / 10);
        const bar = "█".repeat(filled) + "░".repeat(10 - filled);

        const container = new ContainerBuilder();
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "### 🔊 Volume Updated\n\n" +
                "**Level**\n" +
                `-# ${level}%\n\n` +
                "**Volume**\n" +
                `-# ${bar}`
            )
        );
        await interaction.reply({
            components: [container],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });
    },
};
