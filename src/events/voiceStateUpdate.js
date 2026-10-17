const { getGuildData, saveGuildData, deleteGuildData } = require("../utils/mongoGuildData");
const { createChatPlayIdleContainer } = require("../utils/components");
const { MessageFlags } = require("discord.js");
const { addSessionParticipant, removeSessionParticipant } = require("../utils/mongoStats");
const coordinator = require("../utils/mongoCoordinator");

module.exports = {
    name: "voiceStateUpdate",
    async execute(client, oldState, newState) {
        // Track shared listening: user joins/leaves voice channel while music is playing
        if (oldState.id !== client.user.id && !oldState.member?.user?.bot) {
            const player = client.riffy.players.get(oldState.guild.id);
            if (player && player.playing && !player.paused) {
                const sessionId = player.currentSessionId;
                if (sessionId) {
                    // User joined the voice channel
                    if (!oldState.channelId && newState.channelId && newState.channelId === player.voiceChannel) {
                        addSessionParticipant(sessionId, oldState.id);
                    }
                    // User left the voice channel
                    else if (oldState.channelId && !newState.channelId && oldState.channelId === player.voiceChannel) {
                        removeSessionParticipant(sessionId, oldState.id);
                    }
                    // User moved to a different channel
                    else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
                        if (oldState.channelId === player.voiceChannel) {
                            removeSessionParticipant(sessionId, oldState.id);
                        } else if (newState.channelId === player.voiceChannel) {
                            addSessionParticipant(sessionId, oldState.id);
                        }
                    }
                }
            }
        }

        // Check if ANY bot client was disconnected from a voice channel
        let disconnectedBotId = null;
        for (const [id, c] of coordinator.clients) {
            if (c.user && c.user.id === oldState.id) {
                disconnectedBotId = id;
                break;
            }
        }
        if (!disconnectedBotId && oldState.id === client.user.id) {
            disconnectedBotId = client.botId;
        }

        if (disconnectedBotId && oldState.channelId && !newState.channelId) {
            const targetClient = coordinator.getClient(disconnectedBotId) || client;
            const guildData = getGuildData(oldState.guild.id);
            if (guildData.recreatingPlayer) return;

            // Clear idle timeout if it exists
            if (guildData.idleTimeout) {
                clearTimeout(guildData.idleTimeout);
                guildData.idleTimeout = null;
                console.log(`[euphire] Cleared idle timeout for bot ${disconnectedBotId} (manual disconnect)`);
            }

            const player = targetClient.riffy?.players?.get(oldState.guild.id);
            if (player) {
                if (player.idleTimeout) {
                    clearTimeout(player.idleTimeout);
                    player.idleTimeout = null;
                }
                // End active statistics session with listened time
                if (player.currentSessionId) {
                    const { endSession } = require("../utils/mongoStats");
                    const listenedMs = player.position || (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);
                    await endSession(player.currentSessionId, false, listenedMs).catch(() => {});
                    player.currentSessionId = null;
                }
            }

            // Cleanly release bot from coordinator and mark available
            console.log(`[euphire] Manual VC disconnect detected for bot ${disconnectedBotId} from VC ${oldState.channelId}`);
            await coordinator.releaseBot(oldState.channelId);
            if (player?.voiceChannel && player.voiceChannel !== oldState.channelId) {
                await coordinator.releaseBot(player.voiceChannel);
            }
            if (coordinator.botSessions.has(disconnectedBotId)) {
                for (const vcId of [...coordinator.botSessions.get(disconnectedBotId)]) {
                    await coordinator.releaseBot(vcId);
                }
            }
            coordinator.markBotAvailable(disconnectedBotId);

            guildData.djOwnerId = null;
            await saveGuildData(oldState.guild.id, guildData);

            await resetChatPlayIfActive(targetClient, oldState.guild.id);
            if (player) {
                try {
                    player.destroy();
                } catch {
                    // NodeLink often errors destroying an already-dead player
                }
            }
            return;
        }

        // Handle bot being moved between voice channels
        if (disconnectedBotId && oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            console.log(`[euphire] Bot ${disconnectedBotId} moved from VC ${oldState.channelId} to ${newState.channelId}`);
            await coordinator.releaseBot(oldState.channelId);
            await coordinator.reserveSpecificBot(newState.channelId, null, disconnectedBotId, oldState.guild.id, true);
            await coordinator.markBotActive(disconnectedBotId, newState.channelId);
            const targetClient = coordinator.getClient(disconnectedBotId) || client;
            const player = targetClient.riffy?.players?.get(oldState.guild.id);
            if (player) {
                player.voiceChannel = newState.channelId;
            }
        }
    },
};

async function resetChatPlayIfActive(client, guildId) {
    const guildData = getGuildData(guildId);
    // Reset ChatPlay to idle
    if (guildData.chatPlayChannelId && guildData.chatPlayMessageId) {
        try {
            const channel = client.channels.cache.get(guildData.chatPlayChannelId);
            if (channel) {
                const msg = await channel.messages.fetch(guildData.chatPlayMessageId);
                await msg.edit({
                    components: [createChatPlayIdleContainer()],
                    attachments: [],
                    flags: MessageFlags.IsComponentsV2,
                });
            }
        } catch (err) {
            // message may have been deleted
        }
    }
    // Delete regular /play player message
    else if (guildData.playerMessageId && guildData.playerChannelId) {
        try {
            const channel = client.channels.cache.get(guildData.playerChannelId);
            if (channel) {
                const msg = await channel.messages.fetch(guildData.playerMessageId);
                await msg.delete();
            }
        } catch (err) {
            // message already deleted
        }
    }
}
