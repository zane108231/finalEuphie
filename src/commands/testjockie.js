const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");
const { isDeveloper } = require("../utils/developerAccess");

module.exports = {
    primaryOnly: true,
    data: new SlashCommandBuilder()
        .setName("testjockie")
        .setDescription("Preview Euphie's Jockie availability response"),

    async execute(interaction) {
        if (!isDeveloper(interaction.user?.id)) {
            return interaction.reply({
                content: "❌ You are not authorized to use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const embed = new EmbedBuilder()
            .setColor(0xf4a7c7)
            .setTitle("No more JockieBots?")
            .setDescription(
                "You can use **Euphie Music** as an alternative!\n\n" +
                    "Simply type `e!join` to start listening to your favorite music."
            );

        return interaction.reply({ embeds: [embed] });
    },
};
