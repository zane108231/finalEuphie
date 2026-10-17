require("dotenv").config({ path: require('path').resolve(__dirname, '../.env') });

const { Client, GatewayIntentBits, GatewayDispatchEvents, Collection } = require("discord.js");
const { Riffy } = require("riffy");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { loadCommands } = require("./handlers/commandHandler");
const { setupPlayerHandler } = require("./handlers/playerHandler");
const { patchRiffyResolve } = require("./utils/search");
const coordinator = require("./utils/mongoCoordinator");
const { connectToMongoDB, disconnectFromMongoDB } = require("./utils/database");

// Connect to MongoDB before starting bots
(async () => {
    try {
        await connectToMongoDB();
    } catch (err) {
        console.warn("[euphire] MongoDB connection failed, continuing with in-memory storage");
    }
})();

/**
 * Create a Discord client with Riffy and event handlers
 * @param {string} token - Bot token
 * @param {string} botId - Unique bot identifier
 * @returns {Client} Configured Discord client
 */
function createBotInstance(token, botId) {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.MessageContent,
        ],
    });

    // Store bot ID for coordinator reference
    client.botId = botId;

    // --- Initialize Riffy for this client ---
    client.riffy = new Riffy(client, [config.node], {
        send: (payload) => {
            const guild = client.guilds.cache.get(payload.d.guild_id);
            if (guild) guild.shard.send(payload);
        },
        defaultSearchPlatform: config.defaultSearchPlatform || "spsearch",
        restVersion: config.restVersion || "v4",
        bypassChecks: {
            nodeFetchInfo: true,
        },
    });

    patchRiffyResolve(client.riffy);

    // --- Load Commands (shared across all bots) ---
    loadCommands(client);

    // --- Load Events (shared across all bots) ---
    const eventsPath = path.join(__dirname, "events");
    if (fs.existsSync(eventsPath)) {
        const eventFiles = fs.readdirSync(eventsPath).filter((f) => f.endsWith(".js"));
        for (const file of eventFiles) {
            const event = require(path.join(eventsPath, file));
            if (event.once) {
                client.once(event.name, (...args) => event.execute(client, ...args));
            } else {
                client.on(event.name, (...args) => event.execute(client, ...args));
            }
        }
    }

    // --- Setup Riffy Player Handler for this client ---
    setupPlayerHandler(client);

    return client;
}

// --- Initialize Multi-Bot System ---
const botConfigs = [
    {
        id: "euphie_main",
        token: process.env.BOT_TOKEN,
        name: "Euphie",
        isPrimary: true
    },
    {
        id: "euphie_1",
        token: process.env.BOT_1_TOKEN,
        name: "Euphie (1)",
        isPrimary: false
    },
    {
        id: "euphie_2",
        token: process.env.BOT_2_TOKEN,
        name: "Euphie (2)",
        isPrimary: false
    },
    {
        id: "euphie_3",
        token: process.env.BOT_3_TOKEN,
        name: "Euphie (3)",
        isPrimary: false
    }
];

// Validate tokens
const missingTokens = botConfigs.filter(config => !config.token);
if (missingTokens.length > 0) {
    console.error("[euphire] Missing bot tokens:");
    missingTokens.forEach(config => {
        console.error(`  - ${config.name}: missing ${config.isPrimary ? 'BOT_TOKEN' : config.id.toUpperCase() + '_TOKEN'}`);
    });
    process.exit(1);
}

// Initialize coordinator with bot instances
coordinator.initialize(
    botConfigs,
    (token, botId) => createBotInstance(token, botId), // Client creation function
    (client) => client.riffy // Riffy instance accessor
);

// Reset all bots to available state on startup
coordinator.resetAllBotsToAvailable();

// --- Global Error Handlers (prevent crashes) ---
try {
    const { Player } = require("riffy/build/structures/Player");
    const originalTrackEnd = Player.prototype.trackEnd;
    Player.prototype.trackEnd = function trackEndSafe(player, track, payload) {
        if (!track || !track.info) {
            this.playing = false;
            if (player?.queue?.length) {
                try {
                    return player.play();
                } catch {
                    return;
                }
            }
            return this.riffy.emit("queueEnd", player);
        }
        return originalTrackEnd.call(this, player, track, payload);
    };
} catch (err) {
    console.warn("[euphire] Could not patch Riffy trackEnd:", err.message);
}

process.on("unhandledRejection", (reason) => {
    const message = reason && reason.message ? reason.message : String(reason || "");
    if (message.includes("Queue is empty")) return;
    if (message.includes("Making Node Request")) {
        console.warn("[euphire] Lavalink request failed:", message);
        return;
    }
    if (message.includes("Missing 'endpoint' property")) return;
    if (message.includes("Cannot read properties of null (reading 'info')")) return;
    console.error("[euphire] Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
    console.error("[euphire] Uncaught Exception:", error);
});

process.on("uncaughtExceptionMonitor", (error) => {
    console.error("[euphire] Uncaught Exception (monitor):", error);
});

// --- Forward raw voice state to riffy for all clients ---
coordinator.getAllClients().forEach(client => {
    // --- Riffy error safety for this client ---
    client.riffy.on("playerError", (player, error) => {
        console.error(`[euphire] Player error in ${player.guildId} (${client.botId}):`, error);
    });

    client.on("raw", (d) => {
        if (
            ![
                GatewayDispatchEvents.VoiceStateUpdate,
                GatewayDispatchEvents.VoiceServerUpdate,
            ].includes(d.t)
        )
            return;
        if (d.t === GatewayDispatchEvents.VoiceServerUpdate && !d.d?.endpoint) return;
        try {
            client.riffy.updateVoiceState(d);
        } catch (err) {
            if (String(err?.message || "").includes("endpoint")) return;
            console.error(`[euphire] Voice state update failed for ${client.botId}:`, err.message);
        }
    });
});

// --- Login all bots ---
coordinator.getAllClients().forEach(client => {
    const botId = client.botId;
    const token = botConfigs.find(c => c.id === botId)?.token;
    
    if (!token) {
        console.error(`[euphire] No token found for bot ${botId}`);
        return;
    }

    client.login(token).catch(err => {
        console.error(`[euphire] Failed to login bot ${botId}:`, err.message);
        coordinator.markBotDisconnected(botId);
    });

    // Handle client disconnects
    client.on('disconnect', () => {
        console.log(`[euphire] Bot ${botId} disconnected from Discord`);
        coordinator.markBotDisconnected(botId);
    });

    client.on('reconnecting', () => {
        console.log(`[euphire] Bot ${botId} is reconnecting...`);
    });

    client.on('ready', () => {
        console.log(`[euphire] Bot ${botId} reconnected successfully`);
        coordinator.markBotReconnected(botId);
    });
});

// --- Global Error Handlers (prevent crashes) ---
try {
    const { Player } = require("riffy/build/structures/Player");
    const originalTrackEnd = Player.prototype.trackEnd;
    Player.prototype.trackEnd = function trackEndSafe(player, track, payload) {
        if (!track || !track.info) {
            this.playing = false;
            if (player?.queue?.length) {
                try {
                    return player.play();
                } catch {
                    return;
                }
            }
            return this.riffy.emit("queueEnd", player);
        }
        return originalTrackEnd.call(this, player, track, payload);
    };
} catch (err) {
    console.warn("[euphire] Could not patch Riffy trackEnd:", err.message);
}

process.on("unhandledRejection", (reason) => {
    const message = reason && reason.message ? reason.message : String(reason || "");
    if (message.includes("Queue is empty")) return;
    if (message.includes("Making Node Request")) {
        console.warn("[euphire] Lavalink request failed:", message);
        return;
    }
    if (message.includes("Missing 'endpoint' property")) return;
    if (message.includes("Cannot read properties of null (reading 'info')")) return;
    console.error("[euphire] Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
    console.error("[euphire] Uncaught Exception:", error);
});

process.on("uncaughtExceptionMonitor", (error) => {
    console.error("[euphire] Uncaught Exception (monitor):", error);
});
