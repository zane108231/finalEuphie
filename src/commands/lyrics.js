const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require("discord.js");
const { searchGenius, getLyrics, cleanSongTitle, splitLyricsIntoPages } = require("../utils/genius");
const coordinator = require("../utils/mongoCoordinator");
const config = require("../../config");

// Store active search selections: searchId -> { songs, userId, createdAt }
const lyricsSearches = new Map();

// Store active lyrics pagination sessions: sessionId -> { pages, song, userId, currentPage, createdAt }
const lyricsSessions = new Map();

// Periodic cleanup every 5 minutes for sessions older than 15 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, data] of lyricsSearches) {
        if (now - data.createdAt > 15 * 60 * 1000) {
            lyricsSearches.delete(id);
        }
    }
    for (const [id, data] of lyricsSessions) {
        if (now - data.createdAt > 15 * 60 * 1000) {
            lyricsSessions.delete(id);
        }
    }
}, 5 * 60 * 1000);

/**
 * Build the selection UI strictly following the reference image:
 * Page 1/1
 *
 * 1. [Song Title by Artist](url)
 * 2. [Song Title by Artist](url)
 * ...
 *
 * cancel
 */
function buildSelectionPayload(songs, searchId, page = 1, totalPages = 1) {
    let description = `Page **${page}/${totalPages}**\n\n`;

    const selectOptions = [];

    songs.forEach((song, index) => {
        const num = index + 1;
        const fullTitle = song.fullTitle || `${song.title} by ${song.artist}`;
        description += `${num}. [${fullTitle}](${song.url})\n`;

        selectOptions.push(
            new StringSelectMenuOptionBuilder()
                .setLabel(`${num}. ${song.title}`.slice(0, 100))
                .setDescription(`${song.artist}`.slice(0, 100))
                .setValue(`${searchId}:${index}`)
        );
    });

    description += `\ncancel`;

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setDescription(description);

    selectOptions.push(
        new StringSelectMenuOptionBuilder()
            .setLabel("cancel")
            .setDescription("Cancel selection")
            .setValue(`${searchId}:cancel`)
    );

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("lyrics_select")
        .setPlaceholder("Make a selection")
        .addOptions(selectOptions);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    return {
        embeds: [embed],
        components: [row],
    };
}

/**
 * Build lyrics display embed and optional pagination buttons
 */
function buildLyricsPagePayload(session, sessionId) {
    const { pages, song, currentPage } = session;
    const totalPages = pages.length;

    const embed = new EmbedBuilder()
        .setColor(config.accentColor || 0x2b2d31)
        .setTitle(`${song.title} — ${song.artist}`.slice(0, 256))
        .setURL(song.url)
        .setDescription(pages[currentPage]);

    if (song.thumbnail) {
        embed.setThumbnail(song.thumbnail);
    }

    if (totalPages > 1) {
        embed.setFooter({
            text: `Page ${currentPage + 1}/${totalPages} • Powered by Genius`,
        });

        const prevButton = new ButtonBuilder()
            .setCustomId(`lyrics_page_prev:${sessionId}`)
            .setLabel("◀")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(currentPage === 0);

        const pageIndicator = new ButtonBuilder()
            .setCustomId(`lyrics_page_info:${sessionId}`)
            .setLabel(`${currentPage + 1}/${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);

        const nextButton = new ButtonBuilder()
            .setCustomId(`lyrics_page_next:${sessionId}`)
            .setLabel("▶")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(currentPage === totalPages - 1);

        const closeButton = new ButtonBuilder()
            .setCustomId(`lyrics_page_close:${sessionId}`)
            .setLabel("✕")
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(prevButton, pageIndicator, nextButton, closeButton);

        return {
            content: null,
            embeds: [embed],
            components: [row],
        };
    } else {
        embed.setFooter({
            text: `Powered by Genius`,
        });

        return {
            content: null,
            embeds: [embed],
            components: [],
        };
    }
}

module.exports = {
    aliases: ["lyric", "ly"],
    data: new SlashCommandBuilder()
        .setName("lyrics")
        .setDescription("Search and display song lyrics via Genius")
        .addStringOption((opt) =>
            opt.setName("query").setDescription("Song title or artist to search").setRequired(false)
        ),

    async execute(interaction, client) {
        let query = "";
        if (typeof interaction.options?.getString === "function") {
            query = interaction.options.getString("query") || "";
        }
        if (!query && interaction.args && interaction.args.length > 0) {
            query = interaction.args.join(" ");
        }

        // If no query provided, look for currently playing track
        if (!query) {
            const guildId = interaction.guild?.id;
            const voiceChannelId = interaction.member?.voice?.channel?.id;
            let currentTrack = null;

            if (voiceChannelId) {
                // Find player in user's voice channel
                for (const c of coordinator.getAllClients()) {
                    const p = c.riffy?.players?.get(guildId);
                    if (p && p.voiceChannel === voiceChannelId && p.current) {
                        currentTrack = p.current;
                        break;
                    }
                }
            }

            if (!currentTrack && guildId) {
                // Search across all players in this guild
                for (const c of coordinator.getAllClients()) {
                    const p = c.riffy?.players?.get(guildId);
                    if (p && p.current) {
                        currentTrack = p.current;
                        break;
                    }
                }
            }

            if (currentTrack?.info?.title) {
                let songTitle = cleanSongTitle(currentTrack.info.title).trim();
                if (songTitle.includes(" - ")) {
                    const parts = songTitle.split(/\s+-\s+/);
                    if (parts.length >= 2) {
                        const author = (currentTrack.info.author || "").toLowerCase().trim();
                        if (author && parts[0].toLowerCase().includes(author)) {
                            songTitle = parts.slice(1).join(" - ").trim();
                        } else if (author && parts[parts.length - 1].toLowerCase().includes(author)) {
                            songTitle = parts.slice(0, -1).join(" - ").trim();
                        } else {
                            songTitle = parts.slice(1).join(" - ").trim();
                        }
                    }
                }
                query = songTitle.trim();
            }
        }

        if (!query) {
            return interaction.reply({
                content: "❌ No song is currently playing. Usage: `e!lyrics <song name>`",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply();

        // Search Genius
        const songs = await searchGenius(query);

        if (!songs || songs.length === 0) {
            return interaction.editReply({
                content: `❌ No lyrics found on Genius for: **${query}**`,
            });
        }

        // Create search session ID
        const searchId = `ls_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        lyricsSearches.set(searchId, {
            songs,
            userId: interaction.user.id,
            createdAt: Date.now(),
        });

        const payload = buildSelectionPayload(songs, searchId, 1, 1);
        await interaction.editReply(payload);
    },

    /**
     * Handle button and select menu interactions for lyrics
     */
    async handleInteraction(interaction, client) {
        // Dropdown selection
        if (interaction.isStringSelectMenu() && interaction.customId === "lyrics_select") {
            const selectedValue = interaction.values[0];
            const [searchId, selectedIndex] = selectedValue.split(":");

            if (selectedIndex === "cancel") {
                lyricsSearches.delete(searchId);
                return await interaction.update({
                    content: "Selection cancelled.",
                    embeds: [],
                    components: [],
                });
            }

            const search = lyricsSearches.get(searchId);
            if (!search) {
                return await interaction.reply({
                    content: "❌ This selection menu has expired. Please run `e!lyrics` again.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (interaction.user.id !== search.userId) {
                return await interaction.reply({
                    content: "❌ Only the person who requested this command can make a selection.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            const songIndex = parseInt(selectedIndex, 10);
            const song = search.songs[songIndex];

            if (!song) {
                return await interaction.reply({
                    content: "❌ Song selection invalid.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Acknowledge dropdown selection and fetch lyrics
            await interaction.update({
                content: `🔍 Loading lyrics for **${song.fullTitle}**...`,
                embeds: [],
                components: [],
            });

            const lyrics = await getLyrics(song.url);

            if (!lyrics) {
                return await interaction.editReply({
                    content: `❌ Could not find or extract lyrics for **${song.fullTitle}**.\n[View on Genius](${song.url})`,
                    embeds: [],
                    components: [],
                });
            }

            const pages = splitLyricsIntoPages(lyrics, 1800);
            const sessionId = `lp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

            const session = {
                pages,
                song,
                userId: interaction.user.id,
                currentPage: 0,
                createdAt: Date.now(),
            };

            lyricsSessions.set(sessionId, session);

            const payload = buildLyricsPagePayload(session, sessionId);
            return await interaction.editReply(payload);
        }

        // Pagination buttons
        if (interaction.isButton() && interaction.customId.startsWith("lyrics_page_")) {
            const [actionWithPrefix, sessionId] = interaction.customId.split(":");
            const session = lyricsSessions.get(sessionId);

            if (!session) {
                return await interaction.reply({
                    content: "❌ This lyrics session has expired.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (actionWithPrefix === "lyrics_page_close") {
                lyricsSessions.delete(sessionId);
                try {
                    return await interaction.message.delete();
                } catch {
                    return await interaction.update({
                        content: "Lyrics closed.",
                        embeds: [],
                        components: [],
                    });
                }
            }

            if (actionWithPrefix === "lyrics_page_prev") {
                session.currentPage = Math.max(0, session.currentPage - 1);
            } else if (actionWithPrefix === "lyrics_page_next") {
                session.currentPage = Math.min(session.pages.length - 1, session.currentPage + 1);
            }

            const payload = buildLyricsPagePayload(session, sessionId);
            return await interaction.update(payload);
        }
    },
};
