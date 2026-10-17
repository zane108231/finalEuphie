const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    SectionBuilder,
    ThumbnailBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require("discord.js");
const { ButtonStyle } = require("discord.js");

/**
 * Format milliseconds to mm:ss
 */
function formatDuration(ms) {
    if (!ms || isNaN(ms)) return "0:00";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const FALLBACK_ART = "https://i.imgur.com/4YFmJMi.png";

function safeArtworkUrl(track) {
    const raw = track?.info?.artworkUrl || track?.info?.thumbnail || FALLBACK_ART;
    if (typeof raw !== "string") return FALLBACK_ART;
    const url = raw.trim();
    if (!/^https?:\/\//i.test(url)) return FALLBACK_ART;
    return url;
}

/**
 * Create the "Now Playing" container using Components V2
 * Format for .fmbot scrobbling: "<:spotify:emoji> Started playing [song name]" with clickable Spotify link
 * No image, just the embed message
 */
function createNowPlayingContainer(track, player, guildData, musicardBuffer) {
    const container = new ContainerBuilder();

    const trackTitle = track?.info?.title || "Unknown";
    const trackAuthor = track?.info?.author || "Unknown Artist";
    const trackUri = track?.info?.uri || "";
    const trackSource = track?.info?.sourceName || "spotify";

    // Create Spotify URL from URI if available
    let spotifyUrl = "";
    if (trackUri && trackSource === "spotify") {
        // Check if it's already a full URL
        if (trackUri.startsWith("http")) {
            // Already a URL, just add autoplay parameter if not present
            if (trackUri.includes("?")) {
                spotifyUrl = trackUri;
            } else {
                spotifyUrl = `${trackUri}?autoplay_ok=1`;
            }
        } else if (trackUri.startsWith("spotify:track:")) {
            // Convert Spotify URI to URL
            // URI format: spotify:track:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
            // URL format: https://open.spotify.com/track/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?autoplay_ok=1
            const trackId = trackUri.replace("spotify:track:", "");
            spotifyUrl = `https://open.spotify.com/track/${trackId}?autoplay_ok=1`;
        }
    }

    // Format the message for .fmbot
    // Format: "<:spotify:emoji> Started playing [Song Name • Artist](Spotify URL)"
    let messageContent = `<:spotify:1560296021383184545> Started playing ${trackTitle}`;

    // If we have a Spotify URL, make the song name clickable with artist
    if (spotifyUrl) {
        const displayText = `${trackTitle} • ${trackAuthor}`;
        messageContent = `<:spotify:1560296021383184545> Started playing [${displayText}](${spotifyUrl})`;
    }

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(messageContent)
    );

    // No musicard image - removed as requested

    return container;
}

/**
 * Create queue display container with pagination
 */
function createQueueContainer(queue, currentTrack, page = 0) {
    const container = new ContainerBuilder();
    const pageSize = 10;
    const totalTracks = queue ? queue.length : 0;
    const totalPages = Math.max(1, Math.ceil(totalTracks / pageSize));

    // Clamp page
    if (page < 0) page = 0;
    if (page >= totalPages) page = totalPages - 1;

    // --- Total duration ---
    let totalDuration = 0;
    if (currentTrack && currentTrack.info.length) totalDuration += currentTrack.info.length;
    if (queue && queue.length > 0) {
        for (const t of queue) {
            if (t.info.length) totalDuration += t.info.length;
        }
    }

    // --- Header ---
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `### 📜 Queue\n` +
            `-# ${totalTracks} track${totalTracks !== 1 ? "s" : ""} · ${formatDuration(totalDuration)} total`
        )
    );

    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

    // --- Now Playing ---
    if (currentTrack) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "**🎶 Now Playing**\n\n" +
                `**${(currentTrack.info.title || "Unknown").substring(0, 50)}**\n` +
                `-# ${(currentTrack.info.author || "Unknown Artist").substring(0, 30)} · ${formatDuration(currentTrack.info.length)}`
            )
        );
        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    }

    // --- Queue tracks (numbered like Command Browser) ---
    if (!queue || queue.length === 0) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "**Up Next**\n\n" +
                "-# *No upcoming tracks in queue*"
            )
        );
    } else {
        const start = page * pageSize;
        const end = Math.min(start + pageSize, queue.length);

        let queueText = "**Up Next**\n\n";
        for (let i = start; i < end; i++) {
            const t = queue[i];
            const duration = formatDuration(t.info.length);
            queueText += `**${i + 1}.** ${(t.info.title || "Unknown").substring(0, 45)}\n`;
            queueText += `-# ${(t.info.author || "?").substring(0, 25)} · \`${duration}\`\n\n`;
        }

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(queueText.trim())
        );
    }

    // --- Pagination ---
    if (totalPages > 1) {
        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `-# Page ${page + 1} of ${totalPages} · ${totalTracks} tracks`
            )
        );

        const paginationRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`queue_first`)
                .setEmoji("⏮")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`queue_prev`)
                .setEmoji("◀️")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`queue_page_info`)
                .setLabel(`${page + 1}/${totalPages}`)
                .setStyle(ButtonStyle.Primary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(`queue_next`)
                .setEmoji("▶️")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page >= totalPages - 1),
            new ButtonBuilder()
                .setCustomId(`queue_last`)
                .setEmoji("⏭")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page >= totalPages - 1)
        );

        container.addActionRowComponents(paginationRow);
    }

    return container;
}

function capitalize(str) {
    if (!str) return "None";
    return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = {
    createNowPlayingContainer,
    createQueueContainer,
    formatDuration,
    safeArtworkUrl,
};
