const { REST, Routes, ActivityType } = require("discord.js");
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

        // Fetch and cache application emojis
        client.application?.emojis?.fetch().catch(() => {});

        startStatusMonitor(client);

        client.user.setPresence({
            activities: [{ name: "e!help", type: ActivityType.Listening }],
            status: "online",
        });

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

        // Keep the owner-only profile command on the primary bot, and clear the
        // other bot applications so only one /botprofile is registered.
        try {
            const rest = new REST({ version: "10" }).setToken(client.token);
            const commands = client.botId === "euphie_main"
                ? [
                    require("../commands/botprofile").data.toJSON(),
                    require("../commands/modelprofile").data.toJSON(),
                    require("../commands/developerprofile").data.toJSON(),
                    ...require("../commands/model").commands.map((command) => command.data.toJSON()),
                ]
                : [];
            await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
            for (const guildId of client.guilds.cache.keys()) {
                await rest.put(
                    Routes.applicationGuildCommands(client.user.id, guildId),
                    { body: [] }
                );
            }
            console.log(
                commands.length
                    ? "[euphire] Registered the profile and model commands; cleared server-specific commands."
                    : "[euphire] Cleared global and server-specific slash commands for this secondary bot."
            );
        } catch (error) {
            console.error("[euphire] Failed to synchronize slash commands:", error);
        }
    },
};
