const { handleChatPlayMessage } = require("../handlers/chatPlayHandler");
const { handlePrefixCommand } = require("../handlers/commandHandler");
const { JOCKIE_BOT_IDS } = require("../utils/jockieBotIds");
const { EmbedBuilder } = require("discord.js");
const coordinator = require("../utils/mongoCoordinator");

function isJockieNoBotsMessage(message) {
    if (!JOCKIE_BOT_IDS.has(message.author.id)) return false;
    const embedContent = (message.embeds || []).flatMap((embed) => [
        embed.title,
        embed.description,
        embed.author?.name,
        embed.footer?.text,
        ...(embed.fields || []).flatMap((field) => [field.name, field.value]),
    ]);
    const content = [message.content, ...embedContent]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .toLowerCase();
    return content.includes(
        "there are no more bots available in this server"
    );
}

async function respondToJockieNoBotsMessage(client, message) {
    const primaryClient = coordinator.getClient(
        coordinator.primaryBotId || "euphie_main"
    );
    if (client !== primaryClient || !isJockieNoBotsMessage(message)) return;

    const embed = new EmbedBuilder()
        .setColor(0xf4a7c7)
        .setTitle("No more JockieBots?")
        .setDescription(
            "You can use **Euphie Music** as an alternative!\n\n" +
                "Simply type `e!join` to start listening to your favorite music."
        );

    try {
        await message.channel.send({ embeds: [embed] });
    } catch (error) {
        console.error(
            `[euphire] Could not respond to Jockie’s no-bots message in channel ${message.channel.id}:`,
            error.message
        );
    }
}

async function respondToEuphieMention(client, message) {
    if (!client.user?.id || !message.mentions?.users?.has(client.user.id)) {
        return false;
    }

    const supportUrl = "https://discord.gg/mCCyM8Msxm";
    const embed = new EmbedBuilder()
        .setColor(0xf4a7c7)
        .setDescription(
            "Basic commands\n" +
                `[\`e!play\`](${supportUrl}) - Play a track by link or search term\n` +
                `[\`e!skip\`](${supportUrl}) - Skip the current track\n` +
                `[\`e!leave\`](${supportUrl}) - Make the bot leave the voice channel\n` +
                `[\`e!setup\`](${supportUrl}) - Helps you setup certain bot features\n\n` +
                "Use the [`e!help`] command for more commands.\n\n" +
                "Support Server\n" +
                `Join our [Support Server](${supportUrl}) if you need help, want to get information about updates and issues or want to engage in community discussions with the developers!`
        );

    try {
        await message.channel.send({ embeds: [embed] });
    } catch (error) {
        console.error(
            `[euphire] Could not respond to a mention in channel ${message.channel.id}:`,
            error.message
        );
    }

    return true;
}

module.exports = {
    name: "messageCreate",
    isJockieNoBotsMessage,
    async execute(client, message) {
        if (!message.guild) return;
        if (message.author.bot) {
            await respondToJockieNoBotsMessage(client, message);
            return;
        }

        if (await respondToEuphieMention(client, message)) return;

        // console.log(`[euphire] Message received: bot=${client.botId}, content="${message.content}", author=${message.author.id}`);

        if (await handlePrefixCommand(client, message)) return;

        await handleChatPlayMessage(client, message);
    },
};
