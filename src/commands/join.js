const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require("discord.js");
const { ensurePlayer, getOccupiedVoiceChannel, replyAlreadyInUse } = require("../utils/playback");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const coordinator = require("../utils/mongoCoordinator");

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

        // Check if THIS specific bot is already occupied in a DIFFERENT voice channel
        const occupied = getOccupiedVoiceChannel(interaction.guild, client);
        if (occupied && occupied.id !== voiceChannelId) {
            return replyAlreadyInUse(interaction, occupied);
        }

        // Check if another bot is already physically in this voice channel
        for (const c of coordinator.getAllClients()) {
            if (c.botId !== client.botId) {
                const targetGuild = c.guilds?.cache?.get(guildId) || interaction.guild;
                const otherMe = targetGuild?.members?.cache?.get(c.user?.id);
                if (otherMe?.voice?.channelId === voiceChannelId) {
                    return interaction.reply({
                        content: "❌ Another bot is already in your voice channel.",
                        flags: MessageFlags.Ephemeral,
                    });
                }
            }
        }

        // Clean up any stale session if previously bound to a different bot
        const staleOwner = coordinator.sessionOwners.get(voiceChannelId);
        if (staleOwner && staleOwner !== client.botId) {
            await coordinator.releaseBot(voiceChannelId);
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guildData = getGuildData(guildId);

        try {
            // Reserve and mark THIS specific bot active in coordinator for this voice channel
            await coordinator.reserveSpecificBot(voiceChannelId, interaction.user.id, client.botId, guildId, true);
            await coordinator.markBotActive(client.botId, voiceChannelId);
            coordinator.setSessionChannel(voiceChannelId, interaction.channel.id);
            coordinator.setSessionDJ(voiceChannelId, interaction.user.id);

            const player = await ensurePlayer(client, {
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
