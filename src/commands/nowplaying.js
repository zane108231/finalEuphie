const { SlashCommandBuilder, MessageFlags, AttachmentBuilder, EmbedBuilder } = require("discord.js");
const { getGuildData } = require("../utils/mongoGuildData");
const { formatDuration, getSpotifyEmoji } = require("../utils/components");
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
                .setTitle("Now Playing ♪")
                .setDescription("Nothing is playing right now.");
            return interaction.reply({
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }

        const track = player.current;
        const trackTitle = track?.info?.title || "Unknown";
        const trackArtist = track?.info?.author || "Unknown Artist";
        const trackLength = track?.info?.length || 0;
        const currentPosition = player.position || 0;
        const requester = track?.info?.requester;
        const trackUri = track?.info?.uri || null;
        
        // Get Spotify emoji for this bot
        const spotifyEmoji = getSpotifyEmoji(client, player);
        
        // Format time
        const currentTime = formatDuration(currentPosition);
        const totalTime = formatDuration(trackLength);
        
        // Calculate progress bar
        const progress = currentPosition / trackLength;
        const progressBarLength = 20;
        const filled = Math.round(progress * progressBarLength);
        const empty = progressBarLength - filled;
        const progressBar = "▬".repeat(filled) + "▭".repeat(empty);
        
        // Get position in queue
        const queue = player.queue || [];
        const positionInQueue = queue.length + 1;
        
        // Get album art
        const artwork = track?.info?.artworkUrl || track?.info?.thumbnail || null;
        
        // Create embed matching the image design with Spotify emoji and clickable track link
        const description = trackUri 
            ? `**Playing**\n[${trackTitle} by ${trackArtist}](${trackUri})`
            : `**Playing**\n${trackTitle} by ${trackArtist}`;
        
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setTitle(`${spotifyEmoji} Now Playing ♪`)
            .setDescription(description)
            .addFields(
                { name: "Time", value: `${currentTime} / ${totalTime}`, inline: true },
                { name: "Position in Queue", value: positionInQueue.toString(), inline: true },
                { name: "Progress", value: `${progressBar} ${Math.round(progress * 100)}%`, inline: false }
            )
            .setTimestamp()
            .setFooter({ text: `Requested by ${requester?.username || "Unknown"}` });

        if (artwork) {
            embed.setThumbnail(artwork);
        }

        await interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral,
        });
    },
};
