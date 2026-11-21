const { endSession } = require("./mongoStats");
const { removeSavedSession } = require("./playbackRecovery");
const { markIntentionalDisconnect } = require("./playback");
const { returnPlayerToWaitingRoom } = require("./waitingRoom");

function initiatePlayerStop(player) {
    const sessionId = player.currentSessionId;
    const listenedMs = player.position ||
        (player.sessionStartedAt ? Date.now() - player.sessionStartedAt : 0);

    player.currentSessionId = null;
    player.leaveAfterQueueEnd = false;
    player._returningToWaitingRoom = true;
    player.queue?.clear?.();
    if (player.idleTimeout) {
        clearTimeout(player.idleTimeout);
        player.idleTimeout = null;
    }

    try {
        player.stop?.();
    } catch (error) {
        console.error(
            `[euphire] Could not stop playback immediately for ${player.guildId}:`,
            error
        );
    }

    return { sessionId, listenedMs };
}

async function finishPlayerStop(client, player, guildId, action, session) {
    if (session.sessionId) {
        try {
            await endSession(
                session.sessionId,
                false,
                session.listenedMs
            );
        } catch (error) {
            console.error(
                `[euphire] Failed to end stats session on ${action}:`,
                error.message
            );
        }
    }

    await removeSavedSession(guildId, client.botId).catch((error) => {
        console.error(
            `[euphire] Failed to remove saved playback after ${action}:`,
            error.message
        );
    });

    let returnedToWaitingRoom = false;
    try {
        returnedToWaitingRoom = await returnPlayerToWaitingRoom(
            client,
            player
        );
    } catch (error) {
        console.error(
            `[euphire] Failed to return ${client.botId} to the waiting room after ${action}:`,
            error
        );
    }

    if (!returnedToWaitingRoom) {
        delete player._returningToWaitingRoom;
        markIntentionalDisconnect(player);
        try {
            player.destroy?.();
        } catch (error) {
            console.error(
                `[euphire] Could not disconnect ${client.botId} after ${action}:`,
                error
            );
        }
    }
}

module.exports = { initiatePlayerStop, finishPlayerStop };
