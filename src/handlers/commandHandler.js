const fs = require("fs");
const path = require("path");
const { Collection } = require("discord.js");
const { PREFIX, createPrefixInteraction } = require("../utils/prefix");
const { getPrefix, getAllValidPrefixes } = require("../utils/prefixStore");
const coordinator = require("../utils/mongoCoordinator");
const advancedCommands = require("../commands/advanced");

const prefixFallbackNames = [
    ...advancedCommands.commands.map((command) => command.data.name),
    ...advancedCommands.multiWordAliases.map(([phrase]) => phrase),
    "resume session",
    "album search",
    "playlist search",
    "autoplay toggle",
    "wind to",
    "repeat queue",
    "repeat current",
    "repeat disable",
    "update",
];
const prefixFallbackPattern = new RegExp(
    `^e!(?:${prefixFallbackNames
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\-/g, "-").replace(/ /g, "\\s+"))
        .sort((a, b) => b.length - a.length)
        .join("|")})(?:\\s|$)`,
    "i"
);

/**
 * Music commands that require session routing
 */
const MUSIC_COMMANDS = new Set([
    "play", "p",
    "radio", "search", "playqueue", "playrecent", "playlistselect",
    "playingsingle", "albumsearch", "playlistsearch",
    "skip", "s", "next",
    "pause",
    "resume",
    "stop", "leave", "dc",
    "join", "summon",
    "queue", "q", "list",
    "nowplaying", "np",
    "loop", "loopq", "repeat",
    "shuffle",
    "volume", "vol",
    "seek",
    "autoplay",
    "clear",
    "move",
    "remove",
    "insert",
    "lyrics", "lyric", "ly",
    "permission", "permissions", "perms",
    "forward", "backward", "end-time",
    "start-time", "skip-to", "previous", "vote-skip", "restart-queue",
    "select-random", "shuffle-repeat", "remove-after-played", "sort", "swap", "reverse",
    "reorder", "mass-move", "mass-remove", "remove-last", "remove-user",
    "remove-range", "remove-absent", "remove-current", "remove-keyword",
    "remove-duplicates", "song-info", "top-songs", "album-info",
    "artist-info", "searchlyrics", "save", "next-up", "upcoming",
    "requested", "recently-played", "queue-info", "session-statistics",
    "session-information"
]);

/**
 * Check if a command is a music command
 */
function isMusicCommand(commandName) {
    return MUSIC_COMMANDS.has(commandName.toLowerCase());
}

/**
 * Load all commands from the commands directory
 */
function loadCommands(client) {
    client.commands = new Collection();
    client.aliases = new Collection();

    const commandsPath = path.join(__dirname, "..", "commands");

    if (!fs.existsSync(commandsPath)) {
        console.warn("[euphire] No commands directory found.");
        return;
    }

    const commandFiles = fs
        .readdirSync(commandsPath)
        .filter((file) => file.endsWith(".js"));

    for (const file of commandFiles) {
        try {
            const command = require(path.join(commandsPath, file));
            const definitions = Array.isArray(command.commands)
                ? command.commands
                : [command];
            for (const definition of definitions) {
                if (!definition.data || !definition.execute || definition.hidden) {
                    continue;
                }
                client.commands.set(definition.data.name, definition);
                const aliases = definition.aliases || [];
                for (const alias of aliases) {
                    client.aliases.set(alias.toLowerCase(), definition);
                }
                const aliasNote = aliases.length
                    ? ` (${aliases.map((a) => PREFIX + a).join(", ")})`
                    : "";
                console.log(
                    `[euphire] Loaded command: ${PREFIX}${definition.data.name}${aliasNote}`
                );
            }
            if (!definitions.some((definition) => definition.data && definition.execute)) {
                console.warn(`[euphire] Command ${file} is missing "data" or "execute".`);
            }
        } catch (err) {
            console.error(`[euphire] Failed to load command ${file}:`, err.message);
        }
    }
}

function resolveCommand(client, name) {
    const key = name.toLowerCase();
    if (key === "update") return require("../commands/update");
    return client.commands.get(key) || client.aliases.get(key) || null;
}

/**
 * Run a prefix command from a guild message. Returns true if the message
 * started with the prefix (so ChatPlay should not steal it).
 */
async function handlePrefixCommand(client, message) {
    if (!message.guild || message.author.bot) return false;
    const prefixes = getAllValidPrefixes(message.guild.id, message.author.id);
    let matchedPrefix = null;
    for (const p of prefixes) {
        if (message.content.startsWith(p)) {
            matchedPrefix = p;
            break;
        }
    }
    if (
        !matchedPrefix &&
        prefixFallbackPattern.test(message.content)
    ) {
        matchedPrefix = "e!";
    }
    if (!matchedPrefix) return false;

    const without = message.content.slice(matchedPrefix.length).trim();
    if (!without) return true;

    let command = null;
    let args = [];

    // Check multi-word permission aliases
    const advancedPatterns = advancedCommands.multiWordAliases.map(
        ([phrase, commandName]) => ({
            pattern: new RegExp(
                `^${phrase.split(" ").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")}\\b`,
                "i"
            ),
            cmd: commandName,
            prefixArgs: [],
        })
    );
    const multiWordPatterns = [
        ...advancedPatterns,
        { pattern: /^wind\s+to\b/i, cmd: "seek", prefixArgs: [] },
        { pattern: /^resume\s+session\b/i, cmd: "resume-session", prefixArgs: [] },
        { pattern: /^album\s+search\b/i, cmd: "albumsearch", prefixArgs: [] },
        { pattern: /^playlist\s+search\b/i, cmd: "playlistsearch", prefixArgs: [] },
        { pattern: /^autoplay\s+toggle\b/i, cmd: "autoplay", prefixArgs: [] },
        // 3-word patterns
        { pattern: /^(?:allow\s+all\s+permissions|permission\s+allow\s+all|permissions\s+allow\s+all|permissions\s+add\s+all|permission\s+add\s+all|add\s+all\s+permissions)\b/i, cmd: "permission", prefixArgs: ["allow", "all"] },
        { pattern: /^(?:permissions\s+remove\s+all|remove\s+all\s+permissions|permission\s+remove\s+all|deny\s+all\s+permissions|permission\s+deny\s+all|permissions\s+deny\s+all)\b/i, cmd: "permission", prefixArgs: ["deny", "all"] },
        // 2-word patterns
        { pattern: /^(?:permissions\s+allow|allow\s+permission|permissions\s+add|permission\s+add|add\s+permission)\b/i, cmd: "permission", prefixArgs: ["allow"] },
        { pattern: /^(?:permissions\s+remove|permission\s+remove|remove\s+permission|permissions\s+deny|permission\s+deny|deny\s+permission)\b/i, cmd: "permission", prefixArgs: ["deny"] },
        { pattern: /^(?:reset\s+permissions|permissions\s+reset|permission\s+reset)\b/i, cmd: "permission", prefixArgs: ["reset"] },
    ];

    for (const item of multiWordPatterns) {
        const match = without.match(item.pattern);
        if (match) {
            command = resolveCommand(client, item.cmd);
            const remainder = without.slice(match[0].length).trim();
            args = [...item.prefixArgs, ...(remainder ? remainder.split(/\s+/) : [])];
            break;
        }
    }

    if (!command) {
        const [rawName, ...restArgs] = without.split(/\s+/);
        command = resolveCommand(client, rawName);
        args = restArgs;
    }

    // Check if this bot should handle the command BEFORE checking if command exists
    const botId = client.botId;
    const isMusic = command ? isMusicCommand(command.data.name) : false;
    const voiceChannelId = message.member.voice?.channel?.id;
    const guildId = message.guild?.id;

    const shouldHandle = coordinator.shouldHandleCommand(botId, guildId, voiceChannelId, isMusic);
    // console.log(`[euphire] Command routing: bot=${botId}, guild=${guildId}, command=${command?.data?.name || rawName}, voiceChannel=${voiceChannelId}, shouldHandle=${shouldHandle}, isMusic=${isMusic}`);

    if (!shouldHandle) {
        // This bot should not respond - let the correct bot handle it
        return true;
    }

    if (!command) {
        // Silently ignore unknown commands
        return true;
    }

    // console.log(`[euphire] Bot ${botId} will handle command ${command.data.name}`);

    const interaction = createPrefixInteraction(message, command, args);

    try {
        await command.execute(interaction, client);
    } catch (error) {
        console.error(`[euphire] Prefix command error (${command.data.name}):`, error);
        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: "An error occurred." });
            } else {
                await interaction.reply({ content: "An error occurred." });
            }
        } catch {
            // ignore
        }
    }

    return true;
}

module.exports = { loadCommands, handlePrefixCommand };
