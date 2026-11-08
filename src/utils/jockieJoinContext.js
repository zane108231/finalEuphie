const CONTEXT_TTL_MS = 2 * 60 * 1000;
const contexts = new Map();

function contextKey(guildId, voiceChannelId) {
    return `${guildId}:${voiceChannelId}`;
}

function rememberJockieCommand({ guildId, voiceChannelId, textChannelId }) {
    if (!guildId || !voiceChannelId || !textChannelId) return;

    contexts.set(contextKey(guildId, voiceChannelId), {
        textChannelId,
        expiresAt: Date.now() + CONTEXT_TTL_MS,
    });
}

function consumeJockieCommand(guildId, voiceChannelId) {
    const key = contextKey(guildId, voiceChannelId);
    const context = contexts.get(key);
    contexts.delete(key);
    if (!context || context.expiresAt < Date.now()) return null;
    return context;
}

module.exports = { rememberJockieCommand, consumeJockieCommand };
