const fs = require("fs");
const path = require("path");
const { WebhookClient, MessageFlags } = require("discord.js");
const config = require("../../config");
const { buildStatusContainer } = require("../utils/statusPage");

const STATUS_STORE_PATH = path.join(__dirname, "..", "..", "data", "status-webhook.json");
const UPDATE_INTERVAL_MS = 60 * 1000;

let webhookClient = null;
let messageId = null;
let updateTimer = null;
let lastSnapshot = null;
let activeClient = null;

function loadMessageId() {
    if (!fs.existsSync(STATUS_STORE_PATH)) return null;

    try {
        const data = JSON.parse(fs.readFileSync(STATUS_STORE_PATH, "utf-8"));
        return data.messageId || null;
    } catch {
        return null;
    }
}

function saveMessageId(id) {
    const dir = path.dirname(STATUS_STORE_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const payload = id ? { messageId: id } : {};
    fs.writeFileSync(STATUS_STORE_PATH, JSON.stringify(payload, null, 2), "utf-8");
}

function getStatusSnapshot(client) {
    const container = buildStatusContainer(client, { interactive: false });
    return JSON.stringify(container.toJSON());
}

async function pushStatusUpdate(client, force = false) {
    if (!config.statusWebhookUrl) return;

    const snapshot = getStatusSnapshot(client);
    if (!force && snapshot === lastSnapshot) return;

    lastSnapshot = snapshot;

    if (!webhookClient) {
        webhookClient = new WebhookClient({ url: config.statusWebhookUrl });
    }

    const container = buildStatusContainer(client, { interactive: false });
    const payload = {
        components: [container],
        flags: MessageFlags.IsComponentsV2,
        withComponents: true,
    };

    try {
        if (messageId) {
            await webhookClient.editMessage(messageId, payload);
            return;
        }

        const message = await webhookClient.send(payload);
        messageId = message.id;
        saveMessageId(messageId);
    } catch (error) {
        if (error.code === 10008 && messageId) {
            messageId = null;
            saveMessageId();
            const message = await webhookClient.send(payload);
            messageId = message.id;
            saveMessageId(messageId);
            return;
        }

        console.error("[euphire] Failed to update status webhook:", error.message);
    }
}

function scheduleStatusUpdate(client, force = false) {
    if (client) activeClient = client;
    if (!activeClient) return;

    pushStatusUpdate(activeClient, force).catch((error) => {
        console.error("[euphire] Status update error:", error.message);
    });
}

function startStatusMonitor(client) {
    if (!config.statusWebhookUrl) {
        console.warn("[euphire] STATUS_WEBHOOK_URL not set — status monitor disabled.");
        return;
    }

    activeClient = client;
    messageId = loadMessageId();

    setTimeout(() => {
        scheduleStatusUpdate(client, true);
    }, 3000);

    if (updateTimer) clearInterval(updateTimer);
    updateTimer = setInterval(() => {
        scheduleStatusUpdate(client, false);
    }, UPDATE_INTERVAL_MS);

    console.log("[euphire] Status monitor started.");
}

module.exports = {
    startStatusMonitor,
    scheduleStatusUpdate,
    pushStatusUpdate,
};
