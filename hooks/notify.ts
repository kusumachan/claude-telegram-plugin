#!/usr/bin/env bun
/**
 * Notification hook (UserPromptSubmit / Notification / Stop, async): tells
 * allowlisted users on Telegram when a session needs attention or finished a
 * long turn, and tells the hub when a turn boundary means any open approval
 * prompt for this session was answered at the terminal.
 *
 * Never blocks Claude and never fails loudly: problems go to stderr, exit 0.
 */
import { join } from 'path'
import { AccessStore } from '../src/access.ts'
import { isChannelSession } from '../src/channel-mode.ts'
import { loadEnvFile, STATE_DIR } from '../src/config.ts'
import { HubClient } from '../src/hub/client.ts'
import {
  decide,
  type HookInput,
  notifyEnabled,
  pruneSessionState,
  readSessionState,
  writeSessionState,
} from '../src/notify.ts'
import { readHookInput, sendDirect } from './common.ts'

async function main(): Promise<void> {
  const input = await readHookInput<HookInput>()
  if (!input.session_id) return

  // Turn boundary → close this session's open Telegram approval prompts.
  // Applies to channel sessions too (their relayed prompts live in the hub).
  if (input.hook_event_name === 'Stop' || input.hook_event_name === 'UserPromptSubmit') {
    const hub = new HubClient(STATE_DIR, join(import.meta.dir, '../hub.ts'))
    if (await hub.healthy(300)) {
      await hub.post('/hook/event', { session_id: input.session_id, hook_event_name: input.hook_event_name }, 2000)
        .catch(() => {})
    }
  }

  // The channel session already talks over Telegram, so a notice there
  // would be a duplicate.
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
  if (decision.send) await sendDirect(token, access.allowFrom, decision.text)
}

await main().catch(err => process.stderr.write(`telegram notify hook: ${err}\n`))
