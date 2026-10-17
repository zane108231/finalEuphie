const { REST, Routes, ActivityType, MessageFlags } = require("discord.js");
const { getDB, isDBConnected } = require("../utils/database");
const { getGuildData } = require("../utils/mongoGuildData");
const { startStatusMonitor } = require("../services/statusMonitor");

module.exports = {
    name: "clientReady",
    once: true,
    async execute(client) {
        console.log(`[euphire] Logged in as ${client.user.tag}`);
        console.log(`[euphire] Serving ${client.guilds.cache.size} guild(s)`);

        // Initialize riffy with bot user ID
        client.riffy.init(client.user.id);

        startStatusMonitor(client);

        // Cycling statuses
        const statuses = [
            "Pretending to be a DJ",
            "!help for commands",
        ];

        // Set initial activity
        client.user.setPresence({
            activities: [{ name: statuses[0], type: ActivityType.Playing }],
            status: "online",
        });

        let statusIndex = 0;
        setInterval(() => {
            statusIndex = (statusIndex + 1) % statuses.length;
            client.user.setPresence({
                activities: [{ name: statuses[statusIndex], type: ActivityType.Playing }],
                status: "online",
            });
        }, 120000); // 2 minutes

        // Save guild names to MongoDB for stats tracking
        try {
            if (isDBConnected()) {
                const db = getDB();
                for (const [guildId, guild] of client.guilds.cache) {
                    console.log("[euphire] Saving guild name:", guild.name, "for guildId:", guildId);
                    await db.collection('guildData').updateOne(
                        { guildId },
                        { $set: { guildName: guild.name } },
                        { upsert: true }
                    );
                }
                console.log("[euphire] Saved guild names to MongoDB for stats tracking");
            }
        } catch (err) {
            console.error("[euphire] Failed to save guild names:", err.message);
        }

        // Remove global slash commands so Discord stops showing /play "thinking"
        try {
            const rest = new REST({ version: "10" }).setToken(client.token);
            await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
            console.log("[euphire] Cleared slash commands. Use !help for prefix commands.");
        } catch (error) {
            console.error("[euphire] Failed to clear slash commands:", error);
        }
    },
};
