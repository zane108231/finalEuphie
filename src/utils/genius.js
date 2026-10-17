const cheerio = require("cheerio");
const config = require("../../config");

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Clean up title string by removing video/audio tags and noise
 */
function cleanSongTitle(rawTitle) {
    if (!rawTitle) return "";
    let title = String(rawTitle);

    // Remove common video/audio suffixes in brackets/parentheses
    title = title
        .replace(/\((?:official\s*(?:music\s*)?(?:video|audio|visualizer|lyric\s*video)|lyrics?|hd|4k|remastered|explicit|audio)\)/gi, "")
        .replace(/\[(?:official\s*(?:music\s*)?(?:video|audio|visualizer|lyric\s*video)|lyrics?|hd|4k|remastered|explicit|audio)\]/gi, "")
        .replace(/\|\s*(?:official\s*(?:music\s*)?(?:video|audio)|lyrics? video|visualizer)/gi, "")
        .replace(/\s*-\s*(?:official\s*(?:music\s*)?(?:video|audio)|visualizer)/gi, "")
        .trim();

    return title;
}

/**
 * Search songs on Genius using API or fallback
 */
async function searchGenius(query, customApiKey = null) {
    const apiKey = customApiKey || process.env.GENIUS_API_KEY || process.env.GENIUS_ACCESS_TOKEN || config.geniusApiKey;

    if (apiKey) {
        try {
            const apiUrl = `https://api.genius.com/search?q=${encodeURIComponent(query)}&per_page=10`;
            const res = await fetch(apiUrl, {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "User-Agent": USER_AGENT,
                },
            });

            if (res.ok) {
                const data = await res.json();
                const hits = data?.response?.hits || [];
                const results = hits
                    .filter((h) => h.type === "song" && h.result)
                    .map((h) => ({
                        id: h.result.id,
                        title: h.result.title,
                        artist: h.result.primary_artist?.name || "Unknown Artist",
                        fullTitle: h.result.full_title || `${h.result.title} by ${h.result.primary_artist?.name || "Unknown Artist"}`,
                        url: h.result.url,
                        thumbnail: h.result.song_art_image_thumbnail_url || h.result.header_image_thumbnail_url || null,
                    }));

                if (results.length > 0) {
                    return results.slice(0, 10);
                }
            } else {
                console.warn(`[Genius] API search failed with status ${res.status}, trying fallback`);
            }
        } catch (err) {
            console.warn("[Genius] API search error, trying fallback:", err.message);
        }
    }

    // Fallback search
    try {
        const fallbackUrl = `https://genius.com/api/search/song?q=${encodeURIComponent(query)}&per_page=10`;
        const res = await fetch(fallbackUrl, {
            headers: {
                "User-Agent": USER_AGENT,
            },
        });

        if (res.ok) {
            const data = await res.json();
            const hits = data?.response?.sections?.[0]?.hits || [];
            return hits
                .filter((h) => h.type === "song" && h.result)
                .map((h) => ({
                    id: h.result.id,
                    title: h.result.title,
                    artist: h.result.primary_artist?.name || "Unknown Artist",
                    fullTitle: h.result.full_title || `${h.result.title} by ${h.result.primary_artist?.name || "Unknown Artist"}`,
                    url: h.result.url,
                    thumbnail: h.result.song_art_image_thumbnail_url || h.result.header_image_thumbnail_url || null,
                }))
                .slice(0, 10);
        }
    } catch (err) {
        console.error("[Genius] Fallback search error:", err.message);
    }

    return [];
}

/**
 * Fetch and extract lyrics from Genius song URL
 */
async function getLyrics(geniusUrl) {
    if (!geniusUrl) return null;

    try {
        const res = await fetch(geniusUrl, {
            headers: {
                "User-Agent": USER_AGENT,
            },
        });

        if (!res.ok) {
            console.error(`[Genius] Failed to fetch lyrics page: ${res.status}`);
            return null;
        }

        const html = await res.text();
        const $ = cheerio.load(html);

        // Remove non-lyric elements
        $("script, style").remove();
        $('[data-exclude-from-selection="true"]').remove();
        $('[class*="LyricsHeader"]').remove();
        $("br").replaceWith("\n");

        let lyricsList = [];
        $('[data-lyrics-container="true"]').each((_, elem) => {
            lyricsList.push($(elem).text().trim());
        });

        let fullLyrics = lyricsList.join("\n\n");

        if (!fullLyrics) {
            // Older Genius layout fallback
            const oldLyrics = $(".lyrics").text().trim();
            if (oldLyrics) fullLyrics = oldLyrics;
        }

        if (!fullLyrics) return null;

        fullLyrics = fullLyrics
            .replace(/\[/g, "\n[")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/Embed$/i, "")
            .trim();

        return fullLyrics;
    } catch (err) {
        console.error("[Genius] Error scraping lyrics:", err.message);
        return null;
    }
}

/**
 * Split lyrics into pages if too long for a single embed
 */
function splitLyricsIntoPages(lyrics, maxPageChars = 1800) {
    if (!lyrics) return [];
    if (lyrics.length <= maxPageChars) return [lyrics];

    const pages = [];
    const lines = lyrics.split("\n");
    let currentPage = "";

    for (const line of lines) {
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

    return pages.length ? pages : [lyrics];
}

module.exports = {
    cleanSongTitle,
    searchGenius,
    getLyrics,
    splitLyricsIntoPages,
};
