const { handleChatPlayMessage } = require("../handlers/chatPlayHandler");
const { handlePrefixCommand } = require("../handlers/commandHandler");

module.exports = {
    name: "messageCreate",
    async execute(client, message) {
        if (!message.guild) return;
        if (message.author.bot) return;

        // console.log(`[euphire] Message received: bot=${client.botId}, content="${message.content}", author=${message.author.id}`);

        if (await handlePrefixCommand(client, message)) return;

        await handleChatPlayMessage(client, message);
    },
};
