const {
    ChannelType,
    MessageFlags,
    SlashCommandBuilder,
} = require("discord.js");
const {
    MODEL_THRESHOLD_MS,
    getGuildModelStats,
    getCurrentModelUserId,
    manuallySetModel,
    setNotificationChannel,
} = require("../utils/modelMilestones");

const OWNER_ID = "766135407590244383";
const HOUR_MS = 60 * 60 * 1000;

function isOwner(interaction) {
    return interaction.user.id === OWNER_ID;
}

function ownerOnlyReply(interaction) {
    return interaction.reply({
        content: "Only the bot owner can use this command.",
        flags: MessageFlags.Ephemeral,
    });
}

function guildOnlyReply(interaction) {
    return interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
    });
}

const commands = [
    {
        data: new SlashCommandBuilder()
            .setName("modelstats")
            .setDescription("Privately view this server's progress toward Euphie's 100-hour model milestone"),
        async execute(interaction) {
            if (!isOwner(interaction)) return ownerOnlyReply(interaction);
            if (!interaction.guild) return guildOnlyReply(interaction);

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const [entries, currentModelUserId] = await Promise.all([
                    getGuildModelStats(interaction.guildId),
                    getCurrentModelUserId(interaction.guildId),
                ]);

                if (!entries.length) {
                    return interaction.editReply("No active-play listening time has been recorded in this server yet.");
                }

                const lines = entries.map((entry, index) => {
                    const hours = entry.listeningMs / HOUR_MS;
                    const progress = Math.min(100, Math.floor((entry.listeningMs / MODEL_THRESHOLD_MS) * 100));
                    const current = currentModelUserId === entry.userId ? " — current model" : "";
                    return `**${index + 1}.** <@${entry.userId}> — **${hours.toFixed(2)}h / 100h** (${progress}%)${current}`;
                });

                return interaction.editReply({
                    content: `**Euphie model progress — ${interaction.guild.name}**\n${lines.join("\n")}`,
                    allowedMentions: { parse: [] },
                });
            } catch (error) {
                console.error(`[euphire] /modelstats failed in ${interaction.guildId}:`, error);
                return interaction.editReply(`Could not load model stats: ${error.message}`);
            }
        },
    },
    {
        data: new SlashCommandBuilder()
            .setName("modelchannel")
            .setDescription("Set this server's private Euphie 100-hour milestone announcement channel")
            .addChannelOption((option) =>
                option
                    .setName("channel")
                    .setDescription("Channel where milestone messages will be posted")
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setRequired(true)
            ),
        async execute(interaction) {
            if (!isOwner(interaction)) return ownerOnlyReply(interaction);
            if (!interaction.guild) return guildOnlyReply(interaction);

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const channel = interaction.options.getChannel("channel", true);
                const pending = await setNotificationChannel(interaction.guildId, channel.id);
                let message = `Milestone announcements for **${interaction.guild.name}** will be sent to <#${channel.id}>.`;
                if (pending) {
                    message += `\nProcessed ${pending} previously-qualified user(s).`;
                }
                return interaction.editReply({ content: message });
            } catch (error) {
                console.error(`[euphire] /modelchannel failed in ${interaction.guildId}:`, error);
                return interaction.editReply(`Could not set the notification channel: ${error.message}`);
            }
        },
    },
    {
        data: new SlashCommandBuilder()
            .setName("setmodel")
            .setDescription("Manually make a server member Euphie's model and send the milestone message")
            .addUserOption((option) =>
                option
                    .setName("user")
                    .setDescription("The member to use as Euphie's model")
                    .setRequired(true)
            ),
        async execute(interaction) {
            if (!isOwner(interaction)) return ownerOnlyReply(interaction);
            if (!interaction.guild) return guildOnlyReply(interaction);

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const user = interaction.options.getUser("user", true);
                const member = await interaction.guild.members.fetch(user.id);
                const result = await manuallySetModel(interaction.guildId, member);
                const updated = result.updated.map(({ nickname }) => `**${nickname}**`).join(", ");
                let message = `**${member.displayName}** is now the Euphie model in **${interaction.guild.name}**. Updated: ${updated}.`;
                if (result.errors.length) {
                    message += `\nCould not update: ${result.errors.map(({ botName }) => botName).join(", ")}.`;
                }
                if (result.profileError) {
                    message += `\n${result.profileError.message}`;
                }
                if (result.notified) {
                    message += "\nThe milestone message was sent.";
                } else if (result.notificationError) {
                    message += `\nThe model was changed, but the milestone message could not be sent: ${result.notificationError.message}`;
                }
                return interaction.editReply(message);
            } catch (error) {
                console.error(`[euphire] /setmodel failed in ${interaction.guildId}:`, error);
                return interaction.editReply(`Could not set the model: ${error.message}`);
            }
        },
    },
];

module.exports = { commands };
