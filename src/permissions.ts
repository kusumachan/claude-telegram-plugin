import { InlineKeyboard, type Api } from 'grammy'

// Permission-reply spec: 5 lowercase letters a-z minus 'l'. Case-insensitive
// for phone autocorrect. Strict: no bare yes/no (conversational), no
// prefix/suffix chatter.
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
export const PERMISSION_CALLBACK_RE = /^perm:(allow|deny|more):([a-km-z]{5})$/

export type PermissionBehavior = 'allow' | 'deny'

/** A DM chat id, or a chat plus forum topic. */
export type Recipient = string | { chatId: string; threadId?: number }

export type PermissionRequest = {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

type Entry = PermissionRequest & {
  createdAt: number
  /** Which session asked, shown when several are connected (e.g. "api"). */
  label?: string
  /** Every prompt we sent for this request, so all of them can be updated on resolve. */
  messages: { chatId: string; messageId: number }[]
}

/** Requests older than this are forgotten and their buttons disabled. */
export const PERMISSION_TTL_MS = 30 * 60 * 1000

/**
 * Relays Claude Code permission prompts to allowlisted DMs and turns answers
 * (button or "yes abcde") back into notifications.
 *
 * Only DM-allowlisted users may answer. Group members never see prompts and
 * can't answer by text either — declaring the permission capability asserts
 * we authenticate the replier.
 */
export class PermissionRelay {
  private pending = new Map<string, Entry>()

  constructor(
    private api: Api,
    private notify: (request_id: string, behavior: PermissionBehavior) => Promise<void>,
    private log: (msg: string) => void = () => {},
  ) {}

  get size(): number {
    return this.pending.size
  }

  has(request_id: string): boolean {
    return this.pending.has(request_id)
  }

  /** Send the prompt; resolves to how many recipients actually got it. */
  async request(req: PermissionRequest, recipients: Recipient[], now = Date.now(), label?: string): Promise<number> {
    const entry: Entry = { ...req, createdAt: now, label, messages: [] }
    this.pending.set(req.request_id, entry)
    const keyboard = new InlineKeyboard()
      .text('See more', `perm:more:${req.request_id}`)
      .text('✅ Allow', `perm:allow:${req.request_id}`)
      .text('❌ Deny', `perm:deny:${req.request_id}`)
    await Promise.all(recipients.map(async r => {
      const { chatId, threadId } = typeof r === 'string' ? { chatId: r, threadId: undefined } : r
      try {
        const sent = await this.api.sendMessage(chatId, summary(entry), {
          reply_markup: keyboard,
          ...(threadId != null ? { message_thread_id: threadId } : {}),
        })
        entry.messages.push({ chatId, messageId: sent.message_id })
      } catch (e) {
        this.log(`permission_request send to ${chatId}${threadId != null ? `#${threadId}` : ''} failed: ${e}`)
      }
    }))
    if (entry.messages.length === 0) this.pending.delete(req.request_id)
    return entry.messages.length
  }

  /** Full details for the "See more" button, or undefined if unknown/expired. */
  details(request_id: string): string | undefined {
    const e = this.pending.get(request_id)
    if (!e) return undefined
    let prettyInput: string
    try {
      prettyInput = JSON.stringify(JSON.parse(e.input_preview), null, 2)
    } catch {
      prettyInput = e.input_preview
    }
    return `${summary(e)}\n\ndescription: ${e.description}\ninput_preview:\n${prettyInput}`
  }

  /**
   * Forward an answer to Claude Code and replace the buttons on every prompt
   * we sent, so other allowlisted users can't answer the same request again.
   * Unknown ids are still forwarded — the server may have restarted while
   * Claude Code was waiting.
   */
  async resolve(request_id: string, behavior: PermissionBehavior, by: string): Promise<void> {
    await this.notify(request_id, behavior)
    const e = this.pending.get(request_id)
    this.pending.delete(request_id)
    if (!e) return
    const label = `${behavior === 'allow' ? '✅ Allowed' : '❌ Denied'} by ${by}`
    await this.closePrompts(e, label)
  }

  /** Close a request without a verdict, e.g. it was answered in the terminal. */
  async cancel(request_id: string, label: string): Promise<boolean> {
    const e = this.pending.get(request_id)
    if (!e) return false
    this.pending.delete(request_id)
    await this.closePrompts(e, label)
    return true
  }

  /** Drop stale requests (answered in the terminal, or abandoned). */
  async prune(now = Date.now()): Promise<void> {
    for (const [id, e] of this.pending) {
      if (now - e.createdAt > PERMISSION_TTL_MS) {
        this.pending.delete(id)
        await this.closePrompts(e, '⌛ Expired — answer in the terminal if still pending')
      }
    }
  }

  private async closePrompts(e: Entry, label: string): Promise<void> {
    await Promise.all(e.messages.map(m =>
      this.api.editMessageText(m.chatId, m.messageId, `${summary(e)}\n\n${label}`).catch(() => {}),
    ))
  }
}

function summary(e: PermissionRequest & { label?: string }): string {
  return `🔐 ${e.label ? `[${e.label}] ` : ''}Permission: ${e.tool_name}`
}

const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz' // a-z minus 'l', same as Claude Code

/** A request id in Claude Code's format, for prompts that come from hooks. */
export function newRequestId(taken: (id: string) => boolean): string {
  for (;;) {
    let id = ''
    for (let i = 0; i < 5; i++) id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
    if (!taken(id)) return id
  }
}
