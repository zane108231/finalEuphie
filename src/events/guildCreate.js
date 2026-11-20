const { getGuildDataAsync } = require("../utils/mongoGuildData");
const { joinClientToWaitingRoom } = require("../utils/waitingRoom");

module.exports = {
    name: "guildCreate",
    async execute(client, guild) {
        try {
            const data = await getGuildDataAsync(guild.id);
            if (data.waitingRoomEnabled && data.waitingRoomChannelId) {
                await joinClientToWaitingRoom(client, guild.id);
            }
        } catch (error) {
            console.error(
                `[euphire] Could not join the waiting room after ${client.botId} joined guild ${guild.id}:`,
                error
            );
        }
    },
};
