const { SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder } = require("discord.js");
const { getUserData, saveUserData, deleteUserData } = require("../utils/mongoUserData");

module.exports = {
    aliases: [],
    data: new SlashCommandBuilder()
        .setName("logout")
        .setDescription("Disconnect your Last.fm account"),

    async execute(interaction, client) {
        const userId = interaction.user.id;

        // Check if logged in
        const userData = await getUserData(userId);
        if (!userData.lastfmSessionKey) {
            const container = new ContainerBuilder();
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    "### ⚠️ Not Logged In\n\n" +
                    "**Status**\n" +
                    "-# You are not currently authenticated with Last.fm\n\n" +
                    "**Want to log in?**\n" +
                    "-# Use e!login to connect your Last.fm account."
                )
            );
            return interaction.reply({
                components: [container],
                flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
            });
        }

        // Remove session key
        userData.lastfmSessionKey = null;
        userData.lastfmUsername = null;
        await saveUserData(userId, userData);

        const container = new ContainerBuilder();
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "### ✅ Successfully Logged Out\n\n" +
                "**Status**\n" +
                "-# Your Last.fm account has been disconnected\n\n" +
                "**Scrobbling**\n" +
                "-# Your tracks will no longer be scrobbled to Last.fm"
            )
        );

        await interaction.reply({
            components: [container],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });
    }
};
