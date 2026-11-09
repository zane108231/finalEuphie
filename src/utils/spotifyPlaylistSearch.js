const SPOTIFY_OEMBED_URL = "https://open.spotify.com/oembed";

async function readJsonResponse(response, operation) {
    let body;
    try {
        body = await response.json();
    } catch (error) {
        throw new Error(`Spotify ${operation} returned invalid JSON.`, {
            cause: error,
        });
    }

    if (!response.ok) {
        throw new Error(
            `Spotify ${operation} failed with HTTP ${response.status}.`
        );
    }
    return body;
}

function getSpotifyPlaylistId(value) {
    try {
        const url = new URL(value);
        if (
            !["open.spotify.com", "www.open.spotify.com"].includes(
                url.hostname
            )
        ) {
            return null;
        }
        const segments = url.pathname.split("/").filter(Boolean);
        if (/^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0] || "")) {
            segments.shift();
        }
        return segments[0] === "playlist" &&
            /^[a-z0-9]+$/i.test(segments[1] || "")
            ? segments[1]
            : null;
    } catch {
        return null;
    }
}

async function getSpotifyPlaylistMetadata(playlistUrl) {
    const playlistId = getSpotifyPlaylistId(playlistUrl);
    if (!playlistId) return null;

    const canonicalUrl = `https://open.spotify.com/playlist/${playlistId}`;
    const response = await fetch(
        `${SPOTIFY_OEMBED_URL}?${new URLSearchParams({ url: canonicalUrl })}`,
        { signal: AbortSignal.timeout(10000) }
    );
    const oembed = await readJsonResponse(response, "playlist oEmbed lookup");
    const thumbnailUrl = oembed.thumbnail_url;

    return {
        id: playlistId,
        name: oembed.title || null,
        url: canonicalUrl,
        artworkUrl:
            typeof thumbnailUrl === "string" &&
            /^https:\/\//i.test(thumbnailUrl)
                ? thumbnailUrl
                : null,
        trackCount: 0,
    };
}

module.exports = {
    getSpotifyPlaylistId,
    getSpotifyPlaylistMetadata,
};
