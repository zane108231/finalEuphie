const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { requireMusicAction } = require("../utils/permissions");
const { markIntentionalDisconnect } = require("../utils/playback");
const { endSession } = require("../utils/mongoStats");
const { removeSavedSession } = require("../utils/playbackRecovery");
const { createStopConfirmationEmbed } = require("../utils/stopConfirmation");
const { returnPlayerToWaitingRoom } = require("../utils/waitingRoom");

module.exports = {
    aliases: ["leave"],
    data: new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Stop playback, clear queue, and disconnect"),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "stop");
        if (!player) return;

        player.leaveAfterQueueEnd = false;

        // End statistics session (stopped manually)
        try {
            const sessionId = player.currentSessionId;
            if (sessionId) {
                console.log("[euphire] stop: ending session (manual stop)");
                const listenedMs = player.position || (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);
                await endSession(sessionId, false, listenedMs);
                player.currentSessionId = null;
            }
        } catch (err) {
            console.error("[euphire] Failed to end stats session on stop:", err.message);
        }
        
        if (player.idleTimeout) {
            clearTimeout(player.idleTimeout);
            player.idleTimeout = null;
        }

        await removeSavedSession(interaction.guild.id, client.botId);
        let returnedToWaitingRoom = false;
        try {
            returnedToWaitingRoom = await returnPlayerToWaitingRoom(client, player);
        } catch (error) {
            console.error(
                `[euphire] Failed to return ${client.botId} to the waiting room after stop command:`,
                error
            );
        }
        if (!returnedToWaitingRoom) {
            player.queue?.clear?.();
            player.stop?.();
            markIntentionalDisconnect(player);
            player.destroy?.();
        }

        const embed = createStopConfirmationEmbed();
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({
                embeds: [embed],
            });
        } else {
            await interaction.reply({
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
