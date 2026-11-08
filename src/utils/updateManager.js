const { getDB } = require("./database");

async function markMaintenanceComplete() {
    await getDB().collection("systemState").updateOne(
        { key: "maintenance", status: { $in: ["restarting", "scheduled"] } },
        { $set: { status: "completed", completedAt: Date.now() } }
    );
}

module.exports = { markMaintenanceComplete };
