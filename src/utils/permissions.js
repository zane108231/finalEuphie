const { PermissionFlagsBits, MessageFlags, EmbedBuilder } = require("discord.js");
const { getGuildData, saveGuildData } = require("./mongoGuildData");
const { getPrefix } = require("./prefixStore");
const coordinator = require("./mongoCoordinator");

function createNoBotInVoiceEmbed() {
    return new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription("There are no bots in your voice channel.");
}

const VOICE_CHANNEL_DENIAL =
    "❌ You need to be in the same voice channel as the bot to use these controls.";

const MUSIC_ACTIONS = [
    "stop",
    "clear",
    "move",
    "loop",
    "remove",
    "filter",
    "seek",
    "shuffle",
    "skip",
    "volume",
];

const ACTION_ALIASES = {
    vol: "volume",
    s: "skip",
};

const ALL_ACTION_ALIASES = new Set(["all", "everything", "*", "every", "everyone"]);

function isAllAction(raw) {
    return ALL_ACTION_ALIASES.has(String(raw || "").toLowerCase().trim());
}

function normalizeAction(raw) {
    if (!raw) return null;
    const key = String(raw).toLowerCase().trim();
    const mapped = ACTION_ALIASES[key] || key;
    return MUSIC_ACTIONS.includes(mapped) ? mapped : null;
}

function resolveActions(raw) {
    if (isAllAction(raw)) return [...MUSIC_ACTIONS];
    const one = normalizeAction(raw);
    return one ? [one] : [];
}

async function ensureAllowMaps(guildId) {
    const guildData = await getGuildData(guildId);
    
    // Fix musicAllowEveryone
    if (!(guildData.musicAllowEveryone instanceof Set)) {
        if (Array.isArray(guildData.musicAllowEveryone)) {
            guildData.musicAllowEveryone = new Set(guildData.musicAllowEveryone);
        } else if (guildData.musicAllowEveryone === null || guildData.musicAllowEveryone === undefined) {
            guildData.musicAllowEveryone = new Set();
        } else {
            console.log(`[euphire] Warning: musicAllowEveryone is ${typeof guildData.musicAllowEveryone}, resetting to empty Set`);
            guildData.musicAllowEveryone = new Set();
        }
    }
    
    // Fix musicAllows object
    if (!guildData.musicAllows || typeof guildData.musicAllows !== "object") {
        guildData.musicAllows = {};
    }
    
    for (const action of MUSIC_ACTIONS) {
        if (!(guildData.musicAllows[action] instanceof Set)) {
            if (Array.isArray(guildData.musicAllows[action])) {
                guildData.musicAllows[action] = new Set(guildData.musicAllows[action]);
            } else if (guildData.musicAllows[action] === null || guildData.musicAllows[action] === undefined) {
                guildData.musicAllows[action] = new Set();
            } else {
                console.log(`[euphire] Warning: musicAllows[${action}] is ${typeof guildData.musicAllows[action]}, resetting to empty Set`);
                guildData.musicAllows[action] = new Set();
            }
        }
    }
    return guildData;
}

function resetSessionPermissions(guildId) {
    const guildData = getGuildData(guildId);
    guildData.djOwnerId = null;
    guildData.musicAllowEveryone = new Set();
    guildData.musicAllows = {};
    for (const action of MUSIC_ACTIONS) {
        guildData.musicAllows[action] = new Set();
    }
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

    return false;
}

/**
 * Returns true if the member is in the same voice channel as the bot player.
 */
function canControlMusic(member, player) {
    const memberChannel = member?.voice?.channel;
    if (!memberChannel || !player?.voiceChannel) return false;
    return memberChannel.id === player.voiceChannel;
}

async function canUseMusicAction(member, player, action) {
    const resolved = normalizeAction(action);
    if (!resolved) return false;

    const guildId = player.guildId;
    const guildData = await getGuildData(guildId);
    await ensureAllowMaps(guildId);

    if (isServerAdmin(member)) {
        return true;
    }

    if (isDj(member, player, guildData)) {
        return true;
    }

    // Check granted permissions
    // Handle both Set and array formats
    const allowEveryone = guildData.musicAllowEveryone;
    if (allowEveryone) {
        if (allowEveryone instanceof Set) {
            if (allowEveryone.has(resolved)) {
                return true;
            }
        } else if (Array.isArray(allowEveryone)) {
            if (allowEveryone.includes(resolved)) {
                return true;
            }
        }
    }

    const actionAllows = guildData.musicAllows[resolved];
    if (actionAllows) {
        if (actionAllows instanceof Set) {
            if (actionAllows.has(String(member.id))) {
                return true;
            }
        } else if (Array.isArray(actionAllows)) {
            if (actionAllows.includes(String(member.id))) {
                return true;
            }
        }
    }

    return false;
}

function denyMusicMessage(guildId, action) {
    const prefix = getPrefix(guildId);
    const resolved = normalizeAction(action) || action;
    return (
        `❌ Only the DJ of this session can use **${resolved}**.\n` +
        `-# Ask them to run \`${prefix}permission ${resolved} allow\` or \`${prefix}permission ${resolved} allow @you\`.`
    );
}

async function getMusicDenial(member, player, action) {
    if (!canControlMusic(member, player)) return VOICE_CHANNEL_DENIAL;
    if (!(await canUseMusicAction(member, player, action))) {
        console.log(`[euphire] Permission denied for user ${member.id} on action ${action}`);
        return denyMusicMessage(player.guildId, action);
    }
    console.log(`[euphire] Permission granted for user ${member.id} on action ${action}`);
    return null;
}

async function requireMusicAction(interaction, client, action) {
    const voiceChannelId = interaction.member.voice?.channel?.id;

    // Check if user is in a voice channel FIRST
    if (!voiceChannelId) {
        await interaction.reply({
            content: "❌ You need to be in a voice channel to use this command.",
            flags: MessageFlags.Ephemeral,
        });
        return null;
    }

    // Get the session owner for this voice channel (with active bot fallback)
    const sessionOwner = coordinator.resolveSessionOwner(voiceChannelId, interaction.guild);

    // If no session exists for this voice channel, there are no bots in this VC
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

    // Get the correct client and riffy instance
    const targetClient = coordinator.getClient(sessionOwner) || client;
    const targetRiffy = coordinator.getRiffy(sessionOwner) || targetClient.riffy;

    let player = targetRiffy?.players?.get(interaction.guild.id);
    if (!player) {
        // Search across all clients in case another bot client holds this voice channel player
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

    // Fallback: check if bot is physically connected to the voice channel
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
        await interaction.reply({
            content: denyMusicMessage(interaction.guild.id, action),
            flags: MessageFlags.Ephemeral,
        });
        return null;
    }

    return player;
}

async function grantAction(guildId, action, userId) {
    const actions = resolveActions(action);
    if (!actions.length) return false;
    
    // Get fresh data from MongoDB
    const guildData = await getGuildData(guildId);
    await ensureAllowMaps(guildId);
    
    const everyone = !userId || userId === "all";
    for (const resolved of actions) {
        if (everyone) {
            guildData.musicAllowEveryone.add(resolved);
        } else {
            guildData.musicAllows[resolved].add(String(userId));
        }
    }
    
    console.log(`[euphire] Saving permissions to MongoDB: guildId=${guildId}, action=${action}, userId=${userId}, everyone=${everyone}`);
    console.log(`[euphire] musicAllowEveryone:`, Array.from(guildData.musicAllowEveryone));
    console.log(`[euphire] musicAllows:`, Object.fromEntries(Object.entries(guildData.musicAllows).map(([k, v]) => [k, Array.from(v)])));
    
    // Save to MongoDB
    await saveGuildData(guildId, guildData);
    console.log(`[euphire] Permissions saved successfully`);
    return true;
}

async function revokeAction(guildId, action, userId) {
    const actions = resolveActions(action);
    if (!actions.length) return false;
    const guildData = await ensureAllowMaps(guildId);
    const everyone = !userId || userId === "all";
    for (const resolved of actions) {
        if (everyone) {
            guildData.musicAllowEveryone.delete(resolved);
            guildData.musicAllows[resolved].clear();
        } else {
            guildData.musicAllows[resolved].delete(String(userId));
        }
    }
    // Save to MongoDB
    await saveGuildData(guildId, guildData);
    return true;
}

module.exports = {
    VOICE_CHANNEL_DENIAL,
    MUSIC_ACTIONS,
    isAllAction,
    resolveActions,
    ensureAllowMaps,
    canControlMusic,
    canUseMusicAction,
    requireMusicAction,
    resetSessionPermissions,
    isServerAdmin,
    isDj,
    normalizeAction,
    grantAction,
    revokeAction,
    denyMusicMessage,
    getMusicDenial,
    createNoBotInVoiceEmbed,
};
