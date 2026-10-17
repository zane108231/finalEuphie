const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder } = require("discord.js");
const { startIfIdle, setAnnounceChannel } = require("../utils/playback");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const { requireMusicAction, getMusicDenial, createNoBotInVoiceEmbed } = require("../utils/permissions");
const { endSession } = require("../utils/mongoStats");
const coordinator = require("../utils/mongoCoordinator");

module.exports = {
    aliases: ["s", "next"],
    data: new SlashCommandBuilder()
        .setName("skip")
        .setDescription("Skip the current track"),

    async execute(interaction, client) {
        const voiceChannelId = interaction.member.voice?.channel?.id;

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
        const targetClient = coordinator.getClient(sessionOwner);
        const targetRiffy = coordinator.getRiffy(sessionOwner);

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

        const denial = await getMusicDenial(interaction.member, player, "skip");
        if (denial) {
            return interaction.reply({ content: denial, flags: MessageFlags.Ephemeral });
        }

        const skippedTitle = player.current?.info?.title || "Unknown";
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
        } else if (player.queue.length) {
            await startIfIdle(player);
        } else {
            return interaction.reply({
                content: "❌ Nothing is playing and the queue is empty.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const container = new ContainerBuilder();
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "### ⏭ Skipped\n\n" +
                "**Track**\n" +
                `-# ${skippedTitle}`
            )
        );
        await interaction.reply({
            components: [container],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });
    },
};
