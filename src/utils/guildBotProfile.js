const { REST, Routes } = require("discord.js");
const coordinator = require("./mongoCoordinator");

const PRIMARY_BOT_ID = "euphie_main";

async function applyGuildBotProfile(guildId, targetMember) {
    const avatarUrl = targetMember.displayAvatarURL({ size: 1024, extension: "png" });
    const response = await fetch(avatarUrl);
    if (!response.ok) {
        throw new Error(`Could not download the user's avatar (HTTP ${response.status}).`);
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const avatar = `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
    const baseName = targetMember.displayName;
    const clients = coordinator
        .getAllClients()
        .filter((client) => client.guilds.cache.has(guildId))
        .sort((a, b) => {
            if (a.botId === PRIMARY_BOT_ID) return -1;
            if (b.botId === PRIMARY_BOT_ID) return 1;
            return (a.botId || "").localeCompare(b.botId || "");
        });

    const updated = [];
    const errors = [];

    for (const client of clients) {
        const suffix = client.botId === PRIMARY_BOT_ID
            ? ""
            : `(${client.botId.match(/^euphie_(\d+)$/)?.[1] || ""})`;
        const nickname = `${baseName.slice(0, 32 - suffix.length)}${suffix}`;
        const botName = client.user?.username || client.botId || "Euphie";

        try {
            const rest = new REST({ version: "10" }).setToken(client.token);
            await rest.patch(Routes.guildMember(guildId, "@me"), {
                body: { nick: nickname, avatar },
                reason: `Server profile copied from ${targetMember.id}`,
            });
            updated.push({ botName, nickname });
        } catch (error) {
            console.error(`[euphire] Failed to update server profile for ${botName} in ${guildId}:`, error);
            errors.push({ botName, error });
        }
    }

    return { baseName, updated, errors };
}

async function resetGuildBotProfile(guildId) {
    const clients = coordinator
        .getAllClients()
        .filter((client) => client.guilds.cache.has(guildId));
    const updated = [];
    const errors = [];

    for (const client of clients) {
        const botName = client.user?.username || client.botId || "Euphie";
        try {
            const rest = new REST({ version: "10" }).setToken(client.token);
            await rest.patch(Routes.guildMember(guildId, "@me"), {
                body: { nick: null, avatar: null },
                reason: "Reset server-specific Euphie profile",
            });
            updated.push(botName);
        } catch (error) {
            console.error(`[euphire] Failed to reset server profile for ${botName} in ${guildId}:`, error);
            errors.push({ botName, error });
        }
    }

    return { updated, errors };
}

module.exports = { applyGuildBotProfile, resetGuildBotProfile };
