
const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

// ============================================================
// EUPHIE PLAYCARD
// ============================================================

const BRAND_LABEL = 'EUPHIE';
const WIDTH = 1024;
const HEIGHT = 695;
const FONT_DIR = path.join(__dirname, 'fonts');

function registerFont(file, family) {
    const p = path.join(FONT_DIR, file);
    if (!fs.existsSync(p)) return false;

    try {
        GlobalFonts.registerFromPath(p, family);
        return true;
    } catch (_) {
        return false;
    }
}

const HAS_BOLD = registerFont('Montserrat-Bold.ttf', 'CardBold');
registerFont('Montserrat-Medium.ttf', 'CardMedium');
const HAS_REGULAR = registerFont('Montserrat-Regular.ttf', 'CardRegular');

const bold = n =>
    `bold ${n}px ${HAS_BOLD ? 'CardBold' : 'Arial'}, sans-serif`;

const regular = n =>
    `${n}px ${HAS_REGULAR ? 'CardRegular' : 'Arial'}, sans-serif`;

const C = {
    bg: '#eef1f2',
    panel: 'rgba(190, 194, 197, 0.47)',
    panelBorder: 'rgba(255,255,255,0.22)',
    text: '#111318',
    muted: '#45484b',
    empty: '#202326',
    watermark: 'rgba(116, 122, 126, 0.30)',
    avatarRing: '#d9dcde',
    avatarFallback: '#000000',
    spotify: '#1db954'
};

const CARD = {
    servers: {
        x: 33, y: 234, w: 469, h: 195,
        title: 'TOP SERVERS'
    },
    friends: {
        x: 522, y: 234, w: 469, h: 195,
        title: 'TOP FRIENDS'
    },
    tracks: {
        x: 33, y: 449, w: 958, h: 208,
        title: 'TOP TRACKS'
    }
};

// ============================================================
// GENERAL HELPERS
// ============================================================

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function fitText(ctx, text, maxWidth, size, min = 16) {
    let n = size;
    ctx.font = bold(n);

    while (n > min && ctx.measureText(text).width > maxWidth) {
        n--;
        ctx.font = bold(n);
    }

    return n;
}

function truncate(ctx, text, maxWidth) {
    text = String(text ?? '');

    if (maxWidth <= 0) return '';
    if (ctx.measureText(text).width <= maxWidth) return text;

    while (
        text.length > 0 &&
        ctx.measureText(text + '…').width > maxWidth
    ) {
        text = text.slice(0, -1);
    }

    return text.trimEnd() + '…';
}

function formatDuration(ms) {
    if (!ms || ms < 0) return '0m';

    const sec = Math.floor(ms / 1000);
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;

    if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
    if (hours) return mins ? `${hours}h ${mins}m` : `${hours}h`;
    if (mins) return seconds ? `${mins}m ${seconds}s` : `${mins}m`;

    return `${seconds}s`;
}

async function loadImageFromURL(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Image request failed: ${response.status}`);
    }

    return loadImage(Buffer.from(await response.arrayBuffer()));
}

// ============================================================
// CAT WATERMARK WITH CONNECTED HEADPHONES
// ============================================================

function drawWatermark(ctx) {
    ctx.save();
    ctx.translate(530, 365);

    const cat = C.watermark;
    const detail = 'rgba(238, 241, 242, 0.65)';

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // --------------------------------------------------------
    // 1. CAT TAIL
    // --------------------------------------------------------

    ctx.fillStyle = cat;
    ctx.beginPath();

    ctx.moveTo(-90, 130);
    ctx.bezierCurveTo(-160, 145, -225, 110, -228, 52);
    ctx.bezierCurveTo(-232, 20, -211, -12, -190, 4);
    ctx.bezierCurveTo(-173, 17, -184, 51, -166, 75);
    ctx.bezierCurveTo(-150, 99, -123, 105, -105, 91);

    ctx.closePath();
    ctx.fill();

    // --------------------------------------------------------
    // 2. CAT HEAD AND BODY
    // --------------------------------------------------------

    ctx.beginPath();

    ctx.moveTo(-110, 150);
    ctx.bezierCurveTo(-139, 92, -119, 18, -78, -28);

    // Left ear
    ctx.lineTo(-112, -148);
    ctx.lineTo(-30, -143);

    // Top of head and right ear
    ctx.lineTo(14, -204);
    ctx.quadraticCurveTo(31, -224, 49, -198);
    ctx.lineTo(88, -140);

    // Head and right cheek
    ctx.quadraticCurveTo(135, -120, 142, -67);
    ctx.bezierCurveTo(158, -7, 140, 52, 120, 90);

    // Body
    ctx.lineTo(129, 139);
    ctx.quadraticCurveTo(89, 158, 53, 137);
    ctx.quadraticCurveTo(12, 176, -24, 151);

    ctx.closePath();
    ctx.fill();

    // --------------------------------------------------------
    // 3. HEADPHONE BAND
    //
    // One continuous arch running from the left connector
    // over the top of the cat's head to the right connector.
    // --------------------------------------------------------

    ctx.strokeStyle = cat;
    ctx.lineWidth = 19;
    ctx.lineCap = 'round';

    ctx.beginPath();

    ctx.ellipse(
        18, -81,
        158, 164,
        0,
        Math.PI * 1.08,
        Math.PI * 1.96
    );

    ctx.stroke();

    // Inner highlight on the band
    ctx.strokeStyle = 'rgba(238, 241, 242, 0.35)';
    ctx.lineWidth = 3.5;

    ctx.beginPath();

    ctx.ellipse(
        18, -81,
        147, 153,
        0,
        Math.PI * 1.105,
        Math.PI * 1.935
    );

    ctx.stroke();

    // --------------------------------------------------------
    // 4. LEFT CONNECTOR
    //
    // The connector overlaps both the band and ear cup.
    // --------------------------------------------------------

    ctx.strokeStyle = cat;
    ctx.lineWidth = 18;
    ctx.lineCap = 'round';

    ctx.beginPath();

    ctx.moveTo(-135, -115);
    ctx.bezierCurveTo(-145, -101, -146, -89, -143, -76);

    ctx.stroke();

    // Left hinge
    ctx.fillStyle = cat;
    ctx.beginPath();
    ctx.arc(-143, -76, 12, 0, Math.PI * 2);
    ctx.fill();

    // --------------------------------------------------------
    // 5. RIGHT CONNECTOR
    // --------------------------------------------------------

    ctx.strokeStyle = cat;
    ctx.lineWidth = 18;

    ctx.beginPath();

    ctx.moveTo(175, -100);
    ctx.bezierCurveTo(178, -86, 176, -73, 170, -62);

    ctx.stroke();

    // Right hinge
    ctx.fillStyle = cat;
    ctx.beginPath();
    ctx.arc(170, -62, 12, 0, Math.PI * 2);
    ctx.fill();

    // --------------------------------------------------------
    // 6. LEFT EAR CUP
    // --------------------------------------------------------

    ctx.fillStyle = cat;
    ctx.beginPath();

    ctx.ellipse(
        -125, -35,
        36, 64,
        -0.35,
        0,
        Math.PI * 2
    );

    ctx.fill();

    // Ear cup outer edge
    ctx.strokeStyle = 'rgba(116, 122, 126, 0.20)';
    ctx.lineWidth = 5;

    ctx.beginPath();

    ctx.ellipse(
        -125, -35,
        36, 64,
        -0.35,
        0,
        Math.PI * 2
    );

    ctx.stroke();

    // Inner padding
    ctx.strokeStyle = detail;
    ctx.lineWidth = 5;

    ctx.beginPath();

    ctx.ellipse(
        -125, -35,
        25, 50,
        -0.35,
        0,
        Math.PI * 2
    );

    ctx.stroke();

    // --------------------------------------------------------
    // 7. RIGHT EAR CUP
    // --------------------------------------------------------

    ctx.fillStyle = cat;
    ctx.beginPath();

    ctx.ellipse(
        154, -52,
        34, 58,
        0.35,
        0,
        Math.PI * 2
    );

    ctx.fill();

    // Ear cup outer edge
    ctx.strokeStyle = 'rgba(116, 122, 126, 0.20)';
    ctx.lineWidth = 5;

    ctx.beginPath();

    ctx.ellipse(
        154, -52,
        34, 58,
        0.35,
        0,
        Math.PI * 2
    );

    ctx.stroke();

    // Inner padding
    ctx.strokeStyle = detail;
    ctx.lineWidth = 5;

    ctx.beginPath();

    ctx.ellipse(
        154, -52,
        23, 45,
        0.35,
        0,
        Math.PI * 2
    );

    ctx.stroke();

    // --------------------------------------------------------
    // 8. FACE DETAILS
    // --------------------------------------------------------

    ctx.strokeStyle = detail;
    ctx.lineWidth = 7;

    ctx.beginPath();
    ctx.ellipse(6, -66, 39, 34, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(73, -69, 25, 31, 0, 0, Math.PI * 2);
    ctx.stroke();

    // --------------------------------------------------------
    // 9. CABLE ACROSS THE BODY
    // --------------------------------------------------------

    ctx.strokeStyle = detail;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';

    ctx.beginPath();

    ctx.moveTo(-56, 106);
    ctx.bezierCurveTo(4, 128, 84, 109, 74, 79);
    ctx.bezierCurveTo(67, 54, 24, 66, -5, 75);

    ctx.stroke();

    ctx.restore();
}

function drawCoverImage(ctx, img, width, height) {
    const imgRatio = img.width / img.height;
    const canvasRatio = width / height;
    let drawW, drawH, drawX, drawY;

    if (imgRatio > canvasRatio) {
        drawH = height;
        drawW = img.width * (height / img.height);
        drawX = (width - drawW) / 2;
        drawY = 0;
    } else {
        drawW = width;
        drawH = img.height * (width / img.width);
        drawX = 0;
        drawY = (height - drawH) / 2;
    }

    ctx.drawImage(img, drawX, drawY, drawW, drawH);
}

async function drawBackground(ctx, backgroundOption = 'default', customColor = null, botAvatarUrl = null, userId = null) {
    // 1. Plain solid color background (cat watermark removed)
    if (backgroundOption === 'color') {
        ctx.fillStyle = customColor || '#2b2d31';
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        return;
    }

    // 2. Check MongoDB first for custom background (ensures consistency across all bots)
    if (userId && backgroundOption !== 'default' && backgroundOption !== 'avatar') {
        let buf = null;
        
        // First, try to fetch from MongoDB (source of truth)
        try {
            const { getUserBackground } = require('./mongoUserData');
            buf = await getUserBackground(userId);
            if (buf) {
                // Cache to local disk for fast subsequent renders
                const localBgPath = path.join(__dirname, '..', '..', 'data', 'backgrounds', `${userId}.png`);
                try {
                    const bgDir = path.dirname(localBgPath);
                    if (!fs.existsSync(bgDir)) fs.mkdirSync(bgDir, { recursive: true });
                    fs.writeFileSync(localBgPath, buf);
                } catch (_) {}
            }
        } catch (err) {
            console.error('[euphire] Failed to fetch custom background from MongoDB:', err.message);
        }

        // Fallback to local disk cache if MongoDB fetch failed
        if (!buf) {
            const localBgPath = path.join(__dirname, '..', '..', 'data', 'backgrounds', `${userId}.png`);
            if (fs.existsSync(localBgPath)) {
                try {
                    buf = fs.readFileSync(localBgPath);
                } catch (_) {}
            }
        }

        if (buf) {
            try {
                const bgImg = await loadImage(buf);
                ctx.save();
                drawCoverImage(ctx, bgImg, WIDTH, HEIGHT);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
                ctx.fillRect(0, 0, WIDTH, HEIGHT);
                ctx.restore();
                return;
            } catch (err) {
                console.error('[euphire] Failed to load custom background image:', err.message);
            }
        }
    }

    // 3. Custom image URL (cat watermark removed)
    if (backgroundOption && (backgroundOption.startsWith('http://') || backgroundOption.startsWith('https://'))) {
        try {
            const bgImg = await loadImageFromURL(backgroundOption);
            ctx.save();
            drawCoverImage(ctx, bgImg, WIDTH, HEIGHT);
            // Subtle dark overlay to ensure boxes and text remain readable
            ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
            ctx.fillRect(0, 0, WIDTH, HEIGHT);
            ctx.restore();
            return;
        } catch (err) {
            console.error('[euphire] Failed to load custom profile background:', err.message);
            // Fall back to default if image loading fails
        }
    }

    // 3. Bot avatar background (cat watermark removed)
    if (backgroundOption === 'avatar' && botAvatarUrl) {
        try {
            const avImg = await loadImageFromURL(botAvatarUrl);
            ctx.save();
            drawCoverImage(ctx, avImg, WIDTH, HEIGHT);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
            ctx.fillRect(0, 0, WIDTH, HEIGHT);
            ctx.restore();
            return;
        } catch (err) {
            console.error('[euphire] Failed to load bot avatar for background:', err.message);
        }
    }

    // 4. Default background (gradient + cat watermark)
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const gradient = ctx.createLinearGradient(
        0, 0, WIDTH, HEIGHT
    );

    gradient.addColorStop(0, 'rgba(255,255,255,0.20)');
    gradient.addColorStop(1, 'rgba(220,224,226,0.12)');

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Watermark is drawn before the panels in default mode
    drawWatermark(ctx);
}

// ============================================================
// BRAND TAG
// ============================================================

function drawBrand(ctx) {
    const x = 758, y = 0, w = 233, h = 47, r = 9;

    roundRect(ctx, x, y, w, h, r);

    ctx.fillStyle = 'rgba(205,208,210,0.68)';
    ctx.fill();

    ctx.font = bold(20);
    ctx.fillStyle = C.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillText(BRAND_LABEL, x + w / 2, 25);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
}

// ============================================================
// SPOTIFY ICON
// ============================================================

function drawSpotify(ctx, x, y) {
    ctx.fillStyle = C.spotify;

    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#eef1f2';
    ctx.lineWidth = 2.7;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(x - 8, y - 5);
    ctx.quadraticCurveTo(x, y - 10, x + 8, y - 4);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x - 7, y);
    ctx.quadraticCurveTo(x, y - 3, x + 7, y + 1);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x - 5, y + 5);
    ctx.quadraticCurveTo(x, y + 3, x + 5, y + 6);
    ctx.stroke();
}

// ============================================================
// CARDS
// ============================================================

function drawCard(ctx, c) {
    roundRect(ctx, c.x, c.y, c.w, c.h, 9);

    ctx.fillStyle = C.panel;
    ctx.fill();

    ctx.strokeStyle = C.panelBorder;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = bold(19);
    ctx.fillStyle = C.text;
    ctx.textBaseline = 'alphabetic';

    ctx.fillText(c.title, c.x + 19, c.y + 40);
}

function drawEmpty(ctx, c) {
    ctx.font = regular(21);
    ctx.fillStyle = C.empty;
    ctx.textBaseline = 'alphabetic';

    ctx.fillText('No data yet', c.x + 19, c.y + 83);
}

// ============================================================
// RANKED STATISTICS
// ============================================================

function drawRows(ctx, c, rows, labelFn, timeFn) {
    if (!rows.length) {
        drawEmpty(ctx, c);
        return;
    }

    const rowYs = c === CARD.tracks
        ? [c.y + 83, c.y + 125, c.y + 167]
        : [c.y + 83, c.y + 122, c.y + 161];

    rows.slice(0, 3).forEach((item, i) => {
        const y = rowYs[i];
        const x = c.x + 19;

        // Rank badge
        ctx.fillStyle = i === 0 ? '#000000' : '#ffffff';

        roundRect(ctx, x, y - 19, 31, 27, 5);
        ctx.fill();

        ctx.font = bold(14);
        ctx.fillStyle = i === 0 ? '#ffffff' : '#000000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.fillText(String(i + 1), x + 15.5, y - 5);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        // Listening time
        const time = timeFn(item);

        ctx.font = bold(21);
        ctx.fillStyle = C.text;

        const tx = x + 44;
        ctx.fillText(time, tx, y + 3);

        const tw = ctx.measureText(time).width;

        // Item name
        ctx.font = regular(21);
        ctx.fillStyle = C.muted;

        const separator = ' · ';
        const max = c.x + c.w - 20 -
            (tx + tw + ctx.measureText(separator).width);

        const label = truncate(ctx, labelFn(item), max);

        ctx.fillText(separator + label, tx + tw, y + 3);
    });
}

// ============================================================
// MAIN PROFILE CARD GENERATOR
// ============================================================

async function generateProfileCard(
    user,
    stats,
    topServers = [],
    topFriends = [],
    topTracks = [],
    client,
    userSettings = null
) {
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    const bgOption = userSettings?.profileBackground || 'default';
    const bgColor = userSettings?.profileColor || null;
    const botAvatar = client?.user?.displayAvatarURL ? client.user.displayAvatarURL({ extension: 'png', size: 1024 }) : null;

    await drawBackground(ctx, bgOption, bgColor, botAvatar, user.id);
    drawBrand(ctx);

    // Avatar customization
    const av = { x: 116, y: 121, r: 78 };
    const shape = userSettings?.avatarShape === 'square' ? 'square' : 'circle';
    const border = userSettings?.avatarBorder; // 'none' | '#hex' | null / 'default'
    const avBg = (userSettings?.avatarBackground && userSettings.avatarBackground.startsWith('#')) ? userSettings.avatarBackground : C.avatarFallback;

    // Draw border ring if not 'none'
    if (border !== 'none') {
        ctx.fillStyle = (border && border !== 'default' && border.startsWith('#')) ? border : C.avatarRing;
        if (shape === 'square') {
            roundRect(ctx, av.x - av.r - 6, av.y - av.r - 6, (av.r + 6) * 2, (av.r + 6) * 2, 22);
            ctx.fill();
        } else {
            ctx.beginPath();
            ctx.arc(av.x, av.y, av.r + 6, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Avatar background
    ctx.fillStyle = avBg;
    if (shape === 'square') {
        roundRect(ctx, av.x - av.r, av.y - av.r, av.r * 2, av.r * 2, 18);
        ctx.fill();
    } else {
        ctx.beginPath();
        ctx.arc(av.x, av.y, av.r, 0, Math.PI * 2);
        ctx.fill();
    }

    try {
        const url = user.displayAvatarURL({
            extension: 'png',
            size: 256
        });

        const img = await loadImageFromURL(url);

        ctx.save();
        if (shape === 'square') {
            roundRect(ctx, av.x - av.r, av.y - av.r, av.r * 2, av.r * 2, 18);
            ctx.clip();
        } else {
            ctx.beginPath();
            ctx.arc(av.x, av.y, av.r, 0, Math.PI * 2);
            ctx.clip();
        }

        ctx.drawImage(
            img,
            av.x - av.r,
            av.y - av.r,
            av.r * 2,
            av.r * 2
        );

        ctx.restore();
    } catch (_) {
        // Keep fallback avatar if image loading fails.
    }

    // Username
    const name = user.displayName || user.username || 'Unknown';

    ctx.font = bold(fitText(ctx, name, 530, 38, 22));
    ctx.fillStyle = C.text;
    ctx.textBaseline = 'alphabetic';

    ctx.fillText(truncate(ctx, name, 530), 238, 120);

    // Spotify icon
    drawSpotify(ctx, 263, 166);

    // Panels
    drawCard(ctx, CARD.servers);
    drawCard(ctx, CARD.friends);
    drawCard(ctx, CARD.tracks);

    // Check privacy settings
    const privacy = userSettings?.profilePrivacy || { servers: true, friends: true, tracks: true };
    const servers = (privacy.servers !== false && Array.isArray(topServers)) ? topServers : [];

    drawRows(
        ctx,
        CARD.servers,
        servers,
        server => {
            let name = null;
            if (client?.guilds?.cache) {
                const guild = client.guilds.cache.get(server.guildId);
                if (guild) name = guild.name;
            }
            if (!name) {
                try {
                    const coordinator = require('./mongoCoordinator');
                    for (const otherClient of coordinator.getAllClients()) {
                        const g = otherClient?.guilds?.cache?.get(server.guildId);
                        if (g) {
                            name = g.name;
                            break;
                        }
                    }
                } catch (_) {}
            }
            return name || server.guildName || 'Unknown Server';
        },
        server => formatDuration(server.listeningMs)
    );

    // Top friends
    const friends = (privacy.friends !== false && Array.isArray(topFriends)) ? topFriends : [];

    const fetchedFriends = await Promise.all(
        friends.slice(0, 3).map(async friend => {
            let u = await client?.users?.fetch?.(friend.friendId).catch(() => null);
            if (!u) {
                try {
                    const coordinator = require('./mongoCoordinator');
                    for (const otherClient of coordinator.getAllClients()) {
                        u = await otherClient?.users?.fetch?.(friend.friendId).catch(() => null);
                        if (u) break;
                    }
                } catch (_) {}
            }
            return u;
        })
    );

    drawRows(
        ctx,
        CARD.friends,
        friends,
        friend => {
            const index = friends.indexOf(friend);
            const fetched = fetchedFriends[index];

            return fetched
                ? (fetched.displayName || fetched.username)
                : 'Unknown';
        },
        friend => formatDuration(friend.totalSharedMs)
    );

    // Top tracks
    const tracks = (privacy.tracks !== false && Array.isArray(topTracks)) ? topTracks : [];

    drawRows(
        ctx,
        CARD.tracks,
        tracks,
        track => String(track.trackTitle || 'Unknown Track'),
        track => formatDuration(track.listeningMs)
    );

    return canvas.toBuffer('image/png');
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    generateProfileCard,
    formatDuration,
    loadImageFromURL
};
