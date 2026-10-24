const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require("discord.js");
const { startIfIdle, setAnnounceChannel } = require("../utils/playback");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const {
    canUseMusicAction,
    isDj,
    isServerAdmin,
    canControlMusic,
    createNoBotInVoiceEmbed,
    VOICE_CHANNEL_DENIAL,
} = require("../utils/permissions");
const { endSession } = require("../utils/mongoStats");
const coordinator = require("../utils/mongoCoordinator");

async function executeSkipTrack(interaction, player, isVoteSkip = false) {
    const currentTrack = player.current;
    const guildData = getGuildData(interaction.guild.id);
    setAnnounceChannel(player, guildData, interaction.channel.id);

    // End statistics session (skipped manually)
    try {
        const sessionId = player.currentSessionId || guildData.currentSessionId;
        if (sessionId) {
            console.log("[euphire] skip: ending session (manual skip)");
            const listenedMs = player.position || (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);
            await endSession(sessionId, false, listenedMs);
            player.currentSessionId = null;
            guildData.currentSessionId = null;
            await saveGuildData(interaction.guild.id, guildData);
        }
    } catch (err) {
        console.error("[euphire] Failed to end stats session on skip:", err.message);
    }

    if (player.playing || player.paused) {
        player.stop();
    } else if (player.queue?.length) {
        await startIfIdle(player);
    } else {
        return interaction.reply({
            content: "❌ Nothing is playing and the queue is empty.",
            flags: MessageFlags.Ephemeral,
        });
    }

    let description = "The current track has been skipped";
    if (isVoteSkip && currentTrack?.info) {
        const title = currentTrack.info.title || "Unknown Track";
        const author = currentTrack.info.author || "Unknown Artist";
        const uri = currentTrack.info.uri;
        const link = uri ? `[${title} by ${author}](${uri})` : `**${title} by ${author}**`;
        description = `${link} has been vote-skipped`;
    }

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setDescription(description);

    return interaction.reply({ embeds: [embed] });
}

module.exports = {
    aliases: ["s", "next"],
    data: new SlashCommandBuilder()
        .setName("skip")
        .setDescription("Skip the current track"),

    async execute(interaction, client) {
        const voiceChannelId = interaction.member?.voice?.channel?.id;

        // Check if user is in a voice channel
        if (!voiceChannelId) {
            return interaction.reply({
                content: "❌ You need to be in a voice channel to use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }

        // Get the session owner for this voice channel
        const sessionOwner = coordinator.resolveSessionOwner(voiceChannelId, interaction.guild);

        // If no session exists, show error
        if (!sessionOwner) {
            return interaction.reply({
                embeds: [createNoBotInVoiceEmbed()],
                flags: MessageFlags.Ephemeral,
            });
        }

        // Get the correct client and riffy instance
        const targetClient = coordinator.getClient(sessionOwner) || client;
        const targetRiffy = coordinator.getRiffy(sessionOwner) || targetClient.riffy;

        if (!targetClient || !targetRiffy) {
            return interaction.reply({
                embeds: [createNoBotInVoiceEmbed()],
                flags: MessageFlags.Ephemeral,
            });
        }

        const player = targetRiffy.players.get(interaction.guild.id);
        if (!player) {
            return interaction.reply({
                embeds: [createNoBotInVoiceEmbed()],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!canControlMusic(interaction.member, player)) {
            return interaction.reply({
                content: VOICE_CHANNEL_DENIAL,
                flags: MessageFlags.Ephemeral,
            });
        }

        const guildData = await getGuildData(interaction.guild.id);

        // Filter out bots to count only real humans in the voice channel
        const vc = interaction.member.voice?.channel;
        const humans = vc?.members ? vc.members.filter((m) => !m.user?.bot) : null;
        const totalHumans = humans ? humans.size : 1;
        const isAlone = totalHumans <= 1;

        const canSkipImmediate =
            !interaction.forceVoteSkip &&
            (isServerAdmin(interaction.member) ||
                isDj(interaction.member, player, guildData) ||
                isAlone ||
                (await canUseMusicAction(interaction.member, player, "skip")));

        if (canSkipImmediate) {
            player.skipVotes = new Set();
            return executeSkipTrack(interaction, player, false);
        }

        // User does NOT have permission to skip immediately -> Vote Skipping triggers!
        // Example: 4 people in VC including DJ -> 3 votes required; 2 people -> 2 votes required
        const requiredVotes = interaction.forceVoteSkip && totalHumans <= 1
            ? 1
            : totalHumans <= 2
              ? 2
              : Math.max(2, totalHumans - 1);

        if (!player.skipVotes) {
            player.skipVotes = new Set();
        }

        if (player.skipVotes.has(interaction.user.id)) {
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setDescription(`Skipping, **${player.skipVotes.size}/${requiredVotes}** (**${requiredVotes}** votes required)`);
            return interaction.reply({ embeds: [embed] });
        }

        player.skipVotes.add(interaction.user.id);

        if (player.skipVotes.size >= requiredVotes) {
            player.skipVotes.clear();
            return executeSkipTrack(interaction, player, true);
        }

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setDescription(`Skipping, **${player.skipVotes.size}/${requiredVotes}** (**${requiredVotes}** votes required)`);

        return interaction.reply({ embeds: [embed] });
    },
};
