const { handleChatPlayMessage } = require("../handlers/chatPlayHandler");
const { handlePrefixCommand } = require("../handlers/commandHandler");
const { rememberJockieCommand } = require("../utils/jockieJoinContext");

module.exports = {
    name: "messageCreate",
    async execute(client, message) {
        if (!message.guild) return;
        if (message.author.bot) return;

        if (/^\s*m!\S*/i.test(message.content || "")) {
            rememberJockieCommand({
                guildId: message.guild.id,
                voiceChannelId: message.member?.voice?.channelId,
                textChannelId: message.channel.id,
            });
        }

        // console.log(`[euphire] Message received: bot=${client.botId}, content="${message.content}", author=${message.author.id}`);

        if (await handlePrefixCommand(client, message)) return;

        await handleChatPlayMessage(client, message);
    },
};
