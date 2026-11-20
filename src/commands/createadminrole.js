const {
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} = require("discord.js");
const { isDeveloper } = require("../utils/developerAccess");
const ROLE_NAME = "Euphie Administrator";

module.exports = {
    primaryOnly: true,
    data: new SlashCommandBuilder()
        .setName("createadminrole")
        .setDescription("Create Euphie's administrator role (developer only)")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction, client) {
        if (!isDeveloper(interaction.user?.id)) {
            return interaction.reply({
                content: "❌ You are not authorized to use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!interaction.guild) {
            return interaction.reply({
                content: "❌ This command can only be used in a server.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const developerIsAdmin =
                interaction.guild.ownerId === interaction.user.id ||
                interaction.memberPermissions?.has(
                    PermissionFlagsBits.Administrator
                );
            if (!developerIsAdmin) {
                return interaction.editReply({
                    content:
                        "❌ You must own this server or have Administrator permission to create this role.",
                });
            }

            const botMember =
                interaction.guild.members.me ||
                (await interaction.guild.members.fetch(client.user.id));
            if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
                return interaction.editReply({
                    content:
                        "❌ Euphie needs the Manage Roles permission to create this role.",
                });
            }

            const existingRole = interaction.guild.roles.cache.find(
                (role) => role.name === ROLE_NAME
            );
            if (existingRole) {
                if (!existingRole.permissions.has(PermissionFlagsBits.Administrator)) {
                    return interaction.editReply({
                        content:
                            `❌ A role named "${ROLE_NAME}" already exists without Administrator permission. ` +
                            "Rename or remove it, then run this command again.",
                    });
                }

                return interaction.editReply({
                    content:
                        `ℹ️ ${existingRole} already exists with Administrator permission. ` +
                        "You can assign it to members in Server Settings → Roles.",
                });
            }

            const role = await interaction.guild.roles.create({
                name: ROLE_NAME,
                permissions: [PermissionFlagsBits.Administrator],
                reason: `Created by Euphie developer ${interaction.user.id}`,
            });

            return interaction.editReply({
                content:
                    `✅ Created ${role} with Administrator permission. ` +
                    "Administrator grants full server permissions. You can assign this role to members in Server Settings → Roles.",
            });
        } catch (error) {
            console.error(
                `[euphire] Failed to create administrator role in guild ${interaction.guildId}:`,
                error
            );
            return interaction.editReply({
                content:
                    "❌ Could not create the administrator role. Check Euphie's role hierarchy and Manage Roles permission, then try again.",
            });
        }
    },
};
