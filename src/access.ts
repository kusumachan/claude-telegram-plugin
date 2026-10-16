import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { withLock } from './lock.ts'

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type ReplyToMode = 'off' | 'first' | 'all'
export type ChunkMode = 'length' | 'newline'
export type DmPolicy = 'pairing' | 'allowlist' | 'disabled'

export type Access = {
  dmPolicy: DmPolicy
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  /** Emoji to react with on receipt. Empty string disables. Telegram only accepts its fixed whitelist. */
  ackReaction?: string
  /** Which chunks get Telegram's reply reference when reply_to is passed. Default: 'first'. */
  replyToMode?: ReplyToMode
  /** Max chars per outbound message before splitting. Default: 4096 (Telegram's hard cap). */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: ChunkMode
  /** Max concurrent pending pairing codes. Default: 10. */
  maxPending?: number
}

export const PAIRING_TTL_MS = 60 * 60 * 1000
export const DEFAULT_MAX_PENDING = 10

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function normalize(parsed: Partial<Access>): Access {
  return {
    ...parsed,
    dmPolicy: parsed.dmPolicy ?? 'pairing',
    allowFrom: parsed.allowFrom ?? [],
    groups: parsed.groups ?? {},
    pending: parsed.pending ?? {},
  }
}

export function pruneExpired(a: Access, now = Date.now()): boolean {
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

/**
 * Owns access.json. Every mutation goes through `update`, which holds a
 * cross-process lock for the whole read-modify-write so the server and the
 * access CLI can't clobber each other.
 *
 * In static mode the file is snapshotted once and never re-read or written.
 * Pairing requires runtime mutation, so it's downgraded to allowlist.
 */
export class AccessStore {
  readonly file: string
  private readonly lockPath: string
  private readonly snapshot: Access | null

  constructor(readonly stateDir: string, readonly isStatic = false, private log: (msg: string) => void = () => {}) {
    this.file = join(stateDir, 'access.json')
    this.lockPath = join(stateDir, 'access.lock')
    if (isStatic) {
      const a = this.readFile()
      if (a.dmPolicy === 'pairing') {
        log('static mode — dmPolicy "pairing" downgraded to "allowlist"')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      this.snapshot = a
    } else {
      this.snapshot = null
    }
  }

  /** Current access state (read-only use). */
  load(): Access {
    return this.snapshot ? structuredClone(this.snapshot) : this.readFile()
  }

  /**
   * Locked read-modify-write. The file is only rewritten when `fn` actually
   * changed something. In static mode `fn` runs against a throwaway copy.
   */
  update<T>(fn: (a: Access) => T): T {
    if (this.snapshot) return fn(structuredClone(this.snapshot))
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    return withLock(this.lockPath, () => {
      const a = this.readFile()
      const before = JSON.stringify(a)
      const result = fn(a)
      if (JSON.stringify(a) !== before) this.writeFile(a)
      return result
    })
  }

  private readFile(): Access {
    try {
      return normalize(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Access>)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {}
      this.log('access.json is corrupt, moved aside. Starting fresh.')
      return defaultAccess()
    }
  }

  private writeFile(a: Access): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

/**
 * Outbound gate — reply/react/edit can only target chats the inbound gate
 * would deliver from. Telegram DM chat_id == user_id, so allowFrom covers DMs.
 */
export function assertAllowedChat(access: Access, chatId: string): void {
  if (access.allowFrom.includes(chatId)) return
  if (chatId in access.groups) return
  throw new Error(`chat ${chatId} is not allowlisted — add via /telegram-plus:access`)
}
