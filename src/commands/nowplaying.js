const { SlashCommandBuilder, MessageFlags, AttachmentBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, EmbedBuilder } = require("discord.js");
const { getGuildData } = require("../utils/mongoGuildData");
const { createNowPlayingContainer, formatDuration } = require("../utils/components");
const { generateMusicCard } = require("../utils/musicard");
const { isActivelyPlaying } = require("../utils/playback");
const { createNoBotInVoiceEmbed } = require("../utils/permissions");
const coordinator = require("../utils/mongoCoordinator");
const config = require("../../config");

module.exports = {
    aliases: ["np", "now"],
    data: new SlashCommandBuilder()
        .setName("nowplaying")
        .setDescription("Show the currently playing track"),

    async execute(interaction, client) {
        const voiceChannelId = interaction.member.voice?.channel?.id;
        
        // Get the session owner for this voice channel
        const sessionOwner = coordinator.resolveSessionOwner(voiceChannelId, interaction.guild);

        if (voiceChannelId && !sessionOwner) {
            return interaction.reply({
                embeds: [createNoBotInVoiceEmbed()],
                flags: MessageFlags.Ephemeral,
            });
        }
        
        // Get the correct riffy instance
        const targetRiffy = sessionOwner ? coordinator.getRiffy(sessionOwner) : client.riffy;
        
        const player = targetRiffy.players.get(interaction.guild.id);
        if (!player || !isActivelyPlaying(player)) {
            const embed = new EmbedBuilder()
                .setColor(config.accentColor || 0x2b2d31)
                .setTitle("🎶 Now Playing")
                .setDescription("Nothing is playing right now.");
            return interaction.reply({
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guildData = getGuildData(interaction.guild.id);
        const musicardBuffer = await generateMusicCard(player.current, player, guildData);
        const container = createNowPlayingContainer(player.current, player, guildData, musicardBuffer);

        const files = [];
        if (musicardBuffer) {
            files.push(new AttachmentBuilder(musicardBuffer, { name: "musicard.png" }));
        }

        await interaction.editReply({
            components: [container],
            files: files,
            flags: MessageFlags.IsComponentsV2,
        });
    },
};
