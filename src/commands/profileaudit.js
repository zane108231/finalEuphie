const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
} = require("discord.js");
const { getDB, isDBConnected } = require("../utils/database");
const { getProfileTrackDisplayName } = require("../utils/search");

const DEVELOPER_ID = "766135407590244383";
const PAGE_SIZE = 8;
const BUTTON_PREFIX = "profileaudit";

function truncate(value, maxLength = 140) {
    const text = String(value || "Unknown track");
    return text.length > maxLength
        ? `${text.slice(0, maxLength - 1)}…`
        : text;
}

async function loadPage(page) {
    if (!isDBConnected()) {
        throw new Error("MongoDB is not connected.");
    }

    const collection = getDB().collection("userStats");
    const totalUsers = await collection.countDocuments({
        totalListeningMs: { $gt: 0 },
    });
    const pageCount = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE));
    const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
    const users = await collection
        .find(
            { totalListeningMs: { $gt: 0 } },
            { projection: { userId: 1, totalListeningMs: 1, tracksPlayed: 1 } }
        )
        .sort({ updatedAt: -1, userId: 1 })
        .skip(currentPage * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .toArray();

    const tracksByUser = await Promise.all(
        users.map(async (user) => {
            const tracks = await getDB()
                .collection("trackStats")
                .find(
                    { userId: user.userId, listeningMs: { $gt: 0 } },
                    {
                        projection: {
                            trackTitle: 1,
                            trackArtist: 1,
                            trackArtistSource: 1,
                            trackSourceName: 1,
                            trackUri: 1,
                            listeningMs: 1,
                        },
                    }
                )
                .sort({ listeningMs: -1 })
                .limit(3)
                .toArray();
            return [user.userId, tracks];
        })
    );

    return {
        currentPage,
        pageCount,
        totalUsers,
        users,
        tracksByUser: new Map(tracksByUser),
    };
}

function buildPagePayload(data) {
    const description = data.users.length
        ? data.users
              .map((user) => {
                  const tracks = data.tracksByUser.get(user.userId) || [];
                  const trackLines = tracks.length
                      ? tracks
                            .map((track) => {
                                const profileTitle = truncate(
                                    getProfileTrackDisplayName(track)
                                );
                                const storedTitle = truncate(
                                    track.trackTitle || "Unknown track"
                                );
                                return profileTitle === storedTitle
                                    ? `• ${profileTitle}`
                                    : `• ${profileTitle}\n  Stored: ${storedTitle}`;
                            })
                            .join("\n")
                      : "• No saved top tracks";
                  return `**User ID:** \`${user.userId}\`\n${trackLines}`;
              })
              .join("\n\n")
        : "No users with listening profile statistics were found.";

    const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle("Profile audit")
        .setDescription(
            `${description}\n\n` +
                "Use `/viewuserprofile` with an ID to inspect a card, or " +
                "`/cleanprofile` with an ID and exact wording to clean track names."
        )
        .setFooter({
            text: `Page ${data.currentPage + 1}/${data.pageCount} • ${data.totalUsers} users`,
        });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(
                `${BUTTON_PREFIX}:${DEVELOPER_ID}:${data.currentPage - 1}`
            )
            .setLabel("Previous")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(data.currentPage <= 0),
        new ButtonBuilder()
            .setCustomId(
                `${BUTTON_PREFIX}:${DEVELOPER_ID}:${data.currentPage + 1}`
            )
            .setLabel("Next")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(data.currentPage >= data.pageCount - 1)
    );

    return { embeds: [embed], components: [row] };
}

module.exports = {
    primaryOnly: true,
    data: new SlashCommandBuilder()
        .setName("profileaudit")
        .setDescription("Browse users' profile track names and IDs (developer only)"),

    async execute(interaction) {
        if (interaction.user?.id !== DEVELOPER_ID) {
            return interaction.reply({
                content: "❌ Only the bot developer can use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const data = await loadPage(0);
            return interaction.editReply(buildPagePayload(data));
        } catch (error) {
            console.error("[euphire] /profileaudit failed:", error);
            return interaction.editReply({
                content:
                    "❌ Could not load the profile index. Check the bot console for details.",
                components: [],
            });
        }
    },

    async handleButton(interaction) {
        const match = interaction.customId.match(
            /^profileaudit:(\d{17,20}):(\d+)$/
        );
        if (!match) return;

        if (
            interaction.user?.id !== DEVELOPER_ID ||
            interaction.user.id !== match[1]
        ) {
            return interaction.reply({
                content: "❌ Only the developer can browse this profile index.",
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            const data = await loadPage(Number(match[2]));
            return interaction.update(buildPagePayload(data));
        } catch (error) {
            console.error("[euphire] Profile audit pagination failed:", error);
            return interaction.update({
                content:
                    "❌ Could not load that profile index page. Check the bot console for details.",
                embeds: [],
                components: [],
            });
        }
    },
};
