const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder } = require("discord.js");
const { getGuildData, saveGuildData, clearUpdateInterval } = require("../utils/mongoGuildData");
const { requireMusicAction } = require("../utils/permissions");
const { endSession } = require("../utils/mongoStats");
const coordinator = require("../utils/mongoCoordinator");
const { removeSavedSession } = require("../utils/playbackRecovery");

module.exports = {
    aliases: ["leave"],
    data: new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Stop playback, clear queue, and disconnect"),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "stop");
        if (!player) return;

        // Clean up guild state
        const guildData = getGuildData(interaction.guild.id);
        guildData.leaveAfterQueueEnd = false;
        
        // Release bot reservation (DJ releases ownership)
        if (player.voiceChannel) {
            const botId = coordinator.resolveSessionOwner(player.voiceChannel, interaction.guild) || coordinator.getSessionOwner(player.voiceChannel);
            await coordinator.releaseBot(player.voiceChannel);
            if (botId) {
                coordinator.markBotAvailable(botId);
            }
        }
        if (client?.botId) {
            coordinator.markBotAvailable(client.botId);
        }
        
        // Clear DJ ownership from guildData
        guildData.djOwnerId = null;
        
        // End statistics session (stopped manually)
        try {
            const sessionId = player.currentSessionId || guildData.currentSessionId;
            if (sessionId) {
                console.log("[euphire] stop: ending session (manual stop)");
                const listenedMs = player.position || (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);
                await endSession(sessionId, false, listenedMs);
                player.currentSessionId = null;
                guildData.currentSessionId = null;
            }
        } catch (err) {
            console.error("[euphire] Failed to end stats session on stop:", err.message);
        }
        
        clearUpdateInterval(guildData);
        if (player.idleTimeout) {
            clearTimeout(player.idleTimeout);
            player.idleTimeout = null;
        }
        if (guildData.idleTimeout) {
            clearTimeout(guildData.idleTimeout);
            guildData.idleTimeout = null;
        }
        guildData.suggestions = [];
        guildData.previousTracks = [];

        await removeSavedSession(interaction.guild.id);
        player.queue?.clear?.();
        player.stop?.();

        guildData.playerMessageId = null;
        guildData.playerChannelId = null;
        await saveGuildData(interaction.guild.id, guildData);
        player.destroy?.();

        const container = new ContainerBuilder();
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "### ⏹ Stopped\n\n" +
                "**Status**\n" +
                "-# Queue cleared, disconnected, and bot released for others to use."
            )
        );
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
            });
        } else {
            await interaction.reply({
                components: [container],
                flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
            });
        }
    },
};
