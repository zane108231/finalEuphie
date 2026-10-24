const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require("discord.js");
const { isServerAdmin } = require("../utils/permissions");
const {
    DEFAULT_PREFIX,
    isValidPrefix,
    getServerPrefixes,
    getUserPrefixData,
    addServerPrefix,
    setServerPrefix,
    removeServerPrefix,
    resetServerPrefixes,
    addUserPrefix,
    setUserPrefix,
    removeUserPrefix,
    resetUserPrefixes,
    toggleUserCombine,
} = require("../utils/prefixStore");

function buildPrefixHelpEmbed() {
    return new EmbedBuilder()
        .setColor(0x2b2d31)
        .setDescription(
            "Page **14/20**\n\n" +
            "[Prefix](https://discord.gg)\n" +
            "---------------------------------\n" +
            "Prefix related commands\n" +
            "---------------------------------\n\n" +
            "**Server**\n" +
            "**prefix server add**: *Add additional prefixes for this server*\n" +
            "**prefix server set**: *Set a custom prefix for this server*\n" +
            "**prefix server reset**: *Remove all custom prefixes from the server*\n" +
            "**prefix server remove**: *Remove a custom prefix from the server*\n\n" +
            "**Self**\n" +
            "**prefix self add**: *Add additional prefixes*\n" +
            "**prefix self set**: *Set a custom prefix*\n" +
            "**prefix self reset**: *Remove all custom prefixes*\n" +
            "**prefix self remove**: *Remove a custom prefix*\n" +
            "**prefix self combine**: *Combine your prefixes with the server's*\n\n" +
            "**Other**\n" +
            "**prefix list**: *Get all available prefixes*\n\n" +
            "-# next page | previous page | go to page <page> | cancel"
        );
}

module.exports = {
    aliases: ["setprefix"],
    data: new SlashCommandBuilder()
        .setName("prefix")
        .setDescription("View, customize, or manage server and personal command prefixes")
        .addStringOption((opt) =>
            opt.setName("scope")
                .setDescription("Scope: 'server', 'self', 'list', 'set', 'reset'")
                .setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName("action")
                .setDescription("Action: 'add', 'set', 'remove', 'reset', 'combine'")
                .setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName("value")
                .setDescription("Prefix value (max 10 characters, no spaces)")
                .setRequired(false)
        ),

    async execute(interaction) {
        const guildId = interaction.guild?.id;
        const userId = interaction.user?.id;
        const rawArgs = interaction.args || [];

        let scope = (interaction.options?.getString("scope") || rawArgs[0] || "").toLowerCase().trim();
        let action = (interaction.options?.getString("action") || rawArgs[1] || "").toLowerCase().trim();
        let value = interaction.options?.getString("value") || rawArgs[2] || "";

        // If no arguments passed, show the help embed
        if (!scope) {
            return interaction.reply({ embeds: [buildPrefixHelpEmbed()] });
        }

        // Handle shorthand: e!prefix list
        if (scope === "list") {
            const serverPrefixes = getServerPrefixes(guildId);
            const userPrefs = getUserPrefixData(userId);

            const embed = new EmbedBuilder()
                .setColor(0x2b2d31)
                .setTitle("📋 Available Command Prefixes")
                .setDescription(
                    `**Default Prefix**: \`${DEFAULT_PREFIX}\`\n\n` +
                    `**Server Prefixes** (${interaction.guild?.name || "This Server"}):\n` +
                    serverPrefixes.map(p => `• \`${p}\``).join("\n") + "\n\n" +
                    `**Your Personal Prefixes**:\n` +
                    (userPrefs.prefixes.length > 0 ? userPrefs.prefixes.map(p => `• \`${p}\``).join("\n") : "• *None set*") + "\n\n" +
                    `**Combine Personal with Server**: **${userPrefs.combine ? "Enabled" : "Disabled"}**`
                );
            return interaction.reply({ embeds: [embed] });
        }

        // Handle shorthand: e!prefix set <val> / e!prefix reset / e!prefix add <val> / e!prefix remove <val>
        if (["set", "reset", "add", "remove"].includes(scope) && !["server", "self"].includes(action)) {
            value = rawArgs[1] || interaction.options?.getString("action") || "";
            action = scope;
            scope = "server"; // Default shorthand modifies server
        }

        // ======================================================================
        // SERVER PREFIX COMMANDS
        // ======================================================================
        if (scope === "server") {
            const isAdmin =
                !interaction.guild ||
                interaction.guild?.ownerId === interaction.user?.id ||
                isServerAdmin(interaction.member);

            if (!isAdmin) {
                return interaction.reply({
                    content: "❌ Only server administrators can configure server prefixes.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (action === "add") {
                if (!value || !isValidPrefix(value)) {
                    return interaction.reply({
                        content: "❌ Please provide a valid prefix (1–10 characters, no spaces, no mentions). Usage: `prefix server add <prefix>`",
                        flags: MessageFlags.Ephemeral,
                    });
                }
                await addServerPrefix(guildId, value);
                const current = getServerPrefixes(guildId);
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setDescription(`✅ Added server prefix \`${value}\`.\n**Active server prefixes**: ${current.map(p => `\`${p}\``).join(", ")}`);
                return interaction.reply({ embeds: [embed] });
            }

            if (action === "set") {
                if (!value || !isValidPrefix(value)) {
                    return interaction.reply({
                        content: "❌ Please provide a valid prefix (1–10 characters, no spaces, no mentions). Usage: `prefix server set <prefix>`",
                        flags: MessageFlags.Ephemeral,
                    });
                }
                await setServerPrefix(guildId, value);
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setDescription(`✅ Set server prefix to \`${value}\`.\nTry: \`${value}play\``);
                return interaction.reply({ embeds: [embed] });
            }

            if (action === "reset") {
                await resetServerPrefixes(guildId);
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setDescription(`✅ All custom server prefixes removed. Reset back to default: \`${DEFAULT_PREFIX}\`.`);
                return interaction.reply({ embeds: [embed] });
            }

            if (action === "remove") {
                if (!value) {
                    return interaction.reply({
                        content: "❌ Usage: `prefix server remove <prefix>`",
                        flags: MessageFlags.Ephemeral,
                    });
                }
                await removeServerPrefix(guildId, value);
                const current = getServerPrefixes(guildId);
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setDescription(`✅ Removed server prefix \`${value}\`.\n**Active server prefixes**: ${current.map(p => `\`${p}\``).join(", ")}`);
                return interaction.reply({ embeds: [embed] });
            }

            return interaction.reply({ embeds: [buildPrefixHelpEmbed()] });
        }

        // ======================================================================
        // SELF (USER) PREFIX COMMANDS
        // ======================================================================
        if (scope === "self") {
            if (action === "add") {
                if (!value || !isValidPrefix(value)) {
                    return interaction.reply({
                        content: "❌ Please provide a valid prefix (1–10 characters, no spaces, no mentions). Usage: `prefix self add <prefix>`",
                        flags: MessageFlags.Ephemeral,
                    });
                }
                await addUserPrefix(userId, value);
                const userPrefs = getUserPrefixData(userId);
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setDescription(`✅ Added personal prefix \`${value}\`.\n**Your personal prefixes**: ${userPrefs.prefixes.map(p => `\`${p}\``).join(", ")}`);
                return interaction.reply({ embeds: [embed] });
            }

            if (action === "set") {
                if (!value || !isValidPrefix(value)) {
                    return interaction.reply({
                        content: "❌ Please provide a valid prefix (1–10 characters, no spaces, no mentions). Usage: `prefix self set <prefix>`",
                        flags: MessageFlags.Ephemeral,
                    });
                }
                await setUserPrefix(userId, value);
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setDescription(`✅ Set your personal prefix to \`${value}\`.\nYou can now use \`${value}\` anywhere you use Euphie!`);
                return interaction.reply({ embeds: [embed] });
            }

            if (action === "reset") {
                await resetUserPrefixes(userId);
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setDescription("✅ Removed all personal custom prefixes.");
                return interaction.reply({ embeds: [embed] });
            }

            if (action === "remove") {
                if (!value) {
                    return interaction.reply({
                        content: "❌ Usage: `prefix self remove <prefix>`",
                        flags: MessageFlags.Ephemeral,
                    });
                }
                await removeUserPrefix(userId, value);
                const userPrefs = getUserPrefixData(userId);
                const remaining = userPrefs.prefixes.length > 0 ? userPrefs.prefixes.map(p => `\`${p}\``).join(", ") : "*None*";
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setDescription(`✅ Removed personal prefix \`${value}\`.\n**Remaining personal prefixes**: ${remaining}`);
                return interaction.reply({ embeds: [embed] });
            }

            if (action === "combine") {
                const isCombined = await toggleUserCombine(userId);
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setDescription(
                        `✅ Personal prefix combining is now **${isCombined ? "enabled" : "disabled"}**.\n` +
                        (isCombined
                            ? "You can use both your personal prefixes and this server's prefixes."
                            : "You will only use your personal prefixes.")
                    );
                return interaction.reply({ embeds: [embed] });
            }

            return interaction.reply({ embeds: [buildPrefixHelpEmbed()] });
        }

        // Default fallback: show prefix help embed
        return interaction.reply({ embeds: [buildPrefixHelpEmbed()] });
    },
};
