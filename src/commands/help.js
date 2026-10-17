const {
    SlashCommandBuilder,
    MessageFlags,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const { getPrefix } = require("../utils/prefixStore");

// Command categories
const COMMAND_CATEGORIES = {
    MUSIC: {
        title: "Music Playback",
        emoji: "🎵",
        commands: ["play", "skip", "stop", "nowplaying", "lyrics", "seek", "volume", "loop", "autoplay"],
    },
    QUEUE: {
        title: "Queue Management",
        emoji: "📋",
        commands: ["queue", "shuffle", "insert", "move", "remove", "clear"],
    },
    VOICE: {
        title: "Voice & Permissions",
        emoji: "🔊",
        commands: ["join", "leave", "permission"],
    },
    PROFILE: {
        title: "Profile & Last.fm",
        emoji: "📊",
        commands: ["profile", "resetstats", "login", "logout"],
    },
    INFO: {
        title: "General & Settings",
        emoji: "⚙️",
        commands: ["prefix", "about", "help"],
    },
};

// Detailed command metadata
const COMMAND_DETAILS = {
    play: {
        description: "Search and play audio from Spotify, SoundCloud, or links",
        usage: "play <song title or URL>",
    },
    skip: {
        description: "Skip the currently playing track",
        usage: "skip",
    },
    stop: {
        description: "Stop music playback, clear queue, and leave voice channel",
        usage: "stop",
    },
    nowplaying: {
        description: "Display information about the currently playing track",
        usage: "nowplaying",
    },
    lyrics: {
        description: "Search and display song lyrics via Genius",
        usage: "lyrics [song title]",
    },
    seek: {
        description: "Jump to a specific timestamp in the current song",
        usage: "seek <mm:ss | seconds>",
    },
    volume: {
        description: "View or adjust playback volume (1% to 100%)",
        usage: "volume [1-100]",
    },
    loop: {
        description: "Toggle loop modes: single track, entire queue, or off",
        usage: "loop [track | queue | off]",
    },
    autoplay: {
        description: "Toggle automatic playback of related songs when queue finishes",
        usage: "autoplay",
    },
    queue: {
        description: "Display the server's current music queue",
        usage: "queue [page]",
    },
    shuffle: {
        description: "Randomly shuffle the order of upcoming tracks in the queue",
        usage: "shuffle",
    },
    insert: {
        description: "Insert a track to play immediately after the current song",
        usage: "insert <song title or URL>",
    },
    move: {
        description: "Move a track to a different position in the queue",
        usage: "move <from position> <to position>",
    },
    remove: {
        description: "Remove a specific track from the queue",
        usage: "remove <track number>",
    },
    clear: {
        description: "Remove all upcoming tracks from the queue",
        usage: "clear",
    },
    join: {
        description: "Summon the bot to join your active voice channel",
        usage: "join",
    },
    leave: {
        description: "Disconnect the bot from the voice channel",
        usage: "leave",
    },
    permission: {
        description: "Configure DJ permissions and manage who can control playback",
        usage: "permission [view | allow | deny | reset]",
    },
    profile: {
        description: "Generate your personalized music profile card or reset stats",
        usage: "profile [@user | reset | reset me]",
    },
    resetstats: {
        description: "Reset music listening statistics database (e!profile only)",
        usage: "resetstats [all | me | @user]",
    },
    login: {
        description: "Connect and authenticate your Last.fm account for live scrobbling",
        usage: "login",
    },
    logout: {
        description: "Disconnect your Last.fm account from the bot",
        usage: "logout",
    },
    prefix: {
        description: "View or change this server's custom command prefix",
        usage: "prefix [set <prefix> | reset]",
    },
    about: {
        description: "View bot system information, version, and developer credits",
        usage: "about",
    },
    help: {
        description: "Display this interactive command directory",
        usage: "help [command name]",
    },
};

// Help state cache per guild
const helpState = new Map();

function getCommandList() {
    const commandsDir = path.join(__dirname);
    const commandFiles = fs.readdirSync(commandsDir).filter(file => file.endsWith('.js'));
    const commands = [];

    for (const file of commandFiles) {
        try {
            const command = require(path.join(commandsDir, file));
            if (command.data) {
                const name = command.data.name;
                const meta = COMMAND_DETAILS[name] || {};
                commands.push({
                    name,
                    aliases: command.aliases || [],
                    description: meta.description || command.data.description || "No description available",
                    usage: meta.usage || name,
                });
            }
        } catch (_) {}
    }

    return commands;
}

function getCategoryForCommand(cmdName) {
    for (const [_, cat] of Object.entries(COMMAND_CATEGORIES)) {
        if (cat.commands.includes(cmdName)) {
            return cat;
        }
    }
    return { title: "General", emoji: "📁", commands: [] };
}

function buildHelpPage(client, guildId) {
    const state = helpState.get(guildId) || { mode: 'categories', category: null };
    const currentPrefix = getPrefix(guildId);
    const container = new ContainerBuilder();
    const commands = getCommandList();

    if (state.mode === 'categories') {
        // Main categories overview
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "### 🎶 Euphie • Command Directory\n" +
                `-# Server prefix: \`${currentPrefix}\` • Select a command from the dropdown below for details.`
            )
        );

        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

        for (const [_, category] of Object.entries(COMMAND_CATEGORIES)) {
            const categoryCommands = category.commands
                .map(cmdName => commands.find(c => c.name === cmdName))
                .filter(Boolean);

            if (categoryCommands.length === 0) continue;

            let content = `**${category.emoji} ${category.title}**\n`;
            for (const cmd of categoryCommands) {
                const aliasStr = cmd.aliases.length > 0
                    ? ` *(${cmd.aliases.map(a => `${currentPrefix}${a}`).join(", ")})*`
                    : "";
                content += `-# • **\`${currentPrefix}${cmd.name}\`**${aliasStr} — ${cmd.description}\n`;
            }

            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
            container.addSeparatorComponents(new SeparatorBuilder().setDivider(false));
        }

        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "-# 💡 **Tip:** Use the dropdown menu below to view full syntax, arguments, and aliases."
            )
        );
    } else if (state.mode === 'command') {
        // Single command details
        const cmd = commands.find(c => c.name === state.category) ||
            commands.find(c => c.aliases.includes(state.category));

        if (cmd) {
            const cat = getCategoryForCommand(cmd.name);
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `### 📖 Command: \`${currentPrefix}${cmd.name}\`\n\n` +
                    `**Category**\n` +
                    `-# ${cat.emoji} ${cat.title}\n\n` +
                    `**Description**\n` +
                    `-# ${cmd.description}\n\n` +
                    `**Usage**\n` +
                    `-# \`${currentPrefix}${cmd.usage}\`\n\n` +
                    `**Aliases**\n` +
                    `-# ${cmd.aliases.length > 0 ? cmd.aliases.map(a => `\`${currentPrefix}${a}\``).join(", ") : "*None*"}`
                )
            );
        } else {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `### ❌ Command Not Found\n\n` +
                    `-# Could not find command \`${state.category}\`. Choose a valid command below.`
                )
            );
        }

        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    }

    // Dropdown Select Menu
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('help_command_select')
        .setPlaceholder('Select a command for detailed information')
        .setMinValues(1)
        .setMaxValues(1);

    // Option 1: Return to Overview
    selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
            .setLabel("Overview / All Commands")
            .setDescription("Return to all command categories")
            .setValue("overview")
            .setEmoji("📋")
    );

    // Add commands grouped by category (max 25 total options for Discord select menus)
    for (const [_, cat] of Object.entries(COMMAND_CATEGORIES)) {
        for (const cmdName of cat.commands) {
            if (cmdName === "help") continue; // Exclude help from dropdown to stay within Discord 25 options limit
            if (selectMenu.options.length >= 25) break;

            const cmd = commands.find(c => c.name === cmdName);
            if (!cmd) continue;

            selectMenu.addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(cmd.name)
                    .setDescription(cmd.description.slice(0, 100))
                    .setValue(cmd.name)
                    .setEmoji(cat.emoji)
            );
        }
    }

    container.addActionRowComponents(new ActionRowBuilder().addComponents(selectMenu));

    // If viewing single command, provide back button
    if (state.mode === 'command') {
        const backBtn = new ButtonBuilder()
            .setCustomId('help_back')
            .setLabel('← Back to Overview')
            .setStyle(ButtonStyle.Secondary);

        container.addActionRowComponents(new ActionRowBuilder().addComponents(backBtn));
    }

    return container;
}

module.exports = {
    aliases: ["h"],
    data: new SlashCommandBuilder()
        .setName("help")
        .setDescription("Show all commands and their usage")
        .addStringOption((opt) =>
            opt.setName("command")
                .setDescription("Specific command to view info for")
                .setRequired(false)
        ),

    async execute(interaction, client) {
        const guildId = interaction.guild?.id || "dm";
        const query = (
            interaction.args?.[0] ||
            interaction.options?.getString?.("command") ||
            ""
        ).toLowerCase().trim();

        if (query && query !== "overview") {
            const commands = getCommandList();
            const matched = commands.find(c => c.name === query || c.aliases.includes(query));
            if (matched) {
                helpState.set(guildId, { mode: 'command', category: matched.name });
            } else {
                helpState.set(guildId, { mode: 'categories', category: null });
            }
        } else {
            helpState.set(guildId, { mode: 'categories', category: null });
        }

        const container = buildHelpPage(client, guildId);

        await interaction.reply({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        });
    },

    // Handle interactive dropdown & buttons
    async handleInteraction(interaction, client) {
        const guildId = interaction.guild?.id || "dm";
        const state = helpState.get(guildId) || { mode: 'categories', category: null };

        if (interaction.isStringSelectMenu() && interaction.customId === 'help_command_select') {
            await interaction.deferUpdate();
            const selected = interaction.values[0];

            if (selected === 'overview') {
                state.mode = 'categories';
                state.category = null;
            } else {
                state.mode = 'command';
                state.category = selected;
            }

            helpState.set(guildId, state);
            const container = buildHelpPage(client, guildId);
            await interaction.editReply({ components: [container] });
            return;
        }

        if (interaction.isButton() && interaction.customId === 'help_back') {
            await interaction.deferUpdate();
            state.mode = 'categories';
            state.category = null;
            helpState.set(guildId, state);

            const container = buildHelpPage(client, guildId);
            await interaction.editReply({ components: [container] });
            return;
        }
    },
};
