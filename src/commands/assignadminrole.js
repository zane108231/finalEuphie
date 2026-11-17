const {
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} = require("discord.js");

const DEVELOPER_ID = "766135407590244383";
const ROLE_NAME = "Euphie Administrator";

module.exports = {
    primaryOnly: true,
    data: new SlashCommandBuilder()
        .setName("assignadminrole")
        .setDescription("Give Euphie's administrator role to a member (developer only)")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption((option) =>
            option
                .setName("member")
                .setDescription("Member who will receive full server permissions")
                .setRequired(true)
        ),

    async execute(interaction, client) {
        if (interaction.user?.id !== DEVELOPER_ID) {
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
                        "❌ You must own this server or have Administrator permission to assign this role.",
                });
            }

            const botMember =
                interaction.guild.members.me ||
                (await interaction.guild.members.fetch(client.user.id));
            if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
                return interaction.editReply({
                    content:
                        "❌ Euphie needs the Manage Roles permission to assign this role.",
                });
            }

            const role = interaction.guild.roles.cache.find(
                (candidate) =>
                    candidate.name === ROLE_NAME &&
                    candidate.permissions.has(PermissionFlagsBits.Administrator)
            );
            if (!role) {
                return interaction.editReply({
                    content:
                        `❌ The "${ROLE_NAME}" role with Administrator permission was not found. ` +
                        "Create it first with `/createadminrole`.",
                });
            }
            if (role.managed || role.position >= botMember.roles.highest.position) {
                return interaction.editReply({
                    content:
                        "❌ Euphie cannot manage that role. Move Euphie's highest role above it in Server Settings → Roles.",
                });
            }

            const user = interaction.options.getUser("member", true);
            if (user.bot) {
                return interaction.editReply({
                    content: "❌ Choose a human server member, not a bot.",
                });
            }

            const member = await interaction.guild.members.fetch(user.id);
            if (member.roles.cache.has(role.id)) {
                return interaction.editReply({
                    content: `ℹ️ ${member} already has ${role}.`,
                });
            }

            await member.roles.add(
                role,
                `Assigned by Euphie developer ${interaction.user.id}`
            );

            return interaction.editReply({
                content:
                    `✅ Assigned ${role} to ${member}. This role grants full server permissions.`,
            });
        } catch (error) {
            console.error(
                `[euphire] Failed to assign administrator role in guild ${interaction.guildId}:`,
                error
            );
            return interaction.editReply({
                content:
                    "❌ Could not assign the administrator role. Check Euphie's Manage Roles permission and role hierarchy, then try again.",
            });
        }
    },
};
