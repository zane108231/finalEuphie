const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder } = require("discord.js");
const { formatDuration } = require("../utils/components");
const { requireMusicAction } = require("../utils/permissions");

module.exports = {
    aliases: ["rewind"],
    data: new SlashCommandBuilder()
        .setName("seek")
        .setDescription("Seek to a specific position in the track")
        .addStringOption((opt) =>
            opt
                .setName("time")
                .setDescription("Time to seek to (e.g. 1:30 or 90)")
                .setRequired(true)
        ),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "seek");
        if (!player) return;
        if (!player.current) {
            return interaction.reply({
                content: "❌ Nothing is playing right now.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const timeStr = interaction.options.getString("time");
        if (!timeStr) {
            return interaction.reply({
                content: "❌ Usage: `!seek <time>` — e.g. `!seek 1:30` or `!seek 90`",
                flags: MessageFlags.Ephemeral,
            });
        }
        let ms = 0;

        // Parse time — supports "1:30", "90", "1:30:00"
        if (timeStr.includes(":")) {
            const parts = timeStr.split(":").map(Number);
            if (parts.length === 2) {
                ms = (parts[0] * 60 + parts[1]) * 1000;
            } else if (parts.length === 3) {
                ms = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
            }
        } else {
            ms = parseInt(timeStr, 10) * 1000;
        }

        if (isNaN(ms) || ms < 0) {
            return interaction.reply({
                content: "❌ Invalid time format. Use `1:30` or `90`.",
                flags: MessageFlags.Ephemeral,
            });
        }

        if (ms > player.current.info.length) {
            return interaction.reply({
                content: `❌ Can't seek past track duration (${formatDuration(player.current.info.length)}).`,
                flags: MessageFlags.Ephemeral,
            });
        }

        player.seek(ms);

        const container = new ContainerBuilder();
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "### ⏩ Seeked\n\n" +
                "**Position**\n" +
                `-# ${formatDuration(ms)} / ${formatDuration(player.current.info.length)}\n\n` +
                "**Track**\n" +
                `-# ${player.current.info.title}`
            )
        );
        await interaction.reply({
            components: [container],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });
    },
};
