const crypto = require('crypto');

const API_KEY = process.env.LASTFM_API_KEY;
const API_SECRET = process.env.LASTFM_API_SECRET;
const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';

/**
 * Generate MD5 hash for Last.fm API signatures
 */
function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * Generate API signature for Last.fm requests
 */
function generateSignature(params) {
    // Sort keys alphabetically
    const sortedKeys = Object.keys(params).sort();
    let signatureStr = '';
    for (const key of sortedKeys) {
        signatureStr += key + params[key];
    }
    signatureStr += API_SECRET;
    return md5(signatureStr);
}

/**
 * Create a user agent string for Last.fm API
 */
function getUserAgent() {
    return 'Euphie/1.0';
}

/**
 * Make a request to Last.fm API
 */
async function lastfmRequest(params, method = 'GET') {
    if (!API_KEY || !API_SECRET) {
        console.error('[Last.fm] API key or secret not configured');
        return null;
    }

    params.api_key = API_KEY;
    params.format = 'json';

    // Add signature if this is an authenticated request
    // Exclude 'format' from signature generation
    if (params.sk || params.token) {
        const paramsForSig = { ...params };
        delete paramsForSig.format;
        params.api_sig = generateSignature(paramsForSig);
    }

    const url = new URL(BASE_URL);
    if (method === 'GET') {
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.append(key, value);
        }
    }

    try {
        const response = await fetch(url.toString(), {
            method: method,
            headers: {
                'User-Agent': getUserAgent(),
                ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
            },
            body: method === 'POST' ? new URLSearchParams(params).toString() : undefined
        });

        const data = await response.json();
        if (data.error) {
            console.error(`[Last.fm] API Error: ${data.error} - ${data.message}`);
            return null;
        }
        return data;
    } catch (error) {
        console.error('[Last.fm] Request failed:', error.message);
        return null;
    }
}

/**
 * Get an authentication token for a user
 */
async function getAuthToken() {
    const params = { method: 'auth.gettoken' };
    const response = await lastfmRequest(params);
    return response?.token;
}

/**
 * Get the authorization URL for a user
 */
function getAuthUrl(token) {
    return `https://www.last.fm/api/auth/?api_key=${API_KEY}&token=${token}`;
}

/**
 * Get a session key for a user (after they've authorized)
 */
async function getSession(token) {
    const params = {
        method: 'auth.getsession',
        token: token
    };
    const response = await lastfmRequest(params);
    return response?.session;
}

/**
 * Update now playing for a user
 */
async function updateNowPlaying(sessionKey, artist, track, album = null, duration = null) {
    const params = {
        method: 'track.updateNowPlaying',
        sk: sessionKey,
        artist: artist,
        track: track,
        duration: duration ? Math.floor(duration / 1000) : undefined
    };

    if (album) {
        params.album = album;
    }

    const response = await lastfmRequest(params, 'POST');
    return response;
}

/**
 * Scrobble a track for a user
 */
async function scrobble(sessionKey, artist, track, album = null, timestamp, duration = null) {
    const params = {
        method: 'track.scrobble',
        sk: sessionKey,
        artist: artist,
        track: track,
        timestamp: Math.floor(timestamp / 1000),
        duration: duration ? Math.floor(duration / 1000) : undefined
    };

    if (album) {
        params.album = album;
    }

    const response = await lastfmRequest(params, 'POST');
    return response;
}

module.exports = {
    getAuthToken,
    getAuthUrl,
    getSession,
    updateNowPlaying,
    scrobble
};
