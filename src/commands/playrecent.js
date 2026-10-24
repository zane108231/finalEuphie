const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { getDB } = require("../utils/database");
const { getGuildData } = require("../utils/mongoGuildData");
const {
    ensurePlayer,
    isDuplicateTrack,
    startIfIdle,
} = require("../utils/playback");
const coordinator = require("../utils/mongoCoordinator");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("playrecent")
        .setDescription("Queue your recently played tracks"),

    async execute(interaction, client) {
        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) {
            return interaction.reply({
                content: "You need to be in a voice channel to use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const recent = await getDB()
            .collection("recentTracks")
            .findOne({ userId: interaction.user.id });
        const tracks = Array.isArray(recent?.tracks) ? recent.tracks : [];
        if (!tracks.length) {
            return interaction.reply({
                content: "You don't have any recently played tracks saved yet.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const guildId = interaction.guild.id;
        let botId = coordinator.resolveSessionOwner(voiceChannel.id, interaction.guild);
        let assignedClient = botId ? coordinator.getClient(botId) : client;
        let newlyReserved = false;
        let player = null;

        if (!botId) {
            if (!coordinator.isBotAvailable(client.botId, guildId)) {
                return interaction.reply({
                    content: "There is no available music bot in this server.",
                    flags: MessageFlags.Ephemeral,
                });
            }
            const reserved = await coordinator.reserveSpecificBot(
                voiceChannel.id,
                interaction.user.id,
                client.botId,
                guildId
            );
            if (!reserved) {
                return interaction.reply({
                    content: "A bot could not be allocated to your voice channel. Try again.",
                    flags: MessageFlags.Ephemeral,
                });
            }
            botId = client.botId;
            newlyReserved = true;
        }

        assignedClient = coordinator.getClient(botId) || assignedClient;
        const existingPlayer = assignedClient.riffy?.players?.get(guildId) || null;
        const releaseNewReservation = async () => {
            if (!newlyReserved) return;
            if (!existingPlayer && player) {
                try {
                    player.destroy();
                } catch (err) {
                    console.error("[euphire] Failed to destroy unused playrecent player:", err);
                }
            }
            await coordinator.releaseBot(voiceChannel.id);
        };
        const guildData = getGuildData(guildId);
        try {
            player = await ensurePlayer(assignedClient, {
                guildId,
                voiceChannelId: voiceChannel.id,
                textChannelId: interaction.channel.id,
                volume: guildData.volume,
                requesterId: interaction.user.id,
            });

            let queued = 0;
            for (const item of [...tracks].reverse()) {
                try {
                    const result = await assignedClient.riffy.resolve({
                        query: item.uri,
                        requester: interaction.user,
                    });
                    const track = result?.tracks?.[0];
                    if (!track || isDuplicateTrack(player, track)) continue;
                    track.info.requester = interaction.user;
                    player.queue.add(track);
                    queued += 1;
                } catch (err) {
                    console.error(
                        `[euphire] Failed to resolve recent track for ${interaction.user.id}:`,
                        err.message
                    );
                }
            }

            if (!queued) {
                await releaseNewReservation();
                return interaction.reply({
                    content: "None of your recently played tracks could be queued.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            await startIfIdle(player);
            return interaction.reply({
                content: `Queued ${queued} recently played track${queued === 1 ? "" : "s"}.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            await releaseNewReservation();
            console.error("[euphire] playrecent failed:", err);
            return interaction.reply({
                content: "Could not queue your recently played tracks.",
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
