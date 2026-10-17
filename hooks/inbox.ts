#!/usr/bin/env bun
/**
 * PostToolUse / Stop hook: hands owner messages queued in the hub to an
 * inbox session (TELEGRAM_PLUS_INBOX=1), after the current tool call or as
 * the next input when the turn ends.
 *
 * Runs after every tool call in every session, so it must cost nothing when
 * there's nothing to do: no inbox → exit at once (hooks.json also checks the
 * env before starting bun); no hub socket → exit; never spawns the hub,
 * never prints an error to stdout, always exits 0.
 *
 * Stop loops: it blocks the stop only when it actually delivers something,
 * and delivery empties the queue, so a second Stop finds nothing.
 */
import { existsSync } from 'fs'
import { STATE_DIR } from '../src/config.ts'
import { HubClient } from '../src/hub/client.ts'
import { formatInbox, hookOutput, inboxEnabled, type InboxTakeResult } from '../src/inbox.ts'
import { readHookInput } from './common.ts'

type Input = { session_id?: string; hook_event_name: string; stop_hook_active?: boolean }

const TAKE_TIMEOUT_MS = 1500

async function main(): Promise<void> {
  if (!inboxEnabled()) return
  const input = await readHookInput<Input>()
  if (!input.session_id) return
  const hub = new HubClient(STATE_DIR, '')
  if (!existsSync(hub.socket)) return

  const { messages } = await hub.post<InboxTakeResult>('/inbox/take', { session_id: input.session_id }, TAKE_TIMEOUT_MS)
  if (!messages?.length) return
  const out = hookOutput(input.hook_event_name, formatInbox(messages))
  if (out) process.stdout.write(JSON.stringify(out))
}

await main().catch(err => process.stderr.write(`telegram inbox hook: ${err}\n`))
