# Telegram Plus

Connect a Telegram bot to your Claude Code session with an MCP channel server.

Based on the official [`telegram` plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) (Apache-2.0), restructured into modules with tests, several security/reliability fixes, and richer inbound context. See [What's different](#whats-different-from-upstream).

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash` or `brew install oven-sh/bun/bun`.

## Quick setup

1. **Create a bot** — DM [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token (`123456789:AAH…`).
2. **Install the plugin** (from a local checkout):
   ```
   /plugin marketplace add /path/to/claude-telegram-plugin
   /plugin install telegram-plus@telegram-plus-dev
   ```
3. **Save the token:** `/telegram-plus:configure 123456789:AAH...`
   This writes `~/.claude/channels/telegram-plus/.env`. A shell `TELEGRAM_BOT_TOKEN` takes precedence.
4. **Relaunch with the channel flag:** `claude --channels plugin:telegram-plus@telegram-plus-dev`
5. **Pair** — DM your bot, it replies with a 6-char code; run `/telegram-plus:access pair <code>`.
6. **Lock it down:** `/telegram-plus:access policy allowlist`.

> Run multiple bots by pointing `TELEGRAM_STATE_DIR` at a different directory per instance.
> State lives in `channels/telegram-plus`, separate from the official plugin — don't run both on the same token (Telegram allows one poller per token).

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. `chat_id` + `text`, optional `thread_id` (forum topic), `reply_to`, `files` (photos/video/audio/documents, 50MB each), `format` (`text` / `html` / `markdownv2`). Auto-chunks; falls back to plain text if Telegram rejects the markup. |
| `react` | Emoji reaction from Telegram's fixed whitelist. |
| `edit_message` | Edit a message the bot sent (progress updates). |
| `download_attachment` | Fetch an inbound attachment by `attachment_file_id` into the inbox (≤20MB). |

## Inbound context

Each message arrives as a `<channel>` notification with meta including `chat_id`, `message_id`, `thread_id` (forum topics), `user`, `user_name`, `chat_type`, `chat_title`, `reply_to_text` / `reply_to_user` (quoted message), `forwarded_from`, `media_group_id` (albums), `edited`, and attachment fields. Photos and images sent as files are downloaded eagerly (`image_path`); other attachments on demand. Locations and contacts are forwarded as text.

The typing indicator stays on while Claude works (refreshed every 4s, up to 3 min or until the reply). Inbox files older than 7 days are cleaned up automatically.

## Access control

See [ACCESS.md](./ACCESS.md).

## Development

```sh
bun install
bun test          # unit tests
bun run typecheck # tsc --noEmit
```

```
server.ts            entry: MCP server, lifecycle, polling loop
src/access.ts        access.json store (locked read-modify-write)
src/lock.ts          cross-process mkdir lock
src/gate.ts          inbound gate + mention detection
src/inbound.ts       Telegram handlers → channel notifications, bot commands
src/tools.ts         MCP tool definitions + handlers
src/permissions.ts   permission-prompt relay
src/typing.ts        typing indicator keep-alive
src/text.ts          chunking, formatting fallback, sanitizers
src/files.ts         downloads, sendable check, inbox cleanup
src/cli.ts           access CLI used by the /access skill
```

## What's different from upstream

**Security fixes**
- Text permission replies (`yes abcde`) are only accepted from DM-allowlisted users in private chats. Upstream accepted them from any member of an allowlisted group.
- The access skill no longer rewrites `access.json` by hand. It calls a CLI that shares a lock with the server, so pairing codes can't be clobbered by a race.
- The pending-pairing cap is configurable (`maxPending`, default 10, up from 3), so a few strangers can't block legitimate pairing for an hour.

**Reliability**
- Permission prompts are tracked per message. When answered (button, text, or after a 30-min expiry), every copy is updated and the request is forgotten. Upstream leaked memory and left stale buttons.
- Photo downloads check the HTTP status and sanitize the extension. A failed download still passes `attachment_file_id` so Claude can retry.
- Chunking never splits emoji. A parse error in `html`/`markdownv2` falls back to plain text instead of failing mid-reply.
- A persistent 409 keeps retrying slowly instead of leaving the bot permanently deaf. A 401 (bad token) stops with a clear message.
- Size is checked before download, and the inbox is cleaned up.
- `zod` is declared explicitly, plus a tsconfig and tests.
- Permission-reply ack uses 👍/👎. Upstream's ✅/❌ aren't in Telegram's reaction whitelist and silently failed.

**Features**
- Forum topics (`thread_id` in and out)
- Reply/quote context, forwarded-from, edited messages, albums, locations, contacts
- `html` format
- Video and audio file sending
- Persistent typing indicator
