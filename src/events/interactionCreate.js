const { MessageFlags } = require("discord.js");
const { handleButtonInteraction } = require("../handlers/buttonHandler");
const coordinator = require("../utils/mongoCoordinator");

/**
 * Music commands that require session routing
 */
const MUSIC_COMMANDS = new Set([
    "play", "skip", "pause", "resume", "stop", "leave", "dc", "join", "summon", "queue", "nowplaying",
    "loop", "shuffle", "volume", "seek", "autoplay",
    "clear", "move", "remove", "insert", "lyrics"
]);

/**
 * Check if a command is a music command
 */
function isMusicCommand(commandName) {
    return MUSIC_COMMANDS.has(commandName.toLowerCase());
}

module.exports = {
    name: "interactionCreate",
    async execute(client, interaction) {
        // Handle slash commands
        if (interaction.isChatInputCommand()) {
            const command = client.commands.get(interaction.commandName);
            if (!command) return;

            // Check if this bot should handle the command
            const botId = client.botId;
            const isMusic = isMusicCommand(interaction.commandName);
            const voiceChannelId = interaction.member?.voice?.channel?.id;
            const guildId = interaction.guildId || interaction.guild?.id;
            
            if (!coordinator.shouldHandleCommand(botId, guildId, voiceChannelId, isMusic)) {
                // This bot should not respond - let the correct bot handle it
                return;
            }

            try {
                await command.execute(interaction, client);
            } catch (error) {
                console.error(`[euphire] Command error (${interaction.commandName}):`, error);
                
                // Handle expired interactions
                if (error.code === 10062) {
                    console.log("[euphire] Interaction expired - unable to respond");
                    return;
                }
                
                const reply = { content: "An error occurred.", flags: MessageFlags.Ephemeral };
                try {
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp(reply);
                    } else {
                        await interaction.reply(reply);
                    }
                } catch (replyError) {
                    if (replyError.code === 10062) {
                        console.log("[euphire] Interaction expired during error reply");
                    } else {
                        console.error("[euphire] Error sending error reply:", replyError);
                    }
                }
            }
            return;
        }

        // Handle buttons and select menus
        if (interaction.isButton() || interaction.isStringSelectMenu()) {
            try {
                await handleButtonInteraction(client, interaction);
            } catch (error) {
                console.error("[euphire] Interaction error:", error);
                try {
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.deferUpdate();
                    }
                } catch (e) {
                    // ignore
                }
            }
        }
    },
};
