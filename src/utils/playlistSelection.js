const { randomUUID } = require("crypto");
const { getDB } = require("./database");

async function resolvePlaylistSelection(client, interaction, query) {
    const result = await client.riffy.resolve({
        query: query.trim(),
        source: "spsearch",
        requester: interaction.user,
    });
    const loadType = String(result?.loadType || "").toLowerCase();
    const isPlaylist =
        loadType === "playlist" || loadType === "playlist_loaded";

    return {
        name: result?.playlistInfo?.name || null,
        tracks: isPlaylist
            ? (result.tracks || [])
                .filter((track) => track?.info?.uri)
                .map((track) => ({
                    uri: track.info.uri,
                    title: track.info.title || "Unknown track",
                    author: track.info.author || "Unknown artist",
                }))
            : [],
    };
}

async function createPlaylistSelection(client, interaction, query) {
    const selection = await resolvePlaylistSelection(client, interaction, query);
    if (!selection.tracks.length) return { ...selection, token: null };

    const token = randomUUID();
    await getDB().collection("playlistSelections").insertOne({
        token,
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        name: selection.name,
        tracks: selection.tracks.slice(0, 25),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    return { ...selection, token };
}

async function handlePlaylistSelection(interaction, client) {
    const [, token] = interaction.customId.split(":");
    const selection = await getDB()
        .collection("playlistSelections")
        .findOne({ token, expiresAt: { $gt: new Date() } });
    if (
        !selection ||
        selection.guildId !== interaction.guildId ||
        selection.userId !== interaction.user.id
    ) {
        return interaction.reply({
            content: "This playlist selection has expired or belongs to another user.",
            ephemeral: true,
        });
    }

    const selectedTrack = selection.tracks[Number(interaction.values[0])];
    if (!selectedTrack) {
        return interaction.reply({
            content: "That playlist track is no longer available.",
            ephemeral: true,
        });
    }

    await getDB().collection("playlistSelections").deleteOne({ token });
    interaction.queryOverride = selectedTrack.uri;
    try {
        const result = await require("../commands/play").execute(interaction, client);
        await interaction.message.edit({
            content: `Queued **${selectedTrack.title}** from **${selection.name || "the playlist"}**.`,
            components: [],
        });
        return result;
    } finally {
        delete interaction.queryOverride;
    }
}

module.exports = { createPlaylistSelection, handlePlaylistSelection, resolvePlaylistSelection };
