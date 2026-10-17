const { MessageFlags, AttachmentBuilder, SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getUserStats, getTopServers, getTopFriends, getTopTracks, resetAllProfileStats } = require("../utils/mongoStats");
const { getUserData, saveUserData } = require("../utils/mongoUserData");
const { generateProfileCard, loadImageFromURL } = require("../utils/profileCard");
const { isServerAdmin } = require("../utils/permissions");
const fs = require("fs");
const path = require("path");
const config = require("../../config");

// Local backgrounds storage directory
const BG_DIR = path.join(__dirname, "..", "..", "data", "backgrounds");
if (!fs.existsSync(BG_DIR)) {
    fs.mkdirSync(BG_DIR, { recursive: true });
}

/**
 * Resolve and refresh Discord attachment URLs using Bot Token
 */
async function resolveDiscordUrl(url, client) {
    if (!url || typeof url !== "string") return url;

    if (url.includes("cdn.discordapp.com/attachments/") || url.includes("media.discordapp.net/attachments/")) {
        try {
            const token = client?.token || process.env.BOT_TOKEN;
            if (token) {
                const cleanUrl = url.split("?")[0];
                const res = await fetch("https://discord.com/api/v10/attachments/refresh-urls", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bot ${token}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ attachment_urls: [cleanUrl] })
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data?.refreshed_urls?.[0]?.refreshed) {
                        return data.refreshed_urls[0].refreshed;
                    }
                }
            }
        } catch (err) {
            console.error("[euphire] Failed to refresh Discord attachment URL:", err.message);
        }
    }
    return url;
}

// Prevent double execution
const executingProfiles = new Map();

/**
 * Handle e!profile set background <background>
 */
async function handleSetBackground(interaction, client, args) {
    let value = (args[0] || "").trim();

    // Check message attachments if no text URL given
    const attachment = interaction.message?.attachments?.first() || interaction.options?.getAttachment?.("image");
    if (attachment && attachment.url) {
        value = attachment.url;
    }

    if (!value) {
        // Show help embed matching reference Image 3
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setTitle("Help for command: profile set background")
            .setDescription(
                "Set your profile background, this can be set to\n" +
                "`avatar`, which is an image of the bot's avatar\n" +
                "`color`, which is a plain background with your set color\n" +
                "`default`, which resets to the original background\n\n" +
                "It can also be set to a custom background by providing an image URL or uploading an image attachment.\n\n" +
                "**Usage**\n" +
                "```\ne!profile set background <background>\n```\n\n" +
                "**Examples**\n" +
                "```\n" +
                "profile set background avatar\n" +
                "profile set background color\n" +
                "profile set background default\n" +
                "profile set background https://cdn.discordapp.com/attachments/.../maxresdefault.png\n" +
                "```\n\n" +
                "**Aliases**\n" +
                "```\n" +
                "set profile background\n" +
                "profile background\n" +
                "profile background set\n" +
                "```"
            );
        return interaction.reply({ embeds: [embed] });
    }

    const lower = value.toLowerCase();
    const userSettings = await getUserData(interaction.user.id);

    if (lower === "default" || lower === "reset") {
        userSettings.profileBackground = "default";
        const localFile = path.join(BG_DIR, `${interaction.user.id}.png`);
        if (fs.existsSync(localFile)) {
            try { fs.unlinkSync(localFile); } catch (_) {}
        }
        await saveUserData(interaction.user.id, userSettings);
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setDescription("✅ Profile background reset to **default** (with cat watermark). Use `e!profile` to view your card.");
        return interaction.reply({ embeds: [embed] });
    }

    if (lower === "avatar") {
        userSettings.profileBackground = "avatar";
        await saveUserData(interaction.user.id, userSettings);
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setDescription("✅ Profile background set to **bot avatar**. Use `e!profile` to view your card.");
        return interaction.reply({ embeds: [embed] });
    }

    if (lower === "color" || lower === "colour") {
        const colorArg = (args[1] || "").trim();
        if (colorArg && /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(colorArg)) {
            userSettings.profileColor = colorArg.startsWith("#") ? colorArg : `#${colorArg}`;
        }
        userSettings.profileBackground = "color";
        await saveUserData(interaction.user.id, userSettings);
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setDescription(`✅ Profile background set to plain color **${userSettings.profileColor || "#2b2d31"}** (cat watermark removed). Use \`e!profile\` to view your card.`);
        return interaction.reply({ embeds: [embed] });
    }

    // Assume custom image URL
    if (!/^https?:\/\//i.test(value)) {
        return interaction.reply({
            content: "❌ Please provide a valid image URL (e.g. `https://...`) or attach an image to your message.",
            flags: MessageFlags.Ephemeral,
        });
    }

    await interaction.deferReply();

    let resolvedUrl = value;
    if (value.includes("cdn.discordapp.com/attachments/") || value.includes("media.discordapp.net/attachments/")) {
        resolvedUrl = await resolveDiscordUrl(value, client);
    }

    let imgBuffer = null;
    try {
        const res = await fetch(resolvedUrl);
        if (!res.ok) {
            throw new Error(`Image request failed: ${res.status}`);
        }
        imgBuffer = Buffer.from(await res.arrayBuffer());
        const { loadImage } = require("@napi-rs/canvas");
        await loadImage(imgBuffer);
    } catch (err) {
        return interaction.editReply({
            content: `❌ Could not load or decode image from that URL. Please ensure it is a direct image link (PNG, JPG, WEBP) and publicly accessible.\n*Error: ${err.message}*`,
        });
    }

    // Save locally on disk so it NEVER expires!
    const localFile = path.join(BG_DIR, `${interaction.user.id}.png`);
    fs.writeFileSync(localFile, imgBuffer);

    userSettings.profileBackground = "custom";
    await saveUserData(interaction.user.id, userSettings);

    const attachmentPreview = new AttachmentBuilder(localFile, { name: "background-preview.png" });
    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setTitle("✅ Profile Background Updated")
        .setDescription("Your custom background has been saved permanently! Use `e!profile` to view your new card.")
        .setImage("attachment://background-preview.png");

    return interaction.editReply({ embeds: [embed], files: [attachmentPreview] });
}

/**
 * Handle e!profile set color <hex>
 */
async function handleSetColor(interaction, client, args) {
    const colorArg = (args[0] || "").trim();
    if (!colorArg || !/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(colorArg)) {
        return interaction.reply({
            content: "❌ Please provide a valid hex color code (e.g. `e!profile set color #5865F2` or `e!profile set color #1e1f22`).",
            flags: MessageFlags.Ephemeral,
        });
    }

    const hex = colorArg.startsWith("#") ? colorArg : `#${colorArg}`;
    const userSettings = await getUserData(interaction.user.id);
    userSettings.profileColor = hex;
    userSettings.profileBackground = "color";
    await saveUserData(interaction.user.id, userSettings);

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setDescription(`✅ Profile color set to **${hex}** (background switched to plain color). Use \`e!profile\` to view your card.`);

    return interaction.reply({ embeds: [embed] });
}

module.exports = {
    aliases: ["user", "profile-background"],
    data: new SlashCommandBuilder()
        .setName("profile")
        .setDescription("View your music listening statistics profile or customize background")
        .addStringOption((opt) =>
            opt.setName("action")
                .setDescription("Action ('set', 'reset', or leave blank to view profile)")
                .setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName("target")
                .setDescription("Target setting or user to reset")
                .setRequired(false)
        )
        .addUserOption((opt) =>
            opt.setName("user")
                .setDescription("User to view profile for")
                .setRequired(false)
        ),

    async execute(interaction, client) {
        const guildId = interaction.guildId || interaction.guild?.id || "dm";
        const rawArgs = interaction.args || [];

        const firstArg = (
            rawArgs[0] ||
            interaction.options?.getString?.("action") ||
            ""
        ).toLowerCase();

        // Check for "set" subcommands: e!profile set background <url> / e!profile set color <hex>
        if (firstArg === "set") {
            const subAction = (rawArgs[1] || "").toLowerCase();
            if (subAction === "background" || subAction === "bg") {
                return await handleSetBackground(interaction, client, rawArgs.slice(2));
            }
            if (subAction === "color" || subAction === "colour") {
                return await handleSetColor(interaction, client, rawArgs.slice(2));
            }
            // If just "e!profile set", show background help by default
            return await handleSetBackground(interaction, client, []);
        }

        // Direct aliases: e!profile background <url> / e!profile bg <url>
        if (firstArg === "background" || firstArg === "bg") {
            const nextArg = (rawArgs[1] || "").toLowerCase();
            if (nextArg === "set") {
                return await handleSetBackground(interaction, client, rawArgs.slice(2));
            }
            return await handleSetBackground(interaction, client, rawArgs.slice(1));
        }

        // Direct alias: e!profile color <hex>
        if (firstArg === "color" || firstArg === "colour") {
            return await handleSetColor(interaction, client, rawArgs.slice(1));
        }

        // Check for reset action (e!profile reset / e!profile reset all / e!profile reset me / e!profile reset @user)
        if (firstArg === "reset" || firstArg === "clear") {
            const secondArg = (
                rawArgs[1] ||
                interaction.options?.getString?.("target") ||
                ""
            ).trim();

            const isAdmin =
                !interaction.guild ||
                interaction.guild?.ownerId === interaction.user?.id ||
                isServerAdmin(interaction.member);

            let targetUserId = null;
            let targetLabel = "Everyone (All users & servers)";

            if (!secondArg || ["all", "everyone", "global", "*"].includes(secondArg.toLowerCase())) {
                if (!isAdmin) {
                    return interaction.reply({
                        content: "❌ Only server administrators can reset profile statistics for everyone. Use `e!profile reset me` to reset only your own statistics.",
                        flags: MessageFlags.Ephemeral,
                    });
                }
                targetUserId = null;
                targetLabel = "Everyone (All users & servers)";
            } else if (["me", "self"].includes(secondArg.toLowerCase())) {
                targetUserId = interaction.user.id;
                targetLabel = `<@${interaction.user.id}> (${interaction.user.tag || interaction.user.username})`;
            } else {
                const mentionMatch = secondArg.match(/^<@!?(\d{17,20})>$/);
                const rawId = mentionMatch ? mentionMatch[1] : (/^\d{17,20}$/.test(secondArg) ? secondArg : null);

                if (rawId) {
                    if (!isAdmin && rawId !== interaction.user.id) {
                        return interaction.reply({
                            content: "❌ Only server administrators can reset profile statistics for other users.",
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    targetUserId = rawId;
                    targetLabel = `<@${rawId}>`;
                } else {
                    return interaction.reply({
                        content: "❌ Invalid target. Usage:\n• `e!profile reset` or `e!profile reset all` (Admin only: resets everyone)\n• `e!profile reset me` (Resets your own stats)\n• `e!profile reset @user` (Admin only: resets specific user)",
                        flags: MessageFlags.Ephemeral,
                    });
                }
            }

            try {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            } catch {
                // Ignore if defer fails
            }

            try {
                const result = await resetAllProfileStats(targetUserId);

                const summaryText =
                    "### 🧹 Profile Database Reset\n\n" +
                    `**Scope**: ${targetLabel}\n` +
                    `• **User Stats cleared**: \`${result.userStats}\`\n` +
                    `• **Server Stats cleared**: \`${result.serverStats}\`\n` +
                    `• **Friend Stats cleared**: \`${result.friendStats}\`\n` +
                    `• **Track Stats cleared**: \`${result.trackStats}\`\n` +
                    `• **Active Sessions cleared**: \`${result.activeSessions}\`\n\n` +
                    "All requested statistics have been reset.";

                return interaction.editReply({
                    content: summaryText,
                });
            } catch (err) {
                console.error("[euphire] Failed to reset profile database:", err);
                return interaction.editReply({
                    content: `❌ An error occurred while resetting profile statistics: ${err.message}`,
                });
            }
        }

        // View Profile flow
        let targetUser = interaction.options?.getUser?.("user");
        if (!targetUser && rawArgs.length > 0) {
            const rawUserArg = rawArgs[0];
            if (rawUserArg && !["reset", "clear", "set", "background", "bg", "color", "colour"].includes(rawUserArg.toLowerCase())) {
                const mentionMatch = rawUserArg.match(/^<@!?(\d{17,20})>$/);
                const rawId = mentionMatch ? mentionMatch[1] : (/^\d{17,20}$/.test(rawUserArg) ? rawUserArg : null);
                if (rawId) {
                    targetUser = { id: rawId };
                }
            }
        }
        if (!targetUser) {
            targetUser = interaction.user;
        }

        const key = `${guildId}-${targetUser.id}`;
        
        // Check if already executing
        if (executingProfiles.has(key)) {
            return;
        }
        
        executingProfiles.set(key, true);

        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } catch (err) {
            executingProfiles.delete(key);
            return;
        }

        try {
            let user = await client.users.fetch(targetUser.id).catch(() => null);
            if (!user) {
                const coordinator = require("../utils/mongoCoordinator");
                for (const otherClient of coordinator.getAllClients()) {
                    user = await otherClient.users.fetch(targetUser.id).catch(() => null);
                    if (user) break;
                }
            }
            if (!user) user = targetUser;
            
            if (!user) {
                executingProfiles.delete(key);
                return interaction.editReply({
                    content: "❌ Could not fetch user data.",
                });
            }

            const stats = await getUserStats(user.id);
            const topServers = await getTopServers(user.id, 3);
            const topFriends = await getTopFriends(user.id, 3);
            const topTracks = await getTopTracks(user.id, 3);

            // Fetch user customization settings from MongoDB
            const userSettings = await getUserData(user.id);

            const imageBuffer = await generateProfileCard(
                user,
                stats,
                topServers,
                topFriends,
                topTracks,
                client,
                userSettings
            );

            const attachment = new AttachmentBuilder(imageBuffer, { name: `${user.username || user.id}-profile.png` });

            await interaction.editReply({
                files: [attachment],
            });
        } catch (error) {
            console.error("[euphire] Profile command error:", error);
            await interaction.editReply({
                content: "❌ Failed to generate profile. Please try again later.",
            });
        } finally {
            // Clear the flag after a delay
            setTimeout(() => executingProfiles.delete(key), 2000);
        }
    },

    handleSetBackground,
    handleSetColor
};
