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

## How it fits together

```
Telegram ⇄ hub (one per bot: polls, routes, relays approvals; unix socket in the state dir)
             ⇅ channel session "api"  (bin/claude-telegram in ~/code/api)
             ⇅ channel session "web"  (bin/claude-telegram in ~/code/web)
             ⇐ hooks from any other session: notifications + approvals
```

- **The hub** (`hub.ts`) is the only process that talks to Telegram's `getUpdates`, so any number of sessions can share one bot without 409 conflicts. It starts automatically the first time something needs it and exits after 10 minutes with nothing connected. Log: `<state-dir>/hub.log`.
- **Channel sessions** are started with `bin/claude-telegram`. Each registers with the hub under its project folder name (override with `TELEGRAM_PLUS_NAME=...`).
- **Every other session** with the plugin enabled is tools-only, and gets notifications and Telegram approvals through hooks.

## Multiple sessions

With several channel sessions connected, the hub decides where each message goes:

1. A **reply** to a message a session sent goes back to that session.
2. Otherwise it goes to the chat's **active** session: `/use api`, or tap one under `/sessions`.
3. With only **one** session connected, it goes there.
4. Otherwise the hub holds the message and asks *"Which session should get this?"* with a button per session.

Replies are prefixed with the session name (`[api] …`) whenever more than one is connected.

## Forum topics: one topic per project

Instead of switching with `/use`, give every project its own topic in a Telegram forum group:

```
Group "Claude" (Topics on)
├─ api      ← talk to the api session; its approvals and notices land here
├─ web      ← same for web
└─ General  ← /sessions, picker, everything else
```

Setup:

1. Create a group, turn on **Topics** (Group settings → Topics), add the bot and make it an **admin with "Manage Topics"**.
2. In @BotFather: `/setprivacy` → your bot → **Disable** (so the bot sees every message in the topics), then remove and re-add the bot to the group.
3. Get the group id (`-100…`). In [Telegram Web](https://web.telegram.org/a) it's in the URL after `#`. In Telegram Desktop, enable Settings → Advanced → Experimental → "Show Peer IDs in Profile".
4. In Claude Code:
   ```
   /telegram-plus:access group add -100XXXXXXXXXX --no-mention --allow <your-telegram-id>
   /telegram-plus:access set topicsGroup -100XXXXXXXXXX
   ```

What happens:

- When a channel session connects, the hub creates a topic named after it, or reuses the existing one (`<state-dir>/topics.json`). Messages in that topic always go to that session. If it isn't running, the bot says so.
- Approval prompts and notices from any session (including `claude --bg` workers and worktrees) go to their project's topic, created on first use. Only allowlisted users can tap Allow/Deny there.
- Replies in a session's own topic skip the `[name]` prefix.
- If the bot can't create topics (no admin rights, Topics off), it logs why in `hub.log` and falls back to DMs. A topic deleted in Telegram is recreated on next use.

Everyone in the group can read what's posted there, including approval prompts with command previews. Keep the topics group to yourself or people you trust.

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

## Notifications and approvals from any session

The plugin ships [hooks](https://code.claude.com/docs/en/hooks) that work in every session where it's enabled, not only channel sessions.

**Approvals.** When a session (other than a channel session, which uses Claude Code's native relay) hits a permission prompt, allowlisted users get `🔐 [project] Permission: Bash` with **See more / Allow / Deny** buttons in their DM. The terminal dialog stays open at the same time, and whichever answer comes first wins. If you answer at the terminal, the Telegram prompt closes when the turn ends. With no answer within `approvalTimeoutSeconds` (default 300), the decision is left to the terminal.

```
/telegram-plus:access set approvals off                 # notify only, no buttons
/telegram-plus:access set approvalTimeoutSeconds 120
```

**Notifications** go to every allowlisted user when a session outside the channel session:

- needs attention: a permission prompt, a question, or idle waiting for input (`🔐` / `⏳`)
- finished a turn that took at least `notifyStopAfterSeconds` (default 60s), with the start of Claude's last message (`✅`)

The channel session itself is skipped, since there Claude already talks to you on Telegram. Notification hooks run async and never block Claude. With approvals on, the approval prompt replaces the plain "needs permission" notice.

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
bun test          # unit + hub integration tests (fake Bot API)
bun run typecheck # tsc --noEmit
```

`@modelcontextprotocol/sdk` is pinned to an exact version on purpose: Claude Code doesn't register a channel server that negotiates MCP protocol revision `2026-07-28`. The pinned SDK negotiates `2025-11-25`. Check the protocol version before bumping it.

```
hub.ts               the hub: polling, routing, approvals, local API
server.ts            MCP server: hub client (channel) or direct tools-only
src/hub/router.ts    which session gets a message
src/hub/client.ts    hub socket, auto-start, wire types
src/topics.ts        forum topic per project (topics.json)
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
hooks/               hooks.json, notify.ts, permission.ts
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
- Several sessions on one bot through the hub, with `/sessions`, `/use` and reply-based routing
- One forum topic per project: routing, approvals and notices per topic
- Approve permission prompts from Telegram for any session, not just the channel one
- Notification hooks: Telegram ping when any other session needs attention or finishes a long turn
- Forum topics (`thread_id` in and out)
- Reply/quote context, forwarded-from, edited messages, albums, locations, contacts
- Choice buttons for Claude (`buttons` on `reply` / `edit_message`)
- `html` format
- Video and audio file sending
- Persistent typing indicator
