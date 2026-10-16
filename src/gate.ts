import { randomBytes } from 'crypto'
import type { MessageEntity } from 'grammy/types'
import {
  type Access,
  type AccessStore,
  DEFAULT_MAX_PENDING,
  PAIRING_TTL_MS,
  pruneExpired,
} from './access.ts'

export type GateInput = {
  chatType: string | undefined
  chatId: string
  senderId: string
  /** Only consulted for groups with requireMention. */
  mentioned: () => boolean
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export function gate(store: AccessStore, input: GateInput, now = Date.now()): GateResult {
  return store.update((access): GateResult => {
    pruneExpired(access, now)

    if (access.dmPolicy === 'disabled') return { action: 'drop' }
    const { chatType, chatId, senderId } = input

    if (chatType === 'private') {
      if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
      if (access.dmPolicy === 'allowlist') return { action: 'drop' }

      // pairing mode — check for existing non-expired code for this sender
      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          // Reply twice max (initial + one reminder), then go silent.
          if ((p.replies ?? 1) >= 2) return { action: 'drop' }
          p.replies = (p.replies ?? 1) + 1
          return { action: 'pair', code, isResend: true }
        }
      }
      // Each sender holds at most one code, so this cap bounds how many
      // strangers can be waiting at once. Extra attempts are silently dropped.
      const cap = access.maxPending ?? DEFAULT_MAX_PENDING
      if (Object.keys(access.pending).length >= cap) return { action: 'drop' }

      const code = randomBytes(3).toString('hex') // 6 hex chars
      access.pending[code] = {
        senderId,
        chatId,
        createdAt: now,
        expiresAt: now + PAIRING_TTL_MS,
        replies: 1,
      }
      return { action: 'pair', code, isResend: false }
    }

    if (chatType === 'group' || chatType === 'supergroup') {
      const policy = access.groups[chatId]
      if (!policy) return { action: 'drop' }
      const groupAllowFrom = policy.allowFrom ?? []
      if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
        return { action: 'drop' }
      }
      if ((policy.requireMention ?? true) && !input.mentioned()) return { action: 'drop' }
      return { action: 'deliver', access }
    }

    return { action: 'drop' }
  })
}

/** Like gate() but for bot commands: no pairing side effects, just allow/drop. */
export function dmCommandAllowed(access: Access, chatType: string | undefined, senderId: string): boolean {
  if (chatType !== 'private') return false
  if (access.dmPolicy === 'disabled') return false
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return false
  return true
}

/**
 * Who may tap Claude's choice buttons: the same people whose messages the
 * gate would deliver, minus pairing (a stranger tapping never pairs) and
 * minus requireMention (a tap is addressed to the bot by definition).
 */
export function callbackAllowed(access: Access, chatType: string | undefined, chatId: string, senderId: string): boolean {
  if (access.dmPolicy === 'disabled') return false
  if (chatType === 'private') return access.allowFrom.includes(senderId)
  if (chatType === 'group' || chatType === 'supergroup') {
    const policy = access.groups[chatId]
    if (!policy) return false
    const allow = policy.allowFrom ?? []
    return allow.length === 0 || allow.includes(senderId)
  }
  return false
}

export type MentionInput = {
  text: string
  entities: MessageEntity[]
  replyToUsername?: string
  botUsername: string
  patterns?: string[]
}

export function isMentioned({ text, entities, replyToUsername, botUsername, patterns }: MentionInput): boolean {
  if (!botUsername) return false
  const handle = `@${botUsername}`.toLowerCase()
  for (const e of entities) {
    if (e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === handle) {
      return true
    }
    if (e.type === 'text_mention' && e.user.is_bot && e.user.username === botUsername) return true
  }

  // Reply to one of our messages counts as an implicit mention.
  if (replyToUsername === botUsername) return true

  for (const pat of patterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {
      // Invalid user-supplied regex — skip it.
    }
  }
  return false
}
