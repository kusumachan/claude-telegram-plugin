import { randomBytes } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Gate prompts the orchestrator posts through the hub ("Spec ready"
 * [Continue] [Revise]). Like ask_owner questions they live on disk
 * (`prompts.json`), so a tap after a hub restart still counts and an answer
 * given while the orchestrator is down is handed over when it reconnects.
 *
 * Lifecycle: open → (tap on a needs-text button → awaiting_text) → answered
 * → acked by the orchestrator (deleted). Cancel deletes at any point.
 */

export type PromptMessage = { chatId: string; messageId: number; threadId?: number; buttons?: boolean }

export type PromptAnswer = { label?: string; text?: string; by: string; at: number }

export type Prompt = {
  id: string
  /** Caller's idempotency key: posting the same key again returns this prompt. */
  key?: string
  topic?: string
  /** Button labels whose tap asks the owner for typed text (e.g. "Revise"). */
  needsText: string[]
  createdAt: number
  messages: PromptMessage[]
  state: 'open' | 'awaiting_text' | 'answered'
  /** The needs-text label tapped, while waiting for the text. */
  pendingLabel?: string
  answer?: PromptAnswer
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export class PromptStore {
  private readonly file: string
  private prompts: Prompt[]

  constructor(private stateDir: string) {
    this.file = join(stateDir, 'prompts.json')
    this.prompts = this.read()
  }

  private read(): Prompt[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private write(): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.prompts, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** Prompts still waiting for the owner. */
  get openCount(): number {
    return this.prompts.filter(p => p.state !== 'answered').length
  }

  get(id: string): Prompt | undefined {
    return this.prompts.find(p => p.id === id)
  }

  byKey(key: string): Prompt | undefined {
    return this.prompts.find(p => p.key === key)
  }

  byMessage(chatId: string, messageId: number): Prompt | undefined {
    return this.prompts.find(p => p.messages.some(m => m.chatId === chatId && m.messageId === messageId))
  }

  /** Prompts waiting for typed text in this chat (and forum topic). */
  awaitingIn(chatId: string, threadId: number | undefined): Prompt[] {
    return this.prompts.filter(p => p.state === 'awaiting_text'
      && p.messages.some(m => m.chatId === chatId && m.threadId === threadId))
  }

  /** Answered, not yet acked: to (re)send to the orchestrator. */
  answered(): Prompt[] {
    return this.prompts.filter(p => p.state === 'answered')
  }

  add(p: Omit<Prompt, 'id' | 'createdAt' | 'state'>, now = Date.now()): Prompt {
    const full: Prompt = { ...p, id: randomBytes(6).toString('hex'), createdAt: now, state: 'open' }
    this.prompts.push(full)
    this.write()
    return full
  }

  addMessages(id: string, messages: PromptMessage[]): void {
    const p = this.get(id)
    if (!p) return
    p.messages.push(...messages)
    this.write()
  }

  awaitText(id: string, label: string): void {
    const p = this.get(id)
    if (!p || p.state === 'answered') return
    p.state = 'awaiting_text'
    p.pendingLabel = label
    this.write()
  }

  /** Record the answer. False if already answered or unknown. */
  answer(id: string, answer: PromptAnswer): boolean {
    const p = this.get(id)
    if (!p || p.state === 'answered') return false
    p.state = 'answered'
    p.answer = answer
    delete p.pendingLabel
    this.write()
    return true
  }

  remove(id: string): Prompt | undefined {
    const p = this.get(id)
    if (!p) return undefined
    this.prompts = this.prompts.filter(x => x.id !== id)
    this.write()
    return p
  }

  /** Drop prompts nobody acked or answered within 30 days. */
  prune(now = Date.now()): Prompt[] {
    const old = this.prompts.filter(p => now - p.createdAt > MAX_AGE_MS)
    if (old.length === 0) return []
    this.prompts = this.prompts.filter(p => now - p.createdAt <= MAX_AGE_MS)
    this.write()
    return old
  }
}
