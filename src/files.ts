import { mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, sep } from 'path'
import type { Api } from 'grammy'
import { MAX_DOWNLOAD_BYTES } from './config.ts'

/**
 * reply's files param takes any path. Claude can already Read+paste file
 * contents, so this isn't a new exfil channel for arbitrary paths — but the
 * server's own state (token, access.json) is the one thing Claude has no
 * reason to ever send. Inbox files are fine to echo back.
 */
export function assertSendable(file: string, stateDir: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(file)
    stateReal = realpathSync(stateDir)
  } catch {
    return // statSync will fail properly; or stateDir absent → nothing to leak
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${file}`)
  }
}

function safeExt(filePath: string, fallback: string): string {
  const raw = filePath.includes('.') ? filePath.split('.').pop()! : fallback
  return raw.replace(/[^a-zA-Z0-9]/g, '') || fallback
}

/**
 * Download a Telegram file into the inbox and return its local path.
 * Size is checked before fetching — getFile refuses >20MB anyway, but
 * failing early gives a clearer error.
 */
export async function downloadToInbox(
  api: Api,
  token: string,
  fileId: string,
  inboxDir: string,
  opts: { knownSize?: number; fallbackExt?: string } = {},
): Promise<string> {
  if (opts.knownSize != null && opts.knownSize > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `file is ${(opts.knownSize / 1024 / 1024).toFixed(1)}MB — Telegram bots can only download up to 20MB`,
    )
  }
  const file = await api.getFile(fileId)
  if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const ext = safeExt(file.file_path, opts.fallbackExt ?? 'bin')
  const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  mkdirSync(inboxDir, { recursive: true, mode: 0o700 })
  const path = join(inboxDir, `${Date.now()}-${uniqueId}.${ext}`)
  writeFileSync(path, buf, { mode: 0o600 })
  return path
}

/** Delete inbox files older than maxAgeMs. Returns how many were removed. */
export function cleanInbox(inboxDir: string, maxAgeMs: number, now = Date.now()): number {
  let removed = 0
  let names: string[]
  try {
    names = readdirSync(inboxDir)
  } catch {
    return 0
  }
  for (const name of names) {
    const p = join(inboxDir, name)
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) {
        rmSync(p, { force: true })
        removed++
      }
    } catch {}
  }
  return removed
}
