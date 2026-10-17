# Multi-Bot Music System Implementation

## Overview

This implementation adds a Jockie Music-style multi-bot system to Euphie, allowing 4 separate Discord bot identities to work together as a coordinated music system.

## Architecture

### Bot Coordinator (`src/utils/botCoordinator.js`)

The core of the multi-bot system is the Bot Coordinator, which manages:

- **4 Discord Bot Clients**: Euphie, Euphie (1), Euphie (2), Euphie (3)
- **Session Ownership**: Maps voice channels to bot IDs
- **Bot Availability**: Tracks which bots are available, reserved, or active
- **Atomic Allocation**: Prevents race conditions when allocating bots
- **Bot Priority**: Secondary bots (1, 2, 3) are prioritized over the primary bot for music sessions

### Key Features

1. **Automatic Bot Allocation**: When a user runs `e!play`, the system automatically assigns the next available bot to that voice channel
2. **Session Ownership**: Once a bot joins a voice channel, all subsequent music commands for that session are routed to that same bot
3. **No Duplicate Responses**: Only the assigned bot responds to commands; other bots remain silent
4. **Independent Sessions**: Each bot has its own player and queue; actions in one session don't affect others
5. **Automatic Cleanup**: Bots are released when sessions end (stop, queue end, disconnect, etc.)

## Files Changed

### New Files

1. **`src/utils/botCoordinator.js`** - Core coordinator module for session management and bot allocation

### Modified Files

1. **`src/index.js`** - Initializes 4 Discord clients with shared Riffy infrastructure
2. **`src/handlers/commandHandler.js`** - Added command routing to prevent duplicate responses
3. **`src/events/interactionCreate.js`** - Added slash command routing
4. **`src/commands/play.js`** - Added bot reservation and session ownership logic
5. **`src/commands/stop.js`** - Added bot release on stop
6. **`src/commands/queue.js`** - Updated to use session owner's Riffy instance
7. **`src/commands/nowplaying.js`** - Updated to use session owner's Riffy instance
8. **`src/commands/insert.js`** - Updated to use session owner's Riffy instance
9. **`src/commands/247.js`** - Updated to use session owner's Riffy instance
10. **`src/utils/permissions.js`** - Updated `requireMusicAction` to use session owner's Riffy
11. **`src/handlers/playerHandler.js`** - Added bot release on player disconnect and queue end
12. **`src/handlers/buttonHandler.js`** - Updated to use session owner's Riffy and release on stop
13. **`src/events/voiceStateUpdate.js`** - Added bot release on voice disconnect
14. **`.env.example`** - Added environment variable configuration for 4 bot tokens

## Environment Variables

You need to configure the following environment variables in your `.env` file:

```env
# Primary Bot Token (Euphie)
BOT_TOKEN=your_bot_token_here

# Secondary Bot Tokens (Euphie (1), Euphie (2), Euphie (3))
BOT_1_TOKEN=your_bot_1_token_here
BOT_2_TOKEN=your_bot_2_token_here
BOT_3_TOKEN=your_bot_3_token_here

# Discord Client ID (for slash command deployment)
CLIENT_ID=your_client_id_here

# Status Webhook URL (optional)
STATUS_WEBHOOK_URL=your_status_webhook_url_here
```

### Getting Bot Tokens

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create 4 separate applications:
   - Euphie (Primary)
   - Euphie (1)
   - Euphie (2)
   - Euphie (3)
3. For each application:
   - Enable the "Bot" feature
   - Copy the bot token
   - Set the appropriate intents (Guilds, Guild Messages, Guild Voice States, Message Content)
   - Invite the bot to your server with the necessary permissions

## Bot Priority Order

The system allocates bots in the following priority order:

1. **Euphie (1)** - First to be allocated for new sessions
2. **Euphie (2)** - Second priority
3. **Euphie (3)** - Third priority
4. **Euphie** (Primary) - Last resort for music, but handles all general commands

## Command Routing

### General Commands

Commands like `e!help`, `e!prefix`, `e!about`, etc. are handled by the primary Euphie bot only.

### Music Commands

Music commands are routed to the bot that owns the session:

- If a session exists for the voice channel, the owner bot handles the command
- If no session exists, the primary bot coordinates allocation
- Once allocated, only the assigned bot responds to that session's commands

## Session Lifecycle

### Session Creation

1. User runs `e!play <song>` in a voice channel
2. System checks if a session already exists for that channel
3. If no session, the coordinator reserves the next available bot
4. The reserved bot joins the voice channel and starts playback
5. The bot is marked as the session owner

### Session Usage

1. All subsequent music commands (`e!skip`, `e!pause`, `e!queue`, etc.) are routed to the session owner
2. Other bots remain silent for these commands
3. The owner bot's Riffy instance handles all player operations

### Session Termination

A session ends and the bot is released when:

- User runs `e!stop`
- Queue completes naturally
- Bot is manually disconnected
- Voice channel becomes empty (if not in 24/7 mode)
- Player disconnects from Lavalink
- Bot crashes or is restarted

## Testing

### Manual Testing Scenarios

1. **First Session**: Run `e!play <song>` in Voice Channel A → Euphie (1) should join
2. **Second Session**: While Euphie (1) is playing, run `e!play <song>` in Voice Channel B → Euphie (2) should join
3. **Third Session**: With two bots occupied, start a third session → Euphie (3) should join
4. **Fourth Session**: With three bots occupied, start a fourth session → Euphie should join
5. **Session Controls**: Run `e!skip`, `e!pause`, `e!queue` in each session → Only the correct bot should respond
6. **General Commands**: Run `e!help` → Only Euphie should respond
7. **Session Cleanup**: Stop a session → Bot should become available for new sessions

### Expected Behavior

- ✅ Only one bot responds to each command
- ✅ Bots don't interrupt each other's sessions
- ✅ Queues are isolated between sessions
- ✅ Bots become available after sessions end
- ✅ No duplicate messages or responses

## Troubleshooting

### All bots respond to commands

This should not happen with the new routing system. If it does:
- Check that `coordinator.shouldHandleCommand()` is being called in command handlers
- Verify that bot IDs are correctly set on each client

### Bot doesn't release after session ends

Check the following:
- Ensure `coordinator.releaseBot()` is called in:
  - `stop.js` command
  - `playerHandler.js` queueEnd and playerDisconnect events
  - `voiceStateUpdate.js` disconnect handler
  - `buttonHandler.js` stop button

### Commands fail with "No active player"

This may happen if:
- The command is being handled by the wrong bot
- The session owner's Riffy instance is not being used
- Check that `requireMusicAction()` uses the session owner's Riffy

### Race conditions in bot allocation

The coordinator uses a simple spinlock for atomic allocation. For production use with high traffic, consider:
- Using a proper async locking library (like `async-mutex`)
- Implementing a reservation queue for when all bots are occupied

## Resource Considerations

Running 4 Discord clients increases:
- **Memory Usage**: Approximately 4x the memory of a single bot
- **API Rate Limits**: Each bot has its own rate limit bucket (generally positive)
- **WebSocket Connections**: 4 concurrent connections to Discord

The system is designed to share a single Lavalink server, so no additional infrastructure is needed there.

## Future Enhancements

Potential improvements for the multi-bot system:

1. **Redis Coordination**: If running across multiple processes/servers, use Redis for shared state
2. **Dynamic Bot Pool**: Add/remove bots dynamically without code changes
3. **Load Balancing**: Distribute sessions based on bot load, not just availability
4. **Bot Health Monitoring**: Automatically mark disconnected bots as unavailable
5. **Reservation Queue**: Queue requests when all bots are occupied instead of rejecting them

## Summary

This implementation provides a complete, working multi-bot music system that:

- ✅ Supports 4 separate Discord bot identities
- ✅ Shares one codebase and configuration
- ✅ Automatically allocates bots to new sessions
- ✅ Routes commands to the correct session owner
- ✅ Prevents duplicate responses
- ✅ Isolates queues and players between sessions
- ✅ Releases bots when sessions end
- ✅ Preserves all existing Euphie functionality
