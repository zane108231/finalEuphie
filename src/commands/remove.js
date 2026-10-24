const {
    SlashCommandBuilder,
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require("discord.js");
const { requireMusicAction } = require("../utils/permissions");

function formatDurationLeadingZero(ms) {
    if (!ms || isNaN(ms)) return "00:00";
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

module.exports = {
    aliases: ["rm", "delete"],
    data: new SlashCommandBuilder()
        .setName("remove")
        .setDescription("Remove a track from the queue")
        .addIntegerOption((opt) =>
            opt
                .setName("position")
                .setDescription("Position of the track to remove (1-based)")
                .setRequired(false)
                .setMinValue(1)
        ),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "remove");
        if (!player) return;

        if (!player.queue || player.queue.length === 0) {
            return interaction.reply({
                content: "❌ There are no tracks in the queue.",
                flags: MessageFlags.Ephemeral,
            });
        }

        // Direct position argument provided (e.g. e!rm 2)
        const rawArg = interaction.args?.[0];
        const posOption = interaction.options?.getInteger?.("position");
        const pos = posOption || (rawArg && /^\d+$/.test(rawArg) ? parseInt(rawArg, 10) : null);

        if (pos !== null) {
            if (pos < 1 || pos > player.queue.length) {
                return interaction.reply({
                    content: `❌ Invalid position. Queue has **${player.queue.length}** track(s).`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const removed = player.queue.splice(pos - 1, 1)[0];
            const trackTitle = removed?.info?.title || "Unknown Track";
            const trackArtist = removed?.info?.author || "Unknown Artist";
            const trackUri = removed?.info?.uri || "https://open.spotify.com";

            const removedEmbed = new EmbedBuilder()
                .setColor(0x00FF00) // Green outline
                .setDescription(`Removed track [${trackTitle} by ${trackArtist}](${trackUri})`);

            return await interaction.reply({ embeds: [removedEmbed] });
        }

        // Interactive Selection Mode matching Image #2
        // Show up to 10 tracks on the page
        const tracksToShow = player.queue.slice(0, 20); // Discord select menus support up to 25 options
        const totalPages = Math.ceil(player.queue.length / 10) || 1;
        const pageTracks = player.queue.slice(0, 10);

        let lines = [];
        pageTracks.forEach((track, i) => {
            const duration = formatDurationLeadingZero(track.info?.length || 0);
            const title = track.info?.title || "Unknown Track";
            const author = track.info?.author || "Unknown Artist";
            const uri = track.info?.uri || "https://open.spotify.com";
            lines.push(`${i + 1}. \`[${duration}]\` [${title} by ${author}](${uri})`);
        });

        const embedDescription = `Page **1/${totalPages}**\n\n${lines.join("\n")}\n\ncancel`;

        const queueEmbed = new EmbedBuilder()
            .setColor(0x2b2d31)
            .setDescription(embedDescription);

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`remove_select_${interaction.id}`)
            .setPlaceholder("Make a selection")
            .setMinValues(1)
            .setMaxValues(1);

        pageTracks.forEach((track, i) => {
            const duration = formatDurationLeadingZero(track.info?.length || 0);
            const title = track.info?.title || "Unknown Track";
            const author = track.info?.author || "Unknown Artist";

            selectMenu.addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${title}`.slice(0, 100))
                    .setDescription(`by ${author} [${duration}]`.slice(0, 100))
                    .setValue(String(i))
            );
        });

        selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel("cancel")
                .setDescription("Cancel track removal")
                .setValue("cancel")
        );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        // Send the interactive selection menu in the channel
        let message = null;
        if (interaction.channel) {
            message = await interaction.channel.send({
                embeds: [queueEmbed],
                components: [row],
            });
            // If interaction needs acknowledgment
            if (!interaction.replied && !interaction.deferred) {
                if (interaction.isChatInputCommand?.()) {
                    await interaction.reply({ content: "Please make a selection above.", flags: MessageFlags.Ephemeral }).catch(() => {});
                }
            }
        } else {
            message = await interaction.reply({
                embeds: [queueEmbed],
                components: [row],
                fetchReply: true,
            });
        }

        if (!message) return;

        // Await user's selection
        const filter = (i) => i.user.id === interaction.user.id && i.customId === `remove_select_${interaction.id}`;
        const collector = message.createMessageComponentCollector({ filter, time: 60000, max: 1 });

        collector.on("collect", async (menuInteraction) => {
            const selectedValue = menuInteraction.values[0];

            if (selectedValue === "cancel") {
                await message.delete().catch(() => {});
                return;
            }

            const selectedIndex = parseInt(selectedValue, 10);
            if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= player.queue.length) {
                await message.delete().catch(() => {});
                return;
            }

            const removed = player.queue.splice(selectedIndex, 1)[0];
            const trackTitle = removed?.info?.title || "Unknown Track";
            const trackArtist = removed?.info?.author || "Unknown Artist";
            const trackUri = removed?.info?.uri || "https://open.spotify.com";

            // Delete the queue selection message completely so only the removed track embed remains
            await message.delete().catch(() => {});

            // Send green outline left side embed message
            const removedEmbed = new EmbedBuilder()
                .setColor(0x00FF00) // Green outline
                .setDescription(`Removed track [${trackTitle} by ${trackArtist}](${trackUri})`);

            await menuInteraction.channel.send({ embeds: [removedEmbed] });
        });

        collector.on("end", async (collected, reason) => {
            if (reason === "time" && collected.size === 0) {
                await message.delete().catch(() => {});
            }
        });
    },
};
