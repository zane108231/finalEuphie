const USER_AGENT = "Euphie/1.0.0 (https://github.com/euphie-music-bot)";
const BASE_URL = "https://lrclib.net";

/**
 * Clean up title string by removing common video/audio suffixes and noisy tags
 */
function cleanSongTitle(rawTitle) {
    if (!rawTitle) return "";
    let title = String(rawTitle);

    // Remove common video/audio suffixes in brackets/parentheses
    title = title
        .replace(/\((?:official\s*(?:music\s*)?(?:video|audio|visualizer|lyric\s*video)|lyrics?|hd|4k|remastered|explicit|audio)\)/gi, "")
        .replace(/\[(?:official\s*(?:music\s*)?(?:video|audio|visualizer|lyric\s*video)|lyrics?|hd|4k|remastered|explicit|audio)\]/gi, "")
        .replace(/\|\s*(?:official\s*(?:music\s*)?(?:video|audio)|lyrics?\s*video|visualizer)/gi, "")
        .replace(/\s*-\s*(?:official\s*(?:music\s*)?(?:video|audio)|visualizer)/gi, "")
        .trim();

    return title;
}

/**
 * Format a readable song title avoiding duplicate "Song - Artist by Artist" phrases
 */
function formatSongTitle(title, artist) {
    const t = (title || "Unknown Title").trim();
    const a = (artist || "").trim();

    if (!a || a.toLowerCase() === "unknown artist") return t;
    if (t.toLowerCase() === a.toLowerCase()) return t;
    if (t.toLowerCase().endsWith(" by " + a.toLowerCase())) return t;
    if (
        t.toLowerCase().includes(" - " + a.toLowerCase()) ||
        t.toLowerCase().startsWith(a.toLowerCase() + " - ")
    ) {
        return t;
    }

    return `${t} by ${a}`;
}

/**
 * Strip LRC timestamp tags like [01:23.45] from synced lyrics
 */
function stripLrcTimestamps(lrc) {
    if (!lrc) return "";
    return lrc
        .split("\n")
        .map((line) => line.replace(/(?:\[\d{1,2}:\d{2}(?:\.\d{1,3})?\])+/g, "").trim())
        .filter((line, i, arr) => !(line === "" && (i === 0 || arr[i - 1] === "")))
        .join("\n")
        .trim();
}

/**
 * Search songs on LRCLIB
 */
async function searchLrclib(query) {
    if (!query || !query.trim()) return [];

    const cleanQuery = cleanSongTitle(query).trim() || query.trim();
    const url = `${BASE_URL}/api/search?q=${encodeURIComponent(cleanQuery)}`;

    let response;
    try {
        response = await fetch(url, {
            headers: {
                "User-Agent": USER_AGENT,
            },
        });
    } catch (err) {
        console.error(`[LRCLIB] Network error while searching for "${cleanQuery}":`, err.message);
        throw err;
    }

    if (!response.ok) {
        if (response.status === 404) return [];
        throw new Error(`LRCLIB search returned HTTP ${response.status}`);
    }

    const items = await response.json();
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    // Prioritize results that have lyrics available
    const withLyrics = [];
    const withoutLyrics = [];

    for (const item of items) {
        if (item.plainLyrics || item.syncedLyrics) {
            withLyrics.push(item);
        } else {
            withoutLyrics.push(item);
        }
    }

    const sortedItems = [...withLyrics, ...withoutLyrics];
    const seen = new Set();
    const results = [];

    for (const item of sortedItems) {
        const title = (item.trackName || item.name || "").trim();
        const artist = (item.artistName || "Unknown Artist").trim();
        if (!title) continue;

        const key = `${title}::${artist}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
            id: item.id,
            title,
            artist,
            fullTitle: formatSongTitle(title, artist),
            album: item.albumName || null,
            duration: item.duration || null,
            instrumental: Boolean(item.instrumental),
            plainLyrics: item.plainLyrics || null,
            syncedLyrics: item.syncedLyrics || null,
            url: "https://lrclib.net",
        });

        if (results.length >= 10) break;
    }

    return results;
}

/**
 * Resolve plain lyrics text from song record or LRCLIB API
 */
async function getLyrics(songOrId) {
    if (!songOrId) return null;

    const song = typeof songOrId === "object" ? songOrId : { id: songOrId };

    // 1. Direct plainLyrics in memory
    if (song.plainLyrics && song.plainLyrics.trim()) {
        return song.plainLyrics.trim();
    }

    // 2. Synced lyrics in memory fallback
    if (song.syncedLyrics && song.syncedLyrics.trim()) {
        const stripped = stripLrcTimestamps(song.syncedLyrics);
        if (stripped) return stripped;
    }

    // 3. Instrumental in memory
    if (song.instrumental) {
        return "🎼 *This track is instrumental (no lyrics).*";
    }

    // 4. Fetch by LRCLIB ID
    if (song.id) {
        try {
            const res = await fetch(`${BASE_URL}/api/get/${encodeURIComponent(song.id)}`, {
                headers: {
                    "User-Agent": USER_AGENT,
                },
            });

            if (res.ok) {
                const data = await res.json();
                if (data.plainLyrics && data.plainLyrics.trim()) {
                    return data.plainLyrics.trim();
                }
                if (data.syncedLyrics && data.syncedLyrics.trim()) {
                    const stripped = stripLrcTimestamps(data.syncedLyrics);
                    if (stripped) return stripped;
                }
                if (data.instrumental) {
                    return "🎼 *This track is instrumental (no lyrics).*";
                }
            }
        } catch (err) {
            console.error(`[LRCLIB] Failed to fetch lyrics for ID ${song.id}:`, err.message);
        }
    }

    // 5. Fallback fetch by track title and artist
    if (song.title && song.artist && song.artist.toLowerCase() !== "unknown artist") {
        try {
            const url = `${BASE_URL}/api/get?track_name=${encodeURIComponent(song.title)}&artist_name=${encodeURIComponent(song.artist)}`;
            const res = await fetch(url, {
                headers: {
                    "User-Agent": USER_AGENT,
                },
            });

            if (res.ok) {
                const data = await res.json();
                if (data.plainLyrics && data.plainLyrics.trim()) {
                    return data.plainLyrics.trim();
                }
                if (data.syncedLyrics && data.syncedLyrics.trim()) {
                    const stripped = stripLrcTimestamps(data.syncedLyrics);
                    if (stripped) return stripped;
                }
                if (data.instrumental) {
                    return "🎼 *This track is instrumental (no lyrics).*";
                }
            }
        } catch (err) {
            console.error(`[LRCLIB] Failed to fetch lyrics by signature:`, err.message);
        }
    }

    return null;
}

/**
 * Split lyrics into pages if too long for a single embed
 */
function splitLyricsIntoPages(lyrics, maxPageChars = 1800) {
    if (!lyrics) return [];
    if (lyrics.length <= maxPageChars) return [lyrics.trim()];

    const pages = [];
    const lines = lyrics.split("\n");
    let currentPage = "";

    for (let line of lines) {
        while (line.length > maxPageChars) {
            if (currentPage.length > 0) {
                pages.push(currentPage.trim());
                currentPage = "";
            }
            pages.push(line.slice(0, maxPageChars));
            line = line.slice(maxPageChars);
        }

        if ((currentPage + "\n" + line).length > maxPageChars && currentPage.length > 0) {
            pages.push(currentPage.trim());
            currentPage = line;
        } else {
            currentPage = currentPage ? currentPage + "\n" + line : line;
        }
    }

    if (currentPage.trim()) {
        pages.push(currentPage.trim());
    }

    return pages.length ? pages : [lyrics.trim()];
}

module.exports = {
    cleanSongTitle,
    formatSongTitle,
    stripLrcTimestamps,
    searchLrclib,
    getLyrics,
    splitLyricsIntoPages,
};
