const {
    SlashCommandBuilder,
    MessageFlags,
    EmbedBuilder,
} = require("discord.js");
const { getPrefix } = require("../utils/prefixStore");
const {
    AVAILABLE_PERMISSIONS,
    ALL_PERMISSIONS,
    normalizePermission,
    resolvePermissions,
    isSessionStarterOrAdmin,
    isServerAdmin,
    isDj,
    grantPermission,
    denyPermission,
    resetPermissions,
    ensureAllowMaps,
} = require("../utils/permissions");
const { getUserData } = require("../utils/mongoUserData");
const coordinator = require("../utils/mongoCoordinator");

function parseTarget(interaction, tokens, defaultType = "everyone") {
    // 1. Check slash options
    const slashUser = interaction.options?.getUser?.("user") || interaction.options?.getUser?.("target");
    if (slashUser) {
        return { type: "user", id: slashUser.id, name: slashUser.username, obj: slashUser };
    }
    const slashRole = interaction.options?.getRole?.("role");
    if (slashRole) {
        return { type: "role", id: slashRole.id, name: slashRole.name, obj: slashRole };
    }

    // 2. Check message mentions
    const mentions = interaction.message?.mentions;
    if (mentions) {
        if (mentions.roles?.size) {
            const role = mentions.roles.first();
            return { type: "role", id: role.id, name: role.name, obj: role };
        }
        const botId = interaction.client?.user?.id;
        const users = mentions.users?.filter((u) => u.id !== botId);
        if (users?.size) {
            const user = users.first();
            return { type: "user", id: user.id, name: user.username, obj: user };
        }
    }

    // 3. Scan tokens
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i].toLowerCase();
        if (token === "everyone" || token === "@everyone") {
            tokens.splice(i, 1);
            return { type: "everyone", id: "everyone", name: "everyone" };
        }
        if (token === "all") {
            tokens.splice(i, 1);
            return { type: "all", id: "all", name: "all" };
        }
        // Match user mention <@123...> or role mention <@&123...>
        const userMentionMatch = token.match(/^<@!?(\d+)>$/);
        if (userMentionMatch) {
            const id = userMentionMatch[1];
            tokens.splice(i, 1);
            const user = interaction.guild?.members?.cache?.get(id)?.user || interaction.client?.users?.cache?.get(id);
            return { type: "user", id, name: user ? user.username : id };
        }
        const roleMentionMatch = token.match(/^<@&(\d+)>$/);
        if (roleMentionMatch) {
            const id = roleMentionMatch[1];
            tokens.splice(i, 1);
            const role = interaction.guild?.roles?.cache?.get(id);
            return { type: "role", id, name: role ? role.name : id };
        }
        // Match raw ID
        if (/^\d{17,20}$/.test(token)) {
            const id = token;
            tokens.splice(i, 1);
            if (interaction.guild?.roles?.cache?.has(id)) {
                return { type: "role", id, name: interaction.guild.roles.cache.get(id).name };
            }
            const user = interaction.guild?.members?.cache?.get(id)?.user;
            return { type: "user", id, name: user ? user.username : id };
        }
    }

    if (defaultType === "everyone") {
        return { type: "everyone", id: "everyone", name: "everyone" };
    }
    return null;
}

function parseScope(tokens) {
    let scope = "session";
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i].toLowerCase();
        if (t === "--server" || t === "-server" || t === "server") {
            scope = "server";
            tokens.splice(i, 1);
            break;
        } else if (t === "--self" || t === "-self" || t === "self") {
            scope = "self";
            tokens.splice(i, 1);
            break;
        } else if (t === "--session" || t === "-session" || t === "session") {
            scope = "session";
            tokens.splice(i, 1);
            break;
        }
    }
    return scope;
}

function formatTargetDisplay(target) {
    if (!target || target.type === "everyone" || target.id === "everyone") {
        return "everyone";
    }
    if (target.type === "all" || target.id === "all") {
        return "all";
    }
    if (target.type === "role") {
        return `<@&${target.id}>`;
    }
    return `<@${target.id}>`;
}

module.exports = {
    aliases: [
        "permissions",
        "perms",
        "permissionsallow",
        "permissionallow",
        "allowpermission",
        "permissionsdeny",
        "permissiondeny",
        "denypermission",
        "permissionsallowall",
        "permissionallowall",
        "allowallpermissions",
        "permissionsdenyall",
        "permissiondenyall",
        "denyallpermissions",
        "permissionsremoveall",
        "permissionremoveall",
        "removeallpermissions",
        "permissionsreset",
        "permissionreset",
        "resetpermissions",
        "permissionsadd",
        "permissionadd",
        "addpermission",
        "permissionsremove",
        "permissionremove",
        "removepermission",
    ],
    data: new SlashCommandBuilder()
        .setName("permission")
        .setDescription("Allow or deny music controls for users or roles")
        .addSubcommand((sub) =>
            sub
                .setName("allow")
                .setDescription("Allow a specific permission for the current session or server")
                .addStringOption((opt) =>
                    opt.setName("permission").setDescription("Permission to allow (e.g. add track, leave, volume)").setRequired(true)
                )
                .addUserOption((opt) => opt.setName("user").setDescription("User to allow").setRequired(false))
                .addRoleOption((opt) => opt.setName("role").setDescription("Role to allow").setRequired(false))
                .addStringOption((opt) =>
                    opt
                        .setName("scope")
                        .setDescription("Permission scope")
                        .addChoices(
                            { name: "session", value: "session" },
                            { name: "server", value: "server" },
                            { name: "self", value: "self" }
                        )
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("deny")
                .setDescription("Deny a specific permission for the current session or server")
                .addStringOption((opt) =>
                    opt.setName("permission").setDescription("Permission to deny").setRequired(true)
                )
                .addUserOption((opt) => opt.setName("user").setDescription("User to deny").setRequired(false))
                .addRoleOption((opt) => opt.setName("role").setDescription("Role to deny").setRequired(false))
                .addStringOption((opt) =>
                    opt
                        .setName("scope")
                        .setDescription("Permission scope")
                        .addChoices(
                            { name: "session", value: "session" },
                            { name: "server", value: "server" },
                            { name: "self", value: "self" }
                        )
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("reset")
                .setDescription("Reset permissions of a session or user")
                .addStringOption((opt) => opt.setName("target").setDescription("role, user, everyone, or all").setRequired(false))
                .addStringOption((opt) =>
                    opt
                        .setName("scope")
                        .setDescription("Permission scope")
                        .addChoices(
                            { name: "session", value: "session" },
                            { name: "server", value: "server" },
                            { name: "self", value: "self" }
                        )
                        .setRequired(false)
                )
        ),

    async execute(interaction, client) {
        const guildId = interaction.guild?.id;
        if (!guildId) return;

        const prefix = getPrefix(guildId);
        const guildData = await ensureAllowMaps(guildId);

        // Resolve active player if any
        const voiceChannelId = interaction.member?.voice?.channel?.id;
        const sessionOwner = voiceChannelId
            ? coordinator.resolveSessionOwner(voiceChannelId, interaction.guild) || coordinator.getSessionOwner(voiceChannelId)
            : null;
        const targetClient = sessionOwner ? coordinator.getClient(sessionOwner) || client : client;
        const targetRiffy = targetClient.riffy || client.riffy;
        const player = targetRiffy?.players?.get(guildId) || null;

        // Parse command name and raw tokens
        const invoked = (interaction.commandName || "").toLowerCase();
        let tokens = Array.isArray(interaction.args) ? [...interaction.args] : [];

        // Check invoked name for fused aliases
        let mode = null;
        if (
            invoked === "permissionsallowall" ||
            invoked === "permissionallowall" ||
            invoked === "allowallpermissions"
        ) {
            mode = "allow all";
        } else if (
            invoked === "permissionsdenyall" ||
            invoked === "permissiondenyall" ||
            invoked === "denyallpermissions" ||
            invoked === "permissionsremoveall" ||
            invoked === "permissionremoveall" ||
            invoked === "removeallpermissions"
        ) {
            mode = "deny all";
        } else if (
            invoked === "permissionsreset" ||
            invoked === "permissionreset" ||
            invoked === "resetpermissions"
        ) {
            mode = "reset";
        } else if (
            invoked === "permissionsallow" ||
            invoked === "permissionallow" ||
            invoked === "allowpermission" ||
            invoked === "permissionsadd" ||
            invoked === "permissionadd" ||
            invoked === "addpermission"
        ) {
            mode = "allow";
        } else if (
            invoked === "permissionsdeny" ||
            invoked === "permissiondeny" ||
            invoked === "denypermission" ||
            invoked === "permissionsremove" ||
            invoked === "permissionremove" ||
            invoked === "removepermission"
        ) {
            mode = "deny";
        }

        // Determine mode from tokens if not determined by command name
        if (!mode && tokens.length > 0) {
            const first = tokens[0].toLowerCase();
            const second = (tokens[1] || "").toLowerCase();

            if (first === "allow" && second === "all") {
                mode = "allow all";
                tokens.splice(0, 2);
            } else if ((first === "deny" || first === "remove") && second === "all") {
                mode = "deny all";
                tokens.splice(0, 2);
            } else if (first === "allow" || first === "add") {
                mode = "allow";
                tokens.shift();
            } else if (first === "deny" || first === "remove") {
                mode = "deny";
                tokens.shift();
            } else if (first === "reset") {
                mode = "reset";
                tokens.shift();
            } else if (first === "list" || first === "view") {
                mode = "view";
                tokens.shift();
            }
        }

        // Default to view if no action mode was specified
        if (!mode) {
            mode = "view";
        }

        // Extract scope (--server, --self, --session)
        let scope = parseScope(tokens);
        if (interaction.options?.getString?.("scope")) {
            scope = interaction.options.getString("scope").toLowerCase();
        }

        // Parse target
        const target = parseTarget(interaction, tokens, mode === "view" ? "everyone" : "everyone");

        // Parse permission (for allow / deny)
        let rawPerm = interaction.options?.getString?.("permission") || null;
        if (!rawPerm && tokens.length > 0) {
            rawPerm = tokens.join(" ").trim();
        }

        // --- AUTHORIZATION CHECK ---
        if (mode === "allow" || mode === "deny" || mode === "allow all" || mode === "deny all" || mode === "reset") {
            if (scope === "server") {
                if (!isServerAdmin(interaction.member)) {
                    return interaction.reply({
                        content: "❌ Only server admins can change server-wide permissions.",
                        flags: MessageFlags.Ephemeral,
                    });
                }
            } else if (scope === "session") {
                const canManage = isSessionStarterOrAdmin(interaction.member, interaction.guild, player, guildData);
                if (!canManage) {
                    return interaction.reply({
                        content: "❌ Only the session starter (the person who started this music) or server admins can change music permissions.",
                        flags: MessageFlags.Ephemeral,
                    });
                }
            }
            // self scope is allowed for the caller
        }

        // --- EXECUTE SUBCOMMANDS ---

        // 1. ALLOW ALL
        if (mode === "allow all") {
            await grantPermission(guildId, target, "all", scope, interaction.user.id);
            const targetDisplay = formatTargetDisplay(target);
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setDescription(`Allowed all permissions for ${targetDisplay} (${scope})`);
            return interaction.reply({ embeds: [embed] });
        }

        // 2. DENY ALL
        if (mode === "deny all") {
            await denyPermission(guildId, target, "all", scope, interaction.user.id);
            const targetDisplay = formatTargetDisplay(target);
            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setDescription(`Denied all permissions for ${targetDisplay} (${scope})`);
            return interaction.reply({ embeds: [embed] });
        }

        // 3. RESET
        if (mode === "reset") {
            await resetPermissions(guildId, target, scope, interaction.user.id);
            const targetDisplay = formatTargetDisplay(target);
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setDescription(`Reset permissions for ${targetDisplay} (${scope})`);
            return interaction.reply({ embeds: [embed] });
        }

        // 4. ALLOW A SPECIFIC PERMISSION
        if (mode === "allow") {
            if (!rawPerm) {
                return interaction.reply({
                    content: `❌ Please specify a permission to allow.\nAvailable permissions: ${ALL_PERMISSIONS.map((p) => `\`${p}\``).join(", ")}`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            const perm = normalizePermission(rawPerm);
            if (!perm) {
                return interaction.reply({
                    content: `❌ Unknown permission: \`${rawPerm}\`.\nAvailable permissions: ${ALL_PERMISSIONS.map((p) => `\`${p}\``).join(", ")}`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            await grantPermission(guildId, target, perm, scope, interaction.user.id);
            const targetDisplay = formatTargetDisplay(target);
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setDescription(`Allowed \`${perm}\` for ${targetDisplay} (${scope})`);
            return interaction.reply({ embeds: [embed] });
        }

        // 5. DENY A SPECIFIC PERMISSION
        if (mode === "deny") {
            if (!rawPerm) {
                return interaction.reply({
                    content: `❌ Please specify a permission to deny.\nAvailable permissions: ${ALL_PERMISSIONS.map((p) => `\`${p}\``).join(", ")}`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            const perm = normalizePermission(rawPerm);
            if (!perm) {
                return interaction.reply({
                    content: `❌ Unknown permission: \`${rawPerm}\`.\nAvailable permissions: ${ALL_PERMISSIONS.map((p) => `\`${p}\``).join(", ")}`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            await denyPermission(guildId, target, perm, scope, interaction.user.id);
            const targetDisplay = formatTargetDisplay(target);
            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setDescription(`Denied \`${perm}\` for ${targetDisplay} (${scope})`);
            return interaction.reply({ embeds: [embed] });
        }

        // 6. VIEW PERMISSIONS (permissions / permissions @user / permissions everyone / permissions --server / permissions --self)
        if (mode === "view") {
            const targetDisplay = formatTargetDisplay(target);
            const isSelf = scope === "self";
            const targetId = target ? String(target.id) : "everyone";
            const isTargetEveryone = targetId === "everyone";

            let userData = null;
            if (isSelf) {
                userData = await getUserData(interaction.user.id);
            }

            const store = scope === "server" ? guildData.serverPermissions : guildData.sessionPermissions;
            const allows = store?.allows || {};
            const denies = store?.denies || {};
            const allowEveryone = store?.allowEveryone || [];
            const denyEveryone = store?.denyEveryone || [];

            // Check member status if viewing a user in a session
            const memberObj = target.type === "user" ? interaction.guild?.members?.cache?.get(targetId) : null;
            const isUserAdmin = memberObj ? isServerAdmin(memberObj) : false;
            const isUserDj = memberObj ? isDj(memberObj, player, guildData) : false;

            const lines = ALL_PERMISSIONS.map((permName) => {
                const info = AVAILABLE_PERMISSIONS[permName];
                let isAllowed = false;

                if (isSelf && userData?.selfPermissions) {
                    if (userData.selfPermissions.allows?.includes(permName)) isAllowed = true;
                    if (userData.selfPermissions.denies?.includes(permName)) isAllowed = false;
                } else if (scope === "session" && (isUserAdmin || isUserDj)) {
                    isAllowed = true;
                } else {
                    if (isTargetEveryone) {
                        if (denyEveryone.includes(permName)) isAllowed = false;
                        else if (allowEveryone.includes(permName)) isAllowed = true;
                        else if (permName === "add track" || permName === "add playlist") isAllowed = true;
                        else isAllowed = false;
                    } else {
                        // Specific user or role
                        if (denyEveryone.includes(permName)) isAllowed = false;
                        else if (denies[permName]?.includes(targetId)) isAllowed = false;
                        else if (allowEveryone.includes(permName)) isAllowed = true;
                        else if (allows[permName]?.includes(targetId)) isAllowed = true;
                        else if (permName === "add track" || permName === "add playlist") isAllowed = true;
                        else isAllowed = false;
                    }
                }

                const icon = isAllowed ? "✅" : "❌";
                return `${icon} **${info.name}** — ${info.description}`;
            });

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(`🔐 Permissions • ${targetDisplay} (${scope})`)
                .setDescription(lines.join("\n"))
                .setFooter({
                    text: `Usage: ${prefix}permission allow ${targetDisplay === "everyone" ? "everyone" : "@user"} <permission>`,
                });

            return interaction.reply({ embeds: [embed] });
        }
    },
};
