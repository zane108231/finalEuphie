const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const coordinator = require("../utils/mongoCoordinator");
const { checkpointAllClients } = require("../utils/playbackRecovery");
const { getDB } = require("../utils/database");
const { scheduleUpdateRestart } = require("../utils/updateManager");

module.exports = {
    hidden: true,
    data: new SlashCommandBuilder()
        .setName("update")
        .setDescription("Announce maintenance and restart the bot"),

    async execute(interaction) {
        const developerId = process.env.DEVELOPER_DISCORD_ID;
        if (!developerId || interaction.user.id !== developerId) {
            return interaction.reply({
                content: "This command is restricted to the bot developer.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const state = getDB().collection("systemState");
        const current = await state.findOne({ key: "maintenance" });
        if (current?.status === "scheduled") {
            return interaction.editReply({
                content: "An update restart is already scheduled.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const clients = coordinator.getAllClients();
        const textChannels = new Map();

        for (const client of clients) {
            for (const player of client.riffy?.players?.values?.() || []) {
                const voiceChannelId = player.voiceChannel;
                const channelId =
                    player.assignedTextChannel ||
                    player.textChannel ||
                    (voiceChannelId && coordinator.getSessionChannel(voiceChannelId));
                if (!voiceChannelId || !channelId) continue;

                const saved = await coordinator.setSessionChannel(voiceChannelId, channelId);
                if (!saved) {
                    throw new Error(`Could not save the announcement channel for active session ${voiceChannelId}.`);
                }
            }
        }

        const db = getDB();
        const sessions = await db
            .collection("sessions")
            .find({})
            .project({ _id: 0, guildId: 1, channelId: 1, botId: 1 })
            .toArray();

        for (const session of sessions) {
            if (session.channelId) {
                textChannels.set(String(session.channelId), session.botId || null);
            }
        }

        const activeGuildIds = new Set(
            sessions.map((session) => session.guildId).filter(Boolean).map(String)
        );
        const playbackSnapshots = await db
            .collection("playbackSessions")
            .find({ textChannelId: { $type: "string", $ne: "" } })
            .project({ _id: 0, guildId: 1, textChannelId: 1, botId: 1 })
            .toArray();

        for (const snapshot of playbackSnapshots) {
            if (!snapshot.textChannelId) continue;
            textChannels.set(String(snapshot.textChannelId), snapshot.botId || null);
            if (snapshot.guildId) activeGuildIds.add(String(snapshot.guildId));
        }

        if (activeGuildIds.size) {
            const guildData = await db
                .collection("guildData")
                .find({ guildId: { $in: [...activeGuildIds] } })
                .project({ _id: 0, guildId: 1, playerChannelId: 1, chatPlayChannelId: 1 })
                .toArray();

            const botByGuild = new Map();
            for (const session of sessions) {
                if (session.guildId && session.botId) {
                    botByGuild.set(String(session.guildId), session.botId);
                }
            }
            for (const snapshot of playbackSnapshots) {
                if (snapshot.guildId && snapshot.botId) {
                    botByGuild.set(String(snapshot.guildId), snapshot.botId);
                }
            }
            for (const guild of guildData) {
                for (const channelId of [guild.playerChannelId, guild.chatPlayChannelId]) {
                    if (channelId) {
                        textChannels.set(
                            String(channelId),
                            botByGuild.get(String(guild.guildId)) || null
                        );
                    }
                }
            }
        }
        const invocationChannelId = interaction.channel?.id;
        if (invocationChannelId) {
            textChannels.set(String(invocationChannelId), null);
        }

        await checkpointAllClients(clients);

        const embed = new EmbedBuilder()
            .setColor(0xfacc15)
            .setTitle("Update")
            .setDescription(
                "We will be performing an update in a couple of minutes, Euphie Music will temporarily go offline. Once we are done with the update and the bot is back online, the session owner can use the `resume session` command to resume where it left off. ETA 10-15 minutes (this estimate is for a full restart, one or more of the bots may be available a lot earlier)\n\n" +
                    "⭐ Saved sessions will automatically be resumed!\n\n" +
                    "Sorry for any inconvenience caused and thank you for your patience"
            );

        const failures = [];
        for (const [channelId, botId] of textChannels) {
            if (channelId === String(invocationChannelId)) continue;

            const preferredClient = botId ? coordinator.getClient(botId) : null;
            const channelClients = [
                ...(preferredClient ? [preferredClient] : []),
                ...clients.filter((client) => client !== preferredClient),
            ];
            let channel = null;
            let lookupError = null;

            for (const client of channelClients) {
                try {
                    channel =
                        client.channels.cache.get(channelId) ||
                        await client.channels.fetch(channelId);
                    if (channel) break;
                } catch (error) {
                    lookupError = error;
                }
            }

            if (!channel || typeof channel.send !== "function") {
                const error = lookupError || new Error("Channel is unavailable or cannot receive messages.");
                failures.push(channelId);
                console.error(`[euphire] Could not resolve update announcement channel ${channelId}:`, error.message);
                continue;
            }

            try {
                await channel.send({ embeds: [embed] });
            } catch (error) {
                failures.push(channelId);
                console.error(`[euphire] Could not send update announcement to channel ${channelId}:`, error.message);
            }
        }

        const restartAt = Date.now() + 2 * 60 * 1000;
        await scheduleUpdateRestart(restartAt);

        console.log(
            `[euphire] Update notice sent to ${textChannels.size - failures.length} channel(s); ` +
            `${failures.length} delivery failure(s).`
        );
        return interaction.editReply({ embeds: [embed] });
    },
};
