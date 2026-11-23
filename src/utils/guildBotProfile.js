const { REST, Routes } = require("discord.js");
const coordinator = require("./mongoCoordinator");

const PRIMARY_BOT_ID = "euphie_main";
const AVAILABLE_SUFFIX = " 🟢";
const LEGACY_AVAILABLE_SUFFIX = " (available)";

function isWaitingRoomBot(client, guildId) {
    const data = require("./mongoGuildData").getGuildData(guildId);
    const player = client.riffy?.players?.get(guildId);
    return Boolean(
        data.waitingRoomEnabled &&
        data.waitingRoomChannelId &&
        player?._waitingRoom &&
        player.voiceChannel === data.waitingRoomChannelId
    );
}

function formatBotNickname(client, guildId, baseName) {
    const botSuffix = client.botId === PRIMARY_BOT_ID
        ? ""
        : `(${client.botId.match(/^euphie_(\d+)$/)?.[1] || ""})`;
    const availabilitySuffix = isWaitingRoomBot(client, guildId)
        ? AVAILABLE_SUFFIX
        : "";
    const suffix = `${botSuffix}${availabilitySuffix}`;
    return `${baseName.slice(0, 32 - suffix.length)}${suffix}`;
}

async function restoreLegacyYearnNickname(client, guildId, guildData) {
    const savedNicknames = guildData?.euphieYearnOriginalNicknames;
    if (
        !savedNicknames ||
        !Object.prototype.hasOwnProperty.call(savedNicknames, client.botId)
    ) {
        return false;
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild || !client.isReady()) return false;

    const nickname = savedNicknames[client.botId];
    const member = await guild.members.fetch({
        user: client.user.id,
        force: true,
    });
    if ((member.nickname ?? null) !== (nickname ?? null)) {
        const rest = new REST({ version: "10" }).setToken(client.token);
        await rest.patch(Routes.guildMember(guildId, "@me"), {
            body: { nick: nickname },
            reason: "Restore nickname after removing Euphie Yearn",
        });
    }

    delete savedNicknames[client.botId];
    guildData.euphieYearnEnabled = false;
    const hasMoreNicknames = Object.keys(savedNicknames).length > 0;
    if (!hasMoreNicknames) {
        delete guildData.euphieYearnEnabled;
        delete guildData.euphieYearnOriginalNicknames;
    }
    await require("./mongoGuildData").saveGuildData(guildId, guildData);
    if (!hasMoreNicknames) {
        const { getDB, isDBConnected } = require("./database");
        if (isDBConnected()) {
            await getDB().collection("guildData").updateOne(
                { guildId },
                {
                    $unset: {
                        euphieYearnEnabled: "",
                        euphieYearnOriginalNicknames: "",
                    },
                }
            );
        }
    }
    return true;
}

async function setGuildBotAvailability(client, guildId, available) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild || !client.isReady()) return;

    await restoreLegacyYearnNickname(
        client,
        guildId,
        require("./mongoGuildData").getGuildData(guildId)
    );
    const member = await guild.members.fetch({
        user: client.user.id,
        force: true,
    });
    const currentNickname = member.nickname;
    const baseName = (currentNickname || client.user.username)
        .replace(/ 🟢$/, "")
        .replace(/ \(available\)$/, "");
    const hasCurrentIndicator =
        currentNickname?.endsWith(AVAILABLE_SUFFIX) === true;
    const hasLegacyIndicator =
        currentNickname?.endsWith(LEGACY_AVAILABLE_SUFFIX) === true;
    if (
        (available && !hasCurrentIndicator) ||
        (!available && (hasCurrentIndicator || hasLegacyIndicator))
    ) {
        const nickname = available
            ? `${baseName.slice(0, 32 - AVAILABLE_SUFFIX.length)}${AVAILABLE_SUFFIX}`
            : baseName === client.user.username
              ? null
              : baseName;
        const rest = new REST({ version: "10" }).setToken(client.token);
        await rest.patch(Routes.guildMember(guildId, "@me"), {
            body: { nick: nickname },
            reason: available
                ? "Bot joined the Euphie waiting room"
                : "Bot left the Euphie waiting room",
        });
    }

    await require("./waitingRoomStatus").updateWaitingRoomStatus(
        guildId,
        client.botId,
        available
    );
}

async function applyGuildBotProfile(
    guildId,
    targetMember,
    { copyAvatar = true, copyName = true } = {}
) {
    let avatar;
    if (copyAvatar) {
        const avatarUrl = targetMember.displayAvatarURL({ size: 1024, extension: "png" });
        const response = await fetch(avatarUrl);
        if (!response.ok) {
            throw new Error(`Could not download the user's avatar (HTTP ${response.status}).`);
        }

        const contentType = response.headers.get("content-type") || "image/png";
        avatar = `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
    }

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
        const nickname = copyName
            ? formatBotNickname(client, guildId, baseName)
            : isWaitingRoomBot(client, guildId)
              ? formatBotNickname(client, guildId, client.user.username)
              : null;
        const botName = client.user?.username || client.botId || "Euphie";

        try {
            const rest = new REST({ version: "10" }).setToken(client.token);
            const body = { nick: nickname };
            if (copyAvatar) body.avatar = avatar;
            await rest.patch(Routes.guildMember(guildId, "@me"), {
                body,
                reason: `Server profile copied from ${targetMember.id}`,
            });
            updated.push({ botName, nickname });
        } catch (error) {
            console.error(`[euphire] Failed to update server profile for ${botName} in ${guildId}: ${error.message}`);
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
            const nickname = isWaitingRoomBot(client, guildId)
                ? `${client.user.username.slice(0, 32 - AVAILABLE_SUFFIX.length)}${AVAILABLE_SUFFIX}`
                : null;
            await rest.patch(Routes.guildMember(guildId, "@me"), {
                body: { nick: nickname, avatar: null },
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

async function applyGuildBotSettings(guildId, changes, reason) {
    const clients = coordinator
        .getAllClients()
        .filter((client) => client.guilds.cache.has(guildId));
    const updated = [];
    const errors = [];

    for (const client of clients) {
        const botName = client.user?.username || client.botId || "Euphie";
        try {
            const rest = new REST({ version: "10" }).setToken(client.token);
            const body = { ...changes };
            if (typeof body.nickBase === "string") {
                body.nick = formatBotNickname(client, guildId, body.nickBase);
                delete body.nickBase;
            }
            await rest.patch(Routes.guildMember(guildId, "@me"), {
                body,
                reason,
            });
            updated.push(botName);
        } catch (error) {
            console.error(`[euphire] Failed to update server avatar for ${botName} in ${guildId}: ${error.message}`);
            errors.push({ botName, error });
        }
    }

    return { updated, errors };
}

async function applyGuildBotAvatar(guildId, avatar) {
    return applyGuildBotSettings(
        guildId,
        { avatar },
        "Server model uploaded a custom Euphie avatar"
    );
}

module.exports = {
    applyGuildBotProfile,
    resetGuildBotProfile,
    applyGuildBotAvatar,
    applyGuildBotSettings,
    setGuildBotAvailability,
    restoreLegacyYearnNickname,
};
