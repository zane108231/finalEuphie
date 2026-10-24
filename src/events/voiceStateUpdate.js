const { getGuildData, saveGuildData, deleteGuildData } = require("../utils/mongoGuildData");
const { createChatPlayIdleContainer } = require("../utils/components");
const { MessageFlags } = require("discord.js");
const { addSessionParticipant, removeSessionParticipant } = require("../utils/mongoStats");
const coordinator = require("../utils/mongoCoordinator");

module.exports = {
    name: "voiceStateUpdate",
    async execute(client, oldState, newState) {
        // Track shared listening: user joins/leaves voice channel while music is playing
        const member = newState.member || oldState.member;
        if (oldState.id !== client.user.id && !member?.user?.bot) {
            let player = client.riffy?.players?.get(oldState.guild.id);
            if (!player) {
                for (const c of coordinator.getAllClients()) {
                    const p = c.riffy?.players?.get(oldState.guild.id);
                    if (p) {
                        player = p;
                        break;
                    }
                }
            }

            if (player && player.playing && !player.paused) {
                const sessionId = player.currentSessionId;
                if (player.voiceChannel) {
                    const joinedVC = newState.channelId === player.voiceChannel && oldState.channelId !== player.voiceChannel;
                    const leftVC = oldState.channelId === player.voiceChannel && newState.channelId !== player.voiceChannel;

                    if (joinedVC) {
                        if (sessionId) {
                            addSessionParticipant(sessionId, newState.id).catch(() => {});
                        }
                        // Update Last.fm now playing immediately for user who joined
                        const { getUserData } = require("../utils/mongoUserData");
                        const { updateNowPlaying } = require("../utils/lastfm");
                        getUserData(newState.id).then(async (userData) => {
                            if (userData?.lastfmSessionKey && player.current?.info) {
                                const trackInfo = player.current.info;
                                let artist = trackInfo.author || "Unknown";
                                let trackName = trackInfo.title || "Unknown";
                                if ((artist === "Unknown" || artist.includes("- Topic")) && trackName.includes(" - ")) {
                                    const parts = trackName.split(" - ");
                                    if (parts.length >= 2) {
                                        artist = parts[0].trim();
                                        trackName = parts.slice(1).join(" - ").trim();
                                    }
                                }
                                await updateNowPlaying(
                                    userData.lastfmSessionKey,
                                    artist,
                                    trackName,
                                    trackInfo.album || null,
                                    trackInfo.length || 0
                                );
                            }
                        }).catch(() => {});
                    } else if (leftVC && sessionId) {
                        removeSessionParticipant(sessionId, oldState.id).catch(() => {});
                    }
                }
            }
        }

        // Check if all non-bot humans left a voice channel containing a bot
        if (oldState.channelId && oldState.channelId !== newState.channelId) {
            const leftChannel = oldState.guild.channels.cache.get(oldState.channelId);
            if (leftChannel) {
                const sessionOwner = coordinator.resolveSessionOwner(oldState.channelId, oldState.guild);
                if (sessionOwner) {
                    const humans = leftChannel.members.filter((m) => !m.user?.bot);
                    if (humans.size === 0) {
                        const targetClient = coordinator.getClient(sessionOwner) || client;
                        const player = targetClient.riffy?.players?.get(oldState.guild.id);
                        if (player) {
                            const guildData = getGuildData(oldState.guild.id);
                            const { setPlayerIdleTimeout } = require("../utils/playback");
                            setPlayerIdleTimeout(targetClient, player, guildData, "empty");
                        }
                    }
                }
            }
        }

        // Check if a human rejoined a voice channel with a bot (cancel empty timeout)
        if (newState.channelId && newState.channelId !== oldState.channelId && !member?.user?.bot) {
            const joinedChannel = newState.guild.channels.cache.get(newState.channelId);
            if (joinedChannel) {
                const sessionOwner = coordinator.resolveSessionOwner(newState.channelId, newState.guild);
                if (sessionOwner) {
                    const targetClient = coordinator.getClient(sessionOwner) || client;
                    const player = targetClient.riffy?.players?.get(newState.guild.id);
                    if (player && (player.playing || (player.queue && player.queue.length > 0))) {
                        const guildData = getGuildData(newState.guild.id);
                        const { clearPlayerIdleTimeout } = require("../utils/playback");
                        clearPlayerIdleTimeout(player, guildData);
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
