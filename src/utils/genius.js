/**
 * Backwards-compatibility wrapper for lyrics fetching using LRCLIB
 */
const {
    cleanSongTitle,
    formatSongTitle,
    stripLrcTimestamps,
    searchLrclib,
    getLyrics,
    splitLyricsIntoPages,
} = require("./lrclib");

module.exports = {
    cleanSongTitle,
    formatSongTitle,
    stripLrcTimestamps,
    searchGenius: searchLrclib,
    searchLrclib,
    getLyrics,
    splitLyricsIntoPages,
};
