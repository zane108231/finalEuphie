# MongoDB Setup Guide

## Why MongoDB?

The bot now uses MongoDB to store all persistent data:
- Voice channel sessions and DJ ownership
- Guild settings and queues
- Active playback tracks, queues, and positions for restart recovery
- Player state and preferences
- Statistics and tracking data

This ensures:
- Data survives bot restarts
- Low RAM usage (data stored in database, not memory)
- Easy backup and scaling
- Multi-server deployment support

## Getting a Free MongoDB Database

### Option 1: MongoDB Atlas (Recommended - Free)

1. Go to https://www.mongodb.com/atlas
2. Click "Try Free"
3. Create an account or sign in
4. Click "Build a Database"
5. Select "M0" (Free tier, 512MB storage)
6. Choose a region closest to your users
7. Name your cluster (e.g., "euphire")
8. Click "Create"

### Option 2: Render (Free)

1. Go to https://render.com
2. Create account
3. Click "New" → "PostgreSQL" or "MongoDB"
4. Follow setup instructions

### Option 3: Railway (Free)

1. Go to https://railway.app
2. Create account
3. Click "New Project" → "Provision MongoDB"
4. Follow setup instructions

## Getting Your Connection String

### For MongoDB Atlas:

1. After creating cluster, click "Connect"
2. Choose "Connect your application"
3. Select "Node.js" and version 4.1 or later
4. Copy the connection string (looks like):
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

5. Replace `<username>` and `<password>` with:
   - The database user you created
   - The password you set for that user

6. Add `/euphire` at the end to specify the database name:
   ```
   mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/euphire
   ```

## Configure Your Bot

1. Open your `.env` file
2. Add your MongoDB connection string:
   ```
   MONGODB_URI=mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/euphire
   ```

3. Make sure to:
   - Use your actual username and password
   - Keep the database name at the end (`/euphire`)
   - Don't share this file (it contains credentials)

## Whitelist Your IP (Atlas Only)

If using MongoDB Atlas:

1. Go to Network Access in Atlas
2. Click "Add IP Address"
3. Choose "Allow Access from Anywhere" (0.0.0.0/0)
   - Or add your server's specific IP
4. Click "Confirm"

## Restart Your Bot

```bash
npm start
```

You should see:
```
[euphire] Connected to MongoDB
```

## Troubleshooting

### "MongoServerError: bad auth"
- Check your username and password are correct
- Make sure you created a database user in Atlas

### "MongoTimeoutError"
- Check your IP is whitelisted in Atlas Network Access
- Check your internet connection

### "Authentication failed"
- Verify the connection string format
- Make sure you're using the correct database user

### "MongoNotConnectedError"
- Check MONGODB_URI is set in .env
- Verify the connection string is valid

## MongoDB Is Required

The bot will not start if it cannot connect to MongoDB. This prevents playback
sessions from silently falling back to temporary in-memory storage and being lost.
After a restart, active sessions are restored automatically. If automatic recovery
does not complete, the session owner can run `e!resume session` in the server.

Set `DEVELOPER_DISCORD_ID` in your `.env` to the bot developer's Discord user ID.
Only that user can run the hidden `e!update` command. It posts a maintenance notice,
saves active playback sessions to MongoDB, then requests a restart after two
minutes. The host must restart the process after it exits; Docker Compose already
uses `restart: unless-stopped`.

## Backup Your Data

MongoDB Atlas provides automatic backups for paid tiers.
For free tier, export manually:
```bash
mongodump --uri="mongodb+srv://username:password@cluster.mongodb.net/euphire" --out=./backup
```

Restore:
```bash
mongorestore --uri="mongodb+srv://username:password@cluster.mongodb.net/euphire" ./backup
```
