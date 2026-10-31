const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { applyGuildBotProfile, resetGuildBotProfile } = require("../utils/guildBotProfile");
const { getDB } = require("../utils/database");

const OWNER_ID = "766135407590244383";
const PRIMARY_BOT_ID = "euphie_main";

module.exports = {
    data: new SlashCommandBuilder()
        .setName("botprofile")
        .setDescription("Manage Euphie's server-specific profile")
        .addSubcommand((subcommand) =>
            subcommand
                .setName("copy")
                .setDescription("Copy a server member's name and avatar to the Euphies")
                .addUserOption((option) =>
                    option
                        .setName("user")
                        .setDescription("The server member whose name and avatar to copy")
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("reset")
                .setDescription("Restore the Euphies' normal names and avatars in this server")
        ),

    async execute(interaction, client) {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.reply({
                content: "Only the bot owner can use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }

        if (client.botId !== PRIMARY_BOT_ID) {
            return interaction.reply({
                content: "This command is only handled by the main Euphie bot.",
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!interaction.guild) {
            return interaction.reply({
                content: "This command can only be used in a server.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const subcommand = interaction.options.getSubcommand();
            if (subcommand === "reset") {
                const result = await resetGuildBotProfile(interaction.guildId);
                if (!result.updated.length) {
                    return interaction.editReply({
                        content: `Could not reset any Euphie profiles${result.errors.length ? ` (${result.errors.map(({ botName }) => botName).join(", ")}).` : "."}`,
                    });
                }

                if (!result.errors.length) {
                    await getDB().collection("guildData").updateOne(
                        { guildId: interaction.guildId },
                        { $unset: { botModelUserId: "", botModelSince: "" } }
                    );
                }

                let message = `Reset the server-specific profile for ${result.updated.map((name) => `**${name}**`).join(", ")} in **${interaction.guild.name}**. Euphie is back to its normal name and avatar.`;
                if (result.errors.length) {
                    message += `\nThe current model was kept because some bots could not be reset: ${result.errors.map(({ botName }) => botName).join(", ")}.`;
                } else {
                    message += "\nThe current model has been cleared.";
                }
                return interaction.editReply({ content: message });
            }

            const targetUser = interaction.options.getUser("user", true);
            const targetMember = await interaction.guild.members.fetch(targetUser.id);
            const result = await applyGuildBotProfile(interaction.guildId, targetMember);

            if (!result.updated.length) {
                return interaction.editReply({
                    content: `Could not update any Euphie profiles in this server${result.errors.length ? ` (${result.errors.map(({ botName }) => botName).join(", ")}).` : "."}`,
                });
            }

            let message = `Copied **${result.baseName}**'s name and avatar to ${result.updated.map(({ nickname }) => `**${nickname}**`).join(", ")} in **${interaction.guild.name}**.`;
            if (result.errors.length) {
                message += `\nCould not update: ${result.errors.map(({ botName }) => botName).join(", ")}.`;
            }
            message += "\nThese changes apply only to this server.";
            return interaction.editReply({ content: message });
        } catch (error) {
            console.error(`[euphire] /botprofile failed in ${interaction.guildId}:`, error);
            return interaction.editReply({
                content: `Could not update the bot profile: ${error.message}`,
            });
        }
    },
};
