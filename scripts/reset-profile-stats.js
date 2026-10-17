#!/usr/bin/env node
require("dotenv").config();
const { connectToMongoDB, disconnectFromMongoDB, isDBConnected } = require("../src/utils/database");
const { resetAllProfileStats } = require("../src/utils/mongoStats");

async function main() {
    console.log("==================================================");
    console.log("  Musicify / Euphie - Reset Profile Statistics");
    console.log("==================================================");

    const args = process.argv.slice(2);
    let targetUserId = null;

    if (args.includes("--user")) {
        const idx = args.indexOf("--user");
        targetUserId = args[idx + 1];
        if (!targetUserId) {
            console.error("❌ Error: Missing user ID after --user");
            console.log("Usage: node scripts/reset-profile-stats.js [--all | --user <userId>]");
            process.exit(1);
        }
    } else if (args[0] && !args[0].startsWith("--")) {
        if (!["all", "everyone", "global", "*"].includes(args[0].toLowerCase())) {
            targetUserId = args[0];
        }
    }

    const scopeLabel = targetUserId ? `User ID ${targetUserId}` : "Everyone (All users & servers)";
    console.log(`[euphire] Target scope: ${scopeLabel}`);
    console.log("[euphire] Connecting to MongoDB...");

    try {
        await connectToMongoDB();
        if (!isDBConnected()) {
            throw new Error("Could not establish connection to MongoDB.");
        }

        console.log("[euphire] Resetting profile statistics collections...");
        const result = await resetAllProfileStats(targetUserId);

        console.log("\n==================================================");
        console.log("✅ Profile statistics successfully reset!");
        console.log("==================================================");
        console.log(`- Scope:                   ${result.scope}`);
        console.log(`- userStats cleared:       ${result.userStats}`);
        console.log(`- serverStats cleared:     ${result.serverStats}`);
        console.log(`- trackStats cleared:      ${result.trackStats}`);
        console.log(`- sharedListening cleared: ${result.sharedListening}`);
        console.log(`- activeSessions cleared:  ${result.activeSessions}`);
        console.log(`- sessionParticipants:     ${result.sessionParticipants}`);
        console.log("--------------------------------------------------");
        console.log("ℹ️  Preserved collections (untouched):");
        console.log("   • guildData (server prefixes, dj roles, 24/7 settings)");
        console.log("   • userData  (Last.fm logins and session keys)");
        console.log("   • sessions  (Bot DJ assignments across channels)");
        console.log("==================================================");
    } catch (err) {
        console.error("\n❌ Error resetting profile database:", err.message);
        process.exitCode = 1;
    } finally {
        await disconnectFromMongoDB().catch(() => {});
        process.exit(process.exitCode || 0);
    }
}

main();
