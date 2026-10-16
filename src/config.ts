import { chmodSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'telegram-plus')

export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const PID_FILE = join(STATE_DIR, 'bot.pid')

/** Telegram's hard cap on message text length. */
export const MAX_CHUNK_LIMIT = 4096
/** Bot API upload cap. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/** Bot API download cap (getFile refuses anything bigger). */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
/** Inbox files older than this are deleted. */
export const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Parse a dotenv-style file into `env` without overriding keys that are
 * already set (real env wins). Accepts `export KEY=...` and quoted values.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of content.split('\n')) {
    const m = raw.trim().match(/^(?:export\s+)?(\w+)\s*=\s*(.*)$/)
    if (!m) continue
    let value = m[2]!.trim()
    const quoted = value.match(/^(['"])(.*)\1$/)
    if (quoted) value = quoted[2]!
    out[m[1]!] = value
  }
  return out
}

export function loadEnvFile(file = ENV_FILE): void {
  try {
    // Token is a credential — lock to owner. No-op on Windows (would need ACLs).
    chmodSync(file, 0o600)
    for (const [k, v] of Object.entries(parseEnvFile(readFileSync(file, 'utf8')))) {
      if (process.env[k] === undefined) process.env[k] = v
    }
  } catch {}
}
