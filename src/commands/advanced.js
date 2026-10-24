const {
    SlashCommandBuilder,
    EmbedBuilder,
} = require("discord.js");
const { requireMusicAction } = require("../utils/permissions");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const { getTopTracks, endSession } = require("../utils/mongoStats");
const { getDB } = require("../utils/database");
const coordinator = require("../utils/mongoCoordinator");

const COMMANDS = [
    ["pause", "Pause the current track", "pause"],
    ["resume", "Resume the current track", "resume"],
    ["forward", "Wind the track forwards", "forward"],
    ["backward", "Wind the track backwards", "backward"],
    ["end-time", "Set the end position of the current track", "end time"],
    ["start-time", "Set the start position of the current track", "start time"],
    ["skip-to", "Skip to the desired track", "skip to"],
    ["previous", "Go to the previous track in the queue", "previous"],
    ["vote-skip", "Vote to skip the current track", "vote skip"],
    ["restart-queue", "Restart the queue", "restart queue"],
    ["select-random", "Select tracks in the queue at random", "select random"],
    ["shuffle-repeat", "Shuffle the queue every time it repeats", "shuffle repeat"],
    ["remove-after-played", "Remove tracks after they have been played", "remove after played"],
    ["sort", "Sort the queue", "sort"],
    ["swap", "Swap the position of two tracks", "swap"],
    ["reverse", "Reverse the current queue", "reverse"],
    ["reorder", "Order the queue by the specified option", "reorder"],
    ["mass-move", "Move multiple tracks in the queue", "mass move"],
    ["mass-remove", "Remove multiple tracks from the queue", "mass remove"],
    ["remove-last", "Remove the last track in the queue", "remove last"],
    ["remove-user", "Remove all tracks requested by a user", "remove user"],
    ["remove-range", "Remove a range of tracks from the queue", "remove range"],
    ["remove-absent", "Remove tracks requested by absent users", "remove absent"],
    ["remove-current", "Remove the currently playing track from the queue", "remove current"],
    ["remove-keyword", "Remove all tracks containing a keyword", "remove keyword"],
    ["remove-duplicates", "Remove all duplicate tracks from the queue", "remove duplicates"],
    ["song-info", "Get information about a song", "song info"],
    ["top-songs", "Get the top songs", "top songs"],
    ["album-info", "Get information about an album", "album info"],
    ["artist-info", "Get information about an artist", "artist info"],
    ["searchlyrics", "Search for a song by its lyrics", "searchlyrics"],
    ["save", "Save a song to your private messages", "save"],
    ["next-up", "Get information about the next track", "next up"],
    ["upcoming", "Get a list of all the upcoming tracks", "upcoming"],
    ["requested", "Get all the tracks requested by a user", "requested"],
    ["recently-played", "View your recently listened tracks", "recently played"],
    ["queue-info", "Get information about the queue", "queue information"],
    ["session-statistics", "Get statistics for the current session", "session statistics"],
    ["session-information", "Get information about the current session", "session information"],
];

const MULTI_WORD_ALIASES = [
    ["end time", "end-time"],
    ["start time", "start-time"],
    ["skip to", "skip-to"],
    ["vote skip", "vote-skip"],
    ["restart queue", "restart-queue"],
    ["select random", "select-random"],
    ["shuffle repeat", "shuffle-repeat"],
    ["remove after played", "remove-after-played"],
    ["mass move", "mass-move"],
    ["mass remove", "mass-remove"],
    ["remove last", "remove-last"],
    ["remove user", "remove-user"],
    ["remove range", "remove-range"],
    ["remove absent", "remove-absent"],
    ["remove current", "remove-current"],
    ["remove keyword", "remove-keyword"],
    ["remove duplicates", "remove-duplicates"],
    ["song info", "song-info"],
    ["top songs", "top-songs"],
    ["album info", "album-info"],
    ["artist info", "artist-info"],
    ["next up", "next-up"],
    ["recently played", "recently-played"],
    ["queue info", "queue-info"],
    ["queue information", "queue-info"],
    ["session statistics", "session-statistics"],
    ["session information", "session-information"],
];

function getValue(interaction) {
    const args = interaction.args || [];
    return (
        interaction.options?.getString?.("value") ||
        args.join(" ").trim()
    );
}

function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return hours
        ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
        : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function parseTime(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * 1000;
    const parts = raw.split(":");
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
        return null;
    }
    const numbers = parts.map(Number);
    const seconds = numbers.pop();
    const minutes = numbers.pop();
    const hours = numbers.pop() || 0;
    if (seconds >= 60 || (parts.length === 3 && minutes >= 60)) return null;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

function queueArray(player) {
    return Array.from(player.queue || []);
}

function getRequesterId(track) {
    const requester = track?.info?.requester;
    return requester?.id || (typeof requester === "string" ? requester : null);
}

function getRequesterLabel(track, client) {
    const id = getRequesterId(track);
    return id ? `<@${id}>` : "Unknown";
}

function getTrackTitle(track) {
    return track?.info?.title || "Unknown track";
}

function getTrackLink(track) {
    const title = getTrackTitle(track);
    const author = track?.info?.author || "Unknown artist";
    const uri = track?.info?.uri;
    return uri ? `[${title} by ${author}](${uri})` : `${title} by ${author}`;
}

async function reply(interaction, text) {
    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(0x2b2d31)
                .setDescription(text.slice(0, 4000)),
        ],
    });
}

async function persistQueue(client, player) {
    await require("../utils/playbackRecovery").persistPlayer(client, player);
}

function requiredPermission(action) {
    if (["select-random", "shuffle-repeat"].includes(action)) return "shuffle";
    if (["forward", "backward", "end-time", "start-time", "restart-queue", "pause", "resume", "skip-to", "previous"].includes(action)) {
        return "seek";
    }
    if (["sort", "swap", "reverse", "reorder", "mass-move"].includes(action)) {
        return "move";
    }
    if (action.startsWith("remove") || action === "mass-remove") return "remove";
    return "update_state";
}

async function executeTrackState(action, interaction, player, value) {
    const track = player.current;
    if (!track) return reply(interaction, "There is no track currently playing.");
    if (action === "pause" || action === "resume") {
        const paused = action === "pause";
        await player.pause(paused);
        return reply(interaction, paused ? "The current track is paused." : "Playback resumed.");
    }

    const raw = value.split(/\s+/)[0];
    const parsedTime = raw ? parseTime(raw) : null;
    if (!raw && ["start-time", "end-time"].includes(action)) {
        return reply(interaction, `Usage: \`${action.replace("-", " ")} <time>\`.`);
    }
    if (raw && parsedTime === null) {
        return reply(interaction, "Use a valid time such as `1:30` or `90` seconds.");
    }
    const amount = parsedTime ?? 10000;
    let position;
    if (action === "start-time" || action === "end-time") {
        position = amount;
    } else {
        const delta = action === "backward" ? -amount : amount;
        position = (player.position || 0) + delta;
    }
    const length = Number(track.info?.length) || 0;
    if (position < 0 || (length && position > length)) {
        return reply(interaction, `Position must be between 00:00 and ${formatDuration(length)}.`);
    }
    await player.seek(position);
    await persistQueue(interaction.client || {}, player);
    return reply(interaction, `Track position set to **${formatDuration(position)}**.`);
}

async function executeQueueAction(action, interaction, client, player, value) {
    const queue = player.queue;
    const tracks = queueArray(player);
    const args = value.trim().split(/\s+/).filter(Boolean);
    const guildData = getGuildData(interaction.guild.id);

    if (action === "skip-to") {
        const position = Number(args[0]);
        if (!Number.isInteger(position) || position < 1 || position > tracks.length) {
            return reply(interaction, `Choose a queued track from 1 to ${tracks.length}.`);
        }
        if (position > 1) queue.splice(0, position - 1);
        player.stop();
        await persistQueue(client, player);
        return reply(interaction, `Skipping to **${getTrackTitle(queue[0])}**.`);
    }
    if (action === "previous") {
        const previous = guildData.previousTracks?.pop();
        if (!previous) return reply(interaction, "There is no previous track to return to.");
        queue.unshift(previous);
        await saveGuildData(interaction.guild.id, guildData);
        player.stop();
        await persistQueue(client, player);
        return reply(interaction, `Returning to **${getTrackTitle(previous)}**.`);
    }
    if (action === "restart-queue") {
        if (!player.current) return reply(interaction, "There is no current track to restart.");
        await player.seek(0);
        await persistQueue(client, player);
        return reply(interaction, "The current track has been restarted.");
    }
    if (action === "shuffle-repeat") {
        guildData.shuffleRepeat = !guildData.shuffleRepeat;
        if (guildData.shuffleRepeat) {
            player.setLoop("queue");
            guildData.loop = "queue";
            queue.shuffle();
        }
        await saveGuildData(interaction.guild.id, guildData);
        await persistQueue(client, player);
        return reply(interaction, `Shuffle on repeat is ${guildData.shuffleRepeat ? "enabled" : "disabled"}.`);
    }
    if (action === "remove-after-played") {
        guildData.removeAfterPlayed = !guildData.removeAfterPlayed;
        await saveGuildData(interaction.guild.id, guildData);
        return reply(interaction, `Remove after played is ${guildData.removeAfterPlayed ? "enabled" : "disabled"}.`);
    }
    if (action === "select-random") {
        if (!tracks.length) return reply(interaction, "The queue is empty.");
        const index = Math.floor(Math.random() * tracks.length);
        const [selected] = queue.splice(index, 1);
        queue.unshift(selected);
        player.stop();
        await persistQueue(client, player);
        return reply(interaction, `Selected **${getTrackTitle(selected)}** at random.`);
    }
    if (action === "sort" || action === "reorder") {
        if (!tracks.length) return reply(interaction, "The queue is empty.");
        const mode = (args[0] || "title").toLowerCase();
        const reverse = args.includes("reverse") || args.includes("desc");
        if (mode === "random") {
            queue.shuffle();
            await persistQueue(client, player);
            return reply(interaction, "The queue has been put in random order.");
        }
        const compare =
            mode === "length" || mode === "duration"
                ? (a, b) => (a.info?.length || 0) - (b.info?.length || 0)
                : mode === "requester"
                  ? (a, b) => getRequesterLabel(a).localeCompare(getRequesterLabel(b))
                  : mode === "title" || mode === "alphabetical"
                    ? (a, b) => getTrackTitle(a).localeCompare(getTrackTitle(b))
                    : null;
        if (!compare) return reply(interaction, "Sort by `title`, `length`, or `requester`; add `reverse` for descending order.");
        const sorted = [...tracks].sort(compare);
        if (reverse) sorted.reverse();
        queue.splice(0, queue.length, ...sorted);
        await persistQueue(client, player);
        return reply(interaction, `Queue sorted by **${mode}**${reverse ? " in reverse order" : ""}.`);
    }
    if (action === "reverse") {
        if (!tracks.length) return reply(interaction, "The queue is empty.");
        queue.reverse();
        await persistQueue(client, player);
        return reply(interaction, "The queue order has been reversed.");
    }
    if (action === "swap") {
        const [from, to] = args.map(Number);
        if (![from, to].every((n) => Number.isInteger(n) && n >= 1 && n <= tracks.length)) {
            return reply(interaction, `Usage: \`swap <position> <position>\` (queue has ${tracks.length} tracks).`);
        }
        [queue[from - 1], queue[to - 1]] = [queue[to - 1], queue[from - 1]];
        await persistQueue(client, player);
        return reply(interaction, `Swapped queue positions **${from}** and **${to}**.`);
    }
    if (action === "mass-move") {
        const [fromText, toText] = args;
        const positions = (fromText || "").split(",").map(Number);
        const destination = Number(toText);
        if (!positions.length || positions.some((p) => !Number.isInteger(p) || p < 1 || p > tracks.length) || !Number.isInteger(destination) || destination < 1 || destination > tracks.length) {
            return reply(interaction, `Usage: \`mass move <positions separated by commas> <destination>\` (queue has ${tracks.length} tracks).`);
        }
        const selected = [...new Set(positions)].sort((a, b) => a - b).map((p) => tracks[p - 1]);
        const remaining = tracks.filter((_, index) => !positions.includes(index + 1));
        const insertion = Math.min(destination - 1, remaining.length);
        remaining.splice(insertion, 0, ...selected);
        queue.splice(0, queue.length, ...remaining);
        await persistQueue(client, player);
        return reply(interaction, `Moved **${selected.length}** track(s) to position **${destination}**.`);
    }
    if (action === "remove-last") {
        if (!tracks.length) return reply(interaction, "The queue is empty.");
        const removed = queue.pop();
        await persistQueue(client, player);
        return reply(interaction, `Removed ${getTrackLink(removed)} from the queue.`);
    }
    if (action === "remove-current") {
        if (!player.current) return reply(interaction, "There is no current track to remove.");
        const title = getTrackTitle(player.current);
        const sessionId = player.currentSessionId || guildData.currentSessionId;
        if (sessionId) {
            try {
                await endSession(sessionId, false, Number(player.position) || 0);
            } catch (error) {
                console.error("[euphire] Failed to end stats session when removing current track:", error.message);
            }
            player.currentSessionId = null;
            guildData.currentSessionId = null;
            await saveGuildData(interaction.guild.id, guildData);
        }
        player.stop();
        await persistQueue(client, player);
        return reply(interaction, `Removed **${title}** from playback.`);
    }
    if (action === "remove-range") {
        const [from, to] = args.slice(0, 2).map(Number);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > tracks.length) {
            return reply(interaction, `Usage: \`remove range <first position> <last position>\` (queue has ${tracks.length} tracks).`);
        }
        const removed = queue.splice(from - 1, to - from + 1);
        await persistQueue(client, player);
        return reply(interaction, `Removed **${removed.length}** track(s) from positions ${from}–${to}.`);
    }
    if (action === "remove-user") {
        const id = args[0]?.replace(/[<@!>]/g, "") || interaction.user.id;
        const remaining = tracks.filter((track) => getRequesterId(track) !== id);
        const removed = tracks.length - remaining.length;
        if (!removed) return reply(interaction, `No queued tracks were requested by <@${id}>.`);
        queue.splice(0, queue.length, ...remaining);
        await persistQueue(client, player);
        return reply(interaction, `Removed **${removed}** track(s) requested by <@${id}>.`);
    }
    if (action === "remove-absent") {
        const voiceMembers = interaction.member?.voice?.channel?.members;
        if (!voiceMembers) return reply(interaction, "Join the bot's voice channel to remove tracks requested by absent users.");
        const present = new Set([...voiceMembers.values()].filter((member) => !member.user?.bot).map((member) => member.id));
        const remaining = tracks.filter((track) => !getRequesterId(track) || present.has(getRequesterId(track)));
        const removed = tracks.length - remaining.length;
        queue.splice(0, queue.length, ...remaining);
        await persistQueue(client, player);
        return reply(interaction, `Removed **${removed}** track(s) requested by absent users.`);
    }
    if (action === "remove-keyword") {
        const keyword = value.trim().toLowerCase();
        if (!keyword) return reply(interaction, "Usage: `remove keyword <text>`.");
        const remaining = tracks.filter((track) => !`${track.info?.title || ""} ${track.info?.author || ""}`.toLowerCase().includes(keyword));
        const removed = tracks.length - remaining.length;
        queue.splice(0, queue.length, ...remaining);
        await persistQueue(client, player);
        return reply(interaction, `Removed **${removed}** track(s) matching **${keyword}**.`);
    }
    if (action === "remove-duplicates") {
        const seen = new Set();
        const remaining = tracks.filter((track) => {
            const key = track.info?.identifier || track.info?.uri || `${track.info?.title}:${track.info?.author}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const removed = tracks.length - remaining.length;
        queue.splice(0, queue.length, ...remaining);
        await persistQueue(client, player);
        return reply(interaction, `Removed **${removed}** duplicate track(s).`);
    }
    if (action === "mass-remove") {
        const positions = value.split(",").map((part) => Number(part.trim()));
        if (!positions.length || positions.some((position) => !Number.isInteger(position) || position < 1 || position > tracks.length)) {
            return reply(interaction, `Usage: \`mass remove <positions separated by commas>\` (queue has ${tracks.length} tracks).`);
        }
        const removeSet = new Set(positions);
        queue.splice(0, queue.length, ...tracks.filter((_, index) => !removeSet.has(index + 1)));
        await persistQueue(client, player);
        return reply(interaction, `Removed **${removeSet.size}** queued track(s).`);
    }
    return null;
}

async function executeInformation(action, interaction, client, player, value) {
    const tracks = queueArray(player);
    const current = player.current;
    if (action === "top-songs") {
        const rows = await getTopTracks(interaction.user.id, 10);
        return reply(interaction, rows.length
            ? rows.map((row, index) => `${index + 1}. **${row.trackTitle || row.trackId}** — ${formatDuration(row.listeningMs)} listened`).join("\n")
            : "You do not have listening statistics yet.");
    }
    if (action === "save") {
        if (!current) return reply(interaction, "There is no current track to save.");
        const link = current.info?.uri;
        if (!link) return reply(interaction, "The current track has no shareable link.");
        try {
            await interaction.user.send(`Saved song: ${getTrackLink(current)}\n${link}`);
        } catch (error) {
            if (error.code === 50007) {
                return reply(interaction, "I couldn't send you a private message. Enable DMs from this server and try again.");
            }
            throw error;
        }
        return reply(interaction, "I sent the current song to your private messages.");
    }
    if (action === "next-up") {
        return reply(interaction, tracks[0] ? `Next track: ${getTrackLink(tracks[0])}` : "There is no next track in the queue.");
    }
    if (action === "upcoming") {
        return reply(interaction, tracks.length
            ? tracks.slice(0, 40).map((track, index) => `${index + 1}. ${getTrackLink(track)}`).join("\n")
            : "There are no upcoming tracks.");
    }
    if (action === "requested") {
        const id = value.replace(/[<@!>]/g, "").trim() || interaction.user.id;
        const requestedTracks = tracks.filter((track) => getRequesterId(track) === id);
        return reply(interaction, requestedTracks.length
            ? requestedTracks.slice(0, 40).map((track, index) => `${index + 1}. ${getTrackLink(track)}`).join("\n")
            : `No upcoming tracks were requested by <@${id}>.`);
    }
    if (action === "recently-played") {
        const result = await getDB().collection("recentTracks").findOne({ userId: interaction.user.id });
        const recentTracks = Array.isArray(result?.tracks) ? result.tracks.slice(-10).reverse() : [];
        return reply(interaction, recentTracks.length
            ? recentTracks.map((track, index) => `${index + 1}. [${track.title} by ${track.author}](${track.uri})`).join("\n")
            : "You have no recently played tracks saved yet.");
    }
    if (action === "queue-info") {
        const duration = tracks.reduce((total, track) => total + (track.info?.length || 0), 0);
        return reply(interaction, `**Queue information**\nUpcoming tracks: **${tracks.length}**\nUpcoming duration: **${formatDuration(duration)}**\nCurrent track: ${current ? getTrackLink(current) : "None"}`);
    }
    if (action === "session-statistics") {
        const sessionId = player.currentSessionId;
        const session = sessionId
            ? await getDB().collection("activeSessions").findOne({ sessionId })
            : null;
        const listened = Math.max(0, Number(player.position) || 0);
        return reply(interaction, session
            ? `**Current session statistics**\nTrack: **${session.trackTitle || getTrackTitle(current)}**\nTime elapsed: **${formatDuration(listened)}**\nQueued tracks: **${tracks.length}**`
            : "There is no active listening-statistics session.");
    }
    if (action === "session-information") {
        const ownerId = coordinator.getSessionDJ(player.voiceChannel);
        const channel = interaction.guild.channels?.cache?.get(player.voiceChannel);
        return reply(interaction, `**Current session**\nVoice channel: ${channel ? `<#${channel.id}>` : "Unknown"}\nSession owner: ${ownerId ? `<@${ownerId}>` : "Unknown"}\nNow playing: ${current ? getTrackLink(current) : "Nothing"}\nQueue: **${tracks.length}** upcoming track(s)`);
    }
    return null;
}

async function executeMetadata(action, interaction, client, value) {
    if (action === "searchlyrics") {
        if (!value) {
            return reply(interaction, "Usage: `searchlyrics <lyrics or song title>`.");
        }
        const lyricsCommand = require("./lyrics");
        const originalArgs = interaction.args;
        const originalOptions = interaction.options;
        const options = Object.create(originalOptions || null);
        options.getString = (name) =>
            name === "query" ? value : originalOptions?.getString?.(name);
        interaction.args = [value];
        interaction.options = options;
        try {
            return await lyricsCommand.execute(interaction, client);
        } finally {
            interaction.args = originalArgs;
            interaction.options = originalOptions;
        }
    }
    if (!value && action !== "song-info") {
        return reply(interaction, `Usage: \`${interaction.commandName || action} <search term>\`.`);
    }
    const player = await requireMusicAction(interaction, client, "seek");
    if (!player) return;
    const query = value || player.current?.info?.uri;
    if (!query) return reply(interaction, "There is no current track to inspect.");

    const result = await client.riffy.resolve({
        query: query.trim(),
        source: "spsearch",
        requester: interaction.user,
    });
    const track = result?.tracks?.[0];
    if (!track) return reply(interaction, `No information found for **${query}**.`);
    const info = track.info || {};
    if (action === "song-info") {
        return reply(interaction, `**${info.title || "Unknown track"}**\nArtist: ${info.author || "Unknown"}\nDuration: ${formatDuration(info.length)}\n${info.uri || ""}`);
    }
    if (action === "album-info") {
        return reply(interaction, `**Album information**\n${info.album || "The Lavalink source did not provide album metadata."}\nArtist: ${info.author || "Unknown"}\n${info.uri || ""}`);
    }
    if (action === "artist-info") {
        return reply(interaction, `**Artist information**\n${info.author || "Unknown artist"}\nRelated result: ${getTrackLink(track)}`);
    }
}

async function executeFeature(action, interaction, client) {
    const value = getValue(interaction);
    if (action === "vote-skip") {
        const skipCommand = require("./skip");
        interaction.forceVoteSkip = true;
        try {
            return await skipCommand.execute(interaction, client);
        } finally {
            delete interaction.forceVoteSkip;
        }
    }
    const infoActions = new Set([
        "top-songs", "save", "next-up", "upcoming", "requested",
        "recently-played", "queue-info", "session-statistics",
        "session-information",
    ]);
    if (["song-info", "album-info", "artist-info", "searchlyrics"].includes(action)) {
        return executeMetadata(action, interaction, client, value);
    }
    if (infoActions.has(action)) {
        if (action === "top-songs" || action === "recently-played") {
            return executeInformation(action, interaction, client, null, value);
        }
        const player = await requireMusicAction(interaction, client, "seek");
        if (!player) return;
        return executeInformation(action, interaction, client, player, value);
    }
    const player = await requireMusicAction(interaction, client, requiredPermission(action));
    if (!player) return;
    if (["pause", "resume", "forward", "backward", "end-time", "start-time"].includes(action)) {
        return executeTrackState(action, interaction, player, value);
    }
    return executeQueueAction(action, interaction, client, player, value);
}

const commands = COMMANDS.map(([name, description, prefix]) => {
    const command = {
        data: new SlashCommandBuilder()
            .setName(name)
            .setDescription(description)
            .addStringOption((option) =>
                option
                    .setName("value")
                    .setDescription("Position, time, user, or option")
                    .setRequired(false)
            ),
        async execute(interaction, client) {
            return executeFeature(name, interaction, client);
        },
    };
    command.aliases = prefix.includes(" ") || prefix === name ? [] : [prefix];
    return command;
});

module.exports = {
    commands,
    multiWordAliases: MULTI_WORD_ALIASES,
};
