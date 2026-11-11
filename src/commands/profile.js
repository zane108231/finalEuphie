const { MessageFlags, AttachmentBuilder, SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getUserStats, getTopServers, getTopFriends, getTopTracks } = require("../utils/mongoStats");
const { getUserData, saveUserData, saveUserBackground, deleteUserBackground } = require("../utils/mongoUserData");
const { generateProfileCard, loadImageFromURL } = require("../utils/profileCard");
const { createCanvas } = require("@napi-rs/canvas");
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

function parseProfileColor(value) {
    const color = String(value || "").trim();
    if (!/^[a-z]+$/i.test(color)) return null;

    const context = createCanvas(1, 1).getContext("2d");
    context.fillStyle = "#010203";
    const unchangedColor = context.fillStyle;
    context.fillStyle = color;
    return context.fillStyle !== unchangedColor ? color : null;
}

function displayColorSetting(color, fallback) {
    if (!color) return fallback;
    return color.startsWith("#") ? "custom color" : color;
}

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
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setTitle("Help for command: profile set background")
            .setDescription(
                "Set your profile background, this can be set to\n" +
                "`avatar`, which is an image of the bot's avatar\n" +
                "`color`, which is a plain background with your set color\n" +
                "`default`, which resets to the default music background\n\n" +
                "It can also be set to a custom background by providing an image URL or uploading an image attachment.\n\n" +
                "**Usage**\n" +
                "```\ne!profile set background <background>\n```\n\n" +
                "**Examples**\n" +
                "```\n" +
                "profile set background avatar\n" +
                "profile set background color\n" +
                "profile set background color orange\n" +
                "profile set background default\n" +
                "profile set background https://cdn.discordapp.com/attachments/.../bg.png\n" +
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
        await deleteUserBackground(interaction.user.id);
        await saveUserData(interaction.user.id, userSettings);
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setDescription("✅ Profile background reset to the **default music background**. Use `e!profile` to view your card.");
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
        if (colorArg) {
            const profileColor = parseProfileColor(colorArg);
            if (!profileColor) {
                return interaction.reply({
                    content: "❌ Choose a valid color name, such as white, red, or orange.",
                    flags: MessageFlags.Ephemeral,
                });
            }
            userSettings.profileColor = profileColor;
        }
        userSettings.profileBackground = "color";
        await saveUserData(interaction.user.id, userSettings);
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setDescription("✅ Profile background set to a plain color (cat watermark removed). Use `e!profile` to view your card.");
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

    // Save to MongoDB permanently across all bots and restarts
    await saveUserBackground(interaction.user.id, imgBuffer);

    // Save locally on disk as fast cache
    const localFile = path.join(BG_DIR, `${interaction.user.id}.png`);
    try {
        fs.writeFileSync(localFile, imgBuffer);
    } catch (_) {}

    userSettings.profileBackground = "custom";
    await saveUserData(interaction.user.id, userSettings);

    const attachmentPreview = new AttachmentBuilder(localFile, { name: "background-preview.png" });
    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setTitle("✅ Profile Background Updated")
        .setDescription("Your custom background has been saved permanently to MongoDB! It will stay consistent across all bots and servers. Use `e!profile` to view your new card.")
        .setImage("attachment://background-preview.png");

    return interaction.editReply({ embeds: [embed], files: [attachmentPreview] });
}

/**
 * Handle e!profile set color <color name>
 */
async function handleSetColor(interaction, client, args) {
    const colorArg = (args[0] || "").trim();
    const color = parseProfileColor(colorArg);
    if (!color) {
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setTitle("Help for command: profile set color")
            .setDescription(
                "Set your profile color.\n\n" +
                "**Usage**\n" +
                "```\ne!profile set color <color name>\n```\n\n" +
                "**Examples**\n" +
                "```\n" +
                "profile set color white\n" +
                "profile set color red\n" +
                "profile set color orange\n" +
                "```"
            );
        return interaction.reply({ embeds: [embed] });
    }

    const userSettings = await getUserData(interaction.user.id);
    userSettings.profileColor = color;
    await saveUserData(interaction.user.id, userSettings);

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setDescription(`✅ Profile color set to **${colorArg}**. Use \`e!profile\` to view your card.`);

    return interaction.reply({ embeds: [embed] });
}

async function handleSetStatsColor(interaction, args) {
    const colorArg = (args[0] || "").trim();
    if (colorArg.toLowerCase() === "default" || colorArg.toLowerCase() === "reset") {
        const userSettings = await getUserData(interaction.user.id);
        userSettings.profileStatsColor = null;
        await saveUserData(interaction.user.id, userSettings);
        return interaction.reply({
            content: "✅ Profile server, friend, and track text color reset to the default gray.",
        });
    }

    const color = parseProfileColor(colorArg);
    if (!color) {
        return interaction.reply({
            content: "Set the server, friend, and track text color with a color name, such as `white`, `red`, or `orange`.\nUsage: `e!profile set stats color <color name>` (or `default`).",
            flags: MessageFlags.Ephemeral,
        });
    }

    const userSettings = await getUserData(interaction.user.id);
    userSettings.profileStatsColor = color;
    await saveUserData(interaction.user.id, userSettings);
    return interaction.reply({
        content: `✅ Profile server, friend, and track text color set to **${colorArg}**.`,
    });
}

/**
 * Handle e!profile set privacy <servers|friends|tracks|all> <show|hide>
 */
async function handleSetPrivacy(interaction, client, args) {
    const targetPart = (args[0] || "").toLowerCase().trim();
    const action = (args[1] || "").toLowerCase().trim();

    const userSettings = await getUserData(interaction.user.id);
    if (!userSettings.profilePrivacy) {
        userSettings.profilePrivacy = { servers: true, friends: true, tracks: true };
    }

    if (!targetPart || !["servers", "friends", "tracks", "all"].includes(targetPart)) {
        const s = userSettings.profilePrivacy.servers !== false ? "Visible" : "Hidden";
        const f = userSettings.profilePrivacy.friends !== false ? "Visible" : "Hidden";
        const t = userSettings.profilePrivacy.tracks !== false ? "Visible" : "Hidden";

        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setTitle("Help for command: profile set privacy")
            .setDescription(
                "Set what parts (servers, friends and tracks) are visible on your profile.\n\n" +
                "**Current Privacy Settings**\n" +
                `• **Servers**: ${s}\n` +
                `• **Friends**: ${f}\n` +
                `• **Tracks**: ${t}\n\n` +
                "**Usage**\n" +
                "```\ne!profile set privacy <servers | friends | tracks | all> <show | hide>\n```\n\n" +
                "**Examples**\n" +
                "```\n" +
                "profile set privacy tracks hide\n" +
                "profile set privacy friends show\n" +
                "profile set privacy all hide\n" +
                "```"
            );
        return interaction.reply({ embeds: [embed] });
    }

    const isVisible = ["show", "visible", "public", "on", "true", "yes"].includes(action);
    const isHidden = ["hide", "hidden", "private", "off", "false", "no"].includes(action);

    if (!isVisible && !isHidden) {
        return interaction.reply({
            content: "❌ Please specify `show` or `hide` (e.g. `e!profile set privacy tracks hide`).",
            flags: MessageFlags.Ephemeral,
        });
    }

    const stateVal = isVisible;

    if (targetPart === "all") {
        userSettings.profilePrivacy.servers = stateVal;
        userSettings.profilePrivacy.friends = stateVal;
        userSettings.profilePrivacy.tracks = stateVal;
    } else {
        userSettings.profilePrivacy[targetPart] = stateVal;
    }

    await saveUserData(interaction.user.id, userSettings);

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setDescription(`✅ Profile privacy for **${targetPart}** set to **${stateVal ? "Visible" : "Hidden"}**.`);

    return interaction.reply({ embeds: [embed] });
}

/**
 * Handle e!profile set visibility <public | private>
 */
async function handleSetVisibility(interaction, client, args) {
    const val = (args[0] || "").toLowerCase().trim();
    const userSettings = await getUserData(interaction.user.id);

    if (!["public", "private"].includes(val)) {
        const current = userSettings.profileVisibility || "public";
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setTitle("Help for command: profile set visibility")
            .setDescription(
                "Set who can view your profile, `public` or `private`.\n\n" +
                `**Current Setting**: \`${current}\`\n\n` +
                "**Usage**\n" +
                "```\ne!profile set visibility <public | private>\n```\n\n" +
                "**Examples**\n" +
                "```\n" +
                "profile set visibility public\n" +
                "profile set visibility private\n" +
                "```"
            );
        return interaction.reply({ embeds: [embed] });
    }

    userSettings.profileVisibility = val;
    await saveUserData(interaction.user.id, userSettings);

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setDescription(`✅ Profile visibility set to **${val}**.`);

    return interaction.reply({ embeds: [embed] });
}

/**
 * Handle e!profile set avatar shape <circle | square>
 */
async function handleSetAvatarShape(interaction, client, args) {
    const shape = (args[0] || "").toLowerCase().trim();
    const userSettings = await getUserData(interaction.user.id);

    if (!["circle", "square"].includes(shape)) {
        const current = userSettings.avatarShape || "circle";
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setTitle("Help for command: profile set avatar shape")
            .setDescription(
                "Set your profile avatar shape, `circle` or `square`.\n\n" +
                `**Current Setting**: \`${current}\`\n\n` +
                "**Usage**\n" +
                "```\ne!profile set avatar shape <circle | square>\n```\n\n" +
                "**Examples**\n" +
                "```\n" +
                "profile set avatar shape circle\n" +
                "profile set avatar shape square\n" +
                "```"
            );
        return interaction.reply({ embeds: [embed] });
    }

    userSettings.avatarShape = shape;
    await saveUserData(interaction.user.id, userSettings);

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setDescription(`✅ Profile avatar shape set to **${shape}**. Use \`e!profile\` to view your card.`);

    return interaction.reply({ embeds: [embed] });
}

/**
 * Handle e!profile set avatar border <color name | none | default>
 */
async function handleSetAvatarBorder(interaction, client, args) {
    const border = (args[0] || "").toLowerCase().trim();
    const userSettings = await getUserData(interaction.user.id);

    if (!border) {
        const current = displayColorSetting(userSettings.avatarBorder, "default");
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setTitle("Help for command: profile set avatar border")
            .setDescription(
                "Set your profile avatar border.\n\n" +
                `**Current Setting**: \`${current}\`\n\n` +
                "**Usage**\n" +
                "```\ne!profile set avatar border <color name | none | default>\n```\n\n" +
                "**Examples**\n" +
                "```\n" +
                "profile set avatar border white\n" +
                "profile set avatar border orange\n" +
                "profile set avatar border none\n" +
                "profile set avatar border default\n" +
                "```"
            );
        return interaction.reply({ embeds: [embed] });
    }

    if (border === "none") {
        userSettings.avatarBorder = "none";
    } else if (border === "default" || border === "reset") {
        userSettings.avatarBorder = null;
    } else {
        const color = parseProfileColor(border);
        if (!color) {
            return interaction.reply({
                content: "❌ Choose a color name such as white, red, or orange, or use `none` or `default`.",
                flags: MessageFlags.Ephemeral,
            });
        }
        userSettings.avatarBorder = color;
    }

    await saveUserData(interaction.user.id, userSettings);

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setDescription(`✅ Profile avatar border set to **${displayColorSetting(userSettings.avatarBorder, "default")}**. Use \`e!profile\` to view your card.`);

    return interaction.reply({ embeds: [embed] });
}

/**
 * Handle e!profile set server visibility <public | private>
 */
async function handleSetServerVisibility(interaction, client, args) {
    const val = (args[0] || "").toLowerCase().trim();
    const guildId = interaction.guild?.id;
    if (!guildId) {
        return interaction.reply({
            content: "❌ This command must be used in a server.",
            flags: MessageFlags.Ephemeral,
        });
    }

    const userSettings = await getUserData(interaction.user.id);
    if (!userSettings.serverVisibility) {
        userSettings.serverVisibility = {};
    }

    if (!["public", "private"].includes(val)) {
        const current = userSettings.serverVisibility[guildId] || "public";
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setTitle("Help for command: profile set server visibility")
            .setDescription(
                "Set who can view profile data from this server, `public` or `private`.\n\n" +
                `**Current Setting for ${interaction.guild.name}**: \`${current}\`\n\n` +
                "**Usage**\n" +
                "```\ne!profile set server visibility <public | private>\n```\n\n" +
                "**Examples**\n" +
                "```\n" +
                "profile set server visibility public\n" +
                "profile set server visibility private\n" +
                "```"
            );
        return interaction.reply({ embeds: [embed] });
    }

    userSettings.serverVisibility[guildId] = val;
    await saveUserData(interaction.user.id, userSettings);

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setDescription(`✅ Profile data visibility for this server (**${interaction.guild.name}**) set to **${val}**.`);

    return interaction.reply({ embeds: [embed] });
}

/**
 * Handle e!profile set avatar background <color name | default>
 */
async function handleSetAvatarBackground(interaction, client, args) {
    const val = (args[0] || "").toLowerCase().trim();
    const userSettings = await getUserData(interaction.user.id);

    if (!val) {
        const current = displayColorSetting(userSettings.avatarBackground, "default");
        const embed = new EmbedBuilder()
            .setColor(config.accentColor || 0x2b2d31)
            .setTitle("Help for command: profile set avatar background")
            .setDescription(
                "Set your profile avatar background.\n\n" +
                `**Current Setting**: \`${current}\`\n\n` +
                "**Usage**\n" +
                "```\ne!profile set avatar background <color name | default>\n```\n\n" +
                "**Examples**\n" +
                "```\n" +
                "profile set avatar background white\n" +
                "profile set avatar background orange\n" +
                "profile set avatar background default\n" +
                "```"
            );
        return interaction.reply({ embeds: [embed] });
    }

    if (val === "default" || val === "reset") {
        userSettings.avatarBackground = null;
    } else {
        const color = parseProfileColor(val);
        if (!color) {
            return interaction.reply({
                content: "❌ Choose a color name such as white, red, or orange, or use `default`.",
                flags: MessageFlags.Ephemeral,
            });
        }
        userSettings.avatarBackground = color;
    }

    await saveUserData(interaction.user.id, userSettings);

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setDescription(`✅ Profile avatar background set to **${displayColorSetting(userSettings.avatarBackground, "default")}**. Use \`e!profile\` to view your card.`);

    return interaction.reply({ embeds: [embed] });
}

module.exports = {
    aliases: ["user", "profile-background"],
    data: new SlashCommandBuilder()
        .setName("profile")
        .setDescription("View your music listening statistics profile or customize settings")
        .addStringOption((opt) =>
            opt.setName("action")
                .setDescription("Action (set, or leave blank to view profile)")
                .setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName("target")
                .setDescription("Target setting")
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

        // Check for "set" subcommands:
        // profile set color
        // profile set privacy
        // profile set background
        // profile set visibility
        // profile set avatar shape
        // profile set avatar border
        // profile set server visibility
        // profile set avatar background
        if (firstArg === "set") {
            const subAction = (rawArgs[1] || "").toLowerCase();
            const thirdArg = (rawArgs[2] || "").toLowerCase();

            if (subAction === "color" || subAction === "colour") {
                return await handleSetColor(interaction, client, rawArgs.slice(2));
            }
            if (subAction === "stats" && thirdArg === "color") {
                return await handleSetStatsColor(interaction, rawArgs.slice(3));
            }
            if (subAction === "stats" && thirdArg === "colour") {
                return await handleSetStatsColor(interaction, rawArgs.slice(3));
            }
            if (subAction === "privacy") {
                return await handleSetPrivacy(interaction, client, rawArgs.slice(2));
            }
            if (subAction === "background" || subAction === "bg") {
                return await handleSetBackground(interaction, client, rawArgs.slice(2));
            }
            if (subAction === "visibility") {
                return await handleSetVisibility(interaction, client, rawArgs.slice(2));
            }
            if (subAction === "server" && (thirdArg === "visibility" || thirdArg === "vis")) {
                return await handleSetServerVisibility(interaction, client, rawArgs.slice(3));
            }
            if (subAction === "avatar") {
                if (thirdArg === "shape") {
                    return await handleSetAvatarShape(interaction, client, rawArgs.slice(3));
                }
                if (thirdArg === "border") {
                    return await handleSetAvatarBorder(interaction, client, rawArgs.slice(3));
                }
                if (thirdArg === "background" || thirdArg === "bg") {
                    return await handleSetAvatarBackground(interaction, client, rawArgs.slice(3));
                }
            }

            // If just "e!profile set", show general profile help
            const helpCommand = require("./help");
            interaction.args = ["profile"];
            return await helpCommand.execute(interaction, client);
        }

        // Direct aliases without "set":
        if (firstArg === "background" || firstArg === "bg") {
            const nextArg = (rawArgs[1] || "").toLowerCase();
            if (nextArg === "set") {
                return await handleSetBackground(interaction, client, rawArgs.slice(2));
            }
            return await handleSetBackground(interaction, client, rawArgs.slice(1));
        }

        if (firstArg === "color" || firstArg === "colour") {
            return await handleSetColor(interaction, client, rawArgs.slice(1));
        }

        if (
            firstArg === "stats" &&
            ["color", "colour"].includes((rawArgs[1] || "").toLowerCase())
        ) {
            return await handleSetStatsColor(interaction, rawArgs.slice(2));
        }

        if (firstArg === "privacy") {
            return await handleSetPrivacy(interaction, client, rawArgs.slice(1));
        }

        if (firstArg === "visibility") {
            return await handleSetVisibility(interaction, client, rawArgs.slice(1));
        }

        // View Profile flow
        let targetUser = interaction.options?.getUser?.("user");
        if (!targetUser && rawArgs.length > 0) {
            const rawUserArg = rawArgs[0];
            if (rawUserArg && !["set", "background", "bg", "color", "colour", "privacy", "visibility"].includes(rawUserArg.toLowerCase())) {
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

        // Check target user visibility if viewing someone else
        if (targetUser.id !== interaction.user.id) {
            const targetData = await getUserData(targetUser.id);
            if (targetData.profileVisibility === "private") {
                const embed = new EmbedBuilder()
                    .setColor(0x2b2d31)
                    .setDescription("🔒 This user's profile is set to **private**.");
                return interaction.reply({ embeds: [embed] });
            }
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
    handleSetColor,
    handleSetPrivacy,
    handleSetVisibility,
    handleSetAvatarShape,
    handleSetAvatarBorder,
    handleSetServerVisibility,
    handleSetAvatarBackground,
};
