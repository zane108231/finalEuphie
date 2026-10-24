const { createPlaybackFeature } = require("../utils/playbackFeature");

module.exports = createPlaybackFeature({
    name: "radio",
    description: "Search and play from a radio station",
    transformQuery: (query) =>
        /^https?:\/\//i.test(query) ? query : `radio ${query}`,
});
