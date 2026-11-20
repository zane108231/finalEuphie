const DEVELOPER_IDS = Object.freeze([
    "766135407590244383",
    "1226011055201845340",
]);

const developerIdSet = new Set(DEVELOPER_IDS);

function isDeveloper(userId) {
    return developerIdSet.has(String(userId || ""));
}

module.exports = {
    DEVELOPER_IDS,
    isDeveloper,
};
