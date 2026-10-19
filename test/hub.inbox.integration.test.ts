/**
 * Owner-message inbox: messages in an inbox session's topic are queued in
 * the hub and handed to the model by hooks/inbox.ts (run here as Claude Code
 * would run it).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import type { AskResult, AskWaitResult } from '../src/ask.ts'
import type { InboxTakeResult } from '../src/inbox.ts'
import { type Harness, startHub } from './hub-harness.ts'

const USER = 42
const STRANGER = 99
const GROUP = -1009
const G = String(GROUP)
let h: Harness
let thread: number
let agentA: ReturnType<Harness['connectInbox']>

async function runHook(stateDir: string, input: object, env: Record<string, string> = { TELEGRAM_PLUS_INBOX: '1' }) {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), TELEGRAM_STATE_DIR: stateDir, ...env }
  if (!('TELEGRAM_PLUS_INBOX' in env)) delete e.TELEGRAM_PLUS_INBOX
  const p = Bun.spawn(['bun', join(import.meta.dir, '../hooks/inbox.ts')], {
    env: e, stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) : undefined }
}
const postToolUse = (session_id: string) => ({ session_id, hook_event_name: 'PostToolUse', tool_name: 'Bash' })
const stop = (session_id: string, stop_hook_active = false) => ({ session_id, hook_event_name: 'Stop', stop_hook_active })
const reacted = (messageId: number, emoji: string) =>
  h.tg.waitFor(c => c.method === 'setMessageReaction' && c.params.message_id === messageId && c.params.reaction?.[0]?.emoji === emoji)
const take = (session_id: string) => h.hub.post<InboxTakeResult>('/inbox/take', { session_id })

beforeAll(async () => {
  h = await startHub({
    dmPolicy: 'allowlist', allowFrom: [String(USER)], groups: { [G]: { requireMention: false, allowFrom: [] } }, pending: {}, topicsGroup: G,
  })
})
afterAll(() => h.stop())

describe('owner-message inbox', () => {
  test('connecting makes no topic; once it exists, a message there is queued (👀) and delivered after a tool call (👍)', async () => {
    agentA = h.connectInbox('sess-A', 'proj-1A', 'proj')
    await h.waitEvent(agentA.events, e => e.type === 'hello')
    await Bun.sleep(200)
    expect(h.tg.calls.some(c => c.method === 'createForumTopic')).toBe(false)
    await h.hub.post('/topic/ensure', { topic: 'proj' })
    const welcome = await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text?.startsWith('📦 proj —'))
    thread = welcome.params.message_thread_id

    const m = h.tg.groupMsg(USER, GROUP, 'stop, wrong approach', thread, thread)
    await reacted(m, '👀')
    const r = await runHook(h.dir, postToolUse('sess-A'))
    expect(r.code).toBe(0)
    expect(r.json).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Message from the owner on Telegram (@user42):\nstop, wrong approach' },
    })
    await reacted(m, '👍')
    expect((await runHook(h.dir, postToolUse('sess-A'))).stdout).toBe('') // nothing new
  })

  test('several messages go out together, in order; Stop blocks only when there is something to deliver', async () => {
    expect((await runHook(h.dir, stop('sess-A'))).stdout).toBe('')
    const a = h.tg.groupMsg(USER, GROUP, 'also handle X', thread)
    const b = h.tg.groupMsg(USER, GROUP, 'and Y', thread)
    await reacted(a, '👀')
    await reacted(b, '👀')
    const r = await runHook(h.dir, stop('sess-A', true))
    expect(r.json).toEqual({
      decision: 'block',
      reason: '2 messages from the owner on Telegram (@user42), oldest first:\n[1] also handle X\n[2] and Y',
    })
    expect((await runHook(h.dir, stop('sess-A', true))).stdout).toBe('') // no loop
  })

  test('without TELEGRAM_PLUS_INBOX, or with no hub, the hook is a silent no-op', async () => {
    await reacted(h.tg.groupMsg(USER, GROUP, 'queued for later', thread), '👀')
    const off = await runHook(h.dir, postToolUse('sess-A'), {})
    expect(off).toMatchObject({ code: 0, stdout: '', stderr: '' })

    const empty = mkdtempSync('/tmp/tgp-nohub-')
    try {
      const started = Date.now()
      const none = await runHook(empty, postToolUse('sess-A'))
      expect(none).toMatchObject({ code: 0, stdout: '', stderr: '' })
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
    expect((await take('sess-A')).messages.map(m => m.text)).toEqual(['queued for later'])
  })

  test('a plain message still answers the open question in the topic; a reply to it afterwards reaches the inbox', async () => {
    const asked = await h.hub.post<AskResult>('/ask', { session: 'sess-A', asker: 'proj-1A', topic: 'proj', question: 'Which DB?' })
    if ('error' in asked) throw new Error(asked.error)
    const q = await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text?.includes('Which DB?'))
    h.tg.groupMsg(USER, GROUP, 'postgres', thread)
    expect(await h.hub.post<AskWaitResult>('/ask/wait', { id: asked.id, wait_ms: 3000 }))
      .toEqual({ status: 'answered', answer: 'postgres', by: '@user42' })
    expect((await take('sess-A')).messages).toEqual([])

    const m = h.tg.groupMsg(USER, GROUP, 'actually use the existing one', thread, q.result.message_id)
    await reacted(m, '👀')
    expect((await take('sess-A')).messages.map(x => x.text)).toEqual(['actually use the existing one'])
  })

  test('two inbox sessions on one topic: a plain message gets a hint, a reply picks one', async () => {
    const agentB = h.connectInbox('sess-B', 'proj-1B', 'proj')
    await h.waitEvent(agentB.events, e => e.type === 'hello')
    h.tg.groupMsg(USER, GROUP, 'who gets this?', thread)
    await h.tg.waitFor(c => c.method === 'sendMessage' && /2 agents are running here \(proj-1A, proj-1B\)/.test(c.params.text))

    const sent = await h.hub.post<{ content: { text: string }[] }>('/tool', {
      session: 'sess-B', name: 'reply', args: { chat_id: G, thread_id: String(thread), text: 'B: tests are green' },
    })
    const id = Number(/id: (\d+)/.exec(sent.content[0]!.text)![1])
    const m = h.tg.groupMsg(USER, GROUP, 'nice, open the PR', thread, id)
    await reacted(m, '👀')
    expect((await take('sess-B')).messages.map(x => x.text)).toEqual(['nice, open the PR'])
    expect((await take('sess-A')).messages).toEqual([])
    agentB.close()
    await Bun.sleep(100)
  })

  test('attachments are refused; strangers are not queued', async () => {
    h.tg.groupDocument(USER, GROUP, 'see attached', thread)
    await h.tg.waitFor(c => c.method === 'sendMessage' && /Attachments aren't supported for agents/.test(c.params.text))
    h.tg.groupMsg(STRANGER, GROUP, 'rm -rf everything', thread)
    await h.tg.waitFor(c => c.method === 'sendMessage' && /proj isn't connected/.test(c.params.text))
    expect((await take('sess-A')).messages).toEqual([])
  })

  test('a session that ends with unread messages tells the owner they were not delivered', async () => {
    const m = h.tg.groupMsg(USER, GROUP, 'one more thing', thread)
    await reacted(m, '👀')
    agentA.close()
    const notice = await h.tg.waitFor(c => c.method === 'sendMessage' && /proj-1A ended before reading your message/.test(c.params.text))
    expect(notice.params.message_thread_id).toBe(thread)
    expect(notice.params.reply_parameters.message_id).toBe(m)
  })
})
