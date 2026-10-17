const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder } = require("discord.js");
const { getPrefix } = require("../utils/prefixStore");
const {
    MUSIC_ACTIONS,
    isServerAdmin,
    isAllAction,
    resolveActions,
    ensureAllowMaps,
    grantAction,
    revokeAction,
} = require("../utils/permissions");
const coordinator = require("../utils/mongoCoordinator");

function parseMentionUser(interaction) {
    const fromOption = interaction.options?.getUser?.("user");
    if (fromOption) return fromOption;

    const mentions = interaction.message?.mentions?.users;
    if (!mentions?.size) return null;

    const botId = interaction.client?.user?.id;
    const notBot = mentions.filter((u) => u.id !== botId);
    return (notBot.size ? notBot : mentions).first() || null;
}

function parsePermissionArgs(interaction) {
    if (interaction.message?.content) {
        const prefix = getPrefix(interaction.guild.id);
        let rest = interaction.message.content.trim();
        if (rest.toLowerCase().startsWith(prefix.toLowerCase())) {
            rest = rest.slice(prefix.length);
        }
        const tokens = rest.trim().split(/\s+/);
        tokens.shift(); // command name
        const withoutMentions = tokens.filter((t) => !/^<@!?(\d+)>$/.test(t));
        return {
            rawAction: withoutMentions[0] || null,
            mode: (withoutMentions[1] || "").toLowerCase(),
            targetUser: parseMentionUser(interaction),
        };
    }

    return {
        rawAction: interaction.options.getString("action"),
        mode: (interaction.options.getString("mode") || "").toLowerCase(),
        targetUser: parseMentionUser(interaction),
    };
}

module.exports = {
    aliases: ["perms"],
    data: new SlashCommandBuilder()
        .setName("permission")
        .setDescription("Allow others to use music controls")
        .addStringOption((opt) =>
            opt.setName("action").setDescription("skip, stop, volume, all, ...").setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName("mode").setDescription("allow or deny").setRequired(false)
        )
        .addUserOption((opt) =>
            opt.setName("user").setDescription("User to allow/deny (omit for everyone)").setRequired(false)
        ),

    async execute(interaction) {
        const guildId = interaction.guild.id;
        const prefix = getPrefix(guildId);
        const guildData = await ensureAllowMaps(guildId);
        const { rawAction, mode, targetUser } = parsePermissionArgs(interaction);

        // Get session owner (the person who started the music)
        const voiceChannelId = interaction.member.voice?.channel?.id;
        const sessionOwner = coordinator.getSessionOwner(voiceChannelId);

        if (!rawAction || rawAction.toLowerCase() === "list") {
            const owner = sessionOwner ? "Session starter" : "Nobody yet — play a song first.";
            const lines = MUSIC_ACTIONS.map((name) => {
                const everyone = guildData.musicAllowEveryone?.has(name);
                const users = [...(guildData.musicAllows?.[name] || [])].map((id) => `<@${id}>`);
                if (everyone) {
                    return users.length
                        ? `**${name}** — everyone (+ ${users.join(", ")})`
                        : `**${name}** — everyone`;
                }
                if (users.length) return `**${name}** — ${users.join(", ")}`;
                return `**${name}** — session starter only`;
            });

            const container = new ContainerBuilder();
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    "### 🔐 Music Permissions\n\n" +
                    "**Who can control**\n" +
                    `-# ${owner}\n\n` +
                    "**Controls**\n" +
                    `-# ${lines.join("\n-# ")}\n\n` +
                    "**Grant**\n" +
                    `-# \`${prefix}permission skip allow\` — everyone can skip\n` +
                    `-# \`${prefix}permission skip allow @user\` — one person can skip\n` +
                    `-# \`${prefix}permission all allow @user\` — one person gets every control\n` +
                    `-# \`${prefix}permission all allow\` — everyone can control the bot`
                )
            );
            return interaction.reply({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
            });
        }

        // Only session starter or server admin can change permissions
        if (!isServerAdmin(interaction.member)) {
            return interaction.reply({
                content: "❌ Only the session starter (the person who started this music) or server admins can change music permissions.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const actions = resolveActions(rawAction);
        if (!actions.length) {
            return interaction.reply({
                content: `❌ Unknown permission. Use one of: ${MUSIC_ACTIONS.join(", ")}, or **all**`,
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!["allow", "deny"].includes(mode)) {
            return interaction.reply({
                content:
                    `❌ Usage: \`${prefix}permission <${MUSIC_ACTIONS.join("|")}|all> allow|deny [@user]\``,
                flags: MessageFlags.Ephemeral,
            });
        }

        const targetId = targetUser ? targetUser.id : "all";
        if (mode === "allow") await grantAction(guildId, rawAction, targetId);
        else await revokeAction(guildId, rawAction, targetId);

        const who = targetUser ? `<@${targetUser.id}>` : "everyone in the voice channel";
        const controlLabel = isAllAction(rawAction) ? "all music controls" : actions.join(", ");
        const container = new ContainerBuilder();
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `### ${mode === "allow" ? "✅" : "🛑"} Permission ${mode === "allow" ? "Granted" : "Removed"}\n\n` +
                "**Control**\n" +
                `-# ${controlLabel}\n\n` +
                "**Who**\n" +
                `-# ${who}`
            )
        );
        return interaction.reply({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        });
    },
};
