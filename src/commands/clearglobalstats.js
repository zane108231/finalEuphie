const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ModalBuilder,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require("discord.js");
const { clearGlobalProfileStats } = require("../utils/mongoStats");

const DEVELOPER_ID = "766135407590244383";
const CONFIRMATION_PHRASE = "DELETE ALL GLOBAL STATS";
const BUTTON_PREFIX = "clearglobalstats";

function isDeveloper(interaction) {
    return interaction.user?.id === DEVELOPER_ID;
}

module.exports = {
    primaryOnly: true,
    data: new SlashCommandBuilder()
        .setName("clearglobalstats")
        .setDescription("Clear all users' listening profile statistics"),

    async execute(interaction) {
        if (!isDeveloper(interaction)) {
            return interaction.reply({
                content: "❌ Only the bot developer can clear global statistics.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${BUTTON_PREFIX}:continue:${DEVELOPER_ID}`)
                .setLabel("Continue to confirmation")
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`${BUTTON_PREFIX}:cancel:${DEVELOPER_ID}`)
                .setLabel("Cancel")
                .setStyle(ButtonStyle.Secondary)
        );

        return interaction.reply({
            content:
                "⚠️ **This will permanently clear listening profile statistics for every user** " +
                "(`userStats`, `serverStats`, `trackStats`, and `sharedListening`) and remove " +
                "active stats-tracking records. It will not stop music or clear server settings, " +
                "account settings, Last.fm accounts, or saved playback sessions.\n\n" +
                `To proceed, continue and type \`${CONFIRMATION_PHRASE}\` exactly.`,
            components: [row],
            flags: MessageFlags.Ephemeral,
        });
    },

    async handleButton(interaction) {
        const match = interaction.customId.match(
            /^clearglobalstats:(continue|cancel):(\d{17,20})$/
        );
        if (!match) return;

        const [, action, ownerId] = match;
        if (!isDeveloper(interaction) || interaction.user.id !== ownerId) {
            return interaction.reply({
                content: "❌ Only the developer who requested this action can confirm it.",
                flags: MessageFlags.Ephemeral,
            });
        }

        if (action === "cancel") {
            return interaction.update({
                content: "Global statistics clear cancelled. No data was changed.",
                components: [],
            });
        }

        const modal = new ModalBuilder()
            .setCustomId(`${BUTTON_PREFIX}:modal:${DEVELOPER_ID}`)
            .setTitle("Confirm global statistics clear")
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId("confirmation")
                        .setLabel(`Type ${CONFIRMATION_PHRASE}`)
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(CONFIRMATION_PHRASE.length)
                        .setMaxLength(CONFIRMATION_PHRASE.length)
                        .setRequired(true)
                )
            );

        return interaction.showModal(modal);
    },

    async handleModalSubmit(interaction) {
        const match = interaction.customId.match(
            /^clearglobalstats:modal:(\d{17,20})$/
        );
        if (!match) return;

        if (!isDeveloper(interaction) || interaction.user.id !== match[1]) {
            return interaction.reply({
                content: "❌ Only the developer who requested this action can confirm it.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const confirmation = interaction.fields.getTextInputValue("confirmation");
        if (confirmation !== CONFIRMATION_PHRASE) {
            return interaction.reply({
                content: "❌ Confirmation text did not match. No data was changed.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const result = await clearGlobalProfileStats();
            return interaction.editReply({
                content:
                    "✅ **Global listening profile statistics cleared.** Music playback was not stopped.\n" +
                    `• User stats: ${result.userStats}\n` +
                    `• Server stats: ${result.serverStats}\n` +
                    `• Track stats: ${result.trackStats}\n` +
                    `• Shared listening: ${result.sharedListening}\n` +
                    `• Active stats sessions: ${result.activeSessions}\n` +
                    `• Session participants: ${result.sessionParticipants}`,
            });
        } catch (error) {
            console.error("[euphire] Clear global stats command failed:", error);
            return interaction.editReply({
                content:
                    "❌ Could not clear global statistics. Check the bot console; no success was reported.",
            });
        }
    },
};
