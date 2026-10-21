#!/usr/bin/env bun
/**
 * Telegram hub: the one process that polls the bot and routes messages
 * between Telegram and every Claude Code session on this machine.
 *
 * - Channel sessions (started via bin/claude-telegram) connect over a unix
 *   socket, receive their inbound messages as an NDJSON stream and send
 *   through the hub, so several sessions can share one bot.
 * - Non-channel sessions reach it through hooks to get permission prompts
 *   approved from Telegram.
 *
 * Started on demand by whichever process needs it first and exits after
 * HUB_IDLE_MS with nothing connected or pending.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy'
import { AccessStore, type Access } from './src/access.ts'
import {
  ASK_HOLD_MS,
  type AskBody,
  type AskResult,
  type AskWaitBody,
  type AskWaitResult,
  MAX_QUESTION_CHARS,
  parseAskButtons,
  type Question,
  type QuestionMessage,
  QuestionStore,
  questionHeader,
  questionText,
} from './src/ask.ts'
import { buildKeyboard } from './src/buttons.ts'
import { type InboxConnectBody, type InboxMessage, type InboxTakeBody, type InboxTakeResult } from './src/inbox.ts'
import {
  type EditNoticeBody,
  type AskAnswerBody,
  type AskPostBody,
  type EditNoticeResult,
  type InboxSendBody,
  type InboxSendResult,
  type NoticeBody,
  type NoticeResult,
  ORCHESTRATOR_COMMANDS,
  type OrchestratorCommand,
  type OrchestratorEvent,
  type PromptBody,
  type PromptResult,
  type TopicResult,
} from './src/hub/orchestrator.ts'
import { type Prompt, type PromptMessage, PromptStore } from './src/prompts.ts'
import { APPROVED_DIR, INBOX_DIR, INBOX_MAX_AGE_MS, loadEnvFile, STATE_DIR } from './src/config.ts'
import { cleanInbox } from './src/files.ts'
import { callbackAllowed, dmCommandAllowed } from './src/gate.ts'
import {
  type ConnectBody,
  type HookEventBody,
  type HookPermissionBody,
  type HookPermissionResult,
  type HubEvent,
  HubClient,
  type PermissionRequestBody,
  socketPath,
  type ToolCallBody,
} from './src/hub/client.ts'
import { Router, type SessionInfo } from './src/hub/router.ts'
import { type ChannelNotification, registerInbound } from './src/inbound.ts'
import { projectLabel } from './src/notify.ts'
import { newRequestId, type PermissionRequest, PermissionRelay, type Recipient } from './src/permissions.ts'
import { callTool, type ToolDeps } from './src/tools.ts'
import { controlTopic, isControlTopic, isMissingTopic, TopicStore, topicName, topicWelcome } from './src/topics.ts'
import { safeSnippet } from './src/text.ts'
import { TypingTracker } from './src/typing.ts'

const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} hub: ${msg}\n`)

const HUB_IDLE_MS = Number(process.env.TELEGRAM_PLUS_HUB_IDLE_MS ?? 10 * 60 * 1000)
const DEFAULT_APPROVAL_TIMEOUT_S = 300
const MAX_HELD_PER_CHAT = 20
const PID_FILE = join(STATE_DIR, 'hub.pid')
const SOCKET = socketPath(STATE_DIR)

loadEnvFile()
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  log('TELEGRAM_BOT_TOKEN missing — run /telegram-plus:configure <token>')
  process.exit(1)
}

// Single instance: if a healthy hub already answers on the socket, leave.
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
if (await new HubClient(STATE_DIR, '').healthy()) {
  log('another hub is already running — exiting')
  process.exit(0)
}
if (existsSync(SOCKET)) rmSync(SOCKET, { force: true }) // stale, nobody answered
writeFileSync(PID_FILE, String(process.pid))

process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))

const store = new AccessStore(STATE_DIR, process.env.TELEGRAM_ACCESS_MODE === 'static', log)
// TELEGRAM_API_ROOT points at a fake Bot API in integration tests.
const bot = new Bot(TOKEN, process.env.TELEGRAM_API_ROOT ? { client: { apiRoot: process.env.TELEGRAM_API_ROOT } } : undefined)
let botUsername = ''
const typing = new TypingTracker((chatId, threadId) =>
  bot.api.sendChatAction(chatId, 'typing', threadId != null ? { message_thread_id: threadId } : undefined),
)
const router = new Router()
const topics = new TopicStore(STATE_DIR)
/** topic name → when creating/using it last failed (backoff, avoids log spam). */
const topicFailures = new Map<string, number>()
const TOPIC_RETRY_MS = 10 * 60 * 1000
const toolDeps: ToolDeps = { api: bot.api, store, stateDir: STATE_DIR, inboxDir: INBOX_DIR, token: TOKEN, typing }

let lastActivity = Date.now()
const touch = () => { lastActivity = Date.now() }

// --- session streams -------------------------------------------------------

const encoder = new TextEncoder()
const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()

function push(sessionId: string, e: HubEvent): boolean {
  const c = streams.get(sessionId)
  if (!c) return false
  try {
    c.enqueue(encoder.encode(JSON.stringify(e) + '\n'))
    return true
  } catch {
    return false
  }
}

// --- permissions -----------------------------------------------------------

/** Prompts relayed for channel sessions: request id → session id. */
const channelRequests = new Map<string, string>()
/** Prompts raised by PermissionRequest hooks, waiting on an HTTP response. */
const hookRequests = new Map<string, {
  sessionId: string
  resolve: (r: HookPermissionResult) => void
  timer: ReturnType<typeof setTimeout>
}>()

const relay = new PermissionRelay(bot.api, async (request_id, behavior) => {
  const hook = hookRequests.get(request_id)
  if (hook) {
    clearTimeout(hook.timer)
    hookRequests.delete(request_id)
    hook.resolve({ behavior })
    return
  }
  const session = channelRequests.get(request_id)
  channelRequests.delete(request_id)
  if (session) push(session, { type: 'permission_verdict', request_id, behavior })
}, log)

function finishHookRequest(id: string, label: string): void {
  const h = hookRequests.get(id)
  if (!h) return
  clearTimeout(h.timer)
  hookRequests.delete(id)
  h.resolve({})
  void relay.cancel(id, label)
}

function previewInput(input: unknown): string {
  let s: string
  try {
    s = JSON.stringify(input ?? {})
  } catch {
    s = String(input)
  }
  return s.length > 3000 ? `${s.slice(0, 3000)}…` : s
}

// --- forum topics --------------------------------------------------------------

/** The configured topics group, if it's also enabled in `groups`. */
function topicsGroupId(access: Access = store.load()): string | undefined {
  const g = access.topicsGroup
  return g && g in access.groups ? g : undefined
}

/** The topic for a session/project, created on first use. Undefined → use DMs. */
async function topicFor(name: string): Promise<{ chatId: string; threadId: number } | undefined> {
  const group = topicsGroupId()
  if (!group) return undefined
  const failedAt = topicFailures.get(name)
  if (failedAt && Date.now() - failedAt < TOPIC_RETRY_MS) return undefined
  try {
    const control = isControlTopic(store.load(), name)
    const { threadId, created } = await topics.ensure(group, name,
      async n => (await bot.api.createForumTopic(group, control ? `🎛 ${n}` : n)).message_thread_id)
    if (created) {
      log(`created topic "${name}" (#${threadId}) in ${group}`)
      const welcome = control
        ? '🎛 Orchestrator control. Write a new task as "project: request", or use /setup, /queue, /level here.'
        : topicWelcome(name)
      await bot.api.sendMessage(group, welcome, { message_thread_id: threadId }).catch(() => {})
    }
    return { chatId: group, threadId }
  } catch (err) {
    topicFailures.set(name, Date.now())
    log(`can't use a topic for "${name}" in ${group} (${err}) — using DMs. Are Topics on, and is the bot an admin with Manage Topics?`)
    return undefined
  }
}

/**
 * Send to a project's topic. When the topic was deleted in Telegram, forget
 * it, create it again and resend there once. Undefined → no topic to use
 * (or the send failed for another reason): the caller falls back to DMs.
 */
async function inTopic<T>(
  name: string,
  send: (topic: { chatId: string; threadId: number }) => Promise<T>,
  failure: (r: T) => string | undefined,
): Promise<T | undefined> {
  const topic = await topicFor(name)
  if (!topic) return undefined
  const r = await send(topic)
  const err = failure(r)
  if (err === undefined) return r
  if (isMissingTopic(err)) {
    topics.forget(topic.chatId, name)
    const fresh = await topicFor(name)
    if (fresh) {
      log(`topic "${name}" (#${topic.threadId}) is gone — recreated as #${fresh.threadId}`)
      const again = await send(fresh)
      const err2 = failure(again)
      if (err2 === undefined) return again
      log(`send to topic "${name}" failed (${err2}) — using DMs`)
      return undefined
    }
  }
  log(`send to topic "${name}" failed (${err}) — using DMs`)
  return undefined
}

const errorText = (err: unknown): string => err instanceof GrammyError ? err.description : String(err)

/** Send an approval prompt to the project's topic, or allowlisted DMs. */
async function requestApproval(req: PermissionRequest, name: string | undefined, access: Access): Promise<void> {
  if (name && !isControlTopic(access, name)) {
    const sent = await inTopic(name, t => relay.request(req, [t], Date.now(), name),
      r => r.delivered ? undefined : errorText(r.errors[0]))
    if (sent) return
  }
  await relay.request(req, access.allowFrom, Date.now(), name)
}

// --- questions (ask_owner) -----------------------------------------------------

const questions = new QuestionStore(STATE_DIR)
/** ASK_HOLD_MS; tests shorten it. */
const HOLD_MS = Number(process.env.TELEGRAM_PLUS_ASK_HOLD_MS) || ASK_HOLD_MS
/** Question id → ask_owner calls waiting for its answer right now. */
const askWaiters = new Map<string, Set<() => void>>()

function wakeAskWaiters(id: string): void {
  for (const wake of askWaiters.get(id) ?? []) wake()
  askWaiters.delete(id)
}

async function postQuestion(body: AskBody, access: Access): Promise<AskResult> {
  const question = body.question.trim()
  if (question.length > MAX_QUESTION_CHARS) {
    return { error: `question is ${question.length} chars; keep it under ${MAX_QUESTION_CHARS} (put the details in a file or a reply first)` }
  }
  let rows: string[][] | undefined
  try {
    rows = parseAskButtons(body.buttons)
    buildKeyboard(rows) // same limits as reply buttons
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  // The orchestrator's lead may answer it first: hold it, unless no orchestrator is there to decide.
  if (body.via === 'orchestrator' && streams.has(ORCHESTRATOR_STREAM)) {
    const now = Date.now()
    const q = questions.add({
      session: body.session, asker: body.asker, question, askedAt: now, messages: [],
      ...(body.topic ? { topic: body.topic } : {}), ...(rows ? { buttons: rows } : {}), held: { until: now + HOLD_MS },
    })
    toOrchestrator(questionEvent(q))
    log(`question ${q.id} from ${body.asker} held for the orchestrator`)
    return { id: q.id }
  }
  const messages = await sendQuestion(body.asker, question, rows, body.topic, access)
  if (messages.length === 0) return { error: 'could not post the question to Telegram (see hub.log)' }
  const q = questions.add({ session: body.session, asker: body.asker, question, askedAt: Date.now(), messages })
  recordInboxOwner(messages, body.session) // later replies to it reach the asker's inbox
  log(`question ${q.id} from ${body.asker} posted`)
  return { id: q.id }
}

function questionEvent(q: Question): OrchestratorEvent {
  return {
    type: 'question', id: q.id, asker: q.asker, question: q.question, at: q.askedAt, until: q.held?.until ?? q.askedAt,
    ...(q.topic ? { topic: q.topic } : {}), ...(q.buttons ? { buttons: q.buttons } : {}),
  }
}

/** Posts a held question (with the orchestrator's note, if any). False if it couldn't be posted. */
async function releaseQuestion(q: Question, note?: string): Promise<boolean> {
  const messages = await sendQuestion(q.asker, q.question, q.buttons, q.topic, store.load(), note)
  if (messages.length === 0) return false
  questions.release(q.id, messages)
  recordInboxOwner(messages, q.session)
  log(`question ${q.id} from ${q.asker} posted${note ? ' with a note' : ''}`)
  return true
}

/** Held questions whose time is up are posted, so a question never waits on an orchestrator that's gone. */
async function releaseOverdue(now = Date.now()): Promise<void> {
  for (const q of questions.held()) if (q.held!.until <= now) await releaseQuestion(q)
}

async function sendQuestion(asker: string, question: string, rows: string[][] | undefined, topic: string | undefined, access: Access, note?: string): Promise<QuestionMessage[]> {
  const text = `${questionText(asker, question, !!rows)}${note?.trim() ? `\n\n🧭 ${note.trim()}` : ''}`
  const send = async (chatId: string, threadId?: number): Promise<QuestionMessage> => {
    const sent = await bot.api.sendMessage(chatId, text, {
      ...(rows ? { reply_markup: buildKeyboard(rows) } : {}),
      ...(threadId != null ? { message_thread_id: threadId } : {}),
    })
    return { chatId, messageId: sent.message_id, ...(threadId != null ? { threadId } : {}) }
  }

  const messages: QuestionMessage[] = []
  if (topic && !isControlTopic(access, topic)) {
    const r = await inTopic(topic,
      t => send(t.chatId, t.threadId).catch((err: unknown) => ({ error: errorText(err) })),
      r => 'error' in r ? r.error : undefined)
    if (r && !('error' in r)) messages.push(r)
  }
  if (messages.length === 0) {
    for (const chatId of access.allowFrom) {
      try {
        messages.push(await send(chatId))
      } catch (err) {
        log(`question to ${chatId} failed: ${err}`)
      }
    }
  }
  return messages
}

/** Show the answer under every copy of the question and drop its buttons. */
async function closeQuestion(q: Question, note: string): Promise<void> {
  const text = `${questionHeader(q.asker, q.question)}\n\n${note}`
  await Promise.all(q.messages.map(m =>
    bot.api.editMessageText(m.chatId, m.messageId, text, { reply_markup: { inline_keyboard: [] } }).catch(() => {}),
  ))
}

/**
 * Is this inbound message an answer to an open question? A button tap on the
 * question, a reply to it, or — when exactly one question is open in that
 * chat/topic — any other message there, except a reply to a session's
 * message. Only allowlisted users can answer, the same as approvals. Returns
 * true when the message was consumed.
 */
async function answerQuestion(n: ChannelNotification): Promise<boolean> {
  const meta = n.meta
  if (meta.edited || !meta.user_id || !store.load().allowFrom.includes(meta.user_id)) return false
  const chatId = meta.chat_id!
  const thread = meta.thread_id != null ? Number(meta.thread_id) : undefined
  const ref = meta.button_message_id ?? meta.reply_to_message_id
  const refQuestion = ref != null ? questions.byMessage(chatId, Number(ref)) : undefined

  let q: Question | undefined
  if (refQuestion) {
    q = refQuestion
    if (q.answer && inboxSessions.has(q.session)) return false // a follow-up: goes to the asker's inbox
    if (q.answer) {
      await bot.api.sendMessage(chatId, 'That question was already answered.', { message_thread_id: thread }).catch(() => {})
      return true
    }
  } else {
    // A tap on another message's buttons, or a reply meant for a session.
    // (In a forum topic every message "replies" to the topic's first
    // message, so other replies don't rule a message out.)
    if (meta.button_message_id != null) return false
    if (ref != null && router.ownerOf(chatId, Number(ref))) return false
    const open = questions.openIn(chatId, thread)
    if (open.length === 0) return false
    if (open.length > 1) {
      await bot.api.sendMessage(chatId,
        `${open.length} questions are open here. Reply to the one you're answering (or tap its button).`,
        { message_thread_id: thread }).catch(() => {})
      return true
    }
    q = open[0]!
  }

  const by = meta.user ? (/^\d+$/.test(meta.user) ? meta.user_name || meta.user : `@${meta.user}`) : 'owner'
  if (!questions.answer(q.id, n.content, by)) return true
  log(`question ${q.id} answered by ${by}`)
  wakeAskWaiters(q.id)
  await closeQuestion(q, `→ ${safeSnippet(n.content, 200) ?? n.content} (${by})`)
  if (!meta.button_choice && meta.message_id) {
    void bot.api.setMessageReaction(chatId, Number(meta.message_id), [{ type: 'emoji', emoji: '👍' }]).catch(() => {})
  }
  return true
}

// --- owner-message inbox ---------------------------------------------------------

type InboxSession = InboxConnectBody & { queue: InboxMessage[] }
/** Sessions that opted in with TELEGRAM_PLUS_INBOX, by session id, while connected. */
const inboxSessions = new Map<string, InboxSession>()
/** `${chatId}:${messageId}` → inbox session id that sent it. Bounded, insertion-ordered. */
const inboxOwners = new Map<string, string>()
const MAX_INBOX_OWNED = 5000
const MAX_INBOX_QUEUE = 50

function recordInboxOwner(messages: { chatId: string; messageId: number }[], sessionId: string): void {
  for (const m of messages) {
    inboxOwners.set(`${m.chatId}:${m.messageId}`, sessionId)
    if (inboxOwners.size > MAX_INBOX_OWNED) inboxOwners.delete(inboxOwners.keys().next().value!)
  }
}

const react = (chatId: string, messageId: number, emoji: '👀' | '👍') =>
  bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]).catch(() => {})

/**
 * Queue an owner message for an inbox session: a reply to (or tap on) one of
 * its messages, or any message in the topic of exactly one inbox session.
 * Runs after ask_owner's answer matching, so a plain message still answers
 * the single open question there. Returns true when consumed.
 */
async function queueForInbox(n: ChannelNotification): Promise<boolean> {
  if (inboxSessions.size === 0) return false
  const meta = n.meta
  if (meta.edited || !meta.user_id || !store.load().allowFrom.includes(meta.user_id)) return false
  const chatId = meta.chat_id!
  const thread = meta.thread_id != null ? Number(meta.thread_id) : undefined
  const ref = meta.button_message_id ?? meta.reply_to_message_id

  let target: InboxSession | undefined
  const owner = ref != null ? inboxOwners.get(`${chatId}:${ref}`) : undefined
  if (owner && inboxSessions.has(owner)) {
    target = inboxSessions.get(owner)
  } else {
    if (ref != null && router.ownerOf(chatId, Number(ref))) return false // meant for a channel session
    const group = topicsGroupId()
    const topic = group && chatId === group && thread != null ? topics.nameFor(group, thread) : undefined
    if (!topic) return false
    const here = [...inboxSessions.values()].filter(s => s.topic === topic)
    if (here.length === 0) return false
    if (here.length > 1) {
      await bot.api.sendMessage(chatId,
        `${here.length} agents are running here (${here.map(s => s.name).join(', ')}). Reply to a message from the one you mean.`,
        { message_thread_id: thread }).catch(() => {})
      return true
    }
    target = here[0]!
  }
  if (!target) return false

  if (meta.attachment_kind || meta.image_path) {
    await bot.api.sendMessage(chatId, `Attachments aren't supported for agents. Send ${target.name} text instead.`,
      { message_thread_id: thread }).catch(() => {})
    return true
  }
  if (target.queue.length >= MAX_INBOX_QUEUE) {
    await bot.api.sendMessage(chatId, `${target.name} already has ${MAX_INBOX_QUEUE} unread messages. Wait for it to catch up.`,
      { message_thread_id: thread }).catch(() => {})
    return true
  }
  const by = meta.user ? (/^\d+$/.test(meta.user) ? meta.user_name || meta.user : `@${meta.user}`) : 'owner'
  target.queue.push({ chatId, messageId: Number(meta.message_id), threadId: thread, text: n.content, by, at: Date.now() })
  if (!meta.button_choice) void react(chatId, Number(meta.message_id), '👀') // queued
  log(`queued a message for ${target.name} (${target.queue.length} waiting)`)
  return true
}

/** Hand everything queued to the session's hook, oldest first, and mark it delivered. */
function takeInbox(sessionId: string): InboxMessage[] {
  const s = inboxSessions.get(sessionId)
  if (!s || s.queue.length === 0) return []
  const messages = s.queue.splice(0)
  for (const m of messages) if (m.messageId) void react(m.chatId, m.messageId, '👍') // delivered
  log(`delivered ${messages.length} message(s) to ${s.name}`)
  return messages
}

/** The session ended: tell the owner what it never read. */
async function closeInbox(s: InboxSession): Promise<void> {
  if (!s.queue.some(m => m.chatId)) return
  const byChat = new Map<string, InboxMessage[]>()
  // Relayed messages have no Telegram message to reply to; the orchestrator that sent them tracks its sessions.
  for (const m of s.queue.filter(m => m.chatId)) byChat.set(`${m.chatId}:${m.threadId ?? ''}`, [...(byChat.get(`${m.chatId}:${m.threadId ?? ''}`) ?? []), m])
  for (const ms of byChat.values()) {
    const first = ms[0]!
    await bot.api.sendMessage(first.chatId,
      `⚠️ ${s.name} ended before reading ${ms.length === 1 ? 'your message' : `${ms.length} of your messages`}. ${ms.length === 1 ? 'It was' : 'They were'} not delivered.`,
      { message_thread_id: first.threadId, reply_parameters: { message_id: first.messageId, allow_sending_without_reply: true } },
    ).catch(err => log(`undelivered notice failed: ${err}`))
  }
}

// --- orchestrator -------------------------------------------------------------------

const ORCHESTRATOR_STREAM = 'orchestrator'
const prompts = new PromptStore(STATE_DIR)

/** Push to the connected orchestrator. False when it isn't connected. */
function toOrchestrator(e: OrchestratorEvent): boolean {
  return push(ORCHESTRATOR_STREAM, e as unknown as HubEvent)
}

function answerEvent(p: Prompt): OrchestratorEvent {
  return { type: 'prompt_answer', id: p.id, ...(p.key ? { key: p.key } : {}), ...p.answer! }
}

type Sent = { messages: PromptMessage[]; error?: string }

/**
 * Send through the reply tool's code path (chunking, files, markup
 * fallback) to a project topic, or to every allowlisted DM when there's no
 * topic or it can't be used.
 */
async function sendTo(topicKey: string | undefined, args: Record<string, unknown>): Promise<Sent> {
  const access = store.load()
  const once = async (chatId: string, threadId?: number): Promise<Sent> => {
    const r = await callTool(toolDeps, 'reply', { ...args, chat_id: chatId, ...(threadId != null ? { thread_id: String(threadId) } : {}) })
    const messages = (r.sentIds ?? []).map(messageId => ({ chatId, messageId, ...(threadId != null ? { threadId } : {}) }))
    return { messages, ...(r.isError ? { error: r.content[0]?.text ?? 'send failed' } : {}) }
  }
  if (topicKey) {
    const r = await inTopic(topicKey, t => once(t.chatId, t.threadId), r => r.error && !r.messages.length ? r.error : undefined)
    if (r) return r
  }
  const all: Sent = { messages: [] }
  for (const chatId of access.allowFrom) {
    const r = await once(chatId)
    all.messages.push(...r.messages)
    if (r.error) all.error = r.error
  }
  if (access.allowFrom.length === 0) all.error = 'nobody to send to: no Telegram user is allowlisted'
  return all
}

// Telegram's answers for a message that can't be edited any more: post a new one instead.
const EDIT_GONE = /message to edit not found|message can't be edited|no text in the message|MESSAGE_ID_INVALID|chat not found/i

/** Edit through the edit_message tool's code path ("not modified" is fine, markup falls back to plain). */
async function editNotice(p: EditNoticeBody): Promise<EditNoticeResult> {
  if (p.chat_id == null || !Number.isInteger(p.message_id)) return { error: 'chat_id and message_id required' }
  if (typeof p.text !== 'string' || !p.text.trim()) return { error: 'text required' }
  const r = await callTool(toolDeps, 'edit_message', {
    chat_id: String(p.chat_id), message_id: String(p.message_id), text: p.text, format: p.format,
  })
  const text = r.content[0]?.text ?? ''
  if (r.isError) {
    const error = text.replace(/^edit_message failed: /, '')
    return EDIT_GONE.test(error) ? { error, gone: true } : { error }
  }
  if (text.startsWith('unchanged')) return { ok: true, unchanged: true }
  if (text.startsWith('edited as plain text')) return { ok: true, plain: true }
  return { ok: true }
}

async function postPrompt(p: PromptBody): Promise<PromptResult> {
  if (p.key) {
    const known = prompts.byKey(p.key)
    if (known) return { id: known.id, message_ids: known.messages.map(m => m.messageId) }
  }
  if (typeof p.text !== 'string' || !p.text.trim()) return { error: 'text required' }
  let rows: string[][] | undefined
  try {
    rows = parseAskButtons(p.buttons)
    buildKeyboard(rows)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  const labels = new Set((rows ?? []).flat().map(l => l.trim()))
  const needsText = (p.needs_text ?? []).filter(l => labels.has(l.trim()))

  // Files first, so the buttons end up at the bottom, right under the text.
  const sent: PromptMessage[] = []
  if (p.files?.length) {
    const f = await sendTo(p.topic, { text: '', files: p.files })
    if (f.error && f.messages.length === 0) return { error: f.error }
    sent.push(...f.messages)
  }
  const t = await sendTo(p.topic, { text: p.text, format: p.format, ...(rows ? { buttons: rows } : {}) })
  if (t.messages.length === 0) return { error: t.error ?? 'could not post the prompt' }
  // The last message per chat carries the buttons.
  const last = new Map<string, PromptMessage>()
  for (const m of t.messages) last.set(m.chatId, m)
  for (const m of last.values()) if (rows) m.buttons = true
  sent.push(...t.messages)

  const prompt = prompts.add({ key: p.key, topic: p.topic, needsText, messages: sent })
  log(`prompt ${prompt.id}${p.key ? ` (${p.key})` : ''} posted`)
  return { id: prompt.id, message_ids: sent.map(m => m.messageId) }
}

async function dropButtons(p: Prompt): Promise<void> {
  await Promise.all(p.messages.filter(m => m.buttons).map(m =>
    bot.api.editMessageReplyMarkup(m.chatId, m.messageId, { reply_markup: { inline_keyboard: [] } }).catch(() => {}),
  ))
}

function senderLabel(meta: Record<string, string>): string {
  return meta.user ? (/^\d+$/.test(meta.user) ? meta.user_name || meta.user : `@${meta.user}`) : 'owner'
}

/**
 * Is this inbound message an answer to a gate prompt? A tap on its buttons,
 * a reply to it, or — after a needs-text button — the next message in that
 * chat/topic. Allowlisted users only. Returns true when consumed.
 */
async function answerPrompt(n: ChannelNotification): Promise<boolean> {
  const meta = n.meta
  if (meta.edited || !meta.user_id || !store.load().allowFrom.includes(meta.user_id)) return false
  const chatId = meta.chat_id!
  const thread = meta.thread_id != null ? Number(meta.thread_id) : undefined
  const ref = meta.button_message_id ?? meta.reply_to_message_id
  const by = senderLabel(meta)

  let p = ref != null ? prompts.byMessage(chatId, Number(ref)) : undefined
  if (!p) {
    if (meta.button_message_id != null) return false
    const waiting = prompts.awaitingIn(chatId, thread)
    if (waiting.length !== 1) return false // none, or ambiguous: a reply picks one
    p = waiting[0]!
  }
  if (p.state === 'answered') {
    await bot.api.sendMessage(chatId, 'That was already answered.', { message_thread_id: thread }).catch(() => {})
    return true
  }

  if (meta.button_choice) {
    const label = n.content
    if (p.needsText.includes(label)) {
      prompts.awaitText(p.id, label)
      const hint = await bot.api.sendMessage(chatId, `✍️ ${label}: type your notes here (or reply to this message).`,
        { message_thread_id: thread }).catch(() => undefined)
      if (hint) prompts.addMessages(p.id, [{ chatId, messageId: hint.message_id, ...(thread != null ? { threadId: thread } : {}) }])
      return true
    }
    return finishPrompt(p, { label, by, at: Date.now() })
  }
  if (meta.attachment_kind || meta.image_path) {
    await bot.api.sendMessage(chatId, 'Please answer with text.', { message_thread_id: thread }).catch(() => {})
    return true
  }
  const label = p.state === 'awaiting_text' ? p.pendingLabel : undefined
  void react(chatId, Number(meta.message_id), '👍')
  return finishPrompt(p, { ...(label ? { label } : {}), text: n.content, by, at: Date.now() })
}

/** Removes a prompt's buttons and posts `text` under it. */
async function closeWithNote(p: Prompt, text: string): Promise<void> {
  await dropButtons(p)
  const anchor = p.messages.filter(m => m.buttons).length ? p.messages.filter(m => m.buttons) : p.messages.slice(-1)
  await Promise.all(anchor.map(m => bot.api.sendMessage(m.chatId, text, {
    message_thread_id: m.threadId,
    reply_parameters: { message_id: m.messageId, allow_sending_without_reply: true },
  }).catch(() => {})))
}

async function finishPrompt(p: Prompt, answer: { label?: string; text?: string; by: string; at: number }): Promise<boolean> {
  if (!prompts.answer(p.id, answer)) return true
  log(`prompt ${p.id} answered by ${answer.by}`)
  await dropButtons(p)
  const updated = prompts.get(p.id)!
  // Not connected: kept in prompts.json and sent when the orchestrator reconnects.
  toOrchestrator(answerEvent(updated))
  return true
}

/** Where the control topic is, if a topics group is set and the topic exists. */
function controlThread(access: Access = store.load()): { group: string; threadId: number; key: string } | undefined {
  const group = topicsGroupId(access)
  if (!group) return undefined
  const key = controlTopic(access)
  const threadId = topics.get(group, key)
  return threadId != null ? { group, threadId, key } : undefined
}

/**
 * Plain messages in the control topic belong to the orchestrator — never to
 * sessions, ask_owner or the inbox. (Answers to its own prompts there were
 * already taken by answerPrompt.) Returns true when it's that topic.
 */
async function toControlTopic(n: ChannelNotification): Promise<boolean> {
  const meta = n.meta
  const ctl = controlThread()
  if (!ctl || meta.chat_id !== ctl.group || Number(meta.thread_id) !== ctl.threadId) return false
  if (meta.edited || !meta.user_id || !store.load().allowFrom.includes(meta.user_id)) return true
  const say = (text: string) => bot.api.sendMessage(ctl.group, text, { message_thread_id: ctl.threadId }).catch(() => {})
  if (meta.attachment_kind || meta.image_path) {
    await say("Attachments aren't supported here. Send text.")
    return true
  }
  const replyTo = meta.reply_to_message_id != null ? Number(meta.reply_to_message_id) : undefined
  const delivered = toOrchestrator({
    type: 'message',
    text: n.content,
    topic: ctl.key,
    chat_id: ctl.group,
    thread_id: ctl.threadId,
    message_id: Number(meta.message_id),
    user_id: meta.user_id,
    user: senderLabel(meta),
    ts: meta.ts ?? new Date().toISOString(),
    // In a forum every message "replies" to the topic's first message; that one isn't a real reply.
    ...(replyTo != null && replyTo !== ctl.threadId ? { reply_to_message_id: replyTo } : {}),
  })
  if (!delivered) await say('Orchestrator is not running.')
  else void react(ctl.group, Number(meta.message_id), '👀')
  return true
}

/** Bot commands for the orchestrator. Allowlisted senders, DMs or the topics group only. */
async function handleOrchestratorCommand(ctx: Context, command: OrchestratorCommand): Promise<void> {
  const msg = ctx.message
  if (!msg || !ctx.from || !ctx.chat) return
  const access = store.load()
  const senderId = String(ctx.from.id)
  if (!access.allowFrom.includes(senderId) || access.dmPolicy === 'disabled') return
  const chatId = String(ctx.chat.id)
  const group = topicsGroupId(access)
  if (ctx.chat.type !== 'private' && chatId !== group) return
  const thread = msg.is_topic_message ? msg.message_thread_id : undefined
  const threadTopic = group && chatId === group && thread != null ? topics.nameFor(group, thread) : undefined
  const control = isControlTopic(access, threadTopic)
  const topic = control ? undefined : threadTopic
  const say = (text: string) => ctx.reply(text, thread != null ? { message_thread_id: thread } : {}).catch(() => {})
  const args = typeof ctx.match === 'string' ? ctx.match.trim() : ''

  if (command === 'task' && !topic && !control) return void say('Send /task in a project\'s topic, or write "project: request" in the orchestrator topic.')
  if (command === 'task' && !args) return void say('Usage: /task <what to build or fix>')
  if (command === 'setup' && topic) return void say('Send /setup in the General topic or a DM.')

  const delivered = toOrchestrator({
    type: 'command',
    command,
    args,
    ...(topic ? { topic } : {}),
    ...(control ? { control: true as const } : {}),
    chat_id: chatId,
    ...(thread != null ? { thread_id: thread } : {}),
    message_id: msg.message_id,
    user_id: senderId,
    user: ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name,
    ts: new Date(msg.date * 1000).toISOString(),
  })
  if (!delivered) return void say('Orchestrator is not running.')
  void react(chatId, msg.message_id, '👀')
}

for (const command of ORCHESTRATOR_COMMANDS) {
  bot.command(command, ctx => handleOrchestratorCommand(ctx, command))
}

// --- routing inbound messages ---------------------------------------------

const held = new Map<string, ChannelNotification[]>()
const pickerSent = new Set<string>()

function sessionKeyboard(chatId: string, prefix = 'use'): InlineKeyboard {
  const kb = new InlineKeyboard()
  const active = router.activeFor(chatId)?.id
  router.list().forEach((s, i) => {
    if (i > 0 && i % 2 === 0) kb.row()
    kb.text(`${s.id === active ? '✓ ' : ''}${s.name}`, `${prefix}:${s.id}`)
  })
  return kb
}

async function deliver(n: ChannelNotification): Promise<boolean> {
  touch()
  if (await answerPrompt(n)) return false // consumed; stops the typing indicator
  if (await toControlTopic(n)) return false
  if (await answerQuestion(n)) return false
  if (await queueForInbox(n)) return false
  const chatId = n.meta.chat_id!
  const replyTo = n.meta.reply_to_message_id ?? n.meta.button_message_id
  const group = topicsGroupId()
  const thread = n.meta.thread_id != null ? Number(n.meta.thread_id) : undefined
  const topicSession = group && chatId === group && thread != null ? topics.nameFor(group, thread) : undefined
  const route = router.route(chatId, replyTo != null ? Number(replyTo) : undefined, topicSession)

  if (route.kind === 'session') {
    if (push(route.session.id, { type: 'inbound', content: n.content, meta: n.meta })) return true
    router.remove(route.session.id) // stream died without us noticing
    return deliver(n)
  }

  if (route.kind === 'offline') {
    await bot.api.sendMessage(chatId,
      `${route.name} isn't connected right now. Start it with claude-tg in that project.`,
      { message_thread_id: thread }).catch(() => {})
    return false
  }

  if (route.kind === 'none') {
    if (n.meta.chat_type === 'private') {
      await bot.api.sendMessage(chatId,
        'No Claude Code session is connected right now. Start one with claude-tg.').catch(() => {})
    }
    return false
  }

  // Several sessions and no choice for this chat yet: hold the message and ask.
  const queue = held.get(chatId) ?? []
  queue.push(n)
  if (queue.length > MAX_HELD_PER_CHAT) queue.shift()
  held.set(chatId, queue)
  if (!pickerSent.has(chatId)) {
    pickerSent.add(chatId)
    await bot.api.sendMessage(chatId, 'Which session should get this?', {
      reply_markup: sessionKeyboard(chatId),
      ...(n.meta.thread_id ? { message_thread_id: Number(n.meta.thread_id) } : {}),
    }).catch(err => log(`picker send failed: ${err}`))
  }
  return false
}

function activate(chatId: string, session: SessionInfo): void {
  router.setActive(chatId, session.id)
  pickerSent.delete(chatId)
  const queue = held.get(chatId) ?? []
  held.delete(chatId)
  for (const n of queue) {
    if (push(session.id, { type: 'inbound', content: n.content, meta: n.meta })) typing.start(chatId)
  }
}

// --- bot commands for sessions (registered before the generic handlers) ----

function canSwitch(ctx: Context, access: Access): boolean {
  if (!ctx.from || !ctx.chat) return false
  const senderId = String(ctx.from.id)
  if (ctx.chat.type === 'private') {
    return dmCommandAllowed(access, 'private', senderId) && access.allowFrom.includes(senderId)
  }
  return callbackAllowed(access, ctx.chat.type, String(ctx.chat.id), senderId)
}

bot.command('sessions', async ctx => {
  if (!canSwitch(ctx, store.load())) return
  const chatId = String(ctx.chat.id)
  if (router.size === 0) {
    await ctx.reply('No Claude Code session is connected. Start one with claude-tg.')
    return
  }
  const active = router.activeFor(chatId)
  const lines = router.list().map(s => `${s.id === active?.id ? '▶︎' : '•'} ${s.name} — ${s.cwd}`)
  await ctx.reply(`Connected sessions:\n${lines.join('\n')}\n\nTap one to send this chat's messages there.`, {
    reply_markup: sessionKeyboard(chatId),
  })
})

bot.command('use', async ctx => {
  if (!canSwitch(ctx, store.load())) return
  const name = ctx.match.trim()
  const session = name ? router.findByName(name) : undefined
  if (!session) {
    await ctx.reply(name ? `No session named "${name}". Try /sessions.` : 'Usage: /use <session name> — see /sessions.')
    return
  }
  activate(String(ctx.chat.id), session)
  await ctx.reply(`Now talking to ${session.name}.`)
})

bot.callbackQuery(/^use:(.+)$/, async ctx => {
  if (!canSwitch(ctx, store.load())) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const session = router.get(ctx.match[1]!)
  if (!session || !ctx.chat) {
    await ctx.answerCallbackQuery({ text: 'That session is gone. Try /sessions.' }).catch(() => {})
    return
  }
  activate(String(ctx.chat.id), session)
  await ctx.answerCallbackQuery({ text: `→ ${session.name}` }).catch(() => {})
  await ctx.editMessageText(`Talking to ${session.name}.`).catch(() => {})
})

// --- /here: make this group the topics group, from Telegram -------------------

/** What's missing for this chat to work as the topics group (empty: nothing). */
async function topicsGroupProblems(ctx: Context): Promise<string[]> {
  const problems: string[] = []
  if (!ctx.chat || !('is_forum' in ctx.chat) || !ctx.chat.is_forum) problems.push('Turn on Topics in the group settings.')
  const me = await ctx.getChatMember(ctx.me.id).catch(() => undefined)
  const canManage = me?.status === 'creator' || (me?.status === 'administrator' && me.can_manage_topics)
  if (!canManage) problems.push('Make me an admin with Manage Topics.')
  return problems
}

// Works in groups the gate doesn't know yet (that's the point), so only
// allowlisted senders get any answer; everyone else is dropped silently.
bot.command('here', async ctx => {
  if (!ctx.from || !ctx.chat || !ctx.message) return
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return
  const access = store.load()
  const senderId = String(ctx.from.id)
  if (access.dmPolicy === 'disabled' || !access.allowFrom.includes(senderId)) return
  const chatId = String(ctx.chat.id)
  const thread = ctx.message.is_topic_message ? ctx.message.message_thread_id : undefined
  const say = (text: string) => ctx.reply(text, thread != null ? { message_thread_id: thread } : {}).catch(() => {})
  const change = `To change it, run in Claude Code: /telegram-plus:access set topicsGroup ${chatId}`
  const problems = await topicsGroupProblems(ctx)
  const fix = problems.length ? `\n\nTo fix:\n${problems.map(p => `• ${p}`).join('\n')}` : ''

  if (chatId in access.groups) {
    if (access.topicsGroup === chatId) return void say(`✅ This group is the topics group.${fix}`)
    return void say(`This group is enabled, but it isn't the topics group (${access.topicsGroup ? `that's ${access.topicsGroup}` : 'none is set'}).\n${change}${fix}`)
  }
  if (problems.length) return void say(`This group can't be the topics group yet.${fix}\n\nThen send /here again.`)
  if (store.isStatic) return void say('Access is in static mode, so I can\'t change it from here. Edit access.json instead.')

  const result = store.update(a => {
    if (a.topicsGroup && a.topicsGroup !== chatId) return { taken: a.topicsGroup }
    a.groups[chatId] = { requireMention: false, allowFrom: [senderId] }
    a.topicsGroup = chatId
    return { taken: undefined }
  })
  if (result.taken) return void say(`A topics group is already set (${result.taken}), so I left this one alone.\n${change}`)
  log(`/here: ${chatId} is now the topics group (by ${senderId})`)
  await say('✅ This group is now the topics group.')
  if (streams.has(ORCHESTRATOR_STREAM)) void topicFor(controlTopic(store.load())) // it connected before there was a group
})

registerInbound({
  bot,
  store,
  relay,
  typing,
  token: TOKEN,
  inboxDir: INBOX_DIR,
  botUsername: () => botUsername,
  deliver,
  // A question's buttons answer it, so only allowlisted users may tap them.
  tapAllowed: (chatId, messageId, senderId) =>
    !(questions.byMessage(chatId, messageId) || prompts.byMessage(chatId, messageId)) || store.load().allowFrom.includes(senderId),
  log,
})

bot.catch(err => log(`handler error (polling continues): ${err.error}`))

// --- local API ---------------------------------------------------------------

function sessionPrefix(name: string, format: unknown): string {
  if (format === 'html') return `<b>[${name}]</b> `
  if (format === 'markdownv2') return `*\\[${name.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')}\\]* `
  return `[${name}] `
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url)
  touch()

  if (req.method === 'GET' && pathname === '/health') {
    return json({ ok: true, pid: process.pid, sessions: router.size })
  }
  if (req.method === 'GET' && pathname === '/status') {
    return json({
      sessions: router.list(),
      inboxSessions: [...inboxSessions.values()].map(s => ({ name: s.name, topic: s.topic, cwd: s.cwd, queued: s.queue.length })),
      pendingApprovals: hookRequests.size,
      openQuestions: questions.openCount,
      orchestrator: streams.has(ORCHESTRATOR_STREAM),
      openPrompts: prompts.openCount,
    })
  }
  if (req.method !== 'POST') return json({ error: 'not found' }, 404)

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return json({ error: 'bad json' }, 400)

  switch (pathname) {
    case '/session/connect': {
      const { id, name, cwd } = body as ConnectBody
      if (!id) return json({ error: 'id required' }, 400)
      const info = router.add(id, name || projectLabel(cwd), cwd ?? '')
      let ping: ReturnType<typeof setInterval>
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          try { streams.get(id)?.close() } catch {}
          streams.set(id, controller)
          push(id, { type: 'hello', name: info.name })
          ping = setInterval(() => {
            if (!push(id, { type: 'ping' })) clearInterval(ping)
          }, 20_000)
          log(`session connected: ${info.name} (${cwd})`)
          // No topic yet: it's made when something is first sent there, or by POST /topic/ensure.
          if (isControlTopic(store.load(), info.name)) log(`"${info.name}" is the orchestrator's control topic — this session gets no topic`)
        },
        cancel() {
          clearInterval(ping)
          if (streams.get(id)) {
            streams.delete(id)
            router.remove(id)
            log(`session disconnected: ${info.name}`)
          }
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } })
    }

    case '/tool': {
      const { session, name, args } = body as ToolCallBody
      const inbox = inboxSessions.get(session)
      if (inbox) {
        // Inbox sessions send through the hub so replies to their messages find them.
        const result = await callTool(toolDeps, name, args ?? {})
        if (result.sentIds?.length && typeof args?.chat_id === 'string') {
          recordInboxOwner(result.sentIds.map(messageId => ({ chatId: args.chat_id as string, messageId })), session)
        }
        return json(result)
      }
      const info = router.get(session)
      if (!info) return json({ content: [{ type: 'text', text: `${name} failed: session not connected to the hub` }], isError: true })
      const a = { ...(args ?? {}) }
      // With several sessions on one bot, say who's talking — except in the
      // session's own topic, where it's obvious.
      const group = topicsGroupId()
      const ownTopic = group && !isControlTopic(store.load(), info.name) ? topics.get(group, info.name) : undefined
      const inOwnTopic = ownTopic != null && a.chat_id === group && Number(a.thread_id) === ownTopic
      if (name === 'reply' && router.size > 1 && !inOwnTopic && typeof a.text === 'string' && a.text) {
        a.text = sessionPrefix(info.name, a.format) + a.text
      }
      const result = await callTool(toolDeps, name, a)
      if (result.sentIds?.length && typeof a.chat_id === 'string') {
        router.recordOwner(a.chat_id, result.sentIds, session)
      }
      return json(result)
    }

    case '/permission/request': {
      const p = body as PermissionRequestBody
      const info = router.get(p.session)
      channelRequests.set(p.request_id, p.session)
      await requestApproval(
        { request_id: p.request_id, tool_name: p.tool_name, description: p.description, input_preview: p.input_preview },
        info?.name,
        store.load(),
      )
      return json({ ok: true })
    }

    case '/hook/permission': {
      const p = body as HookPermissionBody
      const access = store.load()
      if (access.approvals === 'off' || access.allowFrom.length === 0) return json({})
      const id = newRequestId(x => relay.has(x) || hookRequests.has(x))
      const toolInput = (p.tool_input ?? {}) as Record<string, unknown>
      const description = typeof toolInput.description === 'string' ? toolInput.description : p.tool_name
      const timeoutS = access.approvalTimeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_S
      const result = new Promise<HookPermissionResult>(resolve => {
        hookRequests.set(id, {
          sessionId: p.session_id,
          resolve,
          timer: setTimeout(() => finishHookRequest(id, '⌛ No answer in time — decide in the terminal'), timeoutS * 1000),
        })
      })
      // The hook process goes away if Claude Code moves on without it.
      req.signal.addEventListener('abort', () => finishHookRequest(id, '✔︎ Handled in the terminal'))
      await requestApproval(
        { request_id: id, tool_name: p.tool_name, description, input_preview: previewInput(p.tool_input) },
        p.topic || topicName(projectLabel(p.cwd)),
        access,
      )
      return json(await result)
    }

    case '/hook/event': {
      // A turn ended or a new prompt arrived: anything still waiting for this
      // session was answered at the terminal.
      const { session_id } = body as HookEventBody
      for (const [id, h] of hookRequests) {
        if (h.sessionId === session_id) finishHookRequest(id, '✔︎ Answered in the terminal')
      }
      // Channel sessions' relayed prompts too: hook session_id and the
      // channel server's CLAUDE_CODE_SESSION_ID are the same id.
      for (const [id, sid] of channelRequests) {
        if (sid !== session_id) continue
        channelRequests.delete(id)
        void relay.cancel(id, '✔︎ Answered in the terminal')
      }
      return json({ ok: true })
    }

    case '/inbox/connect': {
      const p = body as InboxConnectBody
      if (!p.id || !p.topic) return json({ error: 'id and topic required' }, 400)
      const reserved = isControlTopic(store.load(), p.topic)
      if (reserved) log(`inbox session ${p.name} asked for the control topic "${p.topic}" — it gets no topic`)
      const s: InboxSession = { ...p, topic: reserved ? '' : p.topic, queue: inboxSessions.get(p.id)?.queue ?? [] }
      let ping: ReturnType<typeof setInterval>
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          try { streams.get(`inbox:${p.id}`)?.close() } catch {}
          streams.set(`inbox:${p.id}`, controller)
          inboxSessions.set(p.id, s)
          push(`inbox:${p.id}`, { type: 'hello', name: p.name })
          ping = setInterval(() => {
            if (!push(`inbox:${p.id}`, { type: 'ping' })) clearInterval(ping)
          }, 20_000)
          log(`inbox session connected: ${p.name} (topic ${s.topic || 'none'})`)
        },
        cancel() {
          clearInterval(ping)
          if (inboxSessions.get(p.id) !== s) return // replaced by a reconnect
          streams.delete(`inbox:${p.id}`)
          inboxSessions.delete(p.id)
          log(`inbox session disconnected: ${p.name}`)
          void closeInbox(s)
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } })
    }

    case '/inbox/take': {
      const { session_id } = body as InboxTakeBody
      return json({ messages: takeInbox(session_id).map(m => ({ text: m.text, by: m.by, ...(m.relayed ? { relayed: true as const } : {}) })) } satisfies InboxTakeResult)
    }

    case '/inbox/send': {
      const p = body as InboxSendBody
      if (!p.name || !p.text?.trim() || !p.by) return json({ error: 'name, text and by required' } satisfies InboxSendResult)
      const target = [...inboxSessions.values()].find(x => x.name === p.name)
      if (!target) return json({ error: `${p.name} isn't connected` } satisfies InboxSendResult)
      if (target.queue.length >= MAX_INBOX_QUEUE) return json({ error: `${p.name} already has ${MAX_INBOX_QUEUE} unread messages` } satisfies InboxSendResult)
      target.queue.push({ chatId: '', messageId: 0, text: p.text, by: p.by, relayed: true, at: Date.now() })
      log(`queued a relayed message for ${target.name} (${target.queue.length} waiting)`)
      return json({ ok: true, queued: target.queue.length } satisfies InboxSendResult)
    }

    case '/orchestrator/connect': {
      let ping: ReturnType<typeof setInterval>
      let mine: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mine = controller
          try { streams.get(ORCHESTRATOR_STREAM)?.close() } catch {} // one orchestrator: the newest wins
          streams.set(ORCHESTRATOR_STREAM, controller)
          toOrchestrator({ type: 'hello', name: 'orchestrator' })
          for (const p of prompts.answered()) toOrchestrator(answerEvent(p)) // answered while it was away
          for (const q of questions.held()) toOrchestrator(questionEvent(q)) // still waiting for it
          ping = setInterval(() => {
            if (!toOrchestrator({ type: 'ping' })) clearInterval(ping)
          }, 20_000)
          log('orchestrator connected')
          if (topicsGroupId()) void topicFor(controlTopic(store.load())) // its control topic
        },
        cancel() {
          clearInterval(ping)
          if (streams.get(ORCHESTRATOR_STREAM) !== mine) return
          streams.delete(ORCHESTRATOR_STREAM)
          log('orchestrator disconnected')
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } })
    }

    case '/prompt':
      return json(await postPrompt(body as PromptBody))

    case '/prompt/ack': {
      const { id } = body as { id: string }
      return json({ ok: !!prompts.remove(id) })
    }

    case '/prompt/cancel': {
      const { id, note } = body as { id: string; note?: string }
      const p = prompts.remove(id)
      if (!p) return json({ ok: false })
      await closeWithNote(p, `✖️ ${note?.trim() || 'Withdrawn'}`)
      log(`prompt ${id} cancelled`)
      return json({ ok: true })
    }

    case '/prompt/close': {
      // Answered somewhere else (e.g. the owner told the orchestrator's lead). A prompt
      // the owner already answered here is left alone: that answer is on its way.
      const { id, note } = body as { id: string; note?: string }
      if (!note?.trim()) return json({ error: 'note required' }, 400)
      const open = prompts.get(id)
      if (!open || open.state === 'answered') return json({ ok: false })
      const p = prompts.remove(id)!
      await closeWithNote(p, note.trim())
      log(`prompt ${id} closed`)
      return json({ ok: true })
    }

    case '/notice': {
      const p = body as NoticeBody
      if (!p.text?.trim() && !p.files?.length) return json({ error: 'text or files required' } satisfies NoticeResult)
      const r = await sendTo(p.topic, { text: p.text ?? '', files: p.files ?? [], format: p.format })
      if (r.messages.length === 0) return json({ error: r.error ?? 'could not send' } satisfies NoticeResult)
      return json({
        message_ids: r.messages.map(m => m.messageId),
        messages: r.messages.map(m => ({ chat_id: m.chatId, message_id: m.messageId, ...(m.threadId != null ? { thread_id: m.threadId } : {}) })),
      } satisfies NoticeResult)
    }

    case '/notice/edit':
      return json(await editNotice(body as EditNoticeBody))

    case '/topic/ensure': {
      const { topic } = body as { topic?: string }
      if (!topic?.trim()) return json({ error: 'topic required' } satisfies TopicResult)
      if (!topicsGroupId()) return json({ error: 'no topics group configured (/telegram-plus:access set topicsGroup)' } satisfies TopicResult)
      topicFailures.delete(topic)
      const t = await topicFor(topic.trim())
      return json((t ? { chat_id: t.chatId, thread_id: t.threadId } : { error: 'could not create the topic (see hub.log)' }) satisfies TopicResult)
    }

    case '/ask': {
      const p = body as AskBody
      if (!p.session || typeof p.question !== 'string' || !p.question.trim()) return json({ error: 'session and question required' }, 400)
      // Asked again after "no answer yet": same question, not posted twice.
      const known = questions.find(p.session, p.question)
      if (known) return json({ id: known.id } satisfies AskResult)
      const access = store.load()
      if (access.allowFrom.length === 0) {
        return json({ error: 'nobody to ask: no Telegram user is allowlisted (pair one with /telegram-plus:access)' } satisfies AskResult)
      }
      return json(await postQuestion(p, access))
    }

    case '/ask/answer': {
      const { id, text, by } = body as AskAnswerBody
      if (!id || typeof text !== 'string' || !text.trim() || !by?.trim()) return json({ error: 'id, text and by required' }, 400)
      const q = questions.get(id)
      if (!q || !questions.answer(id, text, by.trim())) return json({ ok: false })
      log(`question ${id} answered by ${by}`)
      wakeAskWaiters(id)
      const answered = `🧭 ${by.trim()}: ${safeSnippet(text, 500) ?? text}`
      // Posted: show the answer under it. Held: the owner never saw it, so show both.
      if (q.messages.length) await closeQuestion(q, answered)
      else await sendTo(q.topic, { text: `${questionHeader(q.asker, q.question)}\n\n${answered}` })
      return json({ ok: true })
    }

    case '/ask/post': {
      const { id, note } = body as AskPostBody
      const q = questions.get(id)
      if (!q?.held || q.answer) return json({ ok: false })
      return json(await releaseQuestion(q, note) ? { ok: true } : { error: 'could not post the question to Telegram (see hub.log)' })
    }

    case '/ask/wait': {
      const { id, wait_ms } = body as AskWaitBody
      const collect = (): AskWaitResult | undefined => {
        const q = questions.get(id)
        if (!q) return { status: 'unknown' }
        const a = questions.take(id)
        return a ? { status: 'answered', answer: a.text, by: a.by } : undefined
      }
      const now = collect()
      if (now) return json(now)
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, Math.max(0, Math.min(Number(wait_ms) || 0, 60_000)))
        req.signal.addEventListener('abort', done)
        const set = askWaiters.get(id) ?? new Set()
        set.add(done)
        askWaiters.set(id, set)
        function done() {
          clearTimeout(timer)
          set.delete(done)
          resolve()
        }
      })
      // The caller went away (tool call cancelled): leave the answer stored.
      if (req.signal.aborted) return json({ status: 'pending' } satisfies AskWaitResult)
      return json(collect() ?? ({ status: 'pending' } satisfies AskWaitResult))
    }

    default:
      return json({ error: 'not found' }, 404)
  }
}

const server = Bun.serve({ unix: SOCKET, idleTimeout: 0, fetch: handle })
log(`listening on ${SOCKET} (pid ${process.pid})`)

// --- housekeeping ----------------------------------------------------------

// The access skill drops approved/<senderId> when it pairs someone.
function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch {
    return
  }
  for (const senderId of files) {
    rmSync(join(APPROVED_DIR, senderId), { force: true })
    if (!/^-?\d+$/.test(senderId)) continue
    void bot.api.sendMessage(senderId, 'Paired! Say hi to Claude.').catch(err => log(`approval confirm failed: ${err}`))
  }
}
setInterval(checkApprovals, 5000).unref()
setInterval(() => void relay.prune(), 60_000).unref()
const pruneQuestions = () => {
  for (const q of questions.prune()) void closeQuestion(q, '⌛ Expired — nobody is waiting for this answer anymore')
}
pruneQuestions()
const prunePrompts = () => {
  for (const p of prompts.prune()) void dropButtons(p)
}
prunePrompts()
setInterval(prunePrompts, 60 * 60 * 1000).unref()
setInterval(pruneQuestions, 60 * 60 * 1000).unref()
setInterval(() => void releaseOverdue().catch(err => log(`releasing held questions failed: ${err}`)), 5000).unref()
const sweepInbox = () => {
  const n = cleanInbox(INBOX_DIR, INBOX_MAX_AGE_MS)
  if (n) log(`removed ${n} old inbox file(s)`)
}
sweepInbox()
setInterval(sweepInbox, 60 * 60 * 1000).unref()

let shuttingDown = false
function shutdown(reason: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down: ${reason}`)
  typing.stopAll()
  for (const id of [...hookRequests.keys()]) finishHookRequest(id, '⌛ Hub stopped — decide in the terminal')
  void server.stop(true)
  rmSync(SOCKET, { force: true })
  try {
    if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) rmSync(PID_FILE)
  } catch {}
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

setInterval(() => {
  // Open questions keep the hub polling: their answer can come any time.
  if (streams.size === 0 && hookRequests.size === 0 && questions.openCount === 0 && prompts.openCount === 0 && Date.now() - lastActivity > HUB_IDLE_MS) {
    shutdown(`idle for ${Math.round(HUB_IDLE_MS / 60000)}m with no sessions`)
  }
}, Math.min(60_000, HUB_IDLE_MS)).unref()

// --- polling -----------------------------------------------------------------

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        allowed_updates: ['message', 'edited_message', 'callback_query'],
        onStart: info => {
          attempt = 0
          botUsername = info.username
          log(`polling as @${info.username}`)
          void bot.api.setMyCommands(
            [
              { command: 'sessions', description: 'List connected Claude Code sessions' },
              { command: 'use', description: 'Send messages to a session: /use <name>' },
              { command: 'queue', description: "Show the orchestrator's task queue" },
              { command: 'level', description: 'Set the autonomy level: /level <0|1|2>' },
              { command: 'cancel', description: 'Cancel a task: /cancel <id>' },
              { command: 'setup', description: 'Set up a project: /setup <name> <repo-url>' },
              { command: 'status', description: 'Check your pairing status' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'start', description: 'Welcome and setup guide' },
            ],
            { scope: { type: 'all_private_chats' } },
          ).catch(() => {})
          void bot.api.setMyCommands(
            [
              { command: 'here', description: 'Make this group the topics group' },
              { command: 'task', description: 'New task for this project: /task <request>' },
              { command: 'queue', description: "Show the orchestrator's task queue" },
              { command: 'level', description: 'Set the autonomy level: /level <0|1|2>' },
              { command: 'cancel', description: 'Cancel a task: /cancel <id>' },
              { command: 'setup', description: 'Set up a project: /setup <name> <repo-url>' },
            ],
            { scope: { type: 'all_group_chats' } },
          ).catch(() => {})
        },
      })
      return
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      if (err instanceof GrammyError && err.error_code === 401) {
        log('bot token rejected (401) — fix it with /telegram-plus:configure <token>')
        shutdown('invalid token')
        return
      }
      const is409 = err instanceof GrammyError && err.error_code === 409
      const delay = is409 && attempt >= 8 ? 60_000 : Math.min(1000 * attempt, 15_000)
      log(`${is409 ? '409 Conflict — another poller holds the token (an older plugin version or the official telegram plugin?)' : `polling error: ${err}`}, retrying in ${delay / 1000}s`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
})()
