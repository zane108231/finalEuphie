const {
    AttachmentBuilder,
    MessageFlags,
    SlashCommandBuilder,
} = require("discord.js");
const {
    getTopFriends,
    getTopServers,
    getTopTracks,
    getUserStats,
} = require("../utils/mongoStats");
const { generateProfileCard } = require("../utils/profileCard");
const { getDB, isDBConnected } = require("../utils/database");
const coordinator = require("../utils/mongoCoordinator");

const DEVELOPER_ID = "766135407590244383";

function createFallbackUser(userId) {
    const defaultAvatarIndex = Number((BigInt(userId) >> 22n) % 6n);
    const avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`;
    return {
        id: userId,
        username: userId,
        displayName: userId,
        displayAvatarURL: () => avatarUrl,
    };
}

async function fetchUser(userId, client) {
    const clients = [
        client,
        ...coordinator.getAllClients().filter((candidate) => candidate !== client),
    ];
    let lastError = null;

    for (const candidate of clients) {
        try {
            const user = await candidate?.users?.fetch(userId);
            if (user) return user;
        } catch (error) {
            lastError = error;
        }
    }

    if (lastError) {
        console.warn(
            `[euphire] Could not fetch Discord user ${userId} for profile card:`,
            lastError.message
        );
    }
    return createFallbackUser(userId);
}

async function getProfileSettings(userId) {
    if (!isDBConnected()) return {};

    return (
        (await getDB().collection("userData").findOne(
            { userId },
            {
                projection: {
                    profileColor: 1,
                    profileStatsColor: 1,
                },
            }
        )) || {}
    );
}

module.exports = {
    primaryOnly: true,
    data: new SlashCommandBuilder()
        .setName("viewuserprofile")
        .setDescription("View a user's profile card by Discord ID (developer only)")
        .addStringOption((option) =>
            option
                .setName("user_id")
                .setDescription("The user's Discord ID")
                .setMinLength(17)
                .setMaxLength(20)
                .setRequired(true)
        ),

    async execute(interaction, client) {
        if (interaction.user?.id !== DEVELOPER_ID) {
            return interaction.reply({
                content: "❌ Only the bot developer can use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const userId = String(
            interaction.options?.getString?.("user_id") || ""
        ).trim();
        if (!/^\d{17,20}$/.test(userId)) {
            return interaction.reply({
                content: "❌ Provide a valid Discord user ID.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const [user, stats, topServers, topFriends, topTracks, settings] =
                await Promise.all([
                    fetchUser(userId, client),
                    getUserStats(userId),
                    getTopServers(userId, 3),
                    getTopFriends(userId, 3),
                    getTopTracks(userId, 3),
                    getProfileSettings(userId),
                ]);
            const imageBuffer = await generateProfileCard(
                user,
                stats,
                topServers,
                topFriends,
                topTracks,
                client,
                {
                    ...settings,
                    profileBackground: "default",
                    profilePrivacy: {
                        servers: true,
                        friends: true,
                        tracks: true,
                    },
                }
            );

            const userWasFetched = user.username !== userId;
            return interaction.editReply({
                content:
                    `Profile card for \`${userId}\`` +
                    (userWasFetched
                        ? ""
                        : "\nDiscord account details were unavailable; the card uses the ID and default avatar."),
                files: [
                    new AttachmentBuilder(imageBuffer, {
                        name: `${userId}-profile.png`,
                    }),
                ],
            });
        } catch (error) {
            console.error(
                `[euphire] /viewuserprofile failed for ${userId}:`,
                error
            );
            return interaction.editReply({
                content:
                    "❌ Could not generate that profile card. Check the bot console for details.",
            });
        }
    },
};
