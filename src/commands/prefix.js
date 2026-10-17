const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder } = require("discord.js");
const { isServerAdmin } = require("../utils/permissions");
const { DEFAULT_PREFIX, getPrefix, setPrefix, resetPrefix } = require("../utils/prefixStore");

function isValidPrefix(value) {
    if (!value || typeof value !== "string") return false;
    if (value.length > 5) return false;
    if (/\s/.test(value)) return false;
    if (/@everyone|@here|<@/i.test(value)) return false;
    return true;
}

module.exports = {
    aliases: ["setprefix"],
    data: new SlashCommandBuilder()
        .setName("prefix")
        .setDescription("View or change this server's command prefix")
        .addStringOption((opt) =>
            opt.setName("action").setDescription("set or reset").setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName("value").setDescription("New prefix (max 5 characters)").setRequired(false)
        ),

    async execute(interaction) {
        const guildId = interaction.guild.id;
        const current = getPrefix(guildId);
        const action = (interaction.options.getString("action") || "").toLowerCase();
        const value = interaction.options.getString("value");

        if (!action) {
            const container = new ContainerBuilder();
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    "### ✨ Server Prefix\n\n" +
                    "**Current**\n" +
                    `-# \`${current}\`\n\n` +
                    "**Change it**\n" +
                    `-# \`${current}prefix set ?\`\n` +
                    `-# \`${current}prefix reset\`\n\n` +
                    "**Who can change it**\n" +
                    "-# Server administrators only."
                )
            );
            return interaction.reply({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
            });
        }

        if (!isServerAdmin(interaction.member)) {
            return interaction.reply({
                content: "❌ Only server administrators can change the prefix.",
                flags: MessageFlags.Ephemeral,
            });
        }

        if (action === "reset") {
            resetPrefix(guildId);
            const container = new ContainerBuilder();
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    "### ✅ Prefix Reset\n\n" +
                    "**Prefix**\n" +
                    `-# Back to \`${DEFAULT_PREFIX}\``
                )
            );
            return interaction.reply({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
            });
        }

        if (action === "set") {
            if (!isValidPrefix(value)) {
                return interaction.reply({
                    content: "❌ Prefix must be 1–5 characters with no spaces.",
                    flags: MessageFlags.Ephemeral,
                });
            }
            setPrefix(guildId, value);
            const container = new ContainerBuilder();
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    "### ✅ Prefix Updated\n\n" +
                    "**New prefix**\n" +
                    `-# \`${value}\`\n\n` +
                    "**Try it**\n" +
                    `-# \`${value}help\``
                )
            );
            return interaction.reply({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
            });
        }

        return interaction.reply({
            content: `❌ Usage: \`${current}prefix set ?\` or \`${current}prefix reset\``,
            flags: MessageFlags.Ephemeral,
        });
    },
};
