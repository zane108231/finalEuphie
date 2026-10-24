const {
    SlashCommandBuilder,
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require("discord.js");
const { getPrefix } = require("../utils/prefixStore");

// Help directory pages for the supported commands.
const HELP_PAGES = [
    {
        page: 1,
        title: "Meta",
        description: "Meta commands related to the bot",
        sections: [
            {
                name: "Getting Started",
                commands: [
                    { name: "help", desc: "Help command", usage: "help [command | page]" },
                    { name: "about", desc: "Get some information about the bot", usage: "about" },
                ],
            },
            {
                name: "Information",
                commands: [
                    { name: "ping", desc: "Get my ping to Discord", usage: "ping" },
                    { name: "profile", desc: "View your music listening statistics profile card", usage: "profile [user]" },
                    { name: "prefix list", desc: "Get all available prefixes", usage: "prefix list" },
                ],
            },
        ],
    },
    {
        page: 2,
        title: "Playback",
        description: "Commands used for playing",
        sections: [
            {
                name: "Commands",
                commands: [
                    { name: "play", desc: "Queue a track or playlist from a search term or URL", usage: "play <search term or URL>", aliases: ["p"] },
                    { name: "join", desc: "Make me join your voice channel", usage: "join", aliases: ["summon"] },
                    { name: "radio", desc: "Search and play from a radio station", usage: "radio <station or stream URL>" },
                    { name: "leave", desc: "Make me leave the voice channel", usage: "leave", aliases: ["stop", "dc"] },
                    { name: "search", desc: "Search for a track to play", usage: "search <track>" },
                    { name: "insert", desc: "Insert a track right after the one that is currently playing", usage: "insert <track>", aliases: ["ins"] },
                    { name: "playqueue", desc: "Queue a track; after it has finished playing, the bot will leave", usage: "playqueue <track>" },
                    { name: "playrecent", desc: "Queue your recently played tracks", usage: "playrecent" },
                    { name: "playlistselect", desc: "Select and queue a single track from a playlist by URL", usage: "playlistselect <playlist URL>" },
                    { name: "playingsingle", desc: "Queue a single track from a playlist by URL", usage: "playingsingle <playlist URL> [track number]" },
                    { name: "album search", desc: "Search and queue an album", usage: "album search <album>" },
                    { name: "resume session", desc: "Resume a previous session", usage: "resume session" },
                    { name: "autoplay toggle", desc: "Toggle autoplay", usage: "autoplay toggle" },
                    { name: "playlistsearch", desc: "Search Spotify playlists, select one, and queue it", usage: "playlistsearch <search term>" },
                ],
            },
        ],
    },
    {
        page: 3,
        title: "Track State",
        description: "Commands used for updating the state of the current track",
        sections: [
            {
                name: "Commands",
                commands: [
                    { name: "pause", desc: "Pause the current session", usage: "pause" },
                    { name: "resume", desc: "Resume playing the current track", usage: "resume" },
                    { name: "volume", desc: "Change the volume", usage: "volume <0-100>", aliases: ["vol", "v"] },
                    { name: "forward", desc: "Wind the track forwards", usage: "forward [time]" },
                    { name: "wind to", desc: "Wind to the desired position in the track", usage: "wind to <time>" },
                    { name: "backward", desc: "Wind the track backwards", usage: "backward [time]" },
                    { name: "end time", desc: "Set the end position of the current track", usage: "end time <time>" },
                    { name: "start time", desc: "Set the start position of the current track", usage: "start time <time>" },
                ],
            },
        ],
    },
    {
        page: 4,
        title: "Queue State",
        description: "Commands used for updating the state of the queue",
        sections: [
            { name: "Index", commands: [
                    { name: "next", desc: "Go to the next track in the queue", usage: "next", aliases: ["skip", "s"] },
                    { name: "skip to", desc: "Skip to the desired track", usage: "skip to <position>" },
                    { name: "previous", desc: "Go to the previous track in the queue", usage: "previous" },
                    { name: "vote skip", desc: "Vote to skip the current track, same as skip but forces a vote", usage: "vote skip" },
                ] },
            { name: "Repeat", commands: [
                    { name: "rewind", desc: "Rewind the current track", usage: "rewind <time>", aliases: ["seek"] },
                    { name: "restart queue", desc: "Restart the queue", usage: "restart queue" },
                    { name: "repeat queue", desc: "Repeat the queue", usage: "repeat queue" },
                    { name: "repeat current", desc: "Repeat the current track", usage: "repeat current" },
                    { name: "repeat disable", desc: "Disable any repeating which is currently enabled", usage: "repeat disable" },
                ] },
            { name: "Options", commands: [
                    { name: "select random", desc: "Select tracks in the queue at random", usage: "select random" },
                    { name: "shuffle repeat", desc: "Shuffle the queue every time it repeats", usage: "shuffle repeat" },
                    { name: "remove after played", desc: "Remove tracks after they have been played", usage: "remove after played" },
                ] },
            { name: "Other", commands: [
                    { name: "sort", desc: "Sort the queue", usage: "sort <title | length | requester> [reverse]" },
                    { name: "move", desc: "Move a track in the queue", usage: "move <from> <to>" },
                    { name: "swap", desc: "Swap the position of two tracks", usage: "swap <position> <position>" },
                    { name: "reverse", desc: "Reverse the current queue", usage: "reverse" },
                    { name: "shuffle", desc: "Shuffle the queue", usage: "shuffle", aliases: ["mix"] },
                    { name: "reorder", desc: "Order the queue by the specified option", usage: "reorder <title | length | requester> [reverse]" },
                    { name: "mass move", desc: "Move multiple tracks in the queue", usage: "mass move <positions> <destination>" },
                ] },
        ],
    },
    {
        page: 5,
        title: "Queue State Remove",
        description: "Commands used to remove tracks from the queue",
        sections: [
            { name: "Commands", commands: [
                    { name: "clear", desc: "Remove all the tracks from the queue", usage: "clear" },
                    { name: "remove", desc: "Remove a track from the queue", usage: "remove <position>", aliases: ["rm", "delete"] },
                    { name: "mass remove", desc: "Remove multiple tracks from the queue", usage: "mass remove <positions>" },
                    { name: "remove last", desc: "Remove the last track in the queue", usage: "remove last" },
                    { name: "remove user", desc: "Remove all tracks requested by a user", usage: "remove user [user]" },
                    { name: "remove range", desc: "Remove a range of tracks from the queue", usage: "remove range <first> <last>" },
                    { name: "remove absent", desc: "Remove all tracks requested by absent users", usage: "remove absent" },
                    { name: "remove current", desc: "Remove the currently playing track from the queue", usage: "remove current" },
                    { name: "remove keyword", desc: "Remove all the tracks containing the specified keyword", usage: "remove keyword <word>" },
                    { name: "remove duplicates", desc: "Remove all duplicate tracks from the queue", usage: "remove duplicates" },
                ] },
        ],
    },
    {
        page: 6,
        title: "Information",
        description: "Information related commands",
        sections: [
            { name: "Genius", commands: [
                    { name: "lyrics", desc: "Get the lyrics of a song", usage: "lyrics <song>" },
                    { name: "song info", desc: "Get information about a song", usage: "song info [song]" },
                    { name: "top songs", desc: "Get the top songs", usage: "top songs" },
                    { name: "album info", desc: "Get information about an album", usage: "album info <album>" },
                    { name: "artist info", desc: "Get information about an artist", usage: "artist info <artist>" },
                    { name: "searchlyrics", desc: "Search for a song by its lyrics", usage: "searchlyrics <lyrics>" },
                ] },
            { name: "Other", commands: [
                    { name: "save", desc: "Save a song to our private messages", usage: "save" },
                    { name: "queue", desc: "Get a list of the full queue", usage: "queue [page]" },
                    { name: "next up", desc: "Get information about the next track", usage: "next up" },
                    { name: "upcoming", desc: "Get a list of all the upcoming tracks", usage: "upcoming" },
                    { name: "requested", desc: "Get all the tracks requested by a user", usage: "requested [user]" },
                    { name: "now playing", desc: "Get information about the currently playing track", usage: "nowplaying", aliases: ["nowplaying", "np"] },
                    { name: "recently played", desc: "View your recently listened to tracks", usage: "recently played" },
                    { name: "queue information", desc: "Get information about the queue", usage: "queue information" },
                    { name: "session statistics", desc: "Get statistics for the current session", usage: "session statistics" },
                    { name: "session information", desc: "Get information about the current session", usage: "session information" },
                ] },
        ],
    },
    {
        page: 7,
        title: "Profile",
        description: "Commands related to your profile",
        sections: [
            { name: "Commands", commands: [
                    { name: "profile", desc: "View your profile", usage: "profile [user]" },
                    { name: "profile set color", desc: "Set your profile color", usage: "profile set color <color>" },
                    { name: "profile set privacy", desc: "Set what parts (servers, friends and tracks) are visible on your profile", usage: "profile set privacy <part> <show | hide>" },
                    { name: "profile set background", desc: "Set your profile background", usage: "profile set background <background>" },
                    { name: "profile set visibility", desc: "Set who can view your profile, `public` or `private`", usage: "profile set visibility <public | private>" },
                    { name: "profile set avatar shape", desc: "Set your profile avatar shape, `circle` or `square`", usage: "profile set avatar shape <circle | square>" },
                    { name: "profile set avatar border", desc: "Set your profile avatar border", usage: "profile set avatar border <color | none | default>" },
                    { name: "profile set server visibility", desc: "Set who can view profile data from this server, `public` or `private`", usage: "profile set server visibility <public | private>" },
                    { name: "profile set avatar background", desc: "Set your profile avatar background", usage: "profile set avatar background <color | default>" },
                ] },
        ],
    },
    {
        page: 8,
        title: "Prefix",
        description: "Prefix related commands",
        sections: [
            {
                name: "Server",
                commands: [
                    { name: "prefix server add", desc: "Add additional prefixes for this server", usage: "prefix server add <prefix>" },
                    { name: "prefix server set", desc: "Set a custom prefix for this server", usage: "prefix server set <prefix>" },
                    { name: "prefix server reset", desc: "Remove all custom prefixes from the server", usage: "prefix server reset" },
                    { name: "prefix server remove", desc: "Remove a custom prefix from the server", usage: "prefix server remove <prefix>" },
                ],
            },
            {
                name: "Self",
                commands: [
                    { name: "prefix self add", desc: "Add additional prefixes", usage: "prefix self add <prefix>" },
                    { name: "prefix self set", desc: "Set a custom prefix", usage: "prefix self set <prefix>" },
                    { name: "prefix self reset", desc: "Remove all custom prefixes", usage: "prefix self reset" },
                    { name: "prefix self remove", desc: "Remove a custom prefix", usage: "prefix self remove <prefix>" },
                    { name: "prefix self combine", desc: "Combine your prefixes with the server's", usage: "prefix self combine" },
                ],
            },
            {
                name: "Other",
                commands: [
                    { name: "prefix list", desc: "Get all available prefixes", usage: "prefix list" },
                ],
            },
        ],
    },
    {
        page: 9,
        title: "Settings",
        description: "Bot settings, voice connection, and Last.fm scrobbling",
        sections: [
            {
                name: "Last.fm",
                commands: [
                    { name: "login", desc: "Authenticate with Last.fm for live scrobbling", usage: "login" },
                    { name: "logout", desc: "Disconnect your Last.fm account", usage: "logout" },
                ],
            },
            {
                name: "Voice & Permissions",
                commands: [
                    { name: "join", desc: "Summon the bot into your current voice channel", usage: "join", aliases: ["summon"] },
                    { name: "leave", desc: "Disconnect the bot from the voice channel", usage: "leave", aliases: ["dc"] },
                    { name: "permission", desc: "Configure DJ roles and command access permissions", usage: "permission" },
                    { name: "resetstats", desc: "Reset your personal listening statistics", usage: "resetstats" },
                ],
            },
        ],
    },
];

const TOTAL_PAGES = HELP_PAGES.length;

// Session storage for interactive help navigation (messageId -> state)
const helpSessions = new Map();

/**
 * Build the embed for a specific help page matching the exact reference UI
 */
function buildPageEmbed(pageNumber) {
    const pageIndex = Math.max(0, Math.min(pageNumber - 1, TOTAL_PAGES - 1));
    const data = HELP_PAGES[pageIndex];

    let content = `Page **${data.page}/${TOTAL_PAGES}**\n\n`;
    content += `[${data.title}](https://discord.gg)\n`;
    content += "----------------------------------------\n";
    content += `${data.description}\n`;
    content += "----------------------------------------\n\n";

    for (const section of data.sections) {
        content += `${section.name}\n`;
        for (const cmd of section.commands) {
            content += `**${cmd.name}**: *${cmd.desc}*\n`;
        }
        content += "\n";
    }

    content += "-# next page | previous page | go to page <page> | cancel";

    return new EmbedBuilder()
        .setColor(0x2b2d31)
        .setDescription(content.trim());
}

/**
 * Build the select menu and pagination buttons for a page
 */
function buildPageComponents(pageNumber) {
    const pageIndex = Math.max(0, Math.min(pageNumber - 1, TOTAL_PAGES - 1));
    const data = HELP_PAGES[pageIndex];

    // Collect all commands on this page for the dropdown
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("help_command_select")
        .setPlaceholder("Select a command for more information")
        .setMinValues(1)
        .setMaxValues(1);

    const seenNames = new Set();
    for (const section of data.sections) {
        for (const cmd of section.commands) {
            if (seenNames.has(cmd.name)) continue;
            seenNames.add(cmd.name);

            selectMenu.addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(cmd.name.slice(0, 100))
                    .setDescription(cmd.desc.slice(0, 100))
                    .setValue(cmd.name)
            );
        }
    }

    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    // Navigation buttons row: <<  <  >  >>
    const isFirstPage = pageNumber <= 1;
    const isLastPage = pageNumber >= TOTAL_PAGES;

    const btnFirst = new ButtonBuilder()
        .setCustomId("help_nav_first")
        .setLabel("<<")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isFirstPage);

    const btnPrev = new ButtonBuilder()
        .setCustomId("help_nav_prev")
        .setLabel("<")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isFirstPage);

    const btnNext = new ButtonBuilder()
        .setCustomId("help_nav_next")
        .setLabel(">")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isLastPage);

    const btnLast = new ButtonBuilder()
        .setCustomId("help_nav_last")
        .setLabel(">>")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isLastPage);

    const navRow = new ActionRowBuilder().addComponents(btnFirst, btnPrev, btnNext, btnLast);

    return [selectRow, navRow];
}

/**
 * Build detailed command information embed matching the new UI design
 */
function buildCommandDetailEmbed(commandName, prefix = "e!") {
    let foundCmd = null;
    let foundCategory = null;

    for (const page of HELP_PAGES) {
        for (const section of page.sections) {
            for (const cmd of section.commands) {
                if (
                    cmd.name.toLowerCase() === commandName.toLowerCase() ||
                    (cmd.aliases && cmd.aliases.includes(commandName.toLowerCase()))
                ) {
                    foundCmd = cmd;
                    foundCategory = page.title;
                    break;
                }
            }
            if (foundCmd) break;
        }
        if (foundCmd) break;
    }

    if (!foundCmd) {
        foundCmd = {
            name: commandName,
            desc: "Command information",
            usage: commandName,
            aliases: [],
        };
        foundCategory = "General";
    }

    const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle(`Help for command: ${foundCmd.name}`)
        .setDescription(foundCmd.desc);

    // Option definitions section
    if (foundCmd.name === "permission") {
        let optionDefs = "";
        optionDefs += "`reverse` - Reverse the sort type, this would change length from shortest to longest track\n";
        optionDefs += "`length` - Sort by track length\n";
        optionDefs += "`title` - Sort by track title\n";
        embed.addFields({ name: "Option definitions", value: optionDefs || "No option definitions", inline: false });
    }

    // Session permissions section
    if (foundCmd.name === "permission") {
        let permissions = "";
        permissions += "`add track` - Required to add tracks to the queue\n";
        permissions += "`remove track` - Required to remove tracks from the queue\n";
        permissions += "`shuffle queue` - Required to shuffle the queue\n";
        permissions += "`change volume` - Required to change the volume\n";
        permissions += "`update state` - Required to skip, pause, loop, seek\n";
        permissions += "`index queue` - Required to move, clear\n";
        permissions += "`leave` - Required to disconnect the bot\n";
        permissions += "`autoplay` - Required to toggle autoplay\n";
        permissions += "`audio filter` - Required to use audio filters\n";
        embed.addFields({ name: "Session permissions", value: permissions || "No special permissions required", inline: false });
    }

    // Usage section
    let usageText = "";
    if (foundCmd.name === "permission") {
        usageText += `\`\`\`${prefix}permission allow <role|user|everyone> <permission>\`\`\`\n`;
        usageText += `\`\`\`${prefix}permission deny <role|user|everyone> <permission>\`\`\`\n`;
        usageText += `\`\`\`${prefix}permissions allow all <role|user|everyone>\`\`\`\n`;
        usageText += `\`\`\`${prefix}permissions deny all <role|user|everyone>\`\`\`\n`;
        usageText += `\`\`\`${prefix}permissions reset <role|user|everyone|all>\`\`\`\n`;
        usageText += `\`\`\`${prefix}permissions [role|user|everyone]\`\`\`\n`;
    } else {
        usageText = `\`\`\`${prefix}${foundCmd.usage || foundCmd.name}\`\`\``;
    }
    embed.addFields({ name: "Usage", value: usageText, inline: false });

    // Option section (for commands with options)
    if (foundCmd.name === "sort") {
        embed.addFields({ name: "Option", value: "`--reverse`", inline: false });
    }

    // Examples section
    let examples = "";
    if (foundCmd.name === "sort") {
        examples += `\`\`\`sort length\`\`\`\n`;
        examples += `\`\`\`sort title false\`\`\`\n`;
    } else if (foundCmd.name === "permission") {
        examples += `\`\`\`${prefix}permission allow @DJ add track\`\`\`\n`;
        examples += `\`\`\`${prefix}permission deny @User leave\`\`\`\n`;
    } else if (foundCmd.usage) {
        examples += `\`\`\`${prefix}${foundCmd.usage}\`\`\`\n`;
    }
    if (examples) {
        embed.addFields({ name: "Examples", value: examples, inline: false });
    }

    // Aliases section
    if (foundCmd.aliases && foundCmd.aliases.length > 0) {
        embed.addFields({ name: "Aliases", value: foundCmd.aliases.map(a => `\`${prefix}${a}\``).join(", "), inline: false });
    }

    // Category section
    embed.addFields({ name: "Category", value: foundCategory, inline: false });

    const backButton = new ButtonBuilder()
        .setCustomId("help_nav_back")
        .setLabel("← Back to Directory")
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(backButton);

    return { embed, components: [row] };
}

module.exports = {
    aliases: ["h"],
    data: new SlashCommandBuilder()
        .setName("help")
        .setDescription("Show all commands and interactive directory")
        .addStringOption((opt) =>
            opt.setName("query")
                .setDescription("Command name, category, or page number (1-9)")
                .setRequired(false)
        ),

    async execute(interaction) {
        const guildId = interaction.guild?.id;
        const currentPrefix = getPrefix(guildId);
        const rawArg = (interaction.args?.[0] || interaction.options?.getString("query") || "").toLowerCase().trim();

        // 1. Direct page number: e!help 2 / e!help 5
        if (/^[1-9]$/.test(rawArg)) {
            const pageNum = parseInt(rawArg, 10);
            const embed = buildPageEmbed(pageNum);
            const components = buildPageComponents(pageNum);

            const msg = await interaction.reply({
                embeds: [embed],
                components: components,
                fetchReply: true,
            });

            if (msg?.id) {
                helpSessions.set(msg.id, { page: pageNum, userId: interaction.user.id });
            }
            return;
        }

        // 2. Direct category or command query: e!help profile / e!help prefix / e!help music
        if (rawArg) {
            // Check if matches category name (profile, prefix, music, queue, meta, settings)
            const catIndex = HELP_PAGES.findIndex(
                p => p.title.toLowerCase() === rawArg ||
                     (rawArg === "prefix" && p.title === "Prefix") ||
                     (rawArg === "profile" && p.title === "Profile")
            );

            if (catIndex !== -1) {
                const pageNum = catIndex + 1;
                const embed = buildPageEmbed(pageNum);
                const components = buildPageComponents(pageNum);

                const msg = await interaction.reply({
                    embeds: [embed],
                    components: components,
                    fetchReply: true,
                });

                if (msg?.id) {
                    helpSessions.set(msg.id, { page: pageNum, userId: interaction.user.id });
                }
                return;
            }

            // Command detail lookup
            const { embed, components } = buildCommandDetailEmbed(rawArg, currentPrefix);
            const msg = await interaction.reply({
                embeds: [embed],
                components: components,
                fetchReply: true,
            });

            if (msg?.id) {
                helpSessions.set(msg.id, { page: 1, userId: interaction.user.id, inDetail: true });
            }
            return;
        }

        // 3. Default Overview (Page 1: Meta, matching screenshot)
        const embed = buildPageEmbed(1);
        const components = buildPageComponents(1);

        const msg = await interaction.reply({
            embeds: [embed],
            components: components,
            fetchReply: true,
        });

        if (msg?.id) {
            helpSessions.set(msg.id, { page: 1, userId: interaction.user.id });
        }
    },

    /**
     * Handle interactive dropdown & navigation buttons
     */
    async handleInteraction(interaction, client) {
        const messageId = interaction.message?.id;
        const session = helpSessions.get(messageId) || { page: 1, userId: interaction.user.id };
        const currentPrefix = getPrefix(interaction.guild?.id);

        // 1. Dropdown command selection
        if (interaction.isStringSelectMenu() && interaction.customId === "help_command_select") {
            const selectedCmd = interaction.values[0];
            const { embed, components } = buildCommandDetailEmbed(selectedCmd, currentPrefix);

            session.inDetail = true;
            helpSessions.set(messageId, session);

            return await interaction.update({
                embeds: [embed],
                components: components,
            });
        }

        // 2. Return from detail view to current page
        if (interaction.isButton() && interaction.customId === "help_nav_back") {
            session.inDetail = false;
            const embed = buildPageEmbed(session.page);
            const components = buildPageComponents(session.page);
            helpSessions.set(messageId, session);

            return await interaction.update({
                embeds: [embed],
                components: components,
            });
        }

        // 3. Pagination buttons: <<, <, >, >>
        let targetPage = session.page;

        if (interaction.customId === "help_nav_first") {
            targetPage = 1;
        } else if (interaction.customId === "help_nav_prev") {
            targetPage = Math.max(1, session.page - 1);
        } else if (interaction.customId === "help_nav_next") {
            targetPage = Math.min(TOTAL_PAGES, session.page + 1);
        } else if (interaction.customId === "help_nav_last") {
            targetPage = TOTAL_PAGES;
        }

        session.page = targetPage;
        session.inDetail = false;
        helpSessions.set(messageId, session);

        const embed = buildPageEmbed(targetPage);
        const components = buildPageComponents(targetPage);

        return await interaction.update({
            embeds: [embed],
            components: components,
        });
    },
};
