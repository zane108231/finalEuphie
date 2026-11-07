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

function normalizeSpotifyUrl(query) {
    const trimmed = String(query || "").trim();
    if (!isHttpUrl(trimmed)) return trimmed;

    try {
        const url = new URL(trimmed);
        if (url.hostname !== "open.spotify.com" && url.hostname !== "www.open.spotify.com") {
            return trimmed;
        }

        const segments = url.pathname.split("/").filter(Boolean);
        if (/^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0] || "")) {
            segments.shift();
        }
        if (
            segments.length >= 2 &&
            ["track", "playlist", "album", "artist", "episode", "show"].includes(segments[0])
        ) {
            return `https://open.spotify.com/${segments[0]}/${segments[1]}`;
        }
    } catch {
        return trimmed;
    }

    return trimmed;
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
    if (isHttpUrl(trimmed)) return [normalizeSpotifyUrl(trimmed)];

    const primary = source || "spsearch";
    if (primary === "ytsearch") {
        const plainQuery = trimmed.replace(/\s+(?:lyrics?|lyric\s+video)$/i, "").trim();
        const queries = [
            /\blyrics?\b/i.test(trimmed) ? trimmed : `${trimmed} lyrics`,
            plainQuery,
        ].filter((value, index, values) => value && values.indexOf(value) === index);
        return queries.flatMap((searchQuery) =>
            ["ytsearch", "ytmsearch"].map(
                (prefix) => `${prefix}:${searchQuery}`
            )
        );
    }

    const prefixes = [primary];
    for (const extra of ["spsearch", "ytsearch", "ytmsearch", "scsearch"]) {
        if (!prefixes.includes(extra)) prefixes.push(extra);
    }
    return prefixes.map((prefix) => `${prefix}:${trimmed}`);
}

function rankSearchTracks(tracks, query) {
    const queryWords = normalizeSearchText(query)
        .split(" ")
        .filter((word) => !["by", "lyrics", "lyric", "video", "official", "audio"].includes(word));
    if (!queryWords.length) return tracks;

    return tracks
        .map((track, index) => {
            const title = normalizeSearchText(track.info?.title || "");
            const author = normalizeSearchText(track.info?.author || "");
            const candidateWords = new Set(`${title} ${author}`.split(" "));
            const titleWords = new Set(title.split(" "));
            const matchedWords = queryWords.filter((word) => candidateWords.has(word));
            const titleMatches = queryWords.filter((word) => titleWords.has(word));
            const minimumMatches = Math.max(1, Math.ceil(queryWords.length * 0.6));
            const isLyrics = /\b(lyrics?|with lyrics)\b/.test(title);
            const officialAudioPenalty = /\bofficial audio\b/.test(title) ? 4 : 0;

            return {
                track,
                index,
                isLyrics,
                score:
                    matchedWords.length * 4 +
                    titleMatches.length * 2 +
                    -officialAudioPenalty,
                relevant: matchedWords.length >= minimumMatches,
            };
        })
        .filter((candidate) => candidate.relevant)
        .sort(
            (left, right) =>
                Number(right.isLyrics) - Number(left.isLyrics) ||
                right.score - left.score ||
                left.index - right.index
        )
        .map((candidate) => candidate.track);
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
    let rejectedSearchResults = false;
    let fallbackSearchResult = null;

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
                if (/^(ytsearch|ytmsearch):/i.test(identifier)) {
                    result.tracks = rankSearchTracks(result.tracks, identifier.replace(/^[^:]+:/, ""));
                    if (!result.tracks.length) {
                        rejectedSearchResults = true;
                        continue;
                    }
                    const lyricResults = result.tracks.filter((track) =>
                        /\b(lyrics?|with lyrics)\b/i.test(track.info?.title || "")
                    );
                    if (lyricResults.length) {
                        result.tracks = lyricResults;
                        riffy.emit(
                            "debug",
                            `[euphire] Search success for "${query}" via ${identifier}, lyric tracks: ${result.tracks.length}`
                        );
                        return result;
                    }
                    if (!fallbackSearchResult) {
                        fallbackSearchResult = result;
                    }
                    continue;
                }
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

    if (fallbackSearchResult) {
        riffy.emit(
            "debug",
            `[euphire] No lyric result found for "${query}"; using the best matching non-lyric result`
        );
        return fallbackSearchResult;
    }

    if (
        rejectedSearchResults &&
        /^(ytsearch|ytmsearch)$/i.test(source || riffy.defaultSearchPlatform)
    ) {
        return toResult({ loadType: "empty", data: [] }, requester, requestNode);
    }

    return toResult(lastResponse || { loadType: "empty", data: [] }, requester, requestNode);
}

async function searchYoutubeTrack(riffy, track, requester, node) {
    const requestNode = pickNode(riffy, node);
    if (!requestNode) throw new Error("Lavalink node is not available.");

    const title = track?.info?.title?.trim();
    const author = track?.info?.author?.trim();
    if (!title) return null;

    const queries = [
        [title, author, "lyrics"],
        [author, title, "lyrics"],
        [title, author, "lyric video"],
        [author, title],
    ].map((parts) => parts.filter(Boolean).join(" "));
    const titleWords = normalizeSearchText(title).split(" ").filter(Boolean);
    const artistWords = normalizeSearchText(author || "").split(" ").filter(Boolean);
    let bestLyricMatch = null;
    let bestLyricScore = Number.NEGATIVE_INFINITY;
    let bestFallbackMatch = null;
    let bestFallbackScore = Number.NEGATIVE_INFINITY;

    for (const query of [...new Set(queries)]) {
        const response = await requestNode.rest.makeRequest(
            "GET",
            `/${requestNode.rest.version}/loadtracks?identifier=${encodeURIComponent(`ytsearch:${query}`)}`
        );
        const result = toResult(response, requester, requestNode);

        for (const candidate of result.tracks) {
            const candidateTitle = normalizeSearchText(candidate.info.title || "");
            const candidateAuthor = normalizeSearchText(candidate.info.author || "");
            const combined = `${candidateTitle} ${candidateAuthor}`;
            const matchedTitleWords = titleWords.filter((word) =>
                candidateTitle.includes(word)
            ).length;
            const titleMatch = titleWords.length
                ? matchedTitleWords / titleWords.length
                : 0;
            const artistMatch = artistWords.length
                ? artistWords.filter((word) => combined.includes(word)).length /
                  artistWords.length
                : 1;
            if (titleMatch < 0.6 || (artistWords.length && artistMatch < 0.5)) {
                continue;
            }

            const isLyrics = /\b(lyrics?|with lyrics)\b/.test(candidateTitle);
            const isOfficialAudio = /\bofficial audio\b/.test(candidateTitle);

            const score =
                titleMatch * 10 +
                artistMatch * 4 +
                (isLyrics ? 8 : 0) -
                (isOfficialAudio ? 4 : 0);
            if (isLyrics && score > bestLyricScore) {
                bestLyricMatch = candidate;
                bestLyricScore = score;
            } else if (!isLyrics && score > bestFallbackScore) {
                bestFallbackMatch = candidate;
                bestFallbackScore = score;
            }
        }

        if (
            bestLyricMatch &&
            /\b(lyrics?|with lyrics)\b/.test(
                normalizeSearchText(bestLyricMatch.info.title)
            )
        ) {
            return bestLyricMatch;
        }
    }

    return bestLyricMatch || bestFallbackMatch;
}

function normalizeSearchText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/([a-z])([0-9])/g, "$1 $2")
        .replace(/([0-9])([a-z])/g, "$1 $2")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function getTrackDisplayName(track) {
    const { title, author } = getTrackDisplayParts(track);
    return author === "Unknown artist" ? title : `${title} by ${author}`;
}

function getTrackDisplayParts(track) {
    const sourceName = String(track?.info?.sourceName || "").toLowerCase();
    if (sourceName === "youtube" || sourceName === "youtube music") {
        const parsed = parseVideoDisplayMetadata(track.info.title);
        return {
            title: track.info.displayTitle || parsed.title,
            author: track.info.displayAuthor || parsed.author,
        };
    }

    return {
        title: cleanDisplayTitle(
            track?.info?.displayTitle || track?.info?.title || "Unknown track"
        ),
        author: cleanDisplayArtist(
            track?.info?.displayAuthor || track?.info?.author || "Unknown artist"
        ),
    };
}

function getSpotifyTrackUrl(track) {
    const info = track?.info || {};
    const sourceName = String(info.sourceName || "").toLowerCase();
    const rawUri = String(info.spotifyUrl || (sourceName === "spotify" ? info.uri || "" : ""));

    if (/^https?:\/\//i.test(rawUri)) {
        try {
            const url = new URL(rawUri);
            if (
                ["open.spotify.com", "www.open.spotify.com"].includes(url.hostname) &&
                /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/[a-z0-9]+$/i.test(
                    url.pathname
                )
            ) {
                const trackId = url.pathname.split("/").filter(Boolean).pop();
                return `https://open.spotify.com/track/${trackId}`;
            }
        } catch {
            return null;
        }
    }
    const spotifyUri = rawUri.match(/^spotify:track:([a-z0-9]+)$/i);
    if (spotifyUri) {
        return `https://open.spotify.com/track/${spotifyUri[1]}`;
    }
    return null;
}

function getSpotifyArtwork(track) {
    const info = track?.info || {};
    const candidates = [
        info.artworkUrl,
        info._cachedThumbnail,
        track?.pluginInfo?.artworkUrl,
        track?.pluginInfo?.thumbnail,
    ];
    for (const artwork of candidates) {
        if (typeof artwork === "string" && /^https?:\/\//i.test(artwork)) {
            return artwork;
        }
    }

    try {
        const thumbnail = info.thumbnail;
        return typeof thumbnail === "string" && /^https?:\/\//i.test(thumbnail)
            ? thumbnail
            : null;
    } catch (error) {
        return null;
    }
}

async function findSpotifyTrackMetadata(riffy, track, requester) {
    const existingUrl = getSpotifyTrackUrl(track);
    if (existingUrl) {
        return {
            url: existingUrl,
            artworkUrl:
                track?.info?.spotifyArtworkUrl ||
                (String(track?.info?.sourceName || "").toLowerCase() ===
                "spotify"
                    ? getSpotifyArtwork(track)
                    : null),
        };
    }

    const { title, author } = getTrackDisplayParts(track);
    if (!title || title === "Unknown track" || author === "Unknown artist") {
        return { url: null, artworkUrl: null };
    }

    try {
        const result = await resolveTracks(riffy, {
            query: `${title} ${author}`,
            source: "spsearch",
            requester,
            node: track?.node,
        });
        const rankedTracks = rankSearchTracks(result.tracks, `${title} ${author}`);
        const spotifyTrack = rankedTracks.find(
            (candidate) =>
                String(candidate.info?.sourceName || "").toLowerCase() === "spotify" &&
                getSpotifyTrackUrl(candidate)
        );
        return {
            url: getSpotifyTrackUrl(spotifyTrack),
            artworkUrl: getSpotifyArtwork(spotifyTrack),
        };
    } catch (error) {
        console.warn(
            `[euphire] Could not resolve Spotify link for "${title} by ${author}":`,
            error.message
        );
        return { url: null, artworkUrl: null };
    }
}

async function findSpotifyTrackUrl(riffy, track, requester) {
    const metadata = await findSpotifyTrackMetadata(riffy, track, requester);
    return metadata.url;
}

function setTrackDisplayMetadata(track, query) {
    if (!track?.info) return track;

    const queryMatch = String(query || "").trim().match(/^(.+?)\s+by\s+(.+)$/i);
    if (queryMatch) {
        track.info.displayTitle = formatDisplayTitle(queryMatch[1]);
        track.info.displayAuthor = formatDisplayArtist(queryMatch[2]);
        return track;
    }

    const sourceName = String(track.info.sourceName || "").toLowerCase();
    if (sourceName === "youtube" || sourceName === "youtube music") {
        const parsed = parseVideoDisplayMetadata(track.info.title, query);
        track.info.displayTitle = parsed.title;
        track.info.displayAuthor = parsed.author;
        return track;
    }

    track.info.displayTitle = cleanDisplayTitle(track.info.title);
    track.info.displayAuthor = cleanDisplayArtist(track.info.author);
    return track;
}

function parseVideoDisplayMetadata(videoTitle, query = "") {
    const cleanTitle = cleanDisplayTitle(videoTitle);
    const parts = cleanTitle
        .split(/\s+[-–—]\s+/)
        .map((part) => cleanDisplayTitle(part))
        .filter(Boolean);

    if (parts.length >= 2) {
        const queryWords = normalizeSearchText(query)
            .split(" ")
            .filter((word) => !["by", "lyrics", "lyric", "video", "official", "audio"].includes(word));
        const leftWords = new Set(normalizeSearchText(parts[0]).split(" "));
        const rightWords = new Set(normalizeSearchText(parts[parts.length - 1]).split(" "));
        const leftFirstMatch = queryWords.findIndex((word) => leftWords.has(word));
        const rightFirstMatch = queryWords.findIndex((word) => rightWords.has(word));
        const titleIndex =
            leftFirstMatch !== -1 &&
            (rightFirstMatch === -1 || leftFirstMatch < rightFirstMatch)
                ? 0
                : parts.length - 1;
        const artistIndex = titleIndex === 0 ? parts.length - 1 : 0;

        return {
            title: formatDisplayTitle(parts[titleIndex]),
            author: formatDisplayArtist(parts[artistIndex]),
        };
    }

    return {
        title: formatDisplayTitle(cleanTitle),
        author: "Unknown artist",
    };
}

function cleanDisplayTitle(value) {
    return String(value || "Unknown track")
        .replace(/\s*[\[(](?:official\s+)?(?:audio|lyrics?|lyric\s+video|music\s+video|visuali[sz]er)[^\])]*[\])]/gi, "")
        .replace(/\s*[-–—]\s*(?:official\s+)?(?:audio|lyrics?|lyric\s+video|music\s+video|visuali[sz]er)\b.*$/i, "")
        .replace(/\p{Extended_Pictographic}/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

function cleanDisplayArtist(value) {
    return String(value || "Unknown artist")
        .replace(/\s*[-–—]\s*(?:official\s+)?(?:audio|lyrics?|lyric\s+video|music\s+video|visuali[sz]er)\b.*$/i, "")
        .replace(/\p{Extended_Pictographic}/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

function formatDisplayArtist(value) {
    const artist = cleanDisplayArtist(value);
    if (/^[a-z0-9]{2,4}$/i.test(artist)) return artist.toUpperCase();
    return artist.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function formatDisplayTitle(value) {
    return cleanDisplayTitle(value)
        .toLowerCase()
        .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function patchRiffyResolve(riffy) {
    riffy.resolve = (options) => resolveTracks(riffy, options);
}

module.exports = {
    resolveTracks,
    searchYoutubeTrack,
    patchRiffyResolve,
    normalizeSpotifyUrl,
    buildIdentifiers,
    rankSearchTracks,
    getTrackDisplayName,
    getTrackDisplayParts,
    getSpotifyTrackUrl,
    findSpotifyTrackUrl,
    findSpotifyTrackMetadata,
    setTrackDisplayMetadata,
};
