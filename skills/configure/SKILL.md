---
name: configure
description: Set up the Telegram channel — save the bot token and review access policy. Use when the user pastes a Telegram bot token, asks to configure Telegram, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(echo *)
  - Bash(chmod *)
  - Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli.ts status)
---

# /telegram-plus:configure — Telegram Channel Setup

Writes the bot token to `<state-dir>/.env` and orients the user on access
policy. The server reads `.env` at boot.

**Resolve the state directory first** (it may be overridden for multi-bot or
per-project setups):

```bash
echo "${TELEGRAM_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/telegram-plus}"
```

Use the printed path everywhere below in place of `<state-dir>`.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

1. **Token** — check `<state-dir>/.env` for `TELEGRAM_BOT_TOKEN`. Show
   set/not-set; if set, show only the numeric bot id before the colon
   (`123456789:…`). Never print the secret part.

2. **Access** — run `bun ${CLAUDE_PLUGIN_ROOT}/src/cli.ts status` and
   summarize: DM policy and what it means in one line, allowed senders,
   pending pairings.

3. **What next** — end with a concrete next step based on state:
   - No token → *"Run `/telegram-plus:configure <token>` with the token
     from BotFather."*
   - Token set, policy is pairing, nobody allowed → *"DM your bot on
     Telegram. It replies with a code; approve with
     `/telegram-plus:access pair <code>`."*
   - Token set, someone allowed → *"Ready. DM your bot to reach the
     assistant."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is a temporary way to capture Telegram user
IDs, not a policy to stay on.

1. Tell the user who's in the allowlist and ask: *"Is that everyone who
   should reach you through this bot?"*
2. **If yes and policy is still `pairing`** → offer to run
   `/telegram-plus:access policy allowlist`. Do this proactively.
3. **If people are missing** → *"Have them DM the bot; approve each with
   `/telegram-plus:access pair <code>`. Run this skill again once everyone's
   in and we'll lock it."*
4. **If the allowlist is empty** → *"DM your bot to capture your own ID
   first."*
5. **If policy is already `allowlist`** → confirm this is the locked state.
   To add someone: they send their numeric ID (via @userinfobot), or briefly
   flip to `pairing` → they DM → pair → flip back.

### `<token>` — save it

1. Treat `$ARGUMENTS` as the token (trim whitespace). BotFather tokens look
   like `123456789:AAH...` — numeric prefix, colon, long string. If it
   doesn't match `^\d+:[A-Za-z0-9_-]{30,}$`, say so and stop.
2. `mkdir -p` the resolved `<state-dir>`.
3. Read existing `.env` if present; update/add the `TELEGRAM_BOT_TOKEN=`
   line, preserve other keys. Write back, no quotes around the value.
4. `chmod 600 <state-dir>/.env` — the token is a credential.
5. Confirm, then show the no-args status.

### `clear` — remove the token

Delete the `TELEGRAM_BOT_TOKEN=` line (or the file if that's the only line).

---

## Notes

- Missing state dir or files = not configured yet, not an error.
- The server reads `.env` once at boot. Token changes need a session restart
  or `/reload-plugins`. Say so after saving.
- Access changes take effect immediately — no restart.
