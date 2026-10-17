import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync, openSync } from 'fs'
import { join } from 'path'
import { withLock } from '../lock.ts'

/**
 * Talking to the hub: one process per bot token that owns Telegram polling
 * and routes messages between Telegram and every Claude Code session.
 *
 * Transport is HTTP over a unix socket in the state dir (mode 0700), so only
 * this OS user can reach it — no token needed.
 */

/** macOS caps unix socket paths at 104 bytes. */
const MAX_SOCKET_PATH = 100

export function socketPath(stateDir: string): string {
  const preferred = join(stateDir, 'hub.sock')
  if (preferred.length <= MAX_SOCKET_PATH) return preferred
  // Long state dir (tests, deep home dirs): use a private per-user dir in /tmp.
  const uid = process.getuid?.() ?? 0
  const hash = createHash('sha256').update(stateDir).digest('hex').slice(0, 12)
  const dir = `/tmp/telegram-plus-${uid}`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, `${hash}.sock`)
}

export class HubClient {
  readonly socket: string

  constructor(readonly stateDir: string, private hubScript: string, private log: (m: string) => void = () => {}) {
    this.socket = socketPath(stateDir)
  }

  async healthy(timeoutMs = 1000): Promise<boolean> {
    try {
      const res = await fetch('http://hub/health', { unix: this.socket, signal: AbortSignal.timeout(timeoutMs) })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Make sure a hub is running, starting one if needed. A lock keeps two
   * sessions starting at once from spawning two hubs (which would fight over
   * getUpdates with 409s).
   */
  async ensure(timeoutMs = 8000): Promise<void> {
    if (await this.healthy()) return
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    withLock(join(this.stateDir, 'hub-spawn.lock'), () => {
      // Another process may have spawned it while we waited for the lock;
      // its socket may not be up yet, so rely on the pid-file check inside
      // the hub itself to exit duplicates.
      const logFd = openSync(join(this.stateDir, 'hub.log'), 'a', 0o600)
      const child = spawn(process.execPath, [this.hubScript], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, TELEGRAM_STATE_DIR: this.stateDir },
      })
      child.unref()
      this.log(`started hub pid=${child.pid}`)
    })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.healthy(500)) return
      await Bun.sleep(150)
    }
    throw new Error(`hub did not come up within ${timeoutMs}ms — see ${join(this.stateDir, 'hub.log')}`)
  }

  async post<T>(path: string, body: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const res = await fetch(`http://hub${path}`, {
      unix: this.socket,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    })
    if (!res.ok) throw new Error(`hub ${path}: HTTP ${res.status} ${await res.text()}`)
    return (await res.json()) as T
  }

  /**
   * Open the event stream for a channel session and call onEvent for each
   * NDJSON line. Resolves when the stream ends (hub exited or restarted).
   */
  async stream(path: string, body: unknown, onEvent: (e: HubEvent) => void): Promise<void> {
    const res = await fetch(`http://hub${path}`, {
      unix: this.socket,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok || !res.body) throw new Error(`hub ${path}: HTTP ${res.status}`)
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          onEvent(JSON.parse(line) as HubEvent)
        } catch (err) {
          this.log(`bad hub event: ${err}`)
        }
      }
    }
  }
}

// --- wire types ------------------------------------------------------------

export type HubEvent =
  | { type: 'hello'; name: string }
  | { type: 'ping' }
  | { type: 'inbound'; content: string; meta: Record<string, string> }
  | { type: 'permission_verdict'; request_id: string; behavior: 'allow' | 'deny' }

export type ConnectBody = { id: string; name: string; cwd: string }

export type ToolCallBody = { session: string; name: string; args: Record<string, unknown> }

export type PermissionRequestBody = {
  session: string
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export type HookPermissionBody = {
  session_id: string
  cwd?: string
  /** Project topic to post the prompt in; derived from cwd when absent. */
  topic?: string
  tool_name: string
  tool_input?: unknown
}

export type HookPermissionResult = { behavior?: 'allow' | 'deny' }

export type HookEventBody = { session_id: string; hook_event_name: string }
