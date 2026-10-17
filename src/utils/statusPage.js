const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");
const config = require("../../config");
const { formatIncidents } = require("./incidents");

function getNodeList(client) {
    const nodes = client.riffy?.nodeMap;
    if (!nodes) return [];

    if (Array.isArray(nodes)) return nodes;
    if (nodes instanceof Map) return [...nodes.values()];
    return Object.values(nodes || {});
}

function countConnectedNodes(nodeList) {
    const node = nodeList.find((n) => n.name === config.node.name);
    return (node?.connected || node?.isConnected) ? 1 : 0;
}

function getSystemStatus(connectedNodes) {
    const lavalinkUp = connectedNodes > 0;

    if (!lavalinkUp) {
        return { emoji: "🔴", text: "Lavalink unavailable — playback may not work" };
    }

    return { emoji: "", text: "All systems operational" };
}

function getComponentStatus(connected) {
    return connected
        ? { emoji: "🟢", label: "Connected" }
        : { emoji: "🔴", label: "Disconnected" };
}

function buildStatusContainer(client, { interactive = true, showSupportButton = interactive } = {}) {
    const nodeList = getNodeList(client);
    const connectedNodes = countConnectedNodes(nodeList);
    const { emoji: statusEmoji, text: statusText } = getSystemStatus(connectedNodes);

    const uptimeSeconds = process.uptime();
    const startTime = new Date(Date.now() - uptimeSeconds * 1000);
    const startTimestamp = Math.floor(startTime.getTime() / 1000);

    const container = new ContainerBuilder();

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`## ${statusEmoji} ${statusText}`)
    );

    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `**Recent Incidents**\n` + formatIncidents(4)
        )
    );

    container.addSeparatorComponents(new SeparatorBuilder().setDivider(false));

    const linkButtons = showSupportButton
        ? [
              new ButtonBuilder()
                  .setLabel("Support Server")
                  .setURL("https://dsc.gg/duxceriao")
                  .setStyle(ButtonStyle.Link)
          ]
        : [
              new ButtonBuilder()
                  .setLabel("Report Issue")
                  .setEmoji("🐛")
                  .setURL("https://dsc.gg/duxceriao")
                  .setStyle(ButtonStyle.Link)
          ];

    container.addActionRowComponents(new ActionRowBuilder().addComponents(...linkButtons));

    container.addSeparatorComponents(new SeparatorBuilder().setDivider(false));

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `**Uptime**\n` +
            `-# 🕒 <t:${startTimestamp}:f> (<t:${startTimestamp}:R>)\n` +
            `-# *Times shown in your local timezone*`
        )
    );

    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

    const node = nodeList.find((n) => n.name === config.node.name);
    const connected = node?.connected || node?.isConnected || false;
    const nodeStatus = getComponentStatus(connected);

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            "### Lavalink Node Status\n" +
            `-# ${nodeStatus.emoji} ${nodeStatus.label}`
        )
    );

    const updatedAt = Math.floor(Date.now() / 1000);
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(false));
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# Last updated <t:${updatedAt}:R>`)
    );

    return container;
}

module.exports = {
    buildStatusContainer,
    countConnectedNodes,
    getSystemStatus,
    getNodeList,
};
