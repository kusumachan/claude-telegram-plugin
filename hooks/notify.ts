#!/usr/bin/env bun
/**
 * Hook entry point: reads the hook input JSON from stdin and, when warranted,
 * sends a short Telegram message to every allowlisted user.
 *
 * Runs as an async hook, so it never blocks Claude. It must never fail
 * loudly either: any problem (no token, Telegram down) is logged to stderr
 * and the hook exits 0.
 */
import { AccessStore } from '../src/access.ts'
import { loadEnvFile, STATE_DIR } from '../src/config.ts'
import {
  decide,
  type HookInput,
  notifyEnabled,
  pruneSessionState,
  readSessionState,
  writeSessionState,
} from '../src/notify.ts'
import { isChannelSession } from '../src/channel-mode.ts'

const SEND_TIMEOUT_MS = 10_000
// Overridable for end-to-end tests against a local fake Bot API.
const API_ROOT = process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org'

async function main(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text()) as HookInput
  if (!input.session_id) return

  // The channel session already talks over Telegram (and relays permission
  // prompts natively), so a hook message there would be a duplicate.
  if (isChannelSession()) return

  loadEnvFile()
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return

  const access = new AccessStore(STATE_DIR, process.env.TELEGRAM_ACCESS_MODE === 'static').load()
  if (!notifyEnabled(access)) return

  const state = readSessionState(STATE_DIR, input.session_id)
  const decision = decide(input, access, state)
  if (decision.state) writeSessionState(STATE_DIR, input.session_id, decision.state)
  if (input.hook_event_name === 'UserPromptSubmit') pruneSessionState(STATE_DIR)
  if (!decision.send) return

  await Promise.all(access.allowFrom.map(async chatId => {
    try {
      const res = await fetch(`${API_ROOT}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: decision.text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      if (!res.ok) process.stderr.write(`telegram notify to ${chatId}: HTTP ${res.status}\n`)
    } catch (err) {
      process.stderr.write(`telegram notify to ${chatId} failed: ${err}\n`)
    }
  }))
}

await main().catch(err => process.stderr.write(`telegram notify hook: ${err}\n`))
