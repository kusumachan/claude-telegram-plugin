#!/usr/bin/env bun
/**
 * PermissionRequest hook: lets an allowlisted user approve or deny a tool
 * call from Telegram, for sessions that aren't the channel session (that one
 * uses Claude Code's native permission relay instead).
 *
 * Verified behavior this relies on: the terminal dialog stays open while the
 * hook waits, and whichever answer comes first wins — answering at the
 * terminal still works. Printing nothing leaves the decision to the terminal.
 */
import { join } from 'path'
import { AccessStore } from '../src/access.ts'
import { isChannelSession } from '../src/channel-mode.ts'
import { loadEnvFile, STATE_DIR } from '../src/config.ts'
import { type HookPermissionBody, type HookPermissionResult, HubClient } from '../src/hub/client.ts'
import { projectLabel } from '../src/notify.ts'
import { readHookInput, sendNotice } from './common.ts'

type Input = HookPermissionBody & { hook_event_name: string }

const DEFAULT_TIMEOUT_S = 300

async function main(): Promise<void> {
  const input = await readHookInput<Input>()
  if (!input.session_id || isChannelSession()) return

  loadEnvFile()
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  const access = new AccessStore(STATE_DIR, process.env.TELEGRAM_ACCESS_MODE === 'static').load()
  if (access.approvals === 'off' || access.allowFrom.length === 0 || access.dmPolicy === 'disabled') return

  const hub = new HubClient(STATE_DIR, join(import.meta.dir, '../hub.ts'))
  let result: HookPermissionResult
  try {
    await hub.ensure()
    const timeoutS = access.approvalTimeoutSeconds ?? DEFAULT_TIMEOUT_S
    result = await hub.post<HookPermissionResult>('/hook/permission', {
      session_id: input.session_id,
      cwd: input.cwd,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
    } satisfies HookPermissionBody, (timeoutS + 15) * 1000)
  } catch (err) {
    // No hub, no buttons: at least say the session is waiting.
    process.stderr.write(`telegram approval hook: ${err}\n`)
    if (access.notify !== 'off') {
      await sendNotice(token, access, projectLabel(input.cwd),
        `🔐 ${projectLabel(input.cwd)} · Permission needed\n${input.tool_name} is waiting for approval in the terminal.`)
    }
    return
  }

  if (!result.behavior) return // timed out or handled at the terminal
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: result.behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Denied from Telegram' },
    },
  }))
}

await main().catch(err => process.stderr.write(`telegram approval hook: ${err}\n`))
