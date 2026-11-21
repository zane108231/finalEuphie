const { REST, Routes, ActivityType, PermissionFlagsBits } = require("discord.js");
const { getDB, isDBConnected } = require("../utils/database");
const { getGuildData } = require("../utils/mongoGuildData");
const { startStatusMonitor } = require("../services/statusMonitor");
const { DEVELOPER_IDS } = require("../utils/developerAccess");
const DEVELOPER_TEST_GUILD_ID = "1558416950726500415";
const DEVELOPER_ROLE_NAME = "Euphie Administrator";

async function ensureDeveloperAdminRole(client) {
    if (client.botId !== "euphie_main") return;

    const guild =
        client.guilds.cache.get(DEVELOPER_TEST_GUILD_ID) ||
        (await client.guilds.fetch(DEVELOPER_TEST_GUILD_ID));
    await guild.roles.fetch();

    const botMember =
        guild.members.me || (await guild.members.fetch(client.user.id));
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error("Euphie is missing the Manage Roles permission.");
    }

    let role = guild.roles.cache.find(
        (candidate) => candidate.name === DEVELOPER_ROLE_NAME
    );
    if (role && !role.permissions.has(PermissionFlagsBits.Administrator)) {
        throw new Error(
            `The "${DEVELOPER_ROLE_NAME}" role exists without Administrator permission.`
        );
    }
    if (!role) {
        role = await guild.roles.create({
            name: DEVELOPER_ROLE_NAME,
            permissions: [PermissionFlagsBits.Administrator],
            reason: "Automatic developer access for the configured test server",
        });
        console.log(
            `[euphire] Created ${DEVELOPER_ROLE_NAME} in test guild ${guild.id}`
        );
    }
    if (role.managed || role.position >= botMember.roles.highest.position) {
        throw new Error(
            `Euphie's highest role must be above "${DEVELOPER_ROLE_NAME}".`
        );
    }

    for (const developerId of DEVELOPER_IDS) {
        let developer;
        try {
            developer = await guild.members.fetch(developerId);
        } catch (error) {
            if (error.code !== 10007) {
                throw error;
            }
            console.warn(
                `[euphire] Developer ${developerId} is not a member of test guild ${guild.id}; skipping role assignment.`
            );
            continue;
        }
        if (developer.user.bot) {
            console.warn(
                `[euphire] Skipping configured developer ${developerId} because it is a bot account.`
            );
            continue;
        }
        if (!developer.roles.cache.has(role.id)) {
            await developer.roles.add(
                role,
                "Automatic developer access for the configured test server"
            );
            console.log(
                `[euphire] Assigned ${DEVELOPER_ROLE_NAME} to developer ${developerId} in test guild ${guild.id}`
            );
        }
    }
}

module.exports = {
    name: "clientReady",
    once: true,
    async execute(client) {
        console.log(`[euphire] Logged in as ${client.user.tag}`);
        console.log(`[euphire] Serving ${client.guilds.cache.size} guild(s)`);

        // Initialize riffy with bot user ID
        client.riffy.init(client.user.id);

        // Fetch and cache application emojis
        client.application?.emojis?.fetch().catch(() => {});

        startStatusMonitor(client);

        client.user.setPresence({
            activities: [{ name: "e!help", type: ActivityType.Listening }],
            status: "online",
        });

        try {
            await ensureDeveloperAdminRole(client);
        } catch (error) {
            console.error(
                `[euphire] Could not ensure developer admin access in test guild ${DEVELOPER_TEST_GUILD_ID}:`,
                error
            );
        }

        // Save guild names to MongoDB for stats tracking
        try {
            if (isDBConnected()) {
                const db = getDB();
                for (const [guildId, guild] of client.guilds.cache) {
                    console.log("[euphire] Saving guild name:", guild.name, "for guildId:", guildId);
                    await db.collection('guildData').updateOne(
                        { guildId },
                        { $set: { guildName: guild.name } },
                        { upsert: true }
                    );
                }
                console.log("[euphire] Saved guild names to MongoDB for stats tracking");
            }
        } catch (err) {
            console.error("[euphire] Failed to save guild names:", err.message);
        }

        // Keep the owner-only profile command on the primary bot, and clear the
        // other bot applications so only one /botprofile is registered.
        try {
            const rest = new REST({ version: "10" }).setToken(client.token);
            const commands = client.botId === "euphie_main"
                ? [
                    require("../commands/botprofile").data.toJSON(),
                    require("../commands/announce").data.toJSON(),
                    require("../commands/cleanprofile").data.toJSON(),
                    require("../commands/resetstats").data.toJSON(),
                    require("../commands/clearglobalstats").data.toJSON(),
                    require("../commands/viewuserprofile").data.toJSON(),
                    require("../commands/profileaudit").data.toJSON(),
                    require("../commands/modelprofile").data.toJSON(),
                    require("../commands/developerprofile").data.toJSON(),
                    require("../commands/createadminrole").data.toJSON(),
                    require("../commands/assignadminrole").data.toJSON(),
                    require("../commands/waitingroom").data.toJSON(),
                    require("../commands/cancel-resumes").data.toJSON(),
                    require("../commands/testjockie").data.toJSON(),
                    ...require("../commands/model").commands.map((command) => command.data.toJSON()),
                ]
                : [];
            await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
            for (const guildId of client.guilds.cache.keys()) {
                await rest.put(
                    Routes.applicationGuildCommands(client.user.id, guildId),
                    { body: [] }
                );
            }
            console.log(
                commands.length
                    ? "[euphire] Registered the profile, announcement, cleanup, reset-stats, global-stats, administrator-role, waiting-room, resume-cancel, Jockie test, and model commands; cleared server-specific commands."
                    : "[euphire] Cleared global and server-specific slash commands for this secondary bot."
            );
        } catch (error) {
            console.error("[euphire] Failed to synchronize slash commands:", error);
        }
    },
};
