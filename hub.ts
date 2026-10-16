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
import { newRequestId, PermissionRelay } from './src/permissions.ts'
import { callTool, type ToolDeps } from './src/tools.ts'
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
  const chatId = n.meta.chat_id!
  const replyTo = n.meta.reply_to_message_id ?? n.meta.button_message_id
  const route = router.route(chatId, replyTo != null ? Number(replyTo) : undefined)

  if (route.kind === 'session') {
    if (push(route.session.id, { type: 'inbound', content: n.content, meta: n.meta })) return true
    router.remove(route.session.id) // stream died without us noticing
    return deliver(n)
  }

  if (route.kind === 'none') {
    if (n.meta.chat_type === 'private') {
      await bot.api.sendMessage(chatId,
        'No Claude Code session is connected right now. Start one with bin/claude-telegram.').catch(() => {})
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
    await ctx.reply('No Claude Code session is connected. Start one with bin/claude-telegram.')
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

registerInbound({
  bot,
  store,
  relay,
  typing,
  token: TOKEN,
  inboxDir: INBOX_DIR,
  botUsername: () => botUsername,
  deliver,
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
    return json({ sessions: router.list(), pendingApprovals: hookRequests.size })
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
      const info = router.get(session)
      if (!info) return json({ content: [{ type: 'text', text: `${name} failed: session not connected to the hub` }], isError: true })
      const a = { ...(args ?? {}) }
      // With several sessions on one bot, say who's talking.
      if (name === 'reply' && router.size > 1 && typeof a.text === 'string' && a.text) {
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
      await relay.request(
        { request_id: p.request_id, tool_name: p.tool_name, description: p.description, input_preview: p.input_preview },
        store.load().allowFrom,
        Date.now(),
        info?.name,
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
      await relay.request(
        { request_id: id, tool_name: p.tool_name, description, input_preview: previewInput(p.tool_input) },
        access.allowFrom,
        Date.now(),
        projectLabel(p.cwd),
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
  if (streams.size === 0 && hookRequests.size === 0 && Date.now() - lastActivity > HUB_IDLE_MS) {
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
              { command: 'status', description: 'Check your pairing status' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'start', description: 'Welcome and setup guide' },
            ],
            { scope: { type: 'all_private_chats' } },
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
