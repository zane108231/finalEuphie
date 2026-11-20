const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require("discord.js");
const {
    ensurePlayer,
    getOccupiedVoiceChannel,
    buildNoBotsAvailablePayload,
} = require("../utils/playback");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const coordinator = require("../utils/mongoCoordinator");

function createSummonedEmbed() {
    return new EmbedBuilder()
        .setColor(0x57F287) // Discord Green
        .setDescription("I have been summoned");
}

function createAlreadyHereEmbed() {
    return new EmbedBuilder()
        .setColor(0xed4245)
        .setDescription("I am already here 👋");
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

        // Check all Euphie clients so the response is consistent regardless of bot routing.
        for (const c of coordinator.getAllClients()) {
            const targetGuild = c.guilds?.cache?.get(guildId) || interaction.guild;
            const occupied = getOccupiedVoiceChannel(targetGuild, c);
            if (occupied?.id === voiceChannelId) {
                return interaction.reply({
                    embeds: [createAlreadyHereEmbed()],
                    flags: MessageFlags.Ephemeral,
                });
            }
        }

        const existingOwner = coordinator.resolveSessionOwner(
            voiceChannelId,
            interaction.guild
        );
        if (existingOwner) {
            return interaction.reply({
                embeds: [createAlreadyHereEmbed()],
                flags: MessageFlags.Ephemeral,
            });
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
                return interaction.reply({
                    ...buildNoBotsAvailablePayload(),
                    flags: MessageFlags.Ephemeral,
                });
            }
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guildData = getGuildData(guildId);

        try {
            // Reserve and mark THIS specific bot active in coordinator for this voice channel
            const reserved = await coordinator.reserveSpecificBot(
                voiceChannelId,
                interaction.user.id,
                assignedClient.botId,
                guildId,
                true
            );
            if (!reserved) {
                return interaction.editReply({
                    content: "A Euphie bot is already assigned to your voice channel.",
                });
            }
            await coordinator.markBotActive(assignedClient.botId, voiceChannelId);
            coordinator.setSessionChannel(voiceChannelId, interaction.channel.id);
            coordinator.setSessionDJ(voiceChannelId, interaction.user.id);

            const player = await ensurePlayer(assignedClient, {
                guildId: guildId,
                voiceChannelId: voiceChannelId,
                voiceChannelObject: member.voice.channel,
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
            await coordinator.releaseBot(voiceChannelId, assignedClient.botId);
            return interaction.editReply({
                content:
                    error.code === "VOICE_CHANNEL_PERMISSION_MISSING"
                        ? error.message
                        : "❌ Could not join your voice channel.",
            });
        }
    },
};
