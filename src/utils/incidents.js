const fs = require("fs");
const path = require("path");
const config = require("../../config");

const INCIDENTS_PATH = path.join(__dirname, "..", "..", "data", "incidents.json");
const MAX_INCIDENTS = 50;

const UNIMPORTANT_PATTERNS = [
    "unexpected server response",
    "timeout",
    "socket hang up",
    "ECONNRESET",
];

let incidents = [];
let loaded = false;

function ensureLoaded() {
    if (loaded) return;

    const dir = path.dirname(INCIDENTS_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(INCIDENTS_PATH)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(INCIDENTS_PATH, "utf-8"));
            incidents = Array.isArray(parsed) ? parsed : [];
        } catch {
            incidents = [];
        }
    }

    loaded = true;
}

function saveIncidents() {
    ensureLoaded();
    fs.writeFileSync(INCIDENTS_PATH, JSON.stringify(incidents, null, 2), "utf-8");
}

function isImportantIncident(description) {
    const lowerDesc = description.toLowerCase();
    return !UNIMPORTANT_PATTERNS.some((pattern) => lowerDesc.includes(pattern.toLowerCase()));
}

function anonymizeNodeNames(description) {
    return description.replace(config.node.name, "Main Node");
}

function recordIncident(component, description) {
    if (!isImportantIncident(description)) {
        return false;
    }

    ensureLoaded();

    const anonymizedDesc = anonymizeNodeNames(description);
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;
    const isDuplicate = incidents.some(
        (i) =>
            i.component === component &&
            i.description === anonymizedDesc &&
            now - i.timestamp < FIVE_MINUTES
    );

    if (isDuplicate) {
        return false;
    }

    incidents.unshift({
        timestamp: now,
        component,
        description: anonymizedDesc,
    });

    if (incidents.length > MAX_INCIDENTS) {
        incidents.length = MAX_INCIDENTS;
    }

    saveIncidents();
    return true;
}

function getIncidents() {
    ensureLoaded();
    return [...incidents];
}

function getIncidentsForComponent(component) {
    ensureLoaded();
    return incidents.filter((i) => i.component === component);
}

function formatIncidents(limit = 4) {
    ensureLoaded();

    if (incidents.length === 0) {
        return "-# No incidents reported.";
    }

    return incidents
        .slice(0, limit)
        .map(
            (i) =>
                `-# <t:${Math.floor(i.timestamp / 1000)}:t> · ${i.component}: ${i.description}`
        )
        .join("\n");
}

function formatPastIncidents(days = 7) {
    ensureLoaded();

    const lines = [];
    const now = new Date();

    for (let dayOffset = 0; dayOffset < days; dayOffset++) {
        const date = new Date(now);
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() - dayOffset);

        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);

        const dayStart = date.getTime();
        const dayEnd = nextDay.getTime();
        const dayIncidents = incidents.filter(
            (i) => i.timestamp >= dayStart && i.timestamp < dayEnd
        );

        const dateLabel = date.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
        });

        if (dayIncidents.length === 0) {
            lines.push(`**${dateLabel}**\n-# No incidents reported.`);
        } else {
            const entries = dayIncidents
                .map(
                    (i) =>
                        `-# <t:${Math.floor(i.timestamp / 1000)}:t> · ${i.component}: ${i.description}`
                )
                .join("\n");
            lines.push(`**${dateLabel}**\n${entries}`);
        }
    }

    return lines.join("\n\n");
}

module.exports = {
    recordIncident,
    getIncidents,
    getIncidentsForComponent,
    formatIncidents,
    formatPastIncidents,
};
