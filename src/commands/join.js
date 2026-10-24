const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require("discord.js");
const { ensurePlayer, getOccupiedVoiceChannel, replyAlreadyInUse } = require("../utils/playback");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const coordinator = require("../utils/mongoCoordinator");
const config = require("../../config");

function createSummonedEmbed() {
    return new EmbedBuilder()
        .setColor(0x57F287) // Discord Green
        .setDescription("I have been summoned");
}

module.exports = {
    aliases: ["summon"],
    data: new SlashCommandBuilder()
        .setName("join")
        .setDescription("Make the bot join your voice channel"),

    async execute(interaction, client) {
        const member = interaction.member;

        if (!member.voice?.channel) {
            return interaction.reply({
                content: "❌ You need to be in a voice channel!",
                flags: MessageFlags.Ephemeral,
            });
        }

        const voiceChannelId = member.voice.channel.id;
        const guildId = interaction.guild.id;

        // Check if ANY bot is already physically in this voice channel
        for (const c of coordinator.getAllClients()) {
            const targetGuild = c.guilds?.cache?.get(guildId) || interaction.guild;
            const otherMe = targetGuild?.members?.cache?.get(c.user?.id);
            if (otherMe?.voice?.channelId === voiceChannelId) {
                return interaction.reply({
                    embeds: [createSummonedEmbed()],
                    flags: MessageFlags.Ephemeral,
                });
            }
        }

        // Check if THIS specific bot is already occupied in a DIFFERENT voice channel in THIS guild
        const occupiedInGuild = getOccupiedVoiceChannel(interaction.guild, client);
        if (occupiedInGuild && occupiedInGuild.id !== voiceChannelId) {
            return replyAlreadyInUse(interaction, occupiedInGuild);
        }

        // Determine which bot to use:
        let assignedClient = client;
        if (!coordinator.isBotAvailable(client.botId, guildId)) {
            // This bot is not available in THIS guild (e.g. busy in another VC in this server).
            // Try to find another bot in this guild that IS available!
            const availableBotId = coordinator.getAvailableBotInGuild(guildId);
            if (availableBotId) {
                assignedClient = coordinator.getClient(availableBotId);
            } else {
                // No bots available in this guild!
                const embed = new EmbedBuilder()
                    .setColor(config.accentColor || 0x2b2d31)
                    .setDescription("There are no more bots available in this server, looks like I am popular 😎\nYou can invite 2 more bots for free! Check out the invite command for more information.");
                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral,
                });
            }
        }

        // Clean up any stale session if previously bound to a different bot
        const staleOwner = coordinator.sessionOwners.get(voiceChannelId);
        if (staleOwner && staleOwner !== assignedClient.botId) {
            await coordinator.releaseBot(voiceChannelId);
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guildData = getGuildData(guildId);

        try {
            // Reserve and mark THIS specific bot active in coordinator for this voice channel
            await coordinator.reserveSpecificBot(voiceChannelId, interaction.user.id, assignedClient.botId, guildId, true);
            await coordinator.markBotActive(assignedClient.botId, voiceChannelId);
            coordinator.setSessionChannel(voiceChannelId, interaction.channel.id);
            coordinator.setSessionDJ(voiceChannelId, interaction.user.id);

            const player = await ensurePlayer(assignedClient, {
                guildId: guildId,
                voiceChannelId: voiceChannelId,
                textChannelId: interaction.channel.id,
                volume: guildData.volume,
                requesterId: interaction.user.id,
            });
            player.assignedTextChannel = interaction.channel.id;
            guildData.cannotSendPlayer = false;
            guildData.djOwnerId = interaction.user.id;
            await saveGuildData(guildId, guildData);

            // If nothing is playing and queue is empty, start 3-minute idle timeout
            if (!player.playing && (!player.queue || player.queue.length === 0)) {
                const { setPlayerIdleTimeout } = require("../utils/playback");
                setPlayerIdleTimeout(assignedClient, player, guildData, "idle");
            }

            const embed = createSummonedEmbed();

            await interaction.editReply({
                embeds: [embed],
            });
        } catch (error) {
            console.error("[euphire] Join error:", error);
            await coordinator.releaseBot(voiceChannelId);
            return interaction.editReply({ content: "❌ Could not join your voice channel." });
        }
    },
};
