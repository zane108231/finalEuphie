const { createPlaybackFeature } = require("../utils/playbackFeature");
const { getGuildData, saveGuildData } = require("../utils/mongoGuildData");
const coordinator = require("../utils/mongoCoordinator");

module.exports = createPlaybackFeature({
    name: "playleave",
    description: "Play a track and leave when the queue finishes",
    async afterPlay(interaction, client) {
        const guildId = interaction.guild?.id;
        if (!guildId) return;

        const voiceChannelId = interaction.member?.voice?.channel?.id;
        const ownerId = coordinator.getSessionOwner(voiceChannelId);
        const targetRiffy = ownerId
            ? coordinator.getRiffy(ownerId)
            : client.riffy;
        const player = targetRiffy?.players?.get(guildId);
        if (!player || (!player.playing && !player.paused && !player.queue?.length)) {
            return;
        }

        const guildData = getGuildData(guildId);
        guildData.leaveAfterQueueEnd = true;
        await saveGuildData(guildId, guildData);
    },
});
