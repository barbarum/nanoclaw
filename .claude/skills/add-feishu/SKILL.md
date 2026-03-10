---
name: add-feishu
description: Add Feishu (Lark) as a channel. Supports both Feishu (China) and Lark (International) platforms.
---

# Add Feishu (Lark) Channel

This skill adds Feishu/Lark support to NanoClaw. It creates the Feishu channel code, guides through app creation, authentication, registration, and configuration.

## Phase 1: Pre-flight

### Check current state

Check if Feishu is already configured:

```bash
grep -q "FEISHU_APP_ID" .env && echo "Feishu configured" || echo "No Feishu config"
```

If Feishu is already configured, skip to Phase 4 (Registration) or Phase 5 (Verify).

### Platform selection

AskUserQuestion: Which Feishu platform do you use?
- **Feishu (China)** - 飞书, for mainland China users (open.feishu.cn)
- **Lark (International)** - For users outside China (open.larksuite.com)

## Phase 2: Create Feishu/Lark App

### Guide user to create the app

Tell the user:

> **Create a Feishu/Lark Developer App**
>
> 1. Go to the developer portal:
>    - **Feishu (China)**: https://open.feishu.cn/app
>    - **Lark (International)**: https://open.larksuite.com/app
>
> 2. Click **Create App** → Select **自建应用** (Custom App)
> 3. Give your app a name (e.g., "NanoClaw Assistant")
> 4. After creation, you'll see **App ID** and **App Secret** on the app page
>
> 5. Go to **应用功能** → **机器人** (Bot) and enable bot features
> 6. Go to **权限管理** (Permissions) and add these scopes:
>    - `im:message` - Send and receive messages
>    - `im:chat` - Access chat information
>    - `contact:contact` - Read user info (optional, for names)
>
> 7. Go to **事件订阅** (Event Subscription) and note:
>    - You'll need the **Verification Token**
>    - If using encryption, note the **Encrypt Key**

AskUserQuestion: Do you have your App ID and App Secret ready?
- Yes, I have them
- Need help finding them

### Collect credentials

AskUserQuestion: What is your App ID?
(text input)

AskUserQuestion: What is your App Secret?
(text input, sensitive)

AskUserQuestion (optional): What is the Verification Token? (for event verification, can skip for polling mode)
(text input)

### Write to .env

```bash
# Backup existing .env
cp .env .env.backup

# Add Feishu credentials
cat >> .env << EOF

# Feishu/Lark Channel
FEISHU_APP_ID=<app-id>
FEISHU_APP_SECRET=<app-secret>
FEISHU_VERIFICATION_TOKEN=<verification-token>  # optional
FEISHU_PLATFORM=<feishu|lark>
EOF
```

## Phase 3: Apply Code Changes

### Check if Feishu channel exists

```bash
ls src/channels/feishu.ts && echo "Feishu channel exists" || echo "Need to add Feishu channel"
```

If the channel file doesn't exist, it needs to be created. The Feishu channel implementation should include:
- `src/channels/feishu.ts` - FeishuChannel class with self-registration
- `src/channels/feishu.test.ts` - Unit tests
- Import in `src/channels/index.ts`

### Install dependencies and build

```bash
npm install
npm run build
```

Validate the build succeeds before proceeding.

## Phase 4: Registration

### Get bot and chat information

AskUserQuestion: How do you want to chat with the assistant?
- **Direct message** - One-on-one chat with the bot
- **Group chat** - Add bot to an existing or new group

**For Direct Message:**
- The chat ID (JID) will be the bot's chat with you
- You can find it by sending a message to the bot and checking logs

**For Group Chat:**
1. Add the bot to your group in Feishu/Lark
2. Get the Group Chat ID from the group settings or URL

AskUserQuestion: What is the Chat ID (JID)?
- For groups: starts with `oc_` followed by numbers
- For DM: will be discovered automatically

AskUserQuestion: What trigger word should activate the assistant?
- **@Andy** - Default trigger
- **@Claw** - Short and easy
- **@Assistant** - Generic name
- **@<custom>** - Your choice

AskUserQuestion: What should the assistant call itself?
- **Andy** - Default name
- **Claw** - Short name
- **<custom>** - Your choice

### Register the chat

```bash
npx tsx setup/index.ts --step register \
  --jid "<chat-id>" \
  --name "<chat-name>" \
  --trigger "@<trigger>" \
  --folder "feishu_main" \
  --channel feishu \
  --assistant-name "<name>" \
  --is-main \
  --no-trigger-required  # Only for main/DM
```

For additional groups (trigger-required):

```bash
npx tsx setup/index.ts --step register \
  --jid "<group-jid>" \
  --name "<group-name>" \
  --trigger "@<trigger>" \
  --folder "feishu_<group-name>" \
  --channel feishu
```

## Phase 5: Verify

### Build and restart

```bash
npm run build
```

Restart the service:

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw
```

### Test the connection

Tell the user:

> Send a message to your Feishu/Lark chat:
> - For DM/main: Any message works
> - For groups: Use the trigger word (e.g., "@Andy hello")
>
> The assistant should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Invalid access token

Ensure App ID and App Secret are correct. Check that the app has the required permissions:
- `im:message` for messaging
- `im:chat` for chat access

### Bot not receiving messages

For event-based receiving (advanced):
1. Configure the event subscription URL in the developer portal
2. Handle the verification request with your Verification Token

For polling (default):
- The channel polls every 2 seconds for new messages
- Check `FEISHU_POLL_INTERVAL` env var to adjust

### Permission denied

Make sure the bot is added to the group/chat and has the necessary permissions:
- Group owner may need to enable bot messages
- Some enterprise domains restrict third-party apps

### Build errors

If TypeScript compilation fails:
```bash
rm -rf node_modules dist
npm install
npm run build
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `FEISHU_APP_ID` | App ID from developer portal | Yes |
| `FEISHU_APP_SECRET` | App Secret from developer portal | Yes |
| `FEISHU_VERIFICATION_TOKEN` | For event verification | No |
| `FEISHU_ENCRYPT_KEY` | For message encryption | No |
| `FEISHU_PLATFORM` | `feishu` (China) or `lark` (International) | No (auto) |
| `FEISHU_POLL_INTERVAL` | Message polling interval in ms | No (2000) |

## Removal

To remove Feishu integration:

1. Remove credentials from `.env`:
   ```bash
   # Edit .env and remove FEISHU_* lines
   ```

2. Remove Feishu registrations:
   ```bash
   sqlite3 store/messages.db "DELETE FROM registered_groups WHERE channel='feishu'"
   ```

3. Rebuild and restart:
   ```bash
   npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
