/**
 * Decides which connected Claude Code session an inbound Telegram message
 * belongs to. Pure state, no I/O — the hub feeds it events.
 *
 * Order of precedence for a message in a chat:
 *   1. A reply to a message a session sent → that session.
 *   2. The chat's active session (picked with /use or the picker).
 *   3. Exactly one session connected → that one.
 *   4. None connected → nobody; several and no choice yet → ask the user.
 */

export type SessionInfo = {
  id: string
  name: string
  cwd: string
  connectedAt: number
}

export type Route =
  | { kind: 'session'; session: SessionInfo }
  | { kind: 'none' }
  | { kind: 'pick' }

const MAX_OWNED = 5000

export class Router {
  private sessions = new Map<string, SessionInfo>()
  private active = new Map<string, string>()
  /** `${chatId}:${messageId}` → session id. Insertion-ordered, bounded. */
  private owners = new Map<string, string>()

  get size(): number {
    return this.sessions.size
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].sort((a, b) => a.connectedAt - b.connectedAt)
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id)
  }

  findByName(name: string): SessionInfo | undefined {
    const n = name.toLowerCase()
    return this.list().find(s => s.name.toLowerCase() === n)
  }

  /**
   * Register (or re-register after a reconnect) a session. Names are made
   * unique among live sessions: a second "api" becomes "api-2".
   */
  add(id: string, wantedName: string, cwd: string, now = Date.now()): SessionInfo {
    const existing = this.sessions.get(id)
    if (existing) {
      existing.cwd = cwd
      return existing
    }
    const base = sanitizeName(wantedName)
    let name = base
    for (let i = 2; this.findByName(name); i++) name = `${base}-${i}`
    const info = { id, name, cwd, connectedAt: now }
    this.sessions.set(id, info)
    return info
  }

  remove(id: string): void {
    this.sessions.delete(id)
    for (const [chat, sid] of this.active) if (sid === id) this.active.delete(chat)
  }

  setActive(chatId: string, sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false
    this.active.set(chatId, sessionId)
    return true
  }

  activeFor(chatId: string): SessionInfo | undefined {
    const id = this.active.get(chatId)
    return id ? this.sessions.get(id) : undefined
  }

  recordOwner(chatId: string, messageIds: number[], sessionId: string): void {
    for (const m of messageIds) {
      this.owners.set(`${chatId}:${m}`, sessionId)
      if (this.owners.size > MAX_OWNED) this.owners.delete(this.owners.keys().next().value!)
    }
  }

  ownerOf(chatId: string, messageId: number): SessionInfo | undefined {
    const id = this.owners.get(`${chatId}:${messageId}`)
    return id ? this.sessions.get(id) : undefined
  }

  route(chatId: string, replyToMessageId?: number): Route {
    if (replyToMessageId != null) {
      const owner = this.ownerOf(chatId, replyToMessageId)
      if (owner) return { kind: 'session', session: owner }
    }
    const active = this.activeFor(chatId)
    if (active) return { kind: 'session', session: active }
    if (this.sessions.size === 1) return { kind: 'session', session: this.list()[0]! }
    if (this.sessions.size === 0) return { kind: 'none' }
    return { kind: 'pick' }
  }
}

export function sanitizeName(s: string): string {
  const cleaned = s.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return cleaned || 'session'
}
