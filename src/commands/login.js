const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { getUserData, saveUserData } = require("../utils/mongoUserData");
const { getAuthToken, getAuthUrl, getSession } = require("../utils/lastfm");

// Store pending auth tokens (in production, use Redis or database)
const pendingAuth = new Map();

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
            const container = new ContainerBuilder();
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    "### ⚠️ Already Logged In\n\n" +
                    "**Status**\n" +
                    `-# You are already authenticated as **${userData.lastfmUsername}**\n\n` +
                    "**Want to log out?**\n" +
                    "-# Use e!logout to disconnect your Last.fm account."
                )
            );

            if (isPrefix && interaction.guild) {
                try {
                    await interaction.user.send({
                        components: [container],
                        flags: MessageFlags.IsComponentsV2,
                    });
                    const msg = await interaction.channel.send({
                        content: `ℹ️ <@${userId}>, you are already logged in as **${userData.lastfmUsername}**! I sent your details via DM.`,
                    });
                    setTimeout(() => msg.delete().catch(() => {}), 10000);
                    return;
                } catch {
                    return interaction.reply({
                        components: [container],
                        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
                    });
                }
            }

            return interaction.reply({
                components: [container],
                flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
            });
        }

        // Get auth token
        const token = await getAuthToken();
        if (!token) {
            return interaction.reply({
                content: "❌ Failed to get Last.fm authentication token. Please check the API configuration.",
                flags: MessageFlags.Ephemeral,
            });
        }

        // Store token for this user (persist in userData for restarts)
        userData.lastfmToken = token;
        userData.lastfmTokenTimestamp = Date.now();
        await saveUserData(userId, userData);

        // Also store in memory for quick access
        pendingAuth.set(userId, { token, timestamp: Date.now() });

        // Generate auth URL
        const authUrl = getAuthUrl(token);

        const container = new ContainerBuilder();
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "### 🔐 Last.fm Authentication\n\n" +
                "**Step 1**\n" +
                "-# Click the button below to authorize Euphie on Last.fm\n\n" +
                "**Step 2**\n" +
                "-# After authorizing, click **Verify** to complete the login\n\n" +
                "**Note**\n" +
                "-# This link expires in 30 minutes"
            )
        );

        const buttonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel("Authorize on Last.fm")
                .setStyle(ButtonStyle.Link)
                .setURL(authUrl),
            new ButtonBuilder()
                .setCustomId('lastfm_verify')
                .setLabel('Verify')
                .setStyle(ButtonStyle.Primary)
        );

        container.addActionRowComponents(buttonRow);

        // If prefix command in a server channel, deliver via private DM!
        if (isPrefix && interaction.guild) {
            try {
                if (interaction.message?.deletable) {
                    await interaction.message.delete().catch(() => {});
                }

                await interaction.user.send({
                    components: [container],
                    flags: MessageFlags.IsComponentsV2,
                });

                const notice = await interaction.channel.send({
                    content: `🔒 <@${userId}>, I have sent your private Last.fm authorization link to your **Direct Messages** so no one else can see or steal it!`,
                });
                setTimeout(() => notice.delete().catch(() => {}), 15000);
                return;
            } catch (dmErr) {
                return interaction.reply({
                    content: `⚠️ <@${userId}>, I couldn't send you a Direct Message! Please enable Direct Messages from server members so only you can see your login link, or use the slash command \`/login\` (which is natively private/ephemeral).`,
                });
            }
        }

        // Slash command ephemeral reply
        await interaction.reply({
            components: [container],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });

        // Clean up expired tokens after 30 minutes
        setTimeout(() => {
            pendingAuth.delete(userId);
            userData.lastfmToken = null;
            userData.lastfmTokenTimestamp = null;
            saveUserData(userId, userData);
        }, 30 * 60 * 1000);
    },

    async handleVerify(interaction) {
        const userId = interaction.user.id;

        // Try to get token from memory first
        let authData = pendingAuth.get(userId);

        // If not in memory, try to get from userData (for restarts)
        if (!authData) {
            const userData = await getUserData(userId);
            if (userData.lastfmToken && userData.lastfmTokenTimestamp) {
                // Check if token is still valid (30 minutes)
                const tokenAge = Date.now() - userData.lastfmTokenTimestamp;
                if (tokenAge < 30 * 60 * 1000) {
                    authData = { token: userData.lastfmToken, timestamp: userData.lastfmTokenTimestamp };
                }
            }
        }

        if (!authData) {
            return interaction.reply({
                content: "❌ Authentication expired or not found. Please run e!login again.",
                flags: MessageFlags.Ephemeral,
            });
        }

        // Get session key
        const session = await getSession(authData.token);
        if (!session) {
            // Clear invalid token
            const userData = await getUserData(userId);
            userData.lastfmToken = null;
            userData.lastfmTokenTimestamp = null;
            await saveUserData(userId, userData);
            pendingAuth.delete(userId);

            return interaction.reply({
                content: "❌ Failed to get session. Did you authorize on Last.fm? Please try again.",
                flags: MessageFlags.Ephemeral,
            });
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

        const container = new ContainerBuilder();
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "### ✅ Successfully Logged In\n\n" +
                "**Status**\n" +
                `-# You are now authenticated as **${session.name}**\n\n` +
                "**Scrobbling**\n" +
                "-# Your tracks will now be scrobbled to Last.fm automatically!"
            )
        );

        await interaction.reply({
            components: [container],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });
    }
};
