const {
    PermissionFlagsBits,
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");
const { getGuildData, saveGuildData } = require("./mongoGuildData");
const { getUserData, saveUserData } = require("./mongoUserData");
const { getPrefix } = require("./prefixStore");
const coordinator = require("./mongoCoordinator");

function createNoBotInVoiceEmbed() {
    return new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription("There are no bots in your voice channel.");
}

const VOICE_CHANNEL_DENIAL =
    "❌ You need to be in the same voice channel as the bot to use these controls.";

// 10 Official Permissions
const AVAILABLE_PERMISSIONS = {
    "add track": {
        name: "add track",
        key: "add_track",
        description: "Allows you to add tracks to the queue",
    },
    "add playlist": {
        name: "add playlist",
        key: "add_playlist",
        description: "Allows you to add playlists to the queue",
    },
    "remove track": {
        name: "remove track",
        key: "remove_track",
        description: "Allows you to remove tracks from the queue",
    },
    "shuffle queue": {
        name: "shuffle queue",
        key: "shuffle_queue",
        description: "Allows you to shuffle the queue",
    },
    "change volume": {
        name: "change volume",
        key: "change_volume",
        description: "Allows you to change the volume",
    },
    "update state": {
        name: "update state",
        key: "update_state",
        description: "Allows you to update the current track's state",
    },
    "index queue": {
        name: "index queue",
        key: "index_queue",
        description: "Allows you to update the queue",
    },
    "leave": {
        name: "leave",
        key: "leave",
        description: "Allows you to make the bot disconnect",
    },
    "autoplay": {
        name: "autoplay",
        key: "autoplay",
        description: "Allows you to start and stop autoplay",
    },
    "audio filter": {
        name: "audio filter",
        key: "audio_filter",
        description: "Allows you to apply any audio filters",
    },
};

const ALL_PERMISSIONS = Object.keys(AVAILABLE_PERMISSIONS);

const PERMISSION_ALIASES = {
    "addtrack": "add track",
    "add_track": "add track",
    "add-track": "add track",
    "track": "add track",
    "add": "add track",

    "addplaylist": "add playlist",
    "add_playlist": "add playlist",
    "add-playlist": "add playlist",
    "playlist": "add playlist",

    "removetrack": "remove track",
    "remove_track": "remove track",
    "remove-track": "remove track",
    "remove": "remove track",
    "rm": "remove track",

    "shufflequeue": "shuffle queue",
    "shuffle_queue": "shuffle queue",
    "shuffle-queue": "shuffle queue",
    "shuffle": "shuffle queue",

    "changevolume": "change volume",
    "change_volume": "change volume",
    "change-volume": "change volume",
    "volume": "change volume",
    "vol": "change volume",

    "updatestate": "update state",
    "update_state": "update state",
    "update-state": "update state",
    "state": "update state",
    "skip": "update state",
    "s": "update state",
    "pause": "update state",
    "resume": "update state",
    "seek": "update state",
    "loop": "update state",
    "loopq": "update state",
    "repeat": "update state",

    "indexqueue": "index queue",
    "index_queue": "index queue",
    "index-queue": "index queue",
    "index": "index queue",
    "move": "index queue",
    "clear": "index queue",

    "stop": "leave",
    "disconnect": "leave",
    "dc": "leave",
    "leave": "leave",

    "autoplay": "autoplay",
    "auto_play": "autoplay",
    "auto-play": "autoplay",

    "audiofilter": "audio filter",
    "audio_filter": "audio filter",
    "audio-filter": "audio filter",
    "filter": "audio filter",
    "filters": "audio filter",
};

const ACTION_TO_PERMISSION_MAP = {
    stop: "leave",
    leave: "leave",
    dc: "leave",
    disconnect: "leave",

    clear: "index queue",
    move: "index queue",

    loop: "update state",
    loopq: "update state",
    repeat: "update state",
    seek: "update state",
    pause: "update state",
    resume: "update state",
    skip: "update state",
    s: "update state",

    remove: "remove track",
    rm: "remove track",

    filter: "audio filter",
    filters: "audio filter",

    shuffle: "shuffle queue",

    volume: "change volume",
    vol: "change volume",

    autoplay: "autoplay",

    play_track: "add track",
    insert: "add track",
    play_playlist: "add playlist",
};

const ALL_PERMISSION_ALIASES = new Set(["all", "everything", "*", "every", "all permissions"]);

function isAllAction(raw) {
    return ALL_PERMISSION_ALIASES.has(String(raw || "").toLowerCase().trim());
}

function normalizePermission(raw) {
    if (!raw) return null;
    const clean = String(raw).toLowerCase().trim().replace(/\s+/g, " ");
    if (AVAILABLE_PERMISSIONS[clean]) return clean;
    if (PERMISSION_ALIASES[clean]) return PERMISSION_ALIASES[clean];
    const stripped = clean.replace(/[\s_\-]+/g, "");
    if (PERMISSION_ALIASES[stripped]) return PERMISSION_ALIASES[stripped];
    return null;
}

function resolvePermissions(raw) {
    if (isAllAction(raw)) return [...ALL_PERMISSIONS];
    const one = normalizePermission(raw);
    return one ? [one] : [];
}

function actionToPermission(action) {
    if (!action) return null;
    const clean = String(action).toLowerCase().trim();
    if (AVAILABLE_PERMISSIONS[clean]) return clean;
    if (ACTION_TO_PERMISSION_MAP[clean]) return ACTION_TO_PERMISSION_MAP[clean];
    const normalized = normalizePermission(clean);
    return normalized || null;
}

// Backwards-compatible aliases for older code
const MUSIC_ACTIONS = [...ALL_PERMISSIONS];
function normalizeAction(raw) {
    return normalizePermission(raw);
}
function resolveActions(raw) {
    return resolvePermissions(raw);
}

async function ensureAllowMaps(guildId) {
    const guildData = await getGuildData(guildId);
    if (!guildData.sessionPermissions || typeof guildData.sessionPermissions !== "object") {
        guildData.sessionPermissions = { allows: {}, denies: {}, allowEveryone: [], denyEveryone: [] };
    }
    if (!guildData.serverPermissions || typeof guildData.serverPermissions !== "object") {
        guildData.serverPermissions = { allows: {}, denies: {}, allowEveryone: [], denyEveryone: [] };
    }
    return guildData;
}

async function resetSessionPermissions(guildId) {
    const guildData = await getGuildData(guildId);
    guildData.djOwnerId = null;
    guildData.sessionPermissions = {
        allows: {},
        denies: {},
        allowEveryone: [],
        denyEveryone: [],
    };
    guildData.musicAllowEveryone = new Set();
    guildData.musicAllows = {};
    await saveGuildData(guildId, guildData);
}

function isServerAdmin(member) {
    try {
        return Boolean(
            member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
            member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)
        );
    } catch {
        return false;
    }
}

function isDj(member, player, guildData) {
    if (!member?.id) return false;
    const userId = String(member.id);

    // 1. Session DJ stored in coordinator
    if (player?.voiceChannel) {
        const sessionDj = coordinator.getSessionDJ(player.voiceChannel);
        if (sessionDj && sessionDj === userId) return true;
    }

    const memberVcId = member.voice?.channel?.id;
    if (memberVcId) {
        const sessionDj = coordinator.getSessionDJ(memberVcId);
        if (sessionDj && sessionDj === userId) return true;
    }

    // 2. Requester ID on player
    if (player?.requesterId && String(player.requesterId) === userId) {
        return true;
    }

    // 3. DJ owner ID in guildData
    if (guildData?.djOwnerId && String(guildData.djOwnerId) === userId) {
        return true;
    }

    // 4. If this user is the only non-bot human in the voice channel, they are effectively DJ
    const vc = member.voice?.channel;
    if (vc?.members) {
        const humans = vc.members.filter((m) => !m.user?.bot);
        if (humans.size <= 1) return true;
    }

    // 5. Check if user is registered as DJ across active sessions in coordinator
    for (const [, djId] of coordinator.sessionDJs) {
        if (djId === userId) return true;
    }

    return false;
}

function isSessionStarterOrAdmin(member, guild, player, guildData) {
    if (!member) return false;
    if (isServerAdmin(member)) return true;
    if (isDj(member, player, guildData)) return true;

    const userId = String(member.id);
    const voiceChannelId = member.voice?.channel?.id || player?.voiceChannel;
    if (voiceChannelId) {
        const sessionDj = coordinator.getSessionDJ(voiceChannelId);
        if (sessionDj && sessionDj === userId) return true;
        const vc = member.voice?.channel || guild?.channels?.cache?.get(voiceChannelId);
        if (vc?.members) {
            const humans = vc.members.filter((m) => !m.user?.bot);
            if (humans.size <= 1) return true;
        }
    }

    if (guildData?.djOwnerId && String(guildData.djOwnerId) === userId) {
        return true;
    }

    return false;
}

function canControlMusic(member, player) {
    const memberChannel = member?.voice?.channel;
    if (!memberChannel || !player?.voiceChannel) return false;
    return memberChannel.id === player.voiceChannel;
}

/**
 * Checks if a member has permission to perform a music action
 */
async function canUseMusicAction(member, player, action) {
    const perm = actionToPermission(action);
    if (!perm) return false;

    // Server Admin has full access
    if (isServerAdmin(member)) return true;

    const guildId = player?.guildId || member.guild?.id;
    const guildData = await getGuildData(guildId);

    // DJ has full access
    if (isDj(member, player, guildData)) return true;

    // If only 1 human in VC, effectively DJ
    const vc = member.voice?.channel;
    if (vc?.members) {
        const humans = vc.members.filter((m) => !m.user?.bot);
        if (humans.size <= 1) return true;
    }

    const userId = String(member.id);
    const roleIds = member.roles?.cache ? Array.from(member.roles.cache.keys()) : [];

    // Check Session scope first
    const session = guildData.sessionPermissions || { allows: {}, denies: {}, allowEveryone: [], denyEveryone: [] };
    if (session.denyEveryone?.includes(perm)) return false;
    if (session.denies?.[perm]) {
        const deniedList = session.denies[perm];
        if (deniedList.includes(userId) || roleIds.some((r) => deniedList.includes(r))) {
            return false;
        }
    }
    if (session.allowEveryone?.includes(perm)) return true;
    if (session.allows?.[perm]) {
        const allowedList = session.allows[perm];
        if (allowedList.includes(userId) || roleIds.some((r) => allowedList.includes(r))) {
            return true;
        }
    }

    // Check Server scope
    const server = guildData.serverPermissions || { allows: {}, denies: {}, allowEveryone: [], denyEveryone: [] };
    if (server.denyEveryone?.includes(perm)) return false;
    if (server.denies?.[perm]) {
        const deniedList = server.denies[perm];
        if (deniedList.includes(userId) || roleIds.some((r) => deniedList.includes(r))) {
            return false;
        }
    }
    if (server.allowEveryone?.includes(perm)) return true;
    if (server.allows?.[perm]) {
        const allowedList = server.allows[perm];
        if (allowedList.includes(userId) || roleIds.some((r) => allowedList.includes(r))) {
            return true;
        }
    }

    // Legacy fallback
    if (guildData.musicAllowEveryone instanceof Set && guildData.musicAllowEveryone.has(perm)) return true;
    if (Array.isArray(guildData.musicAllowEveryone) && guildData.musicAllowEveryone.includes(perm)) return true;
    if (guildData.musicAllows?.[perm]) {
        const legacyList = guildData.musicAllows[perm];
        if (legacyList instanceof Set && legacyList.has(userId)) return true;
        if (Array.isArray(legacyList) && legacyList.includes(userId)) return true;
    }

    // Defaults:
    // Adding tracks and playlists is allowed to everyone by default unless explicitly denied
    if (perm === "add track" || perm === "add playlist") {
        return true;
    }

    // All other controls are DJ/admin only by default
    return false;
}

/**
 * Builds the red left-outline embed matching the screenshot for missing permissions
 */
function buildMissingPermissionResponse(permissionName, scope = "session") {
    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription(`You are missing the required ${scope} permission\n\`${permissionName}\` to do that`);

    const safePermKey = String(permissionName).toLowerCase().replace(/[\s\-]+/g, "_");
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`perm_info_${safePermKey}`)
            .setLabel("Info")
            .setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row] };
}

/**
 * Ephemeral help details when user clicks the Info button
 */
function getPermissionInfoEmbed(rawPermName, guildId) {
    const prefix = getPrefix(guildId);
    const permKey = normalizePermission(rawPermName) || rawPermName;
    const permObj = AVAILABLE_PERMISSIONS[permKey] || {
        name: permKey,
        description: "Control playback and music settings.",
    };

    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`ℹ️ Permission: ${permObj.name}`)
        .setDescription(
            `**Description:**\n${permObj.description}\n\n` +
            `**How to allow:**\n` +
            `The session starter (DJ) or a server admin can run:\n` +
            `\`${prefix}permission allow @user ${permObj.name}\`\n` +
            `or \`${prefix}permission allow everyone ${permObj.name}\``
        );
}

function denyMusicMessage(guildId, action) {
    const prefix = getPrefix(guildId);
    const perm = actionToPermission(action) || action;
    return (
        `❌ Only the DJ of this session can use **${perm}**.\n` +
        `-# Ask them to run \`${prefix}permission allow @you ${perm}\` or \`${prefix}permission allow everyone ${perm}\`.`
    );
}

async function getMusicDenial(member, player, action) {
    if (!canControlMusic(member, player)) return VOICE_CHANNEL_DENIAL;
    if (!(await canUseMusicAction(member, player, action))) {
        return denyMusicMessage(player.guildId, action);
    }
    return null;
}

async function requireMusicAction(interaction, client, action) {
    const voiceChannelId = interaction.member?.voice?.channel?.id;

    if (!voiceChannelId) {
        await interaction.reply({
            content: "❌ You need to be in a voice channel to use this command.",
            flags: MessageFlags.Ephemeral,
        });
        return null;
    }

    const sessionOwner = coordinator.resolveSessionOwner(voiceChannelId, interaction.guild);

    if (!sessionOwner) {
        const embed = createNoBotInVoiceEmbed();
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({ embeds: [embed] });
        } else {
            await interaction.reply({
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }
        return null;
    }

    const targetClient = coordinator.getClient(sessionOwner) || client;
    const targetRiffy = coordinator.getRiffy(sessionOwner) || targetClient.riffy;

    let player = targetRiffy?.players?.get(interaction.guild.id);
    if (!player) {
        for (const c of coordinator.getAllClients()) {
            if (c.riffy?.players) {
                for (const [, p] of c.riffy.players) {
                    if (p && p.voiceChannel === voiceChannelId) {
                        player = p;
                        break;
                    }
                }
            }
            if (player) break;
        }
    }

    if (!player) {
        for (const c of coordinator.getAllClients()) {
            const targetGuild = c.guilds?.cache?.get(interaction.guild?.id) || interaction.guild;
            const memberMe = targetGuild?.members?.cache?.get(c.user?.id) || (c.user?.id === interaction.guild?.members?.me?.id ? interaction.guild?.members?.me : null);
            if (memberMe?.voice?.channelId === voiceChannelId) {
                player = {
                    guildId: interaction.guild.id,
                    voiceChannel: voiceChannelId,
                    queue: { clear: () => {} },
                    stop: () => {},
                    destroy: () => {
                        try {
                            memberMe.voice.disconnect();
                        } catch {}
                    },
                };
                break;
            }
        }
    }

    if (!player) {
        const embed = createNoBotInVoiceEmbed();
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({ embeds: [embed] });
        } else {
            await interaction.reply({
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }
        return null;
    }

    if (!canControlMusic(interaction.member, player)) {
        await interaction.reply({
            content: VOICE_CHANNEL_DENIAL,
            flags: MessageFlags.Ephemeral,
        });
        return null;
    }

    // Check if user has permission to use this action
    if (!(await canUseMusicAction(interaction.member, player, action))) {
        const requiredPerm = actionToPermission(action) || action;
        const resp = buildMissingPermissionResponse(requiredPerm, "session");
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply(resp);
        } else {
            await interaction.reply(resp);
        }
        return null;
    }

    return player;
}

/**
 * Grant permissions to user/role/everyone
 */
async function grantPermission(guildId, target, permissions, scope = "session", authorId = null) {
    const perms = Array.isArray(permissions) ? permissions : resolvePermissions(permissions);
    if (!perms.length) return false;

    if (scope === "self" && authorId) {
        const userData = await getUserData(authorId);
        userData.selfPermissions = userData.selfPermissions || { allows: [], denies: [] };
        for (const p of perms) {
            if (!userData.selfPermissions.allows.includes(p)) {
                userData.selfPermissions.allows.push(p);
            }
            userData.selfPermissions.denies = userData.selfPermissions.denies.filter((x) => x !== p);
        }
        await saveUserData(authorId, userData);
        return true;
    }

    const guildData = await getGuildData(guildId);
    await ensureAllowMaps(guildId);

    const store = scope === "server" ? guildData.serverPermissions : guildData.sessionPermissions;
    store.allows = store.allows || {};
    store.denies = store.denies || {};
    store.allowEveryone = store.allowEveryone || [];
    store.denyEveryone = store.denyEveryone || [];

    const isEveryone = target === "everyone" || target?.type === "everyone" || !target;
    const targetId = isEveryone ? "everyone" : String(target.id || target);

    for (const p of perms) {
        if (isEveryone) {
            if (!store.allowEveryone.includes(p)) store.allowEveryone.push(p);
            store.denyEveryone = store.denyEveryone.filter((x) => x !== p);
        } else {
            store.allows[p] = store.allows[p] || [];
            if (!store.allows[p].includes(targetId)) store.allows[p].push(targetId);
            if (store.denies[p]) {
                store.denies[p] = store.denies[p].filter((x) => x !== targetId);
            }
        }
    }

    await saveGuildData(guildId, guildData);
    return true;
}

/**
 * Deny permissions from user/role/everyone
 */
async function denyPermission(guildId, target, permissions, scope = "session", authorId = null) {
    const perms = Array.isArray(permissions) ? permissions : resolvePermissions(permissions);
    if (!perms.length) return false;

    if (scope === "self" && authorId) {
        const userData = await getUserData(authorId);
        userData.selfPermissions = userData.selfPermissions || { allows: [], denies: [] };
        for (const p of perms) {
            if (!userData.selfPermissions.denies.includes(p)) {
                userData.selfPermissions.denies.push(p);
            }
            userData.selfPermissions.allows = userData.selfPermissions.allows.filter((x) => x !== p);
        }
        await saveUserData(authorId, userData);
        return true;
    }

    const guildData = await getGuildData(guildId);
    await ensureAllowMaps(guildId);

    const store = scope === "server" ? guildData.serverPermissions : guildData.sessionPermissions;
    store.allows = store.allows || {};
    store.denies = store.denies || {};
    store.allowEveryone = store.allowEveryone || [];
    store.denyEveryone = store.denyEveryone || [];

    const isEveryone = target === "everyone" || target?.type === "everyone" || !target;
    const targetId = isEveryone ? "everyone" : String(target.id || target);

    for (const p of perms) {
        if (isEveryone) {
            if (!store.denyEveryone.includes(p)) store.denyEveryone.push(p);
            store.allowEveryone = store.allowEveryone.filter((x) => x !== p);
            // clear individual allows when everyone is denied
            delete store.allows[p];
        } else {
            store.denies[p] = store.denies[p] || [];
            if (!store.denies[p].includes(targetId)) store.denies[p].push(targetId);
            if (store.allows[p]) {
                store.allows[p] = store.allows[p].filter((x) => x !== targetId);
            }
        }
    }

    await saveGuildData(guildId, guildData);
    return true;
}

/**
 * Reset permissions of a session, server, or user
 */
async function resetPermissions(guildId, target, scope = "session", authorId = null) {
    if (scope === "self" && authorId) {
        const userData = await getUserData(authorId);
        userData.selfPermissions = { allows: [], denies: [] };
        await saveUserData(authorId, userData);
        return true;
    }

    const guildData = await getGuildData(guildId);
    await ensureAllowMaps(guildId);

    const store = scope === "server" ? guildData.serverPermissions : guildData.sessionPermissions;

    const isAll = target === "all" || target?.type === "all";
    const isEveryone = target === "everyone" || target?.type === "everyone";

    if (isAll || !target) {
        store.allows = {};
        store.denies = {};
        store.allowEveryone = [];
        store.denyEveryone = [];
    } else if (isEveryone) {
        store.allowEveryone = [];
        store.denyEveryone = [];
    } else {
        const targetId = String(target.id || target);
        for (const p of ALL_PERMISSIONS) {
            if (store.allows[p]) {
                store.allows[p] = store.allows[p].filter((x) => x !== targetId);
            }
            if (store.denies[p]) {
                store.denies[p] = store.denies[p].filter((x) => x !== targetId);
            }
        }
    }

    await saveGuildData(guildId, guildData);
    return true;
}

// Backwards compatibility functions
async function grantAction(guildId, action, userId) {
    const target = userId === "all" || !userId ? "everyone" : { id: userId, type: "user" };
    return grantPermission(guildId, target, action, "session");
}

async function revokeAction(guildId, action, userId) {
    const target = userId === "all" || !userId ? "everyone" : { id: userId, type: "user" };
    return denyPermission(guildId, target, action, "session");
}

module.exports = {
    VOICE_CHANNEL_DENIAL,
    AVAILABLE_PERMISSIONS,
    ALL_PERMISSIONS,
    MUSIC_ACTIONS,
    normalizePermission,
    resolvePermissions,
    actionToPermission,
    normalizeAction,
    resolveActions,
    isAllAction,
    ensureAllowMaps,
    canControlMusic,
    canUseMusicAction,
    requireMusicAction,
    resetSessionPermissions,
    isServerAdmin,
    isDj,
    isSessionStarterOrAdmin,
    grantPermission,
    denyPermission,
    resetPermissions,
    grantAction,
    revokeAction,
    denyMusicMessage,
    getMusicDenial,
    createNoBotInVoiceEmbed,
    buildMissingPermissionResponse,
    getPermissionInfoEmbed,
};
