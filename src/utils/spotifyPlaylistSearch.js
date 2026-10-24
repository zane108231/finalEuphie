const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";

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

module.exports = { searchSpotifyPlaylists };
