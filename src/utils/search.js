const { Track } = require("riffy/build/structures/Track");

const SUCCESS_TYPES = new Set([
    "search",
    "track",
    "playlist",
    "SEARCH_RESULT",
    "TRACK_LOADED",
    "PLAYLIST_LOADED",
]);

function isHttpUrl(query) {
    return /^https?:\/\//i.test(String(query || "").trim());
}

function pickNode(riffy, node) {
    if (node && typeof node !== "string" && node.rest) return node;
    if (typeof node === "string") {
        const named = riffy.nodeMap.get(node);
        if (named?.connected) return named;
    }
    const main = riffy.nodeMap.get("Main");
    if (main?.connected) return main;
    const nodes = [...riffy.nodeMap.values()];
    return nodes.find(n => n.connected) || nodes[0] || null;
}

function hasTracks(response) {
    if (!response) return false;
    if (response.loadType === "track" && response.data) return true;
    if (response.loadType === "playlist" && response.data?.tracks?.length) return true;
    if (response.loadType === "search" && Array.isArray(response.data) && response.data.length) return true;
    if (Array.isArray(response.tracks) && response.tracks.length) return true;
    return false;
}

function mapTracks(response, requester, node) {
    if (!response) return [];
    if (node.rest.version === "v4") {
        if (response.loadType === "track" && response.data) {
            return [new Track(response.data, requester, node)];
        }
        if (response.loadType === "playlist" && response.data?.tracks) {
            return response.data.tracks.map((track) => new Track(track, requester, node));
        }
        if (response.loadType === "search" && Array.isArray(response.data)) {
            return response.data.map((track) => new Track(track, requester, node));
        }
        return [];
    }
    return response.tracks ? response.tracks.map((track) => new Track(track, requester, node)) : [];
}

function toResult(response, requester, node) {
    const tracks = mapTracks(response, requester, node);
    let playlistInfo = null;
    if (node.rest.version === "v4" && response?.loadType === "playlist") {
        playlistInfo = response.data?.info ?? null;
    } else {
        playlistInfo = response?.playlistInfo ?? null;
    }

    return {
        loadType: response?.loadType ?? "empty",
        exception:
            response?.loadType === "error"
                ? response.data
                : response?.loadType === "LOAD_FAILED"
                  ? response.exception
                  : null,
        playlistInfo,
        pluginInfo: response?.pluginInfo ?? {},
        tracks,
    };
}

function buildIdentifiers(query, source) {
    const trimmed = String(query || "").trim();
    if (!trimmed) return [];
    if (isHttpUrl(trimmed)) return [trimmed];

    const prefixes = [];
    const primary = source || "spsearch";
    prefixes.push(primary);
    for (const extra of ["spsearch", "ytsearch", "ytmsearch", "scsearch"]) {
        if (!prefixes.includes(extra)) prefixes.push(extra);
    }
    return prefixes.map((prefix) => `${prefix}:${trimmed}`);
}

/**
 * Search Lavalink without Riffy's broken fallback that turns
 * "memories" into https://open.spotify.com/track/memories
 */
async function resolveTracks(riffy, { query, source, requester, node } = {}) {
    if (!riffy.initiated) throw new Error("You have to initialize Riffy in your ready event");

    const requestNode = pickNode(riffy, node);
    if (!requestNode) throw new Error("Lavalink node is not available.");

    const identifiers = buildIdentifiers(query, source || riffy.defaultSearchPlatform);
    if (!identifiers.length) {
        return toResult({ loadType: "empty", data: [] }, requester, requestNode);
    }

    let lastResponse = null;

    for (const identifier of identifiers) {
        try {
            riffy.emit("debug", `[euphire] Searching "${identifier}" on node "${requestNode.name}"`);
            const response = await requestNode.rest.makeRequest(
                "GET",
                `/${requestNode.rest.version}/loadtracks?identifier=${encodeURIComponent(identifier)}`
            );
            lastResponse = response;

            if (SUCCESS_TYPES.has(response.loadType) && hasTracks(response)) {
                const result = toResult(response, requester, requestNode);
                riffy.emit(
                    "debug",
                    `[euphire] Search success for "${query}" via ${identifier}, tracks: ${result.tracks.length}`
                );
                return result;
            }
        } catch (err) {
            console.warn(`[euphire] Search identifier failed (${identifier}):`, err.message);
        }
    }

    return toResult(lastResponse || { loadType: "empty", data: [] }, requester, requestNode);
}

function patchRiffyResolve(riffy) {
    riffy.resolve = (options) => resolveTracks(riffy, options);
}

module.exports = {
    resolveTracks,
    patchRiffyResolve,
};
