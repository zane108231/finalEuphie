const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder } = require("discord.js");
const { getGuildData } = require("../utils/mongoGuildData");
const { isDuplicateTrack, ensurePlayer, getOccupiedVoiceChannel, replyAlreadyInUse } = require("../utils/playback");
const { createNoBotInVoiceEmbed } = require("../utils/permissions");
const coordinator = require("../utils/mongoCoordinator");

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
                    const container = new ContainerBuilder();
                    container.addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            "### ⚠️ Duplicate Detected\n\n" +
                            "**Track**\n" +
                            `-# ${track.info.title}\n\n` +
                            "**Status**\n" +
                            `-# Already in queue or currently playing`
                        )
                    );
                    return await interaction.editReply({
                        components: [container],
                        flags: MessageFlags.IsComponentsV2,
                    });
                }

                track.info.requester = interaction.user;

                // Insert at position 1 (right after currently playing track)
                // Save current queue
                const queueArray = [...player.queue];
                
                // Clear queue and rebuild with inserted track at position 1
                player.queue.clear();
                player.queue.add(track); // Add inserted track first (position 1)
                queueArray.forEach(t => player.queue.add(t)); // Add remaining tracks

                const container = new ContainerBuilder();
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        "### ✅ Track Inserted\n\n" +
                        "**Title**\n" +
                        `-# ${track.info.title}\n\n` +
                        "**Artist**\n" +
                        `-# ${track.info.author}\n\n` +
                        "**Status**\n-# Playing next after current track"
                    )
                );
                await interaction.editReply({
                    components: [container],
                    flags: MessageFlags.IsComponentsV2,
                });
            } else {
                return interaction.editReply({ content: `❌ No results found. (loadType: ${loadType})` });
            }
        } catch (error) {
            console.error("[euphire] Insert error:", error);
            return interaction.editReply({ content: "❌ An error occurred while searching." });
        }
    },
};
