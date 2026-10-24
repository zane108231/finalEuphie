require("dotenv").config();

module.exports = {
    node: {
        host: "160.191.77.60",
        password: "zealooser",
        port: 6393,
        secure: false,
        name: "Main",
    },

    prefix: "e!",

    defaultSearchPlatform: "spsearch",
    restVersion: "v4",

    accentColor: 0x2b2d31,
    statusWebhookUrl: process.env.STATUS_WEBHOOK_URL,
    geniusApiKey: process.env.GENIUS_API_KEY || process.env.GENIUS_ACCESS_TOKEN || null,

    musicard: {
        theme: "Bloom",
        progressBarColor: "#FACC15",
        backgroundColor: "#2b2d31",
    },
};
