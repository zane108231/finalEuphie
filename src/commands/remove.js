const {
    SlashCommandBuilder,
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require("discord.js");
const { requireMusicAction } = require("../utils/permissions");
const { getTrackDisplayName } = require("../utils/search");

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

        const currentTrack =
            player.current && (player.playing || player.paused)
                ? player.current
                : null;
        const queueTracks = player.queue || [];
        const allTracks = currentTrack
            ? [currentTrack, ...queueTracks]
            : [...queueTracks];
        if (allTracks.length === 0) {
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
            if (pos < 1 || pos > allTracks.length || (currentTrack && pos === 1)) {
                const queueDescription = currentTrack
                    ? "The currently playing song cannot be removed with a queue position. "
                    : "";
                return interaction.reply({
                    content: `❌ Invalid position. ${queueDescription}There are **${queueTracks.length}** upcoming track(s).`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const queueIndex = currentTrack ? pos - 2 : pos - 1;
            const removed = queueTracks.splice(queueIndex, 1)[0];
            const trackUri = removed?.info?.uri || "https://open.spotify.com";

            const removedEmbed = new EmbedBuilder()
                .setColor(0x00FF00) // Green outline
                .setDescription(`Removed track [${getTrackDisplayName(removed)}](${trackUri})`);

            return await interaction.reply({ embeds: [removedEmbed] });
        }

        // Interactive Selection Mode matching Image #2
        // Show up to 10 tracks on the page
        const totalPages = Math.ceil(allTracks.length / 10) || 1;
        const pageTracks = allTracks.slice(0, 10);
        const selectableTracks = currentTrack ? pageTracks.slice(1) : pageTracks;

        const lines = pageTracks.map((track, i) => {
            const duration = formatDurationLeadingZero(track.info?.length || 0);
            const uri = track.info?.uri || "https://open.spotify.com";
            return `${i + 1}. \`[${duration}]\` [${getTrackDisplayName(track)}](${uri})`;
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

        selectableTracks.forEach((track) => {
            const queueIndex = queueTracks.indexOf(track);
            const duration = formatDurationLeadingZero(track.info?.length || 0);

            selectMenu.addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${queueIndex + (currentTrack ? 2 : 1)}. ${getTrackDisplayName(track)}`.slice(0, 100))
                    .setDescription(`[${duration}]`.slice(0, 100))
                    .setValue(String(queueIndex))
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
            const shouldAcknowledge =
                interaction.isChatInputCommand?.() &&
                !interaction.replied &&
                !interaction.deferred;
            if (shouldAcknowledge) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            }
            try {
                message = await interaction.channel.send({
                    embeds: [queueEmbed],
                    components: [row],
                });
            } catch (error) {
                if (shouldAcknowledge) {
                    await interaction.editReply({
                        content: "❌ Could not send the queue selection menu.",
                    });
                }
                throw error;
            }
            if (shouldAcknowledge) {
                await interaction.deleteReply();
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
            await menuInteraction.deferUpdate();
            const selectedValue = menuInteraction.values[0];

            if (selectedValue === "cancel") {
                await message.delete().catch(() => {});
                return;
            }

            const selectedIndex = parseInt(selectedValue, 10);
            if (
                isNaN(selectedIndex) ||
                selectedIndex < 0 ||
                selectedIndex >= queueTracks.length
            ) {
                await message.delete().catch(() => {});
                return;
            }

            const removed = queueTracks.splice(selectedIndex, 1)[0];
            const trackUri = removed?.info?.uri || "https://open.spotify.com";

            // Delete the queue selection message completely so only the removed track embed remains
            await message.delete().catch(() => {});

            // Send green outline left side embed message
            const removedEmbed = new EmbedBuilder()
                .setColor(0x00FF00) // Green outline
                .setDescription(`Removed track [${getTrackDisplayName(removed)}](${trackUri})`);

            await menuInteraction.channel.send({ embeds: [removedEmbed] });
        });

        collector.on("end", async (collected, reason) => {
            if (reason === "time" && collected.size === 0) {
                await message.delete().catch(() => {});
            }
        });
    },
};
