const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";
const SPOTIFY_PLAYLISTS_URL = "https://api.spotify.com/v1/playlists";
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

async function getSpotifyAccessToken() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        const error = new Error(
            "Spotify playlist search requires Spotify client credentials."
        );
        error.code = "SPOTIFY_CREDENTIALS_MISSING";
        throw error;
    }

    const response = await fetch(SPOTIFY_TOKEN_URL, {
        method: "POST",
        headers: {
            Authorization: `Basic ${Buffer.from(
                `${clientId}:${clientSecret}`
            ).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
        signal: AbortSignal.timeout(10000),
    });
    const tokenResponse = await readJsonResponse(response, "token request");
    if (typeof tokenResponse.access_token !== "string") {
        throw new Error("Spotify token response did not include an access token.");
    }
    return tokenResponse.access_token;
}

async function searchSpotifyPlaylists(query, limit = 50) {
    const accessToken = await getSpotifyAccessToken();
    const params = new URLSearchParams({
        q: query.trim(),
        type: "playlist",
        limit: String(Math.min(Math.max(Math.trunc(limit), 1), 50)),
    });
    const response = await fetch(`${SPOTIFY_SEARCH_URL}?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10000),
    });
    const searchResponse = await readJsonResponse(response, "playlist search");
    const items = searchResponse.playlists?.items;
    if (!Array.isArray(items)) {
        throw new Error("Spotify playlist search response had no playlist results.");
    }

    return items
        .filter(
            (playlist) =>
                playlist?.id &&
                playlist?.external_urls?.spotify &&
                playlist.is_playable !== false
        )
        .map((playlist) => ({
            id: playlist.id,
            name: playlist.name || "Untitled playlist",
            url: playlist.external_urls.spotify,
            owner: playlist.owner?.display_name || null,
            trackCount: Number(playlist.tracks?.total) || 0,
            artworkUrl: playlist.images?.[0]?.url || null,
        }));
}

async function findExactSpotifyTrack(query) {
    const searchTerm = String(query || "").trim();
    if (!searchTerm) return null;

    const accessToken = await getSpotifyAccessToken();
    const params = new URLSearchParams({
        q: searchTerm,
        type: "track",
        limit: "10",
    });
    const response = await fetch(`${SPOTIFY_SEARCH_URL}?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10000),
    });
    const searchResponse = await readJsonResponse(response, "track search");
    const items = searchResponse.tracks?.items;
    if (!Array.isArray(items)) {
        throw new Error("Spotify track search response had no track results.");
    }

    const exactTrack = items.find(
        (track) =>
            track?.name?.trim().toLowerCase() === searchTerm.toLowerCase() &&
            track.is_playable !== false &&
            track.artists?.some((artist) => artist?.name?.trim())
    );
    if (!exactTrack) return null;

    return {
        name: exactTrack.name.trim(),
        artist: exactTrack.artists
            .map((artist) => artist?.name?.trim())
            .filter(Boolean)
            .join(" "),
    };
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
        return segments[0] === "playlist" && /^[a-z0-9]+$/i.test(segments[1] || "")
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
    const oembedPromise = fetch(
        `${SPOTIFY_OEMBED_URL}?${new URLSearchParams({ url: canonicalUrl })}`,
        { signal: AbortSignal.timeout(10000) }
    )
        .then((response) =>
            readJsonResponse(response, "playlist oEmbed lookup")
        )
        .then(
            (metadata) => ({ metadata }),
            (error) => ({ error })
        );

    let spotifyMetadata = null;
    let spotifyApiError = null;
    try {
        const accessToken = await getSpotifyAccessToken();
        const response = await fetch(
            `${SPOTIFY_PLAYLISTS_URL}/${encodeURIComponent(playlistId)}`,
            {
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(10000),
            }
        );
        const playlist = await readJsonResponse(response, "playlist lookup");
        spotifyMetadata = {
            id: playlist.id || playlistId,
            name: playlist.name || null,
            url:
                playlist.external_urls?.spotify || canonicalUrl,
            artworkUrl: playlist.images?.[0]?.url || null,
            trackCount: Number(playlist.tracks?.total) || 0,
        };
    } catch (error) {
        spotifyApiError = error;
    }

    let oembedMetadata = null;
    const oembedResult = await oembedPromise;
    const oembedError = oembedResult.error || null;
    if (!oembedError) {
        const oembed = oembedResult.metadata;
        const thumbnailUrl = oembed.thumbnail_url;
        oembedMetadata = {
            name: oembed.title || null,
            artworkUrl:
                typeof thumbnailUrl === "string" &&
                /^https:\/\//i.test(thumbnailUrl)
                    ? thumbnailUrl
                    : null,
        };
    }

    if (!spotifyMetadata && !oembedMetadata?.artworkUrl) {
        if (spotifyApiError && oembedError) {
            throw new Error(
                `Spotify playlist metadata lookup failed (${spotifyApiError.message}); oEmbed lookup failed (${oembedError.message}).`,
                { cause: spotifyApiError }
            );
        }
        throw (
            spotifyApiError ||
            oembedError ||
            new Error("Spotify playlist metadata did not include artwork.")
        );
    }

    if (spotifyApiError && oembedMetadata?.artworkUrl) {
        console.warn(
            `[euphire] Spotify API playlist lookup failed for ${playlistId}; using oEmbed artwork:`,
            spotifyApiError.message
        );
    }
    if (oembedError && spotifyMetadata?.artworkUrl) {
        console.warn(
            `[euphire] Spotify oEmbed lookup failed for ${playlistId}; using Spotify API artwork:`,
            oembedError.message
        );
    }

    return {
        id: playlistId,
        name: spotifyMetadata?.name || oembedMetadata?.name || null,
        url: spotifyMetadata?.url || canonicalUrl,
        artworkUrl:
            spotifyMetadata?.artworkUrl || oembedMetadata?.artworkUrl || null,
        trackCount: spotifyMetadata?.trackCount || 0,
    };
}

module.exports = {
    searchSpotifyPlaylists,
    findExactSpotifyTrack,
    getSpotifyPlaylistMetadata,
};
