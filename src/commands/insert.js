const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require("discord.js");
const { isDuplicateTrack, getOccupiedVoiceChannel, replyAlreadyInUse } = require("../utils/playback");
const { createNoBotInVoiceEmbed } = require("../utils/permissions");
const coordinator = require("../utils/mongoCoordinator");

const SPOTIFY_ICON_URL = "https://cdn.discordapp.com/emojis/1561285569068273674.png";

function formatDurationLeadingZero(ms) {
    if (!ms || isNaN(ms)) return "00:00";
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

async function sendPublicEmbed(interaction, embed) {
    try {
        await interaction.channel.send({ embeds: [embed] });
        await interaction.deleteReply().catch(() => {});
    } catch (err) {
        await interaction.editReply({ embeds: [embed] });
    }
}

module.exports = {
    aliases: ["ins"],
    data: new SlashCommandBuilder()
        .setName("insert")
        .setDescription("Insert a track right after the one that is currently playing")
        .addStringOption((opt) =>
            opt.setName("query").setDescription("Song name or URL").setRequired(true)
        ),

    async execute(interaction, client) {
        const query = interaction.options.getString("query");
        if (!query) {
            return interaction.reply({
                content: "❌ Usage: `e!insert <song name or URL>`",
                flags: MessageFlags.Ephemeral,
            });
        }
        if (/(?:youtube\.com|youtu\.be)/i.test(query)) {
            return interaction.reply({
                content: "❌ YouTube links are currently not supported.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const member = interaction.member;
        if (!member.voice?.channel) {
            return interaction.reply({
                content: "❌ You need to be in a voice channel!",
                flags: MessageFlags.Ephemeral,
            });
        }

        const voiceChannelId = member.voice.channel.id;
        
        // Get the session owner for this voice channel
        const sessionOwner = coordinator.resolveSessionOwner(voiceChannelId, interaction.guild);
        if (!sessionOwner) {
            return interaction.reply({
                embeds: [createNoBotInVoiceEmbed()],
                flags: MessageFlags.Ephemeral,
            });
        }
        
        // Get the correct riffy instance
        const targetRiffy = sessionOwner ? coordinator.getRiffy(sessionOwner) : client.riffy;
        
        const player = targetRiffy.players.get(interaction.guild.id);
        if (!player || !player.current) {
            return interaction.reply({
                content: "❌ Nothing is playing right now.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const occupied = getOccupiedVoiceChannel(interaction.guild, client);
        if (occupied && occupied.id !== member.voice.channel.id) {
            return replyAlreadyInUse(interaction, occupied);
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const result = await client.riffy.resolve({
                query: query.trim(),
                source: "spsearch",
                requester: interaction.user,
            });

            const { loadType, tracks } = result;

            if (
                loadType === "search" ||
                loadType === "track" ||
                loadType === "SEARCH_RESULT" ||
                loadType === "TRACK_LOADED"
            ) {
                const track = tracks[0];
                if (!track) {
                    return interaction.editReply({ content: "❌ No results found." });
                }

                // Check if track is already in queue or currently playing
                if (isDuplicateTrack(player, track)) {
                    const dupEmbed = new EmbedBuilder()
                        .setColor(0xED4245)
                        .setDescription(`⚠️ **Duplicate Detected**: [${track.info.title} by ${track.info.author}](${track.info.uri || "https://open.spotify.com"}) is already in queue or playing.`);
                    return await interaction.editReply({
                        embeds: [dupEmbed],
                    });
                }

                track.info.requester = interaction.user;

                // Insert at position 1 (right after currently playing track)
                const queueArray = [...player.queue];
                player.queue.clear();
                player.queue.add(track); // Add inserted track first (next in queue)
                queueArray.forEach(t => player.queue.add(t)); // Add remaining tracks

                // Compute time remaining on current track
                const etaMs = Math.max(0, (player.current.info?.length || 0) - (player.position || 0));
                const eta = formatDurationLeadingZero(etaMs);
                const trackLength = formatDurationLeadingZero(track.info.length || 0);
                const trackUri = track.info.uri || "https://open.spotify.com";
                const trackValue = `[${track.info.title} by ${track.info.author}](${trackUri})`;
                const thumbnail = track.info.thumbnail || track.info.artworkUrl || null;

                // Build Added Track Embed strictly matching Image #1
                const embed = new EmbedBuilder()
                    .setColor(0x2b2d31)
                    .setAuthor({
                        name: "Added Track",
                        iconURL: SPOTIFY_ICON_URL,
                    })
                    .addFields(
                        { name: "Track", value: trackValue, inline: false },
                        { name: "Estimated time until played", value: eta, inline: true },
                        { name: "Track Length", value: trackLength, inline: true },
                        { name: "\u200b", value: "\u200b", inline: true },
                        { name: "Position in upcoming", value: "Next", inline: true },
                        { name: "Position in queue", value: "2", inline: true },
                        { name: "\u200b", value: "\u200b", inline: true }
                    )
                    .setFooter({
                        text: `Requested by ${interaction.user.tag || interaction.user.username}`,
                        iconURL: interaction.user.displayAvatarURL(),
                    });

                if (thumbnail) {
                    embed.setThumbnail(thumbnail);
                }

                await sendPublicEmbed(interaction, embed);
            } else {
                return interaction.editReply({ content: `❌ No results found. (loadType: ${loadType})` });
            }
        } catch (error) {
            console.error("[euphire] Insert error:", error);
            return interaction.editReply({ content: "❌ An error occurred while searching." });
        }
    },
};
