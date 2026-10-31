const { MessageFlags, SlashCommandBuilder } = require("discord.js");
const { applyGuildBotSettings } = require("../utils/guildBotProfile");

const DEVELOPER_ID = "766135407590244383";
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
]);

async function getImageDataUri(attachment, label) {
    if (!IMAGE_CONTENT_TYPES.has(attachment.contentType)) {
        throw new Error(`${label} must be a PNG, JPEG, GIF, or WebP image.`);
    }
    if (attachment.size > MAX_IMAGE_SIZE_BYTES) {
        throw new Error(`${label} must be 10 MB or smaller.`);
    }

    const response = await fetch(attachment.url);
    if (!response.ok) {
        throw new Error(`Could not download ${label} (HTTP ${response.status}).`);
    }

    const contentType = response.headers.get("content-type")?.split(";")[0].toLowerCase();
    if (!IMAGE_CONTENT_TYPES.has(contentType)) {
        throw new Error(`${label} is not a supported image.`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_SIZE_BYTES) {
        throw new Error(`${label} must be non-empty and 10 MB or smaller.`);
    }
    return `data:${contentType};base64,${bytes.toString("base64")}`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("developerprofile")
        .setDescription("Set Euphie's server-specific name, avatar, banner, or bio (developer only)")
        .addStringOption((option) =>
            option
                .setName("name")
                .setDescription("Server-specific Euphie name")
                .setMaxLength(32)
                .setRequired(false)
        )
        .addAttachmentOption((option) =>
            option
                .setName("avatar")
                .setDescription("Server-specific Euphie avatar image")
                .setRequired(false)
        )
        .addStringOption((option) =>
            option
                .setName("bio")
                .setDescription("Server-specific Euphie bio")
                .setMaxLength(190)
                .setRequired(false)
        )
        .addAttachmentOption((option) =>
            option
                .setName("banner")
                .setDescription("Server-specific Euphie banner image")
                .setRequired(false)
        ),

    async execute(interaction) {
        if (interaction.user.id !== DEVELOPER_ID) {
            return interaction.reply({
                content: "Only the bot developer can use this command.",
                flags: MessageFlags.Ephemeral,
            });
        }
        if (!interaction.guild) {
            return interaction.reply({
                content: "This command can only be used in a server.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const name = interaction.options.getString("name");
        const avatarAttachment = interaction.options.getAttachment("avatar");
        const bio = interaction.options.getString("bio");
        const bannerAttachment = interaction.options.getAttachment("banner");
        if (name === null && !avatarAttachment && bio === null && !bannerAttachment) {
            return interaction.reply({
                content: "Choose at least one of name, avatar, bio, or banner to update.",
                flags: MessageFlags.Ephemeral,
            });
        }
        if (name !== null && !name.trim()) {
            return interaction.reply({
                content: "The Euphie name cannot be blank.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const changes = {};
            if (name !== null) changes.nickBase = name.trim().slice(0, 32);
            if (bio !== null) changes.bio = bio;
            if (avatarAttachment) {
                changes.avatar = await getImageDataUri(avatarAttachment, "Avatar");
            }
            if (bannerAttachment) {
                changes.banner = await getImageDataUri(bannerAttachment, "Banner");
            }

            const result = await applyGuildBotSettings(
                interaction.guildId,
                changes,
                `Server-specific Euphie profile updated by developer ${DEVELOPER_ID}`
            );
            if (!result.updated.length) {
                const details = result.errors
                    .map(({ botName, error }) => `${botName}: ${error.message}`)
                    .join("\n");
                return interaction.editReply(`Could not update any Euphie profiles.\n${details}`);
            }

            const changed = [
                name !== null && "name",
                avatarAttachment && "avatar",
                bio !== null && "bio",
                bannerAttachment && "banner",
            ].filter(Boolean);
            let message = `Updated ${changed.join(", ")} for ${result.updated.map((botName) => `**${botName}**`).join(", ")} in **${interaction.guild.name}**.`;
            if (result.errors.length) {
                message += "\nSome bots could not be updated:\n" + result.errors
                    .map(({ botName, error }) => `• ${botName}: ${error.message}`)
                    .join("\n");
            }
            return interaction.editReply(message);
        } catch (error) {
            console.error(`[euphire] /developerprofile failed in ${interaction.guildId}: ${error.message}`);
            return interaction.editReply(`Could not update the Euphie profile: ${error.message}`);
        }
    },
};
