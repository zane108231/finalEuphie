const { startIfIdle } = require("./playback");

const API_KEY = process.env.LASTFM_API_KEY;

function cleanTrackName(title) {
    if (!title) return "";
    return title
        .replace(/\s*[\(\[](?:official\s*video|official\s*audio|official\s*music\s*video|lyrics?|visualizer|video|audio|remastered|hd|4k)[\)\]]/gi, "")
        .replace(/\s*ft\.?.*$/i, "")
        .replace(/\s*feat\.?.*$/i, "")
        .trim();
}

/**
 * Get recommended tracks from diverse similar artists (avoiding the same artist repeatedly)
 */
async function getRecommendations(artist, title, recentTitles = [], recentArtists = []) {
    if (!artist || !title) return [];
    const cleanTitle = cleanTrackName(title);
    const cleanArtist = artist.replace(/\s*-\s*Topic$/i, "").trim();
    const lowerCurrentArtist = cleanArtist.toLowerCase();

    const recentTitlesSet = new Set(recentTitles.map((t) => String(t || "").toLowerCase().trim()));
    const recentArtistsSet = new Set(recentArtists.map((a) => String(a || "").toLowerCase().trim()));
    recentArtistsSet.add(lowerCurrentArtist);

    const candidates = [];

    // 1. Try track.getsimilar (filter out same artist so we don't repeat the same artist)
    if (API_KEY) {
        try {
            const url = `https://ws.audioscrobbler.com/2.0/?method=track.getsimilar&artist=${encodeURIComponent(cleanArtist)}&track=${encodeURIComponent(cleanTitle)}&api_key=${API_KEY}&format=json&limit=15`;
            const res = await fetch(url);
            const data = await res.json();
            const tracks = data?.similartracks?.track;
            if (Array.isArray(tracks) && tracks.length > 0) {
                for (const t of tracks) {
                    const tName = t.name;
                    const aName = (t.artist?.name || "").trim();
                    const lowerAName = aName.toLowerCase();
                    // Prioritize other artists to provide a diverse radio experience
                    if (tName && aName && lowerAName !== lowerCurrentArtist && !recentTitlesSet.has(tName.toLowerCase())) {
                        candidates.push({ title: tName, artist: aName });
                    }
                }
            }
        } catch (err) {
            console.error("[euphire] [Autoplay] track.getsimilar error:", err.message);
        }

        // 2. Query artist.getsimilar to find peer / similar artists and their top tracks
        if (candidates.length < 5) {
            try {
                const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(cleanArtist)}&api_key=${API_KEY}&format=json&limit=8`;
                const res = await fetch(url);
                const data = await res.json();
                const similarArtists = data?.similarartists?.artist || [];
                for (const sim of similarArtists) {
                    const simName = (sim.name || "").trim();
                    if (!simName || simName.toLowerCase() === lowerCurrentArtist) continue;

                    // Fetch top 2 tracks for this similar artist
                    try {
                        const tUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.gettoptracks&artist=${encodeURIComponent(simName)}&api_key=${API_KEY}&format=json&limit=2`;
                        const tRes = await fetch(tUrl);
                        const tData = await tRes.json();
                        const topTracks = tData?.toptracks?.track || [];
                        for (const t of topTracks) {
                            const tName = t.name;
                            if (tName && !recentTitlesSet.has(tName.toLowerCase())) {
                                candidates.push({ title: tName, artist: simName });
                            }
                        }
                    } catch {}
                }
            } catch (err) {
                console.error("[euphire] [Autoplay] artist.getsimilar error:", err.message);
            }
        }
    }

    return candidates;
}

/**
 * Trigger autoplay when queue ends.
 * Enqueues a diverse recommended track and starts playback without an extra announcement embed.
 * The standard "Started playing" player UI will naturally display on trackStart.
 */
async function handleAutoplay(client, player, guildData) {
    if (!guildData?.autoplay) return false;
    if (!player || !player.voiceChannel) return false;

    console.log(`[euphire] Autoplay triggered for guild ${player.guildId}`);

    // Determine the last played track
    const lastTrack =
        player.previous ||
        player.current ||
        (Array.isArray(guildData.previousTracks) && guildData.previousTracks.length > 0
            ? guildData.previousTracks[guildData.previousTracks.length - 1]
            : null);

    if (!lastTrack?.info) {
        console.log("[euphire] Autoplay: no previous track found to generate recommendations from");
        return false;
    }

    const recentTitles = (guildData.previousTracks || [])
        .map((t) => t.info?.title || t.title)
        .filter(Boolean);
    if (lastTrack.info.title) recentTitles.push(lastTrack.info.title);

    const recentArtists = (guildData.previousTracks || [])
        .map((t) => t.info?.author || t.author)
        .filter(Boolean);
    if (lastTrack.info.author) recentArtists.push(lastTrack.info.author);

    let artist = lastTrack.info.author || "";
    let title = lastTrack.info.title || "";

    if ((!artist || artist === "Unknown" || artist.includes("- Topic")) && title.includes(" - ")) {
        const parts = title.split(" - ");
        artist = parts[0].trim();
        title = parts.slice(1).join(" - ").trim();
    }

    const lowerCurrentArtist = artist.toLowerCase().trim();
    const candidates = await getRecommendations(artist, title, recentTitles, recentArtists);

    let chosenTrack = null;

    // Try resolving candidates via Riffy (spsearch)
    for (const cand of candidates) {
        try {
            const query = `${cand.title} ${cand.artist}`;
            const res = await client.riffy.resolve({
                query: query,
                source: "spsearch",
                requester: client.user,
            });
            if (res?.tracks?.length > 0) {
                // Pick track ensuring it's not the same artist
                const valid = res.tracks.find(
                    (t) => (t.info?.author || "").toLowerCase().trim() !== lowerCurrentArtist
                ) || res.tracks[0];

                if (valid) {
                    chosenTrack = valid;
                    break;
                }
            }
        } catch (err) {
            // continue searching next candidate
        }
    }

    // Fallback: search Spotify radio for similar artist songs
    if (!chosenTrack && artist) {
        try {
            const res = await client.riffy.resolve({
                query: `${artist} radio`,
                source: "spsearch",
                requester: client.user,
            });
            if (res?.tracks?.length > 0) {
                // Find a track by a DIFFERENT artist that hasn't been played recently
                const found = res.tracks.find(
                    (t) =>
                        (t.info?.author || "").toLowerCase().trim() !== lowerCurrentArtist &&
                        !recentTitles.some((r) => r.toLowerCase() === t.info?.title?.toLowerCase())
                );
                if (found) chosenTrack = found;
            }
        } catch {}
    }

    if (!chosenTrack) {
        console.log("[euphire] Autoplay: could not resolve any diverse recommendation");
        return false;
    }

    console.log(`[euphire] Autoplay resolved: "${chosenTrack.info.title}" by "${chosenTrack.info.author}"`);

    // Add track to queue and play immediately
    player.queue.add(chosenTrack);
    guildData.cannotSendPlayer = false;
    await startIfIdle(player);

    // No separate announcement message sent as requested.
    // The regular "Started playing" card will display via trackStart.
    return true;
}

module.exports = {
    getRecommendations,
    handleAutoplay,
};
