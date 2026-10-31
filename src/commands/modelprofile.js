const { MessageFlags, SlashCommandBuilder } = require("discord.js");
const { getCurrentModelUserId } = require("../utils/modelMilestones");
const { applyGuildBotAvatar } = require("../utils/guildBotProfile");

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
]);

function describeAvatarError(error) {
    const rawErrors = error.rawError?.errors?.avatar?._errors || [];
    if (
        rawErrors.some((entry) => entry.code === "AVATAR_RATE_LIMIT") ||
        /AVATAR_RATE_LIMIT|changing your avatar too fast/i.test(error.message || "")
    ) {
        return "Discord is temporarily rate-limiting this bot's avatar changes. The other Euphies may already have updated; wait for Discord's cooldown to expire, then try again.";
    }

    return error.message || "Unknown Discord API error.";
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("modelprofile")
        .setDescription("Upload a custom Euphie avatar (current model only)")
        .addAttachmentOption((option) =>
            option
                .setName("image")
                .setDescription("The image to use as Euphie's avatar in this server")
                .setRequired(true)
        ),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({
                content: "This command can only be used in a server.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const currentModelUserId = await getCurrentModelUserId(interaction.guildId);
        if (!currentModelUserId || interaction.user.id !== currentModelUserId) {
            return interaction.reply({
                content: "Only this server's current Euphie model can use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const image = interaction.options.getAttachment("image", true);
            if (!IMAGE_CONTENT_TYPES.has(image.contentType)) {
                return interaction.editReply("Upload a PNG, JPEG, GIF, or WebP image.");
            }
            if (image.size > MAX_IMAGE_SIZE_BYTES) {
                return interaction.editReply("The image must be 10 MB or smaller.");
            }

            const response = await fetch(image.url);
            if (!response.ok) {
                throw new Error(`Could not download the uploaded image (HTTP ${response.status}).`);
            }

            const contentType = response.headers.get("content-type")?.split(";")[0].toLowerCase();
            if (!IMAGE_CONTENT_TYPES.has(contentType)) {
                return interaction.editReply("The uploaded file is not a supported image.");
            }

            const bytes = Buffer.from(await response.arrayBuffer());
            if (!bytes.length || bytes.length > MAX_IMAGE_SIZE_BYTES) {
                return interaction.editReply("The image must be non-empty and 10 MB or smaller.");
            }

            const avatar = `data:${contentType};base64,${bytes.toString("base64")}`;
            const result = await applyGuildBotAvatar(interaction.guildId, avatar);
            if (!result.updated.length) {
                const details = result.errors
                    .map(({ botName, error }) => `${botName}: ${describeAvatarError(error)}`)
                    .join("\n");
                return interaction.editReply(
                    `Could not update any Euphie avatars.\n${details}`
                );
            }

            let message = `Updated the avatar for ${result.updated.map((name) => `**${name}**`).join(", ")} in **${interaction.guild.name}**.`;
            if (result.errors.length) {
                message += "\nSome bots could not be updated:\n" + result.errors
                    .map(({ botName, error }) => `• ${botName}: ${describeAvatarError(error)}`)
                    .join("\n");
            }
            return interaction.editReply(message);
        } catch (error) {
            console.error(`[euphire] /modelprofile failed in ${interaction.guildId}: ${error.message}`);
            return interaction.editReply(`Could not update the Euphie avatar: ${describeAvatarError(error)}`);
        }
    },
};
