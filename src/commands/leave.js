const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder } = require("discord.js");
const { getGuildData, saveGuildData, clearUpdateInterval } = require("../utils/mongoGuildData");
const { requireMusicAction } = require("../utils/permissions");
const { endSession } = require("../utils/mongoStats");
const coordinator = require("../utils/mongoCoordinator");

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

        player.queue?.clear?.();
        player.stop?.();
        player.destroy?.();

        const container = new ContainerBuilder();
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "### 👋 Left Voice Channel\n\n" +
                "**Status**\n" +
                "-# Disconnected from voice channel and cleared queue."
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
