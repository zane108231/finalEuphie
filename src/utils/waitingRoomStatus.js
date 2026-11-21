const {
    EmbedBuilder,
    PermissionFlagsBits,
} = require("discord.js");
const { getGuildDataAsync, saveGuildData } = require("./mongoGuildData");
const coordinator = require("./mongoCoordinator");

const PRIMARY_BOT_ID = "euphie_main";
const statusUpdates = new Map();

function isBotInWaitingRoom(client, guildId, channelId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild || !client.user) return false;

    const player = client.riffy?.players?.get(guildId);
    const actualChannelId =
        guild.voiceStates?.cache?.get(client.user.id)?.channelId ||
        guild.members.cache.get(client.user.id)?.voice?.channelId ||
        null;

    if (player) {
        return (
            player._waitingRoom === true &&
            player.voiceChannel === channelId
        );
    }

    return actualChannelId === channelId;
}

function buildStatusEmbed(clients, guildId, data, overrides) {
    const botStatuses = clients.map((client) => {
        const available = Boolean(
            data.waitingRoomEnabled &&
                data.waitingRoomChannelId &&
                (overrides.has(client.botId)
                    ? overrides.get(client.botId)
                    : isBotInWaitingRoom(
                          client,
                          guildId,
                          data.waitingRoomChannelId
                      ))
        );
        const mention = client.user?.id
            ? `<@${client.user.id}>`
            : client.user?.username || client.botId;

        return `${mention} — ${available ? "🟢 Available" : "🔴 Unavailable"}`;
    });

    const explanation =
        "Euphie bots stay in this voice channel while they are idle and ready to play. " +
        "just use `e!play` or `e!join` and an available bot will leave the waiting room for you.";

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("Euphie Waiting Room")
        .setDescription(
            `${explanation}\n\n${botStatuses.join("\n") || "No Euphie bots are in this server."}`
        )
        .setFooter({ text: "Available bots are waiting here; unavailable bots are in use." })
        .setTimestamp();
}

async function updateWaitingRoomStatusNow(guildId, overrides) {
    const data = await getGuildDataAsync(guildId);
    if (!data.waitingRoomChannelId) return;

    const mainClient = coordinator.getClient(PRIMARY_BOT_ID);
    const guild = mainClient?.guilds.cache.get(guildId);
    if (!mainClient?.isReady() || !guild) return;

    let channel = guild.channels.cache.get(data.waitingRoomChannelId);
    if (!channel) {
        channel = await guild.channels.fetch(data.waitingRoomChannelId);
    }
    if (!channel?.isTextBased?.()) {
        throw new Error(
            `Waiting-room channel ${data.waitingRoomChannelId} cannot receive messages.`
        );
    }

    const mainMember =
        guild.members.me ||
        (await guild.members.fetch(mainClient.user.id));
    const permissions = channel.permissionsFor(mainMember);
    const missing = [
        ["View Channel", PermissionFlagsBits.ViewChannel],
        ["Send Messages", PermissionFlagsBits.SendMessages],
        ["Embed Links", PermissionFlagsBits.EmbedLinks],
    ].filter(([, permission]) => !permissions?.has(permission));
    if (missing.length) {
        throw new Error(
            `Euphie Music is missing ${missing.map(([name]) => name).join(" and ")} in the waiting room.`
        );
    }

    const clients = coordinator
        .getAllClients()
        .filter((client) => client.guilds.cache.has(guildId));
    const embed = buildStatusEmbed(clients, guildId, data, overrides);
    const payload = {
        embeds: [embed],
        allowedMentions: { parse: [] },
    };

    if (
        data.waitingRoomStatusMessageId &&
        data.waitingRoomStatusChannelId === channel.id
    ) {
        try {
            const message = await channel.messages.fetch(
                data.waitingRoomStatusMessageId
            );
            await message.edit(payload);
            return;
        } catch (error) {
            if (error.code !== 10008) throw error;
            console.warn(
                `[euphire] Waiting-room status message was deleted in guild ${guildId}; creating a replacement.`
            );
        }
    } else if (
        data.waitingRoomStatusMessageId &&
        data.waitingRoomStatusChannelId
    ) {
        try {
            const oldChannel = await mainClient.channels.fetch(
                data.waitingRoomStatusChannelId
            );
            const oldMessage = await oldChannel?.messages?.fetch(
                data.waitingRoomStatusMessageId
            );
            await oldMessage?.delete();
        } catch (error) {
            if (error.code !== 10008 && error.code !== 10003) {
                console.error(
                    `[euphire] Could not remove the old waiting-room status message in guild ${guildId}:`,
                    error
                );
            }
        }
    }

    const message = await channel.send(payload);
    data.waitingRoomStatusMessageId = message.id;
    data.waitingRoomStatusChannelId = channel.id;
    await saveGuildData(guildId, data);
}

async function updateWaitingRoomStatus(guildId, botId, available) {
    const overrides = new Map();
    if (botId) overrides.set(botId, available === true);

    const previous = statusUpdates.get(guildId) || Promise.resolve();
    const current = previous
        .catch((error) => {
            console.error(
                `[euphire] Previous waiting-room status update failed for guild ${guildId}:`,
                error
            );
        })
        .then(() => updateWaitingRoomStatusNow(guildId, overrides));
    statusUpdates.set(guildId, current);

    try {
        await current;
    } finally {
        if (statusUpdates.get(guildId) === current) {
            statusUpdates.delete(guildId);
        }
    }
}

module.exports = { updateWaitingRoomStatus };
