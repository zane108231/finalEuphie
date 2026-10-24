const { createPlaybackFeature } = require("../utils/playbackFeature");

module.exports = createPlaybackFeature({
    name: "albumsearch",
    description: "Search and queue an album",
    transformQuery: (query) =>
        /^https?:\/\//i.test(query) ? query : `album ${query}`,
});
