import { statSync } from 'fs'
import { extname } from 'path'
import { GrammyError, InputFile, type Api } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { type AccessStore, assertAllowedChat } from './access.ts'
import { MAX_CHUNK_LIMIT, MAX_UPLOAD_BYTES } from './config.ts'
import { assertSendable, downloadToInbox } from './files.ts'
import { chunk, isParseError, parseModeFor, toPlain } from './text.ts'
import type { TypingTracker } from './typing.ts'

const FORMAT_SCHEMA = {
  type: 'string',
  enum: ['text', 'html', 'markdownv2'],
  description:
    "Rendering mode. 'html' (recommended for formatting) supports <b>, <i>, <code>, <pre>, <a href>, <blockquote>; escape &, <, > in plain text as &amp; &lt; &gt;. " +
    "'markdownv2' requires escaping _*[]()~`>#+-=|{}.! with a backslash. " +
    "Default 'text' (plain, no escaping). If Telegram rejects the markup the message is resent as plain text.",
}

export const TOOL_DEFINITIONS = [
  {
    name: 'reply',
    description:
      'Reply on Telegram. Pass chat_id from the inbound message (and thread_id if present). Optionally pass reply_to (message_id) to quote a specific earlier message, and files (absolute paths) to attach.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
        thread_id: {
          type: 'string',
          description: 'Forum topic id. Pass the thread_id from the inbound <channel> block so the reply lands in the same topic.',
        },
        reply_to: {
          type: 'string',
          description: 'Message ID to thread under. Use message_id from the inbound <channel> block.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute file paths to attach. Images send as photos, .mp4 as video, .mp3/.m4a as audio, everything else as documents. Max 50MB each.',
        },
        format: FORMAT_SCHEMA,
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'react',
    description:
      'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        emoji: { type: 'string' },
      },
      required: ['chat_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'download_attachment',
    description:
      'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'edit_message',
    description:
      "Edit a message the bot previously sent. Useful for interim progress updates. Edits don't trigger push notifications — send a new reply when a long task completes so the user's device pings.",
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        text: { type: 'string' },
        format: FORMAT_SCHEMA,
      },
      required: ['chat_id', 'message_id', 'text'],
    },
  },
]

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const VIDEO_EXTS = new Set(['.mp4'])
const AUDIO_EXTS = new Set(['.mp3', '.m4a'])

export type ToolDeps = {
  api: Api
  store: AccessStore
  stateDir: string
  inboxDir: string
  token: string
  typing: TypingTracker
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function optNumber(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`expected a numeric id, got ${JSON.stringify(v)}`)
  return n
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v === '') throw new Error(`missing required argument: ${key}`)
  return v
}

export async function callTool(deps: ToolDeps, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'reply':
        return await reply(deps, args)
      case 'react': {
        const chatId = requireString(args, 'chat_id')
        assertAllowedChat(deps.store.load(), chatId)
        await deps.api.setMessageReaction(chatId, optNumber(args.message_id)!, [
          { type: 'emoji', emoji: requireString(args, 'emoji') as ReactionTypeEmoji['emoji'] },
        ])
        return ok('reacted')
      }
      case 'download_attachment': {
        const path = await downloadToInbox(deps.api, deps.token, requireString(args, 'file_id'), deps.inboxDir)
        return ok(path)
      }
      case 'edit_message':
        return await editMessage(deps, args)
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${name} failed: ${msg}` }], isError: true }
  }
}

async function reply(deps: ToolDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const { api, store } = deps
  const chatId = requireString(args, 'chat_id')
  const text = typeof args.text === 'string' ? args.text : ''
  const replyTo = optNumber(args.reply_to)
  const threadId = optNumber(args.thread_id)
  const files = (args.files as string[] | undefined) ?? []
  const format = args.format as string | undefined
  const parseMode = parseModeFor(format)

  const access = store.load()
  assertAllowedChat(access, chatId)
  if (!text && files.length === 0) throw new Error('nothing to send: text is empty and no files given')

  for (const f of files) {
    assertSendable(f, deps.stateDir)
    const st = statSync(f)
    if (st.size > MAX_UPLOAD_BYTES) {
      throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
    }
  }

  const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const replyMode = access.replyToMode ?? 'first'
  const chunks = text ? chunk(text, limit, access.chunkMode ?? 'length') : []
  const sentIds: number[] = []
  const notes: string[] = []
  const threadOpt = threadId != null ? { message_thread_id: threadId } : {}
  const replyOpt = (i: number) =>
    replyTo != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
      ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
      : {}

  deps.typing.stopChat(chatId)

  try {
    for (let i = 0; i < chunks.length; i++) {
      const base = { ...threadOpt, ...replyOpt(i) }
      try {
        const sent = await api.sendMessage(chatId, chunks[i]!, { ...base, ...(parseMode ? { parse_mode: parseMode } : {}) })
        sentIds.push(sent.message_id)
      } catch (err) {
        if (!parseMode || !isParseError(err)) throw err
        const sent = await api.sendMessage(chatId, toPlain(chunks[i]!, format), base)
        sentIds.push(sent.message_id)
        notes.push(`chunk ${i + 1} sent as plain text — Telegram rejected the ${format} markup (${(err as GrammyError).description})`)
      }
    }

    // Files go as separate messages (sendMessage can't carry a file).
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!
      const ext = extname(f).toLowerCase()
      const input = new InputFile(f)
      const opts = { ...threadOpt, ...replyOpt(chunks.length + i) }
      const sent = PHOTO_EXTS.has(ext)
        ? await api.sendPhoto(chatId, input, opts)
        : VIDEO_EXTS.has(ext)
          ? await api.sendVideo(chatId, input, opts)
          : AUDIO_EXTS.has(ext)
            ? await api.sendAudio(chatId, input, opts)
            : await api.sendDocument(chatId, input, opts)
      sentIds.push(sent.message_id)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const total = chunks.length + files.length
    throw new Error(`reply failed after ${sentIds.length} of ${total} message(s) sent (ids: ${sentIds.join(', ') || 'none'}): ${msg}`)
  }

  const head = sentIds.length === 1
    ? `sent (id: ${sentIds[0]})`
    : `sent ${sentIds.length} messages (ids: ${sentIds.join(', ')})`
  return ok([head, ...notes].join('\n'))
}

async function editMessage(deps: ToolDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const chatId = requireString(args, 'chat_id')
  const messageId = optNumber(args.message_id)!
  const text = requireString(args, 'text')
  const format = args.format as string | undefined
  const parseMode = parseModeFor(format)
  assertAllowedChat(deps.store.load(), chatId)
  if (text.length > MAX_CHUNK_LIMIT) {
    throw new Error(`text is ${text.length} chars; Telegram caps a message at ${MAX_CHUNK_LIMIT}. Send the rest with reply.`)
  }

  try {
    await deps.api.editMessageText(chatId, messageId, text, parseMode ? { parse_mode: parseMode } : undefined)
  } catch (err) {
    if (err instanceof GrammyError && /message is not modified/i.test(err.description)) {
      return ok(`unchanged (id: ${messageId})`)
    }
    if (!parseMode || !isParseError(err)) throw err
    await deps.api.editMessageText(chatId, messageId, toPlain(text, format))
    return ok(`edited as plain text (id: ${messageId}) — Telegram rejected the ${format} markup`)
  }
  return ok(`edited (id: ${messageId})`)
}
