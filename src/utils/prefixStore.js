const fs = require("fs");
const path = require("path");
const config = require("../../config");

const FILE_PATH = path.join(__dirname, "..", "..", "data", "prefixes.json");
const DEFAULT_PREFIX = config.prefix || "!";

let cache = null;

function ensureFile() {
    const dir = path.dirname(FILE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(FILE_PATH)) {
        fs.writeFileSync(FILE_PATH, "{}", "utf-8");
    }
}

function readAll() {
    if (cache) return cache;
    ensureFile();
    try {
        cache = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8") || "{}");
    } catch {
        cache = {};
    }
    return cache;
}

function writeAll(data) {
    ensureFile();
    cache = data;
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function getPrefix(guildId) {
    if (!guildId) return DEFAULT_PREFIX;
    const data = readAll();
    const custom = data[String(guildId)];
    if (typeof custom === "string" && custom.length) return custom;
    return DEFAULT_PREFIX;
}

function setPrefix(guildId, prefix) {
    const data = readAll();
    data[String(guildId)] = prefix;
    writeAll(data);
}

function resetPrefix(guildId) {
    const data = readAll();
    delete data[String(guildId)];
    writeAll(data);
}

module.exports = {
    DEFAULT_PREFIX,
    getPrefix,
    setPrefix,
    resetPrefix,
};
