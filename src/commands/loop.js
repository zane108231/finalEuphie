const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const { requireMusicAction } = require("../utils/permissions");

module.exports = {
    aliases: ["repeat", "loopq"],
    data: new SlashCommandBuilder()
        .setName("loop")
        .setDescription("Toggle track or queue loop mode")
        .addStringOption((opt) =>
            opt
                .setName("mode")
                .setDescription("Loop mode (track, queue, or off)")
                .setRequired(false)
                .addChoices(
                    { name: "Track", value: "track" },
                    { name: "Queue", value: "queue" },
                    { name: "Off", value: "none" }
                )
        ),

    async execute(interaction, client) {
        const player = await requireMusicAction(interaction, client, "loop");
        if (!player) return;

        const guildId = interaction.guild.id;
        const guildData = getGuildData(guildId);
        const currentLoop = player.loop || guildData.loop || "none";

        const rawArgs = interaction.args || [];
        const rawFirst = (rawArgs[0] || "").toLowerCase().trim();
        const modeOpt = (interaction.options?.getString("mode") || "").toLowerCase().trim();

        // Check if queue loop was requested (e!loopq, e!loop q, e!loop queue, /loop mode:queue)
        const isQueueTarget =
            interaction.commandName === "loopq" ||
            rawFirst === "q" ||
            rawFirst === "queue" ||
            modeOpt === "queue";

        // Check if explicit off / none was requested
        const isExplicitOff =
            rawFirst === "off" ||
            rawFirst === "none" ||
            rawFirst === "disable" ||
            modeOpt === "none";

        let newMode = "none";
        let messageText = "";

        if (isExplicitOff) {
            newMode = "none";
            if (currentLoop === "queue") {
                messageText = "I will no longer repeat the queue";
            } else {
                messageText = "I will no longer repeat the current track";
            }
        } else if (isQueueTarget) {
            if (currentLoop === "queue") {
                newMode = "none";
                messageText = "I will no longer repeat the queue";
            } else {
                newMode = "queue";
                messageText = "I will now repeat the queue :repeat:";
            }
        } else {
            // Track loop toggle (e!loop, e!loop track, /loop mode:track, or e!repeat)
            if (currentLoop === "track") {
                newMode = "none";
                messageText = "I will no longer repeat the current track";
            } else {
                newMode = "track";
                messageText = "I will now repeat the current track :repeat_one:";
            }
        }

        // Apply new loop state
        player.setLoop(newMode);
        guildData.loop = newMode;
        await saveGuildData(guildId, guildData);

        // Green line on left side of rectangle embed message (0x00FF00)
        const embed = new EmbedBuilder()
            .setColor(0x00ff00)
            .setDescription(messageText);

        return interaction.reply({ embeds: [embed] });
    },
};
