
require("dotenv").config({
    path: require("path").resolve(__dirname, "../.env"),
});

const http = require("http");
const { Client, GatewayIntentBits, GatewayDispatchEvents } = require("discord.js");
const { Riffy } = require("riffy");
const fs = require("fs");
const path = require("path");
const config = require("../config");

const { loadCommands } = require("./handlers/commandHandler");
const { setupPlayerHandler } = require("./handlers/playerHandler");
const { patchRiffyResolve } = require("./utils/search");
const coordinator = require("./utils/mongoCoordinator");
const { connectToMongoDB } = require("./utils/database");

// ======================================================
// HTTP SERVER - NO EXPRESS REQUIRED
// ======================================================

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
    // Allow uptime monitors and browsers to access the bot.
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        return res.end(
            req.method === "HEAD"
                ? undefined
                : JSON.stringify({ error: "Method not allowed" })
        );
    }

    if (req.url === "/" || req.url === "/health") {
        const clients =
            typeof coordinator.getAllClients === "function"
                ? coordinator.getAllClients()
                : [];

        const bots = clients.map((client) => ({
            id: client.botId || "unknown",
            connected: client.isReady(),
        }));

        const response = JSON.stringify({
            status: "online",
            service: "Euphie Music Bot",
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            bots,
        });

        res.writeHead(200);
        return res.end(req.method === "HEAD" ? undefined : response);
    }

    res.writeHead(404);
    return res.end(
        req.method === "HEAD"
            ? undefined
            : JSON.stringify({ error: "Not found" })
    );
});

server.on("error", (error) => {
    console.error("[euphire] HTTP server error:", error);
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`[euphire] HTTP server listening on port ${PORT}`);
    console.log("[euphire] Health check: /health");
});

// ======================================================
// MONGODB
// ======================================================

connectToMongoDB().catch((err) => {
    console.warn(
        "[euphire] MongoDB connection failed; continuing with in-memory storage:",
        err.message
    );
});

// ======================================================
// CREATE DISCORD BOT INSTANCE
// ======================================================

function createBotInstance(token, botId) {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.MessageContent,
        ],
    });

    client.botId = botId;

    client.riffy = new Riffy(client, [config.node], {
        send: (payload) => {
            const guildId = payload?.d?.guild_id;
            if (!guildId) return;

            const guild = client.guilds.cache.get(guildId);
            if (guild) {
                guild.shard.send(payload);
            }
        },
        defaultSearchPlatform: config.defaultSearchPlatform || "spsearch",
        restVersion: config.restVersion || "v4",
        bypassChecks: {
            nodeFetchInfo: true,
        },
    });

    patchRiffyResolve(client.riffy);

    // Load commands.
    loadCommands(client);

    // Load event handlers.
    const eventsPath = path.join(__dirname, "events");

    if (fs.existsSync(eventsPath)) {
        const eventFiles = fs
            .readdirSync(eventsPath)
            .filter((file) => file.endsWith(".js"));

        for (const file of eventFiles) {
            const event = require(path.join(eventsPath, file));

            if (event.once) {
                client.once(event.name, (...args) =>
                    event.execute(client, ...args)
                );
            } else {
                client.on(event.name, (...args) =>
                    event.execute(client, ...args)
                );
            }
        }
    }

    // Initialize Riffy player events.
    setupPlayerHandler(client);

    // Log player errors.
    client.riffy.on("playerError", (player, error) => {
        console.error(
            `[euphire] Player error in ${player.guildId} (${botId}):`,
            error
        );
    });

    // Forward Discord voice updates to Riffy.
    client.on("raw", (packet) => {
        if (
            packet.t !== GatewayDispatchEvents.VoiceStateUpdate &&
            packet.t !== GatewayDispatchEvents.VoiceServerUpdate
        ) {
            return;
        }

        if (
            packet.t === GatewayDispatchEvents.VoiceServerUpdate &&
            !packet.d?.endpoint
        ) {
            return;
        }

        try {
            client.riffy.updateVoiceState(packet);
        } catch (err) {
            if (String(err?.message || "").includes("endpoint")) return;

            console.error(
                `[euphire] Voice state update failed for ${botId}:`,
                err.message
            );
        }
    });

    return client;
}

// ======================================================
// MULTI-BOT CONFIGURATION
// ======================================================

const botConfigs = [
    {
        id: "euphie_main",
        token: process.env.BOT_TOKEN,
        name: "Euphie",
        isPrimary: true,
    },
    {
        id: "euphie_1",
        token: process.env.BOT_1_TOKEN,
        name: "Euphie (1)",
        isPrimary: false,
    },
    {
        id: "euphie_2",
        token: process.env.BOT_2_TOKEN,
        name: "Euphie (2)",
        isPrimary: false,
    },
    {
        id: "euphie_3",
        token: process.env.BOT_3_TOKEN,
        name: "Euphie (3)",
        isPrimary: false,
    },
];

// ======================================================
// VALIDATE BOT TOKENS
// ======================================================

const missingTokens = botConfigs.filter((bot) => !bot.token);

if (missingTokens.length > 0) {
    console.error("[euphire] Missing bot tokens:");

    for (const bot of missingTokens) {
        const envName = bot.isPrimary
            ? "BOT_TOKEN"
            : `BOT_${bot.id.split("_").pop().toUpperCase()}_TOKEN`;

        console.error(`  - ${bot.name}: missing ${envName}`);
    }

    console.error(
        "[euphire] Add the missing variables in your Render Environment settings."
    );

    process.exitCode = 1;
} else {
    // ======================================================
    // INITIALIZE MULTI-BOT COORDINATOR
    // ======================================================

    coordinator.initialize(
        botConfigs,
        (token, botId) => createBotInstance(token, botId),
        (client) => client.riffy
    );

    coordinator.resetAllBotsToAvailable();

    // ======================================================
    // LOGIN ALL BOTS
    // ======================================================

    for (const client of coordinator.getAllClients()) {
        const botId = client.botId;

        const botConfig = botConfigs.find((bot) => bot.id === botId);
        const token = botConfig?.token;

        if (!token) {
            console.error(`[euphire] No token found for ${botId}`);
            continue;
        }

        client.on("ready", () => {
            console.log(
                `[euphire] ${botConfig.name} connected successfully (${botId})`
            );

            coordinator.markBotReconnected(botId);
        });

        client.on("shardDisconnect", () => {
            console.warn(`[euphire] ${botId} disconnected from Discord`);
            coordinator.markBotDisconnected(botId);
        });

        client.on("shardReconnecting", () => {
            console.log(`[euphire] ${botId} is reconnecting...`);
        });

        client.login(token).catch((err) => {
            console.error(
                `[euphire] Failed to login ${botId}:`,
                err.message
            );

            coordinator.markBotDisconnected(botId);
        });
    }
}

// ======================================================
// RIFFY TRACK-END SAFETY PATCH
// ======================================================

try {
    const { Player } = require("riffy/build/structures/Player");
    const originalTrackEnd = Player.prototype.trackEnd;

    if (typeof originalTrackEnd === "function") {
        Player.prototype.trackEnd = function trackEndSafe(
            player,
            track,
            payload
        ) {
            if (!track || !track.info) {
                this.playing = false;

                if (player?.queue?.length) {
                    try {
                        return player.play();
                    } catch (err) {
                        console.error(
                            "[euphire] Failed to resume queued track:",
                            err.message
                        );
                        return;
                    }
                }

                return this.riffy.emit("queueEnd", player);
            }

            return originalTrackEnd.call(this, player, track, payload);
        };
    }
} catch (err) {
    console.warn(
        "[euphire] Could not patch Riffy trackEnd:",
        err.message
    );
}

// ======================================================
// GLOBAL ERROR HANDLING
// ======================================================

process.on("unhandledRejection", (reason) => {
    const message =
        reason?.message || String(reason || "Unknown rejection");

    if (
        message.includes("Queue is empty") ||
        message.includes("Missing 'endpoint' property") ||
        message.includes("Cannot read properties of null (reading 'info')")
    ) {
        return;
    }

    if (message.includes("Making Node Request")) {
        console.warn("[euphire] Lavalink request failed:", message);
        return;
    }

    console.error("[euphire] Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
    console.error("[euphire] Uncaught Exception:", error);
});

process.on("uncaughtExceptionMonitor", (error) => {
    console.error("[euphire] Uncaught Exception (monitor):", error);
});
