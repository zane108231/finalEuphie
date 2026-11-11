const { SlashCommandBuilder, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { getUserData, saveUserData } = require("../utils/mongoUserData");
const { getAuthToken, getAuthUrl, getSession } = require("../utils/lastfm");

// Store pending auth tokens (in production, use Redis or database)
const pendingAuth = new Map();
const authExpiryTimers = new Map();
const AUTH_TOKEN_TTL_MS = 6 * 60 * 1000;

function createRetryRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("lastfm_retry")
            .setLabel("Try again")
            .setStyle(ButtonStyle.Primary)
    );
}

function createAuthErrorReply() {
    const embed = new EmbedBuilder()
        .setColor(0xf5a623)
        .setDescription(
            "Login expired or failed. Use the button below to try again.\n\n" +
            "Still having trouble connecting your Last.fm to Euphie? Feel free to ask for help on our support server."
        );

    return {
        embeds: [embed],
        components: [createRetryRow()],
        flags: MessageFlags.Ephemeral,
    };
}

async function createAuthToken(userId) {
    const token = await getAuthToken();
    if (!token) return null;

    const timestamp = Date.now();
    const userData = await getUserData(userId);
    userData.lastfmToken = token;
    userData.lastfmTokenTimestamp = timestamp;
    await saveUserData(userId, userData);
    pendingAuth.set(userId, { token, timestamp });

    const previousTimer = authExpiryTimers.get(userId);
    if (previousTimer) clearTimeout(previousTimer);

    const timer = setTimeout(async () => {
        try {
            const currentData = await getUserData(userId);
            if (currentData.lastfmToken === token) {
                currentData.lastfmToken = null;
                currentData.lastfmTokenTimestamp = null;
                await saveUserData(userId, currentData);
            }
            if (pendingAuth.get(userId)?.token === token) {
                pendingAuth.delete(userId);
            }
        } catch (error) {
            console.error("[Last.fm] Failed to clear expired login token:", error.message);
        } finally {
            if (authExpiryTimers.get(userId) === timer) {
                authExpiryTimers.delete(userId);
            }
        }
    }, AUTH_TOKEN_TTL_MS);
    timer.unref?.();
    authExpiryTimers.set(userId, timer);

    return token;
}

function createWelcomeEmbed(displayName) {
    return new EmbedBuilder()
        .setColor(0xf5a623)
        .setDescription(
            `Hi ${displayName}, welcome to Euphie.\n` +
            "To use Euphie's Last.fm features, first connect your Last.fm account.\n\n" +
            "Use the button below to connect your existing Last.fm account."
        );
}

function createAuthReply(token) {
    const embed = new EmbedBuilder()
        .setColor(0xf5a623)
        .setDescription(
            "Authorize Euphie on Last.fm, then click **Verify** to complete setup.\n\n" +
            "-# This link expires in 6 minutes."
        );
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel("Connect Last.fm account")
            .setStyle(ButtonStyle.Link)
            .setURL(getAuthUrl(token)),
        new ButtonBuilder()
            .setCustomId("lastfm_verify")
            .setLabel("Verify")
            .setStyle(ButtonStyle.Primary)
    );

    return {
        embeds: [embed],
        components: [row],
        flags: MessageFlags.Ephemeral,
    };
}

module.exports = {
    aliases: [],
    data: new SlashCommandBuilder()
        .setName("login")
        .setDescription("Authenticate with Last.fm for scrobbling"),

    async execute(interaction, client) {
        const userId = interaction.user.id;
        const isPrefix = Boolean(interaction.message);

        // Check if already logged in
        const userData = await getUserData(userId);
        if (userData.lastfmSessionKey) {
            const embed = new EmbedBuilder()
                .setColor(0x57f287)
                .setDescription(
                    `✅ You have already logged in to Euphie with the username **${userData.lastfmUsername}**.\n\n` +
                    "Please note that Euphie is not affiliated with Last.fm."
                );
            return interaction.reply({
                embeds: [embed],
                flags: isPrefix ? undefined : MessageFlags.Ephemeral,
            });
        }

        const displayName =
            interaction.member?.displayName || interaction.user.username;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("lastfm_begin_login")
                .setLabel("Connect Last.fm account")
                .setStyle(ButtonStyle.Primary)
        );

        return interaction.reply({
            embeds: [createWelcomeEmbed(displayName)],
            components: [row],
            flags: isPrefix ? undefined : MessageFlags.Ephemeral,
        });
    },

    async handleStart(interaction) {
        const token = await createAuthToken(interaction.user.id);
        if (!token) {
            return interaction.reply(createAuthErrorReply());
        }
        return interaction.reply(createAuthReply(token));
    },

    async handleVerify(interaction) {
        const userId = interaction.user.id;

        // Try to get token from memory first
        let authData = pendingAuth.get(userId);
        if (authData && Date.now() - authData.timestamp >= AUTH_TOKEN_TTL_MS) {
            pendingAuth.delete(userId);
            authData = null;
        }

        // If not in memory, try to get from userData (for restarts)
        if (!authData) {
            const userData = await getUserData(userId);
            if (userData.lastfmToken && userData.lastfmTokenTimestamp) {
                const tokenAge = Date.now() - userData.lastfmTokenTimestamp;
                if (tokenAge < AUTH_TOKEN_TTL_MS) {
                    authData = { token: userData.lastfmToken, timestamp: userData.lastfmTokenTimestamp };
                } else {
                    userData.lastfmToken = null;
                    userData.lastfmTokenTimestamp = null;
                    await saveUserData(userId, userData);
                }
            }
        }

        if (!authData) {
            return interaction.reply(createAuthErrorReply());
        }

        // Get session key
        const session = await getSession(authData.token);
        if (!session) {
            // Clear invalid token
            const userData = await getUserData(userId);
            if (userData.lastfmToken === authData.token) {
                userData.lastfmToken = null;
                userData.lastfmTokenTimestamp = null;
                await saveUserData(userId, userData);
            }
            if (pendingAuth.get(userId)?.token === authData.token) {
                pendingAuth.delete(userId);
            }

            const timer = authExpiryTimers.get(userId);
            if (timer) clearTimeout(timer);
            authExpiryTimers.delete(userId);
            return interaction.reply(createAuthErrorReply());
        }

        // Save session key
        const userData = await getUserData(userId);
        userData.lastfmSessionKey = session.key;
        userData.lastfmUsername = session.name;
        userData.lastfmToken = null;
        userData.lastfmTokenTimestamp = null;
        await saveUserData(userId, userData);

        // Clean up
        pendingAuth.delete(userId);
        const timer = authExpiryTimers.get(userId);
        if (timer) clearTimeout(timer);
        authExpiryTimers.delete(userId);
        const embed = new EmbedBuilder()
            .setColor(0x57f287)
            .setDescription(
                `✅ You have been logged in to Euphie with the username **${session.name}**!\n\n` +
                "Your tracks will now be scrobbled to Last.fm automatically.\n\n" +
                "Please note that Euphie is not affiliated with Last.fm."
            );

        await interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral,
        });
    }
};
