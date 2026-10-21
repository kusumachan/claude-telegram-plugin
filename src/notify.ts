import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join, sep } from 'path'
import type { Access } from './access.ts'

/**
 * Notification hooks: tell the user on Telegram when a Claude Code session
 * needs attention (permission, question, idle) or finished a long turn.
 *
 * Pure decision logic lives here; hooks/notify.ts does the I/O. Kept free of
 * grammy so the hook starts fast and runs without node_modules.
 */

export type HookInput = {
  session_id: string
  cwd?: string
  hook_event_name: string
  // Notification
  message?: string
  title?: string
  notification_type?: string
  // Stop
  stop_hook_active?: boolean
  last_assistant_message?: string
}

export type SessionState = {
  /** When the current turn started (UserPromptSubmit). */
  turnStart?: number
  /** When we last sent a "finished" message for this session. */
  stopNotifiedAt?: number
}

export const DEFAULT_STOP_AFTER_SECONDS = 60
const PREVIEW_CHARS = 600
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Notification types worth a ping. auth_success, quota_* etc. are noise. */
export const ATTENTION_TYPES = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
])

/**
 * Per-session switch, read from the session's environment: `attention` keeps
 * only the notices that mean the session is stuck (permission, question),
 * `off` sends none. For sessions another program already reports on, like
 * the orchestrator's agents. Unset, or anything else, sends everything.
 */
export const NOTIFY_ENV = 'TELEGRAM_PLUS_NOTIFY'
export type NotifyScope = 'all' | 'attention' | 'off'

export function notifyScope(env: NodeJS.ProcessEnv = process.env): NotifyScope {
  const v = env[NOTIFY_ENV]?.trim().toLowerCase()
  if (v === 'attention') return 'attention'
  if (v === 'off' || v === '0' || v === 'false') return 'off'
  return 'all'
}

export function notifyEnabled(access: Access): boolean {
  return access.notify !== 'off' && access.allowFrom.length > 0 && access.dmPolicy !== 'disabled'
}

/** "api", or "api/fix-login" when running in a Claude Code worktree. */
export function projectLabel(cwd: string | undefined): string {
  if (!cwd) return 'session'
  const marker = `${sep}.claude${sep}worktrees${sep}`
  const i = cwd.indexOf(marker)
  if (i >= 0) {
    const worktree = cwd.slice(i + marker.length).split(sep)[0]
    return `${basename(cwd.slice(0, i))}/${worktree}`
  }
  return basename(cwd) || cwd
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function preview(text: string | undefined): string {
  const t = (text ?? '').trim()
  return t.length > PREVIEW_CHARS ? `${t.slice(0, PREVIEW_CHARS)}…` : t
}

export type Decision =
  | { send: false; reason: string; state?: SessionState }
  | { send: true; text: string; state?: SessionState }

/**
 * Decide what (if anything) to send for one hook event, and how the
 * per-session state changes.
 */
export function decide(input: HookInput, access: Access, state: SessionState, now = Date.now(), scope: NotifyScope = 'all'): Decision {
  const label = projectLabel(input.cwd)

  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
      return { send: false, reason: 'turn start recorded', state: { ...state, turnStart: now } }

    case 'Notification': {
      const type = input.notification_type ?? ''
      if (!ATTENTION_TYPES.has(type)) return { send: false, reason: `ignored type ${type}` }
      if (scope === 'off') return { send: false, reason: 'notices off for this session' }
      // Idle between turns is the normal state of a session someone else drives.
      if (type === 'idle_prompt' && scope === 'attention') return { send: false, reason: 'idle notices off for this session' }
      // With approvals on, the PermissionRequest hook already sent buttons.
      if (type === 'permission_prompt' && access.approvals !== 'off') {
        return { send: false, reason: 'approval prompt sent instead' }
      }
      // "Waiting for your input" right after we said it finished is a repeat.
      if (type === 'idle_prompt' && state.stopNotifiedAt && state.stopNotifiedAt >= (state.turnStart ?? 0)) {
        return { send: false, reason: 'idle after finished notice' }
      }
      const head = `${type === 'permission_prompt' ? '🔐' : '⏳'} ${label} · ${input.title || 'Needs your attention'}`
      return { send: true, text: [head, input.message].filter(Boolean).join('\n') }
    }

    case 'Stop': {
      if (input.stop_hook_active) return { send: false, reason: 'continuing from another stop hook' }
      if (scope !== 'all') return { send: false, reason: 'finished notices off for this session' }
      const threshold = (access.notifyStopAfterSeconds ?? DEFAULT_STOP_AFTER_SECONDS) * 1000
      const elapsed = state.turnStart != null ? now - state.turnStart : undefined
      if (threshold > 0 && (elapsed == null || elapsed < threshold)) {
        return { send: false, reason: 'turn too short' }
      }
      const head = `✅ ${label} · finished${elapsed != null ? ` (${formatDuration(elapsed)})` : ''}`
      const body = access.notifyPreview === 'off' ? '' : preview(input.last_assistant_message)
      return {
        send: true,
        text: body ? `${head}\n\n${body}` : head,
        state: { ...state, stopNotifiedAt: now },
      }
    }

    default:
      return { send: false, reason: `unhandled event ${input.hook_event_name}` }
  }
}

// --- per-session state on disk ------------------------------------------

function stateFile(stateDir: string, sessionId: string): string {
  return join(stateDir, 'hookstate', `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

export function readSessionState(stateDir: string, sessionId: string): SessionState {
  try {
    return JSON.parse(readFileSync(stateFile(stateDir, sessionId), 'utf8')) as SessionState
  } catch {
    return {}
  }
}

export function writeSessionState(stateDir: string, sessionId: string, state: SessionState): void {
  mkdirSync(join(stateDir, 'hookstate'), { recursive: true, mode: 0o700 })
  writeFileSync(stateFile(stateDir, sessionId), JSON.stringify(state), { mode: 0o600 })
}

/** Remove state for sessions untouched for a week. */
export function pruneSessionState(stateDir: string, now = Date.now()): void {
  const dir = join(stateDir, 'hookstate')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    const p = join(dir, n)
    try {
      if (now - statSync(p).mtimeMs > STATE_MAX_AGE_MS) rmSync(p, { force: true })
    } catch {}
  }
}
