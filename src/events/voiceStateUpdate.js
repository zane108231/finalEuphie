const { getGuildData, deleteGuildData } = require("../utils/mongoGuildData");
const { createChatPlayIdleContainer } = require("../utils/components");
const { EmbedBuilder, MessageFlags } = require("discord.js");
const { addSessionParticipant, removeSessionParticipant } = require("../utils/mongoStats");
const coordinator = require("../utils/mongoCoordinator");
const {
    getHumanVoiceMembers,
    isHumanVoiceMember,
} = require("../utils/voiceMembers");
const recentDisconnectNotices = new Set();

module.exports = {
    name: "voiceStateUpdate",
    async execute(client, oldState, newState) {
        // Track shared listening: user joins/leaves voice channel while music is playing
        const member = newState.member || oldState.member;
        if (oldState.id !== client.user.id && isHumanVoiceMember(member)) {
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
        if (
            oldState.channelId &&
            oldState.channelId !== newState.channelId &&
            isHumanVoiceMember(member)
        ) {
            const leftChannel = oldState.guild.channels.cache.get(oldState.channelId);
            if (leftChannel) {
                const sessionOwner = coordinator.resolveSessionOwner(oldState.channelId, oldState.guild);
                if (sessionOwner) {
                    const humans = getHumanVoiceMembers(
                        oldState.guild,
                        leftChannel
                    ).filter((human) => human.id !== oldState.id);
                    if (humans.length === 0) {
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
        if (newState.channelId && newState.channelId !== oldState.channelId && isHumanVoiceMember(member)) {
            const joinedChannel = newState.guild.channels.cache.get(newState.channelId);
            if (joinedChannel) {
                const sessionOwner = coordinator.resolveSessionOwner(newState.channelId, newState.guild);
                if (sessionOwner) {
                    const targetClient = coordinator.getClient(sessionOwner) || client;
                    const player = targetClient.riffy?.players?.get(newState.guild.id);
                    if (player) {
                        const guildData = getGuildData(newState.guild.id);
                        const {
                            clearPlayerIdleTimeout,
                            setPlayerIdleTimeout,
                        } = require("../utils/playback");
                        clearPlayerIdleTimeout(player, guildData);
                        if (
                            !player.playing &&
                            !player.paused &&
                            !(player.queue && player.queue.length > 0)
                        ) {
                            setPlayerIdleTimeout(
                                targetClient,
                                player,
                                guildData,
                                "idle"
                            );
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

        if (
            disconnectedBotId === client.botId &&
            oldState.channelId &&
            !newState.channelId
        ) {
            const targetClient = coordinator.getClient(disconnectedBotId) || client;
            const player = targetClient.riffy?.players?.get(oldState.guild.id);
            if (player?._waitingRoom) {
                if (player.idleTimeout) clearTimeout(player.idleTimeout);
                if (!player._intentionalDisconnect) {
                    console.warn(
                        `[euphire] Waiting-room bot ${disconnectedBotId} disconnected from guild ${oldState.guild.id}`
                    );
                }
                try {
                    const { joinClientToWaitingRoom } = require("../utils/waitingRoom");
                    const result = await joinClientToWaitingRoom(
                        targetClient,
                        oldState.guild.id
                    );
                    if (result.status === "joined" || result.status === "already") {
                        if (!coordinator.botSessions.get(disconnectedBotId)?.size) {
                            coordinator.markBotAvailable(disconnectedBotId);
                        }
                        return;
                    }
                    console.warn(
                        `[euphire] Could not restore waiting-room bot ${disconnectedBotId}: ${result.status}`
                    );
                } catch (error) {
                    console.error(
                        `[euphire] Failed to restore waiting-room bot ${disconnectedBotId}:`,
                        error
                    );
                }
                player.destroy();
                if (!coordinator.botSessions.get(disconnectedBotId)?.size) {
                    coordinator.markBotAvailable(disconnectedBotId);
                }
                return;
            }
            const wasIntentionalDisconnect =
                player?._intentionalDisconnect === true;
            if (player) {
                if (player.idleTimeout) {
                    clearTimeout(player.idleTimeout);
                    player.idleTimeout = null;
                }
                // End active statistics session with listened time
                if (player.currentSessionId) {
                    const { endSession } = require("../utils/mongoStats");
                    const listenedMs = player.position || (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);
                    try {
                        await endSession(player.currentSessionId, false, listenedMs);
                    } catch (error) {
                        console.error(
                            `[euphire] Failed to end stats session after ${disconnectedBotId} was manually disconnected:`,
                            error
                        );
                    }
                    player.currentSessionId = null;
                }
            }

            // Cleanly release bot from coordinator and mark available
            console.log(`[euphire] Manual VC disconnect detected for bot ${disconnectedBotId} from VC ${oldState.channelId}`);
            const noticeKey =
                `${disconnectedBotId}:${oldState.guild.id}:${oldState.channelId}`;
            if (
                !wasIntentionalDisconnect &&
                !recentDisconnectNotices.has(noticeKey)
            ) {
                recentDisconnectNotices.add(noticeKey);
                const noticeCleanup = setTimeout(
                    () => recentDisconnectNotices.delete(noticeKey),
                    30000
                );
                noticeCleanup.unref?.();

                const textChannelId =
                    player?.assignedTextChannel ||
                    player?.textChannel ||
                    player?.playerChannelId ||
                    coordinator.getSessionChannel(oldState.channelId);
                let textChannel = textChannelId
                    ? targetClient.channels.cache.get(textChannelId)
                    : null;
                if (!textChannel && textChannelId) {
                    try {
                        textChannel = await targetClient.channels.fetch(
                            textChannelId
                        );
                    } catch (error) {
                        console.warn(
                            `[euphire] Could not fetch disconnect notification channel ${textChannelId}:`,
                            error.message
                        );
                    }
                }

                if (textChannel?.send) {
                    try {
                        const embed = new EmbedBuilder()
                            .setColor(0xed4245)
                            .setDescription(
                                "I have been kicked from the voice channel 😟"
                            );
                        await textChannel.send({ embeds: [embed] });
                    } catch (error) {
                        console.error(
                            `[euphire] Could not send voice disconnect notification in guild ${oldState.guild.id}:`,
                            error.message
                        );
                    }
                } else {
                    console.warn(
                        `[euphire] No text channel available for voice disconnect notification in guild ${oldState.guild.id}`
                    );
                }
            }

            await coordinator.releaseBot(oldState.channelId, disconnectedBotId);
            if (player?.voiceChannel && player.voiceChannel !== oldState.channelId) {
                await coordinator.releaseBot(player.voiceChannel, disconnectedBotId);
            }
            const anotherActivePlayer = coordinator.getAllClients().some((otherClient) => {
                if (otherClient === targetClient) return false;
                const otherPlayer = otherClient.riffy?.players?.get(oldState.guild.id);
                return Boolean(otherPlayer?.voiceChannel && !otherPlayer._waitingRoom);
            });
            if (!anotherActivePlayer) {
                await resetChatPlayIfActive(targetClient, oldState.guild.id);
            }
            let returnedToWaitingRoom = false;
            if (player) {
                try {
                    returnedToWaitingRoom =
                        await require("../utils/waitingRoom")
                            .returnPlayerToWaitingRoom(targetClient, player);
                } catch (error) {
                    console.error(
                        `[euphire] Failed to return ${disconnectedBotId} to the waiting room after manual disconnect:`,
                        error
                    );
                }
            } else {
                try {
                    const { joinClientToWaitingRoom } = require("../utils/waitingRoom");
                    const result = await joinClientToWaitingRoom(
                        targetClient,
                        oldState.guild.id
                    );
                    returnedToWaitingRoom =
                        result.status === "joined" || result.status === "already";
                } catch (error) {
                    console.error(
                        `[euphire] Failed to restore ${disconnectedBotId} to the waiting room after manual disconnect:`,
                        error
                    );
                }
            }
            if (!returnedToWaitingRoom && player) {
                try {
                    player.destroy();
                } catch (error) {
                    console.warn(
                        `[euphire] Could not destroy disconnected player for ${disconnectedBotId}:`,
                        error.message
                    );
                }
            }
            if (!coordinator.botSessions.get(disconnectedBotId)?.size) {
                coordinator.markBotAvailable(disconnectedBotId);
            }
            return;
        }

        // Handle bot being moved between voice channels
        if (
            disconnectedBotId === client.botId &&
            oldState.channelId &&
            newState.channelId &&
            oldState.channelId !== newState.channelId
        ) {
            console.log(`[euphire] Bot ${disconnectedBotId} moved from VC ${oldState.channelId} to ${newState.channelId}`);
            const targetClient = coordinator.getClient(disconnectedBotId) || client;
            const player = targetClient.riffy?.players?.get(oldState.guild.id);
            const movedFromStandby =
                player?._waitingRoom || player?._movingFromWaitingRoom;
            if (!movedFromStandby) {
                await coordinator.releaseBot(oldState.channelId, disconnectedBotId);
            }
            if (
                player?._waitingRoom &&
                require("../utils/waitingRoom").isWaitingRoomChannel(
                    oldState.guild.id,
                    newState.channelId
                )
            ) {
                coordinator.markBotAvailable(disconnectedBotId);
                return;
            }
            const targetOwner = coordinator.resolveSessionOwner(
                newState.channelId,
                oldState.guild
            );
            if (targetOwner && targetOwner !== disconnectedBotId) {
                console.warn(
                    `[euphire] Bot ${disconnectedBotId} moved into VC ${newState.channelId}, already owned by ${targetOwner}`
                );
                return;
            }
            const reserved = await coordinator.reserveSpecificBot(
                newState.channelId,
                null,
                disconnectedBotId,
                oldState.guild.id,
                true
            );
            if (!reserved) return;
            await coordinator.markBotActive(disconnectedBotId, newState.channelId);
            if (player) {
                player.voiceChannel = newState.channelId;
                player._waitingRoom = false;
                delete player._movingFromWaitingRoom;
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
    // Keep regular /play announcements in channel history.
    else if (guildData.playerMessageId && guildData.playerChannelId) {
        guildData.playerMessageId = null;
        guildData.playerChannelId = null;
    }
}
