const {
    ChannelType,
    MessageFlags,
    SlashCommandBuilder,
} = require("discord.js");
const { getGuildDataAsync, saveGuildData } = require("../utils/mongoGuildData");
const { reconcileGuildWaitingRoom } = require("../utils/waitingRoom");
const { isDeveloper } = require("../utils/developerAccess");

function formatResults(results) {
    const joined = results.filter(
        (result) => result.status === "joined" || result.status === "already"
    ).length;
    const left = results.filter((result) => result.status === "left").length;
    const busy = results.filter((result) => result.status === "busy").length;
    const failures = results.filter((result) => result.status === "error");
    const unavailable = results.filter(
        (result) =>
            result.status === "unavailable" ||
            result.status === "not-in-room"
    ).length;
    return { joined, left, busy, failures, unavailable };
}

module.exports = {
    primaryOnly: true,
    data: new SlashCommandBuilder()
        .setName("waitingroom")
        .setDescription("Configure Euphie's per-server waiting room (developer only)")
        .addSubcommand((subcommand) =>
            subcommand
                .setName("set")
                .setDescription("Set this server's waiting room voice channel")
                .addChannelOption((option) =>
                    option
                        .setName("channel")
                        .setDescription("Voice channel where available Euphie bots will wait")
                        .addChannelTypes(ChannelType.GuildVoice)
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("enable")
                .setDescription("Enable the waiting room and send available bots there")
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("disable")
                .setDescription("Disable the waiting room and remove waiting bots")
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("status")
                .setDescription("Show this server's waiting room settings")
        ),

    async execute(interaction) {
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
        if (!interaction.isChatInputCommand?.()) {
            return interaction.reply({
                content:
                    "Use `/waitingroom set`, `/waitingroom enable`, `/waitingroom disable`, or `/waitingroom status`.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const action = interaction.options.getSubcommand();
        if (action === "status") {
            const data = await getGuildDataAsync(interaction.guildId);
            return interaction.reply({
                content:
                    `Euphie Waiting Room is **${data.waitingRoomEnabled ? "enabled" : "disabled"}**.` +
                    (data.waitingRoomChannelId
                        ? `\nChannel: <#${data.waitingRoomChannelId}>`
                        : "\nNo channel has been set. Use `/waitingroom set` first."),
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const data = await getGuildDataAsync(interaction.guildId);

        if (action === "set") {
            const channel = interaction.options.getChannel("channel", true);
            if (channel.type !== ChannelType.GuildVoice) {
                return interaction.editReply({
                    content: "❌ Choose a standard server voice channel.",
                });
            }
            data.waitingRoomChannelId = channel.id;
            await saveGuildData(interaction.guildId, data);
            if (!data.waitingRoomEnabled) {
                return interaction.editReply({
                    content:
                        `✅ Euphie Waiting Room channel set to ${channel}. It is currently disabled; run \`/waitingroom enable\` to turn it on.`,
                });
            }
        } else if (action === "enable") {
            if (!data.waitingRoomChannelId) {
                return interaction.editReply({
                    content:
                        "❌ Set a voice channel first with `/waitingroom set`.",
                });
            }
            data.waitingRoomEnabled = true;
            await saveGuildData(interaction.guildId, data);
        } else if (action === "disable") {
            data.waitingRoomEnabled = false;
            await saveGuildData(interaction.guildId, data);
        } else {
            return interaction.editReply({
                content: "❌ Unknown waiting room action.",
            });
        }

        const results = await reconcileGuildWaitingRoom(interaction.guildId);
        const summary = formatResults(results);
        if (summary.failures.length) {
            return interaction.editReply({
                content:
                    `Waiting room ${action === "disable" ? "disabled" : "updated"}; ` +
                    `${summary.joined} bot(s) joined or were already there, ` +
                    `${summary.busy} active bot(s) were left in their current channel, ` +
                    `${summary.unavailable} bot(s) were not currently available.\n` +
                    summary.failures
                        .map(({ botId, error }) => `• ${botId}: ${error}`)
                        .join("\n"),
            });
        }
        return interaction.editReply({
            content:
                action === "disable"
                    ? `✅ Euphie Waiting Room disabled. ${summary.left} waiting bot(s) were removed; active sessions were left alone.`
                    : `✅ Euphie Waiting Room ${action === "enable" ? "enabled" : "channel updated"}. ${summary.joined} bot(s) joined or were already there; ${summary.busy} active bot(s) stayed in their current channel.`,
        });
    },
};
