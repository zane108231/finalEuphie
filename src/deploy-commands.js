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

        const commands = [
            require("./commands/botprofile").data,
            require("./commands/modelprofile").data,
            ...require("./commands/model").commands.map((command) => command.data),
        ];
        console.log("[euphire] Registering the owner profile and model commands...");
        await rest.put(Routes.applicationCommands(appId), {
            body: commands.map((command) => command.toJSON()),
        });
        console.log("[euphire] Registered /botprofile, /modelprofile, /modelstats, /modelchannel, and /setmodel.");
    } catch (error) {
        console.error("[euphire] Failed to register slash commands:", error);
    }
})();
