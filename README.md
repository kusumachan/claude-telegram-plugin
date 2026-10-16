# Telegram Plus

Connect a Telegram bot to your Claude Code session with an MCP channel server.

Based on the official [`telegram` plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) (Apache-2.0), restructured into modules with tests, several security/reliability fixes, and richer inbound context. See [What's different](#whats-different-from-upstream).

## Prerequisites

- Claude Code signed in with a claude.ai account or a Console API key (channels aren't available on Bedrock, Vertex, or Foundry). Team/Enterprise orgs must enable channels first.
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
4. **Start a channel session with the launcher:**
   ```sh
   /path/to/claude-telegram-plugin/bin/claude-telegram
   ```
   It runs `claude --dangerously-load-development-channels plugin:telegram-plus@telegram-plus-dev` and marks that one session as the channel. Extra arguments pass through to `claude`; set `TELEGRAM_PLUS_PLUGIN` if you installed from a different marketplace. Tip: `alias claude-tg=/path/to/claude-telegram-plugin/bin/claude-telegram`.

   Why a launcher: channels are a research preview and `--channels` only accepts Anthropic-allowlisted plugins, so this plugin needs the development flag (interactive sessions only; it's ignored with `-p` and the Agent SDK). On top of that, Claude Code starts the plugin's MCP server in **every** session where the plugin is enabled and gives it no way to tell whether that session registered it as a channel. Without the launcher's marker every session would poll the bot and evict the others. Sessions not started via the launcher run tools-only: no polling, but notification hooks still work (see below).
5. **Pair** — DM your bot, it replies with a 6-char code; run `/telegram-plus:access pair <code>`.
6. **Lock it down:** `/telegram-plus:access policy allowlist`.

> Run multiple bots by pointing `TELEGRAM_STATE_DIR` at a different directory per instance.
> State lives in `channels/telegram-plus`, separate from the official plugin — don't run both on the same token (Telegram allows one poller per token).

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. `chat_id` + `text`, optional `thread_id` (forum topic), `reply_to`, `files` (photos/video/audio/documents, 50MB each), `format` (`text` / `html` / `markdownv2`), `buttons` (choice buttons). Auto-chunks; falls back to plain text if Telegram rejects the markup. |
| `react` | Emoji reaction from Telegram's fixed whitelist. |
| `edit_message` | Edit a message the bot sent (progress updates). Optional `buttons` replaces the keyboard; `[]` removes it. |
| `download_attachment` | Fetch an inbound attachment by `attachment_file_id` into the inbox (≤20MB). |

## Choice buttons

Claude can attach inline buttons to a reply instead of asking the user to type:

```json
{ "chat_id": "412587349", "text": "Deploy to production?", "buttons": [["Yes", "No"], [{ "text": "Changelog", "url": "https://example.com" }]] }
```

Tapping a label button sends it back to Claude as a new message (content = label, meta `button_choice`). The keyboard is then removed and the choice is appended under the question, so each prompt is single-use. Only people who could message the bot can tap: allowlisted users in DMs, and members of enabled groups (respecting the group's `allowFrom`). Labels are read back from the message itself, so buttons keep working across server restarts.

## Inbound context

Each message arrives as a `<channel>` notification with meta including `chat_id`, `message_id`, `thread_id` (forum topics), `user`, `user_name`, `chat_type`, `chat_title`, `reply_to_text` / `reply_to_user` (quoted message), `forwarded_from`, `media_group_id` (albums), `edited`, and attachment fields. Photos and images sent as files are downloaded eagerly (`image_path`); other attachments on demand. Locations and contacts are forwarded as text.

The typing indicator stays on while Claude works (refreshed every 4s, up to 3 min or until the reply). Inbox files older than 7 days are cleaned up automatically.

## Notifications from any session

The plugin ships [hooks](https://code.claude.com/docs/en/hooks) that message every allowlisted user when a session **outside** the channel session:

- needs attention: a permission prompt, a question, or idle waiting for input (`🔐` / `⏳`)
- finished a turn that took at least `notifyStopAfterSeconds` (default 60s), with the start of Claude's last message (`✅`)

The channel session itself is skipped, since there Claude already talks to you on Telegram. Hooks run async and never block Claude. Approving a permission from Telegram for these sessions isn't supported yet; that needs the multi-session hub. For now you're told the session is waiting.

```
/telegram-plus:access set notify off                  # disable
/telegram-plus:access set notifyStopAfterSeconds 300  # only turns ≥ 5 min (0 = every turn)
/telegram-plus:access set notifyPreview off           # don't include Claude's message text
```

In `-p` (headless) runs Claude Code cancels async hooks at teardown, so a "finished" notice may not arrive.

## Access control

See [ACCESS.md](./ACCESS.md).

## Development

```sh
bun install
bun test          # unit tests
bun run typecheck # tsc --noEmit
```

`@modelcontextprotocol/sdk` is pinned to an exact version on purpose: Claude Code doesn't register a channel server that negotiates MCP protocol revision `2026-07-28`. The pinned SDK negotiates `2025-11-25`. Check the protocol version before bumping it.

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
src/buttons.ts       choice-button keyboards + tap resolution
src/files.ts         downloads, sendable check, inbox cleanup
src/cli.ts           access CLI used by the /access skill
src/channel-mode.ts  detects the launcher-started channel session
src/notify.ts        notification-hook decisions
hooks/               hooks.json + notify.ts entry point
bin/claude-telegram  launcher for the channel session
```

## What's different from upstream

**Security fixes**
- Text permission replies (`yes abcde`) are only accepted from DM-allowlisted users in private chats. Upstream accepted them from any member of an allowlisted group.
- The access skill no longer rewrites `access.json` by hand. It calls a CLI that shares a lock with the server, so pairing codes can't be clobbered by a race.
- The pending-pairing cap is configurable (`maxPending`, default 10, up from 3), so a few strangers can't block legitimate pairing for an hour.

**Reliability**
- Only the launcher-started session polls Telegram. Upstream's MCP server polls in every session where the plugin is enabled, and each new session kills the previous session's poller. Verified: Claude Code starts the server, with identical env and handshake, whether or not the session registered it as a channel.
- Permission prompts are tracked per message. When answered (button, text, or after a 30-min expiry), every copy is updated and the request is forgotten. Upstream leaked memory and left stale buttons.
- Photo downloads check the HTTP status and sanitize the extension. A failed download still passes `attachment_file_id` so Claude can retry.
- Chunking never splits emoji. A parse error in `html`/`markdownv2` falls back to plain text instead of failing mid-reply.
- A persistent 409 keeps retrying slowly instead of leaving the bot permanently deaf. A 401 (bad token) stops with a clear message.
- Size is checked before download, and the inbox is cleaned up.
- `zod` is declared explicitly, plus a tsconfig and tests.
- Permission-reply ack uses 👍/👎. Upstream's ✅/❌ aren't in Telegram's reaction whitelist and silently failed.

**Features**
- Notification hooks: Telegram ping when any other session needs attention or finishes a long turn
- Forum topics (`thread_id` in and out)
- Reply/quote context, forwarded-from, edited messages, albums, locations, contacts
- Choice buttons for Claude (`buttons` on `reply` / `edit_message`)
- `html` format
- Video and audio file sending
- Persistent typing indicator
