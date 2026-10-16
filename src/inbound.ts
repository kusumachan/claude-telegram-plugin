import type { Bot, Context } from 'grammy'
import type { Message, ReactionTypeEmoji } from 'grammy/types'
import type { AccessStore } from './access.ts'
import { downloadToInbox } from './files.ts'
import { dmCommandAllowed, gate, isMentioned } from './gate.ts'
import { PERMISSION_CALLBACK_RE, PERMISSION_REPLY_RE, type PermissionRelay } from './permissions.ts'
import { safeName, safeSnippet } from './text.ts'
import type { TypingTracker } from './typing.ts'
import { InlineKeyboard } from 'grammy'

export type ChannelNotification = { content: string; meta: Record<string, string> }

export type InboundDeps = {
  bot: Bot
  store: AccessStore
  relay: PermissionRelay
  typing: TypingTracker
  token: string
  inboxDir: string
  botUsername: () => string
  deliver: (n: ChannelNotification) => Promise<void>
  log: (msg: string) => void
}

type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

type InboundOpts = {
  attachment?: AttachmentMeta
  /** Eagerly fetched (photos) — deferred until after the gate approves. */
  download?: () => Promise<string>
  edited?: boolean
}

export function registerInbound(deps: InboundDeps): void {
  const { bot } = deps

  registerCommands(deps)
  registerPermissionButtons(deps)

  bot.on('message:text', ctx => handleInbound(deps, ctx, ctx.message.text))
  bot.on('edited_message:text', ctx => handleInbound(deps, ctx, ctx.editedMessage.text, { edited: true }))

  bot.on('message:photo', ctx => {
    // Largest size is last in the array.
    const best = ctx.message.photo[ctx.message.photo.length - 1]!
    return handleInbound(deps, ctx, ctx.message.caption ?? '(photo)', {
      attachment: { kind: 'photo', file_id: best.file_id, size: best.file_size },
      download: () => downloadToInbox(ctx.api, deps.token, best.file_id, deps.inboxDir, {
        knownSize: best.file_size,
        fallbackExt: 'jpg',
      }),
    })
  })

  bot.on('message:document', ctx => {
    const doc = ctx.message.document
    const name = safeName(doc.file_name)
    const attachment = { kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name }
    // Images sent "as file" (uncompressed) get the same eager treatment as photos.
    const isImage = doc.mime_type?.startsWith('image/') && (doc.file_size ?? 0) <= 20 * 1024 * 1024
    return handleInbound(deps, ctx, ctx.message.caption ?? `(document: ${name ?? 'file'})`, {
      attachment,
      ...(isImage
        ? { download: () => downloadToInbox(ctx.api, deps.token, doc.file_id, deps.inboxDir, { knownSize: doc.file_size }) }
        : {}),
    })
  })

  bot.on('message:voice', ctx => {
    const v = ctx.message.voice
    return handleInbound(deps, ctx, ctx.message.caption ?? '(voice message)', {
      attachment: { kind: 'voice', file_id: v.file_id, size: v.file_size, mime: v.mime_type },
    })
  })

  bot.on('message:audio', ctx => {
    const a = ctx.message.audio
    const name = safeName(a.file_name)
    return handleInbound(deps, ctx, ctx.message.caption ?? `(audio: ${safeName(a.title) ?? name ?? 'audio'})`, {
      attachment: { kind: 'audio', file_id: a.file_id, size: a.file_size, mime: a.mime_type, name },
    })
  })

  bot.on('message:video', ctx => {
    const v = ctx.message.video
    return handleInbound(deps, ctx, ctx.message.caption ?? '(video)', {
      attachment: { kind: 'video', file_id: v.file_id, size: v.file_size, mime: v.mime_type, name: safeName(v.file_name) },
    })
  })

  bot.on('message:video_note', ctx => {
    const vn = ctx.message.video_note
    return handleInbound(deps, ctx, '(video note)', {
      attachment: { kind: 'video_note', file_id: vn.file_id, size: vn.file_size },
    })
  })

  bot.on('message:sticker', ctx => {
    const s = ctx.message.sticker
    return handleInbound(deps, ctx, `(sticker${s.emoji ? ` ${s.emoji}` : ''})`, {
      attachment: { kind: 'sticker', file_id: s.file_id, size: s.file_size },
    })
  })

  bot.on('message:location', ctx => {
    const { latitude, longitude } = ctx.message.location
    return handleInbound(deps, ctx, `(location: ${latitude}, ${longitude})`)
  })

  bot.on('message:contact', ctx => {
    const c = ctx.message.contact
    const name = safeName([c.first_name, c.last_name].filter(Boolean).join(' '))
    return handleInbound(deps, ctx, `(contact: ${name} ${c.phone_number})`)
  })
}

function messageOf(ctx: Context): Message | undefined {
  return ctx.message ?? ctx.editedMessage
}

async function handleInbound(deps: InboundDeps, ctx: Context, text: string, opts: InboundOpts = {}): Promise<void> {
  const msg = messageOf(ctx)
  const from = ctx.from
  if (!msg || !from || !ctx.chat) return
  const chatId = String(ctx.chat.id)
  const senderId = String(from.id)

  const result = gate(deps.store, {
    chatType: ctx.chat.type,
    chatId,
    senderId,
    mentioned: () => isMentioned({
      text: msg.text ?? msg.caption ?? '',
      entities: msg.entities ?? msg.caption_entities ?? [],
      replyToUsername: msg.reply_to_message?.from?.username,
      botUsername: deps.botUsername(),
      patterns: deps.store.load().mentionPatterns,
    }),
  })

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram-plus:access pair ${result.code}`)
    return
  }

  const access = result.access
  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined

  // Permission-reply intercept. Only DM-allowlisted users may answer — a
  // member of an allowlisted group passed the gate but was never paired, and
  // never received the prompt.
  const permMatch = !opts.edited && ctx.chat.type === 'private' && access.allowFrom.includes(senderId)
    ? PERMISSION_REPLY_RE.exec(text)
    : null
  if (permMatch) {
    const allow = permMatch[1]!.toLowerCase().startsWith('y')
    await deps.relay.resolve(permMatch[2]!.toLowerCase(), allow ? 'allow' : 'deny', displayName(from))
    void ctx.api.setMessageReaction(chatId, msg.message_id, [
      { type: 'emoji', emoji: (allow ? '👍' : '👎') as ReactionTypeEmoji['emoji'] },
    ]).catch(() => {})
    return
  }

  deps.typing.start(chatId, threadId)

  // Ack reaction — fire-and-forget. Non-whitelisted emoji are rejected by the API.
  if (access.ackReaction && !opts.edited) {
    void ctx.api.setMessageReaction(chatId, msg.message_id, [
      { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
    ]).catch(() => {})
  }

  let imagePath: string | undefined
  let downloadError: string | undefined
  if (opts.download) {
    try {
      imagePath = await opts.download()
    } catch (err) {
      downloadError = err instanceof Error ? err.message : String(err)
      deps.log(`attachment download failed: ${downloadError}`)
    }
  }

  const reply = msg.reply_to_message
  const att = opts.attachment
  // image_path goes in meta only — an in-content "[image attached — read: PATH]"
  // annotation is forgeable by any allowlisted sender typing that string.
  const meta: Record<string, string | undefined> = {
    chat_id: chatId,
    message_id: String(msg.message_id),
    thread_id: threadId != null ? String(threadId) : undefined,
    user: from.username ?? senderId,
    user_id: senderId,
    user_name: safeSnippet([from.first_name, from.last_name].filter(Boolean).join(' '), 64),
    chat_type: ctx.chat.type,
    chat_title: 'title' in ctx.chat ? safeSnippet(ctx.chat.title, 64) : undefined,
    ts: new Date(msg.date * 1000).toISOString(),
    edited: opts.edited ? 'true' : undefined,
    media_group_id: msg.media_group_id,
    forwarded_from: forwardedFrom(msg),
    // Reply context — the Bot API has no history, so this is the only way
    // Claude learns what a quote-reply refers to.
    reply_to_message_id: reply ? String(reply.message_id) : undefined,
    reply_to_user: reply?.from ? (reply.from.username ?? String(reply.from.id)) : undefined,
    reply_to_text: safeSnippet(msg.quote?.text ?? reply?.text ?? reply?.caption),
    image_path: imagePath,
    // Keep the file_id for photos too, so a failed eager download can be retried.
    ...(att && (!imagePath || att.kind !== 'photo')
      ? {
          attachment_kind: att.kind,
          attachment_file_id: att.file_id,
          attachment_size: att.size != null ? String(att.size) : undefined,
          attachment_mime: att.mime,
          attachment_name: att.name,
        }
      : {}),
    attachment_error: safeSnippet(downloadError, 200),
  }

  try {
    await deps.deliver({ content: text, meta: compact(meta) })
  } catch (err) {
    deps.typing.stop(chatId, threadId)
    deps.log(`failed to deliver inbound to Claude: ${err}`)
  }
}

function compact(o: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) if (v != null && v !== '') out[k] = v
  return out
}

function displayName(u: { username?: string; first_name: string; id: number }): string {
  return u.username ? `@${u.username}` : safeName(u.first_name) ?? String(u.id)
}

function forwardedFrom(msg: Message): string | undefined {
  const o = msg.forward_origin
  if (!o) return undefined
  switch (o.type) {
    case 'user':
      return safeSnippet(o.sender_user.username ? `@${o.sender_user.username}` : o.sender_user.first_name, 64)
    case 'hidden_user':
      return safeSnippet(o.sender_user_name, 64)
    case 'chat':
      return safeSnippet(o.sender_chat.title ?? 'chat', 64)
    case 'channel':
      return safeSnippet(o.chat.title ?? 'channel', 64)
  }
}

// Commands are DM-only. Responding in groups would: (1) leak pairing codes via
// /status to other group members, (2) confirm bot presence in non-allowlisted
// groups, (3) spam channels the operator never approved.
function registerCommands(deps: InboundDeps): void {
  const { bot, store } = deps
  const allowed = (ctx: Context) =>
    !!ctx.from && dmCommandAllowed(store.load(), ctx.chat?.type, String(ctx.from.id))

  bot.command('start', async ctx => {
    if (!allowed(ctx)) return
    await ctx.reply(
      `This bot bridges Telegram to a Claude Code session.\n\n` +
      `To pair:\n` +
      `1. DM me anything — you'll get a 6-char code\n` +
      `2. In Claude Code: /telegram-plus:access pair <code>\n\n` +
      `After that, DMs here reach that session.`,
    )
  })

  bot.command('help', async ctx => {
    if (!allowed(ctx)) return
    await ctx.reply(
      `Messages you send here route to a paired Claude Code session. ` +
      `Text, photos, files, voice, locations and replies are forwarded; replies and reactions come back.\n\n` +
      `/start — pairing instructions\n` +
      `/status — check your pairing state`,
    )
  })

  bot.command('status', async ctx => {
    if (!allowed(ctx)) return
    const access = store.load()
    const senderId = String(ctx.from!.id)
    if (access.allowFrom.includes(senderId)) {
      await ctx.reply(`Paired as ${displayName(ctx.from!)}.`)
      return
    }
    const code = Object.entries(access.pending).find(([, p]) => p.senderId === senderId && p.expiresAt > Date.now())?.[0]
    await ctx.reply(code
      ? `Pending pairing — run in Claude Code:\n\n/telegram-plus:access pair ${code}`
      : `Not paired. Send me a message to get a pairing code.`)
  })
}

// Callback data is `perm:allow:<id>`, `perm:deny:<id>`, or `perm:more:<id>`.
function registerPermissionButtons(deps: InboundDeps): void {
  deps.bot.on('callback_query:data', async ctx => {
    const m = PERMISSION_CALLBACK_RE.exec(ctx.callbackQuery.data)
    if (!m) {
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    if (!deps.store.load().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const [, behavior, requestId] = m as unknown as [string, 'allow' | 'deny' | 'more', string]

    if (behavior === 'more') {
      const details = deps.relay.details(requestId)
      if (!details) {
        await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
        return
      }
      const keyboard = new InlineKeyboard()
        .text('✅ Allow', `perm:allow:${requestId}`)
        .text('❌ Deny', `perm:deny:${requestId}`)
      await ctx.editMessageText(details, { reply_markup: keyboard }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    await deps.relay.resolve(requestId, behavior, displayName(ctx.from))
    await ctx.answerCallbackQuery({ text: behavior === 'allow' ? '✅ Allowed' : '❌ Denied' }).catch(() => {})
  })
}
