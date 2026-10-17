require("dotenv").config();

const { REST, Routes } = require("discord.js");

const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

(async () => {
    try {
        const appId = process.env.CLIENT_ID;
        if (!appId) {
            console.error("[euphire] CLIENT_ID is not set in .env");
            process.exit(1);
        }

        console.log("[euphire] Clearing global slash commands (prefix commands are used instead)...");
        await rest.put(Routes.applicationCommands(appId), { body: [] });
        console.log("[euphire] Slash commands cleared. Use !help in Discord.");
    } catch (error) {
        console.error("[euphire] Failed to clear slash commands:", error);
    }
})();
