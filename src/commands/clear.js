const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { requireMusicAction } = require("../utils/permissions");

module.exports = {
    aliases: ["purge"],
    data: new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Clear the queue and stop the current track"),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "clear");
        if (!player) return;

        const hasQueuedTracks = (player.queue?.length || 0) > 0;
        const isPlaying = Boolean(player.playing || player.paused);
        if (!hasQueuedTracks && !isPlaying) {
            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setDescription("There are no more tracks");

            return interaction.reply({
                embeds: [embed],
            });
        }

        if (typeof player.queue?.clear === "function") {
            player.queue.clear();
        } else if (Array.isArray(player.queue)) {
            player.queue.length = 0;
        } else {
            throw new TypeError("The player's queue does not support clearing.");
        }

        if (isPlaying) {
            player._clearQueueRequested = true;
            player._clearQueueLoopMode = player.loop || "none";
            player.setLoop("none");
            player.paused = false;
            player.pausedAtPosition = null;
            player.stop();

            player._clearQueueRestoreTimer = setTimeout(() => {
                if (!player._clearQueueRequested) return;
                player._clearQueueRequested = false;
                player.setLoop(player._clearQueueLoopMode || "none");
                delete player._clearQueueLoopMode;
                delete player._clearQueueRestoreTimer;
            }, 10000);
            player._clearQueueRestoreTimer.unref?.();
        }

        let persistError = null;
        try {
            await require("../utils/playbackRecovery").persistPlayer(client, player);
        } catch (error) {
            persistError = error;
            console.error(
                `[euphire] Failed to persist cleared playback for guild ${player.guildId}:`,
                error
            );
        }

        const embed = new EmbedBuilder()
            .setColor(persistError ? 0xED4245 : 0x00FF00)
            .setDescription(
                persistError
                    ? "The queue has been cleared and playback stopped, but the cleared state could not be saved for recovery."
                    : "The queue has been cleared"
            );

        return interaction.reply({
            embeds: [embed],
        });
    },
};
