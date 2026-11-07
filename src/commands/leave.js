const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { getGuildData, saveGuildData, clearUpdateInterval } = require("../utils/mongoGuildData");
const { requireMusicAction } = require("../utils/permissions");
const { markIntentionalDisconnect } = require("../utils/playback");
const { endSession } = require("../utils/mongoStats");
const coordinator = require("../utils/mongoCoordinator");
const { removeSavedSession } = require("../utils/playbackRecovery");
const { createStopConfirmationEmbed } = require("../utils/stopConfirmation");

module.exports = {
    aliases: ["dc"],
    data: new SlashCommandBuilder()
        .setName("leave")
        .setDescription("Force the bot to leave the voice channel (ignores 24/7 mode)"),

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
        
        // End statistics session (disconnected manually)
        try {
            const sessionId = player.currentSessionId || guildData.currentSessionId;
            if (sessionId) {
                console.log("[euphire] leave: ending session (manual disconnect)");
                const listenedMs = player.position || (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);
                await endSession(sessionId, false, listenedMs);
                player.currentSessionId = null;
                guildData.currentSessionId = null;
            }
        } catch (err) {
            console.error("[euphire] Failed to end stats session on leave:", err.message);
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
        guildData.playerMessageId = null;
        guildData.playerChannelId = null;
        guildData.chatPlayChannelId = null;
        guildData.chatPlayMessageId = null;
        await saveGuildData(interaction.guild.id, guildData);

        await removeSavedSession(interaction.guild.id);
        player.queue?.clear?.();
        player.stop?.();
        markIntentionalDisconnect(player);
        player.destroy?.();

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
