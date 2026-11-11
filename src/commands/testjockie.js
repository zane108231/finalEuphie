const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");

const DEVELOPER_ID = "766135407590244383";

module.exports = {
    primaryOnly: true,
    data: new SlashCommandBuilder()
        .setName("testjockie")
        .setDescription("Preview Euphie's Jockie availability response"),

    async execute(interaction) {
        if (interaction.user?.id !== DEVELOPER_ID) {
            return interaction.reply({
                content: "❌ You are not authorized to use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const embed = new EmbedBuilder()
            .setColor(0xf4a7c7)
            .setTitle("Ubos na Jockie? Ako na!")
            .setDescription("Gamitin mo na ako `e!join`")
            .setFooter({ text: "Ako napapalit muna diyan" });

        return interaction.reply({ embeds: [embed] });
    },
};
