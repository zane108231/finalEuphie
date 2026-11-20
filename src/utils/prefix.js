const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");
const { DEFAULT_PREFIX, getPrefix } = require("./prefixStore");

const PREFIX = DEFAULT_PREFIX;

const OptionType = {
    SUB_COMMAND: 1,
    SUB_COMMAND_GROUP: 2,
    STRING: 3,
    INTEGER: 4,
    BOOLEAN: 5,
    USER: 6,
    CHANNEL: 7,
    ROLE: 8,
    NUMBER: 10,
};

function formatCmd(name, subcommand = null, guildId = null) {
    const prefix = getPrefix(guildId);
    return subcommand ? `\`${prefix}${name} ${subcommand}\`` : `\`${prefix}${name}\``;
}

function commandJson(data) {
    if (!data) return { options: [] };
    if (typeof data.toJSON === "function") return data.toJSON();
    return data;
}

function optionType(type) {
    if (typeof type === "number") return type;
    const names = {
        SUB_COMMAND: 1,
        SUB_COMMAND_GROUP: 2,
        STRING: 3,
        INTEGER: 4,
        BOOLEAN: 5,
        USER: 6,
        CHANNEL: 7,
        ROLE: 8,
        NUMBER: 10,
    };
    return names[type] ?? type;
}

function parsePositional(options, args) {
    const map = {};
    if (!options?.length) return map;

    for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const type = optionType(opt.type);

        if (type === OptionType.STRING) {
            const later = options.slice(i + 1);
            const moreStrings = later.some((o) => optionType(o.type) === OptionType.STRING);
            const laterMention = later.some((o) => {
                const t = optionType(o.type);
                return t === OptionType.USER || t === OptionType.CHANNEL || t === OptionType.ROLE;
            });
            // Don't swallow @user / #channel into the last string option.
            if (!moreStrings && !laterMention) {
                const rest = args.slice(i).join(" ").trim();
                map[opt.name] = rest || null;
                break;
            }
            map[opt.name] = args[i] ?? null;
        } else if (type === OptionType.INTEGER || type === OptionType.NUMBER) {
            map[opt.name] = args[i] ?? null;
        } else if (type === OptionType.BOOLEAN) {
            const raw = (args[i] || "").toLowerCase();
            if (!raw) map[opt.name] = null;
            else map[opt.name] = ["true", "yes", "on", "1"].includes(raw);
        } else {
            map[opt.name] = args[i] ?? null;
        }
    }

    return map;
}

function parseCommandArgs(data, args) {
    const json = commandJson(data);
    const options = json.options || [];
    const map = {};

    const hasSub = options.some((o) => {
        const t = optionType(o.type);
        return t === OptionType.SUB_COMMAND || t === OptionType.SUB_COMMAND_GROUP;
    });

    if (hasSub) {
        const subName = (args[0] || "").toLowerCase();
        const subOpt = options.find((o) => {
            const t = optionType(o.type);
            return (
                o.name === subName &&
                (t === OptionType.SUB_COMMAND || t === OptionType.SUB_COMMAND_GROUP)
            );
        });
        if (subOpt) {
            map.__subcommand = subOpt.name;
            Object.assign(map, parsePositional(subOpt.options || [], args.slice(1)));
        } else {
            map.__subcommand = args[0] || null;
        }
        return map;
    }

    return parsePositional(options, args);
}

function sanitizePayload(payload) {
    if (payload == null) return { content: "\u200b" };
    if (typeof payload === "string") return { content: payload };

    const out = { ...payload };
    if (out.flags != null) {
        out.flags = Number(out.flags) & ~MessageFlags.Ephemeral;
        if (out.flags === 0) delete out.flags;
    }
    return out;
}

function createUsageHelpPayload(message, command, payload) {
    const content =
        typeof payload === "string"
            ? payload
            : payload?.content ||
              payload?.embeds?.[0]?.description ||
              payload?.embeds?.[0]?.data?.description ||
              "";
    if (!/\busage\b/i.test(content)) return payload;

    const helpCommand = require("../commands/help");
    const commandName = command.data?.name || "command";
    let helpInfo = helpCommand.getCommandHelpInfo(commandName);
    const usageMatch = content.match(/\busage\b\s*:?\s*/i);
    const usageRemainder = content.slice(
        usageMatch.index + usageMatch[0].length
    );
    let usages = [];
    const codeBlock = usageRemainder.match(/```(?:[a-z]*)\s*([\s\S]*?)```/i);
    if (codeBlock) {
        usages = codeBlock[1]
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
    } else {
        const usageLines = usageRemainder.split(/\r?\n/);
        const firstUsageLine = usageLines.findIndex((line) =>
            line.replace(/^\*+/, "").trim()
        );
        if (firstUsageLine !== -1) {
            const startsWithList = /^[\s>*-]*[•*-]\s*/.test(
                usageLines[firstUsageLine]
            );
            if (startsWithList) {
                for (
                    let index = firstUsageLine;
                    index < usageLines.length;
                    index++
                ) {
                    const line = usageLines[index]
                        .replace(/^\*+/, "")
                        .trim();
                    if (!line) break;
                    if (!/^[>*-]*[•*-]\s*/.test(line)) break;
                    const code = line.match(/`{1,3}([^`\r\n]+)`{1,3}/);
                    if (code) usages.push(code[1].trim());
                }
            } else {
                const firstLine = usageLines[firstUsageLine]
                    .replace(/^\*+/, "")
                    .trim();
                const codeBlocks = [
                    ...firstLine.matchAll(/`{1,3}([^`\r\n]+)`{1,3}/g),
                ];
                const hasAlternatives = /\s+or\s+/i.test(
                    firstLine.replace(/`[^`]*`/g, " ")
                );
                usages = codeBlocks.length
                    ? (hasAlternatives
                          ? codeBlocks
                          : codeBlocks.slice(0, 1)
                      ).map((code) => code[1].trim())
                    : [firstLine];
            }
        }
    }
    if (!usages.length) usages = [helpInfo?.usage || commandName];
    usages = usages.map((usage) =>
        usage
            .replace(/^[\s>*•-]+/, "")
            .replace(/^(?:<@!?\d+>\s*)?(?:[^\s`]+!|!)\s*/i, "")
            .replace(/^\/\s*/, "")
    );
    const usageCommand = usages[0].split(/\s*[<[]/)[0].trim();
    const detailedHelpInfo = helpCommand.getCommandHelpInfo(usageCommand);
    if (
        detailedHelpInfo &&
        (!helpInfo || detailedHelpInfo.name.length > helpInfo.name.length)
    ) {
        helpInfo = detailedHelpInfo;
    }
    const usageText = usages.map((usage) => `e!${usage}`).join("\n");

    const description =
        helpInfo?.desc ||
        command.data?.toJSON?.().description ||
        command.data?.description ||
        "Command information";
    const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setAuthor({
            name: "Help",
            iconURL: message.client.user.displayAvatarURL(),
        })
        .setDescription(
            `**Usage:** ${usageText}\n**Description:** ${description}`
        );
    const button = new ButtonBuilder()
        .setCustomId(
            `prefix_usage_help:${encodeURIComponent(
                helpInfo?.name || commandName
            )}`
        )
        .setLabel("Help")
        .setStyle(ButtonStyle.Success);

    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(button)],
    };
}

/**
 * Fake ChatInputCommandInteraction backed by a guild message.
 * Prefix replies skip Discord's slash "thinking" state.
 */
function createPrefixInteraction(message, command, args) {
    const values = parseCommandArgs(command.data, args);
    let replyMessage = null;

    const interaction = {
        client: message.client,
        guild: message.guild,
        guildId: message.guild?.id,
        channel: message.channel,
        member: message.member,
        user: message.author,
        message,
        args,
        commandName: command.data?.name,
        deferred: false,
        replied: false,
        ephemeral: false,
        isChatInputCommand: () => true,
        options: {
            getString(name) {
                const v = values[name];
                return v == null || v === "" ? null : String(v);
            },
            getInteger(name) {
                const v = values[name];
                if (v == null || v === "") return null;
                const n = parseInt(v, 10);
                return Number.isNaN(n) ? null : n;
            },
            getNumber(name) {
                const v = values[name];
                if (v == null || v === "") return null;
                const n = Number(v);
                return Number.isNaN(n) ? null : n;
            },
            getBoolean(name) {
                const v = values[name];
                if (typeof v === "boolean") return v;
                return null;
            },
            getSubcommand(required = true) {
                if (values.__subcommand) return values.__subcommand;
                if (required) return null;
                return null;
            },
            getUser(name) {
                if (message.mentions?.users?.first()) {
                    return message.mentions.users.first();
                }
                const v = values[name];
                if (v && /^\d{17,20}$/.test(v)) {
                    return message.client.users.cache.get(v) || { id: v };
                }
                return null;
            },
            getMember() {
                return null;
            },
            getChannel() {
                return null;
            },
        },
        async deferReply() {
            interaction.deferred = true;
            try {
                await message.channel.sendTyping();
            } catch {
                // ignore
            }
        },
        async reply(payload) {
            interaction.replied = true;
            const helpPayload = createUsageHelpPayload(
                message,
                command,
                payload
            );
            replyMessage = await message.channel.send(
                sanitizePayload(helpPayload)
            );
            return replyMessage;
        },
        async editReply(payload) {
            const helpPayload = createUsageHelpPayload(
                message,
                command,
                payload
            );
            const cleaned = sanitizePayload(helpPayload);
            if (replyMessage) {
                return replyMessage.edit(cleaned);
            }
            interaction.replied = true;
            replyMessage = await message.channel.send(cleaned);
            return replyMessage;
        },
        async followUp(payload) {
            return message.channel.send(sanitizePayload(payload));
        },
        async deferUpdate() {
            interaction.deferred = true;
        },
        async deleteReply() {
            if (replyMessage) {
                await replyMessage.delete().catch(() => {});
                replyMessage = null;
            }
        },
        async fetchReply() {
            return replyMessage;
        },
    };

    return interaction;
}

module.exports = {
    PREFIX,
    formatCmd,
    parseCommandArgs,
    createPrefixInteraction,
    getPrefix,
};
