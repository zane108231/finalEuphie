const coordinator = require("./mongoCoordinator");

async function broadcastToActiveSessions(payload) {
    const destinations = new Map();
    let activeSessionCount = 0;

    for (const client of coordinator.getAllClients()) {
        for (const player of client.riffy?.players?.values?.() || []) {
            const voiceChannelId = player.voiceChannel;
            const hasActivePlayback =
                player.playing || player.paused || player.queue?.length > 0;
            if (!voiceChannelId || !hasActivePlayback) continue;

            const sessionOwner = coordinator.getSessionOwner(voiceChannelId);
            if (sessionOwner && sessionOwner !== client.botId) continue;
            activeSessionCount++;

            const channelId =
                player.assignedTextChannel ||
                player.textChannel ||
                coordinator.getSessionChannel(voiceChannelId);
            if (!channelId) {
                console.warn(
                    `[euphire] Active session ${voiceChannelId} (${client.botId}) has no announcement text channel`
                );
                continue;
            }

            const key = `${client.botId}:${channelId}`;
            if (!destinations.has(key)) {
                destinations.set(key, { client, channelId });
            }
        }
    }

    const failures = [];
    for (const { client, channelId } of destinations.values()) {
        try {
            const channel =
                client.channels.cache.get(channelId) ||
                (await client.channels.fetch(channelId));
            if (!channel || typeof channel.send !== "function") {
                throw new Error("Channel is unavailable or cannot receive messages.");
            }
            await channel.send({
                ...payload,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            failures.push(channelId);
            console.error(
                `[euphire] Could not broadcast to active session channel ${channelId} via ${client.botId}:`,
                error.message
            );
        }
    }

    return {
        activeSessionCount,
        targetCount: destinations.size,
        deliveredCount: destinations.size - failures.length,
        failedCount: failures.length,
    };
}

module.exports = { broadcastToActiveSessions };
