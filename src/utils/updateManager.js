const { getDB, disconnectFromMongoDB } = require("./database");
const { checkpointAllClients } = require("./playbackRecovery");
const coordinator = require("./mongoCoordinator");

let restartTimer = null;

async function scheduleUpdateRestart(restartAt) {
    if (restartTimer) {
        throw new Error("An update restart is already scheduled in this process.");
    }

    const state = getDB().collection("systemState");
    const existing = await state.findOne({ key: "maintenance" });
    if (existing?.status === "scheduled") {
        throw new Error("An update restart is already scheduled.");
    }

    await state.updateOne(
        { key: "maintenance" },
        {
            $set: {
                status: "scheduled",
                initiatedAt: Date.now(),
                restartAt,
            },
        },
        { upsert: true }
    );

    restartTimer = setTimeout(async () => {
        try {
            const clients = coordinator.getAllClients();
            await checkpointAllClients(clients);

            await state.updateOne(
                { key: "maintenance" },
                { $set: { status: "restarting", restartingAt: Date.now() } }
            );

            for (const client of clients) {
                client.destroy();
            }
            await disconnectFromMongoDB();
            process.exit(0);
        } catch (err) {
            restartTimer = null;
            console.error("[euphire] Update restart cancelled:", err);
            await state.updateOne(
                { key: "maintenance" },
                {
                    $set: {
                        status: "failed",
                        failedAt: Date.now(),
                        error: err.message,
                    },
                }
            );
        }
    }, Math.max(0, restartAt - Date.now()));
}

async function markMaintenanceComplete() {
    await getDB().collection("systemState").updateOne(
        { key: "maintenance", status: { $in: ["restarting", "scheduled"] } },
        { $set: { status: "completed", completedAt: Date.now() } }
    );
}

module.exports = { markMaintenanceComplete, scheduleUpdateRestart };
