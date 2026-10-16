import { execFileSync } from 'child_process'
import { basename } from 'path'

/**
 * Is this process running inside a session that was launched as a Telegram
 * channel?
 *
 * Claude Code starts a plugin's MCP server in every session where the plugin
 * is enabled, with the same env and the same initialize handshake whether or
 * not the session registered it as a channel. So the server can't tell, and
 * without this check every session would start polling the bot and evict
 * each other (409 / stale-poller kills).
 *
 * The bin/claude-telegram launcher sets TELEGRAM_PLUS_CHANNEL_PID to its own
 * PID and then execs claude, so that PID *is* the channel session's claude
 * process. A process belongs to the channel session when its nearest
 * `claude` ancestor is that PID. A nested `claude -p` started from inside
 * the channel session inherits the env var but has a different nearest
 * claude ancestor, so it correctly isn't treated as the channel.
 */
export const CHANNEL_ENV = 'TELEGRAM_PLUS_CHANNEL_PID'

type ProcInfo = { ppid: number; comm: string }
export type ProcLookup = (pid: number) => ProcInfo | undefined

const psLookup: ProcLookup = pid => {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const m = out.match(/^(\d+)\s+(.+)$/)
    return m ? { ppid: Number(m[1]), comm: m[2]! } : undefined
  } catch {
    return undefined
  }
}

/** PID of the nearest ancestor whose executable is named `claude`, if any. */
export function nearestClaudeAncestor(startPid: number, lookup: ProcLookup = psLookup, maxDepth = 12): number | undefined {
  let pid = startPid
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    const info = lookup(pid)
    if (!info) return undefined
    if (basename(info.comm) === 'claude') return pid
    pid = info.ppid
  }
  return undefined
}

export function isChannelSession(
  env: NodeJS.ProcessEnv = process.env,
  startPid: number = process.ppid,
  lookup: ProcLookup = psLookup,
): boolean {
  const want = env[CHANNEL_ENV]
  if (!want) return false
  const owner = nearestClaudeAncestor(startPid, lookup)
  // No `claude` ancestor found (npm-installed CLI runs as `node`, or no `ps`
  // on Windows): fall back to trusting the env var.
  return owner == null || String(owner) === want
}
