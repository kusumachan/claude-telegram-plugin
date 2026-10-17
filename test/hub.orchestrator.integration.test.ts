/**
 * The orchestrator API: bot commands routed to the orchestrator's stream,
 * gate prompts and their answers, notices, and topics.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { type NoticeResult, OrchestratorClient, type OrchestratorEvent, type PromptResult, type TopicResult } from '../src/hub/orchestrator.ts'
import { type Harness, startHub } from './hub-harness.ts'

const USER = 42
const STRANGER = 99
const GROUP = -1009
const G = String(GROUP)
let h: Harness
let thread: number
let orch: ReturnType<Harness['connectOrchestrator']>
let files: string

const ev = (events: any[], pred: (e: any) => boolean) => h.waitEvent(events, pred as any) as Promise<any>
const sent = (pred: (text: string) => boolean) => h.tg.waitFor(c => c.method === 'sendMessage' && pred(c.params.text ?? ''))
const promptOf = (r: PromptResult) => {
  if ('error' in r) throw new Error(r.error)
  return r
}

beforeAll(async () => {
  h = await startHub({
    dmPolicy: 'allowlist', allowFrom: [String(USER)], groups: { [G]: { requireMention: false, allowFrom: [] } }, pending: {}, topicsGroup: G,
  })
  files = mkdtempSync('/tmp/tgp-orch-files-')
})
afterAll(async () => {
  await h.stop()
  rmSync(files, { recursive: true, force: true })
})

describe('orchestrator API', () => {
  test('topic/ensure creates a project topic once and returns it', async () => {
    const r = await h.hub.post<TopicResult>('/topic/ensure', { topic: 'proj' })
    if ('error' in r) throw new Error(r.error)
    expect(r.chat_id).toBe(G)
    thread = r.thread_id
    expect(await h.hub.post('/topic/ensure', { topic: 'proj' })).toEqual(r)
    expect(h.tg.calls.filter(c => c.method === 'createForumTopic' && c.params.name === 'proj').length).toBe(1)
  })

  test('commands without an orchestrator get "not running"', async () => {
    h.tg.groupMsg(USER, GROUP, '/task add a login page', thread)
    const r = await sent(t => t === 'Orchestrator is not running.')
    expect(r.params.message_thread_id).toBe(thread)
  })

  test('commands reach the orchestrator with their project topic; misplaced ones get a hint; strangers are ignored', async () => {
    orch = h.connectOrchestrator()
    await ev(orch.events, e => e.type === 'hello')

    const m = h.tg.groupMsg(USER, GROUP, '/task add a login page', thread)
    const task = await ev(orch.events, e => e.type === 'command' && e.command === 'task')
    expect(task).toMatchObject({ args: 'add a login page', topic: 'proj', chat_id: G, thread_id: thread, message_id: m, user_id: String(USER), user: '@user42' })
    await h.tg.waitFor(c => c.method === 'setMessageReaction' && c.params.message_id === m && c.params.reaction[0].emoji === '👀')

    h.tg.groupMsg(USER, GROUP, '/queue@test_bot', thread)
    expect(await ev(orch.events, e => e.type === 'command' && e.command === 'queue')).toMatchObject({ args: '', topic: 'proj' })

    h.tg.dm(USER, '/setup shop git@github.com:me/shop.git')
    const setup = await ev(orch.events, e => e.type === 'command' && e.command === 'setup')
    expect(setup).toMatchObject({ args: 'shop git@github.com:me/shop.git', chat_id: String(USER) })
    expect(setup.topic).toBeUndefined()

    h.tg.groupMsg(USER, GROUP, '/task no topic here')
    await sent(t => t === "Send /task in a project's topic.")
    h.tg.groupMsg(USER, GROUP, '/setup x y', thread)
    await sent(t => t === 'Send /setup in the General topic or a DM.')

    h.tg.groupMsg(STRANGER, GROUP, '/cancel 12', thread)
    h.tg.groupMsg(USER, GROUP, '/level 1', thread)
    expect(await ev(orch.events, e => e.type === 'command' && e.command === 'level')).toMatchObject({ args: '1' })
    expect(orch.events.some((e: any) => e.command === 'cancel')).toBe(false)
  })

  test('a prompt sends its files first, then text with buttons; the same key does not post twice', async () => {
    const spec = join(files, 'spec.md')
    writeFileSync(spec, '# Spec\n\nlong text')
    const body = { key: 'task-1-gate1', topic: 'proj', text: 'Spec ready for task 1', buttons: [['Continue', 'Revise']], needs_text: ['Revise'], files: [spec] }
    const r = promptOf(await h.hub.post<PromptResult>('/prompt', body))
    const doc = h.tg.calls.findIndex(c => c.method === 'sendDocument')
    const msg = h.tg.calls.findIndex(c => c.method === 'sendMessage' && c.params.text === 'Spec ready for task 1')
    expect(doc).toBeGreaterThan(-1)
    expect(msg).toBeGreaterThan(doc)
    expect(h.tg.calls[msg]!.params.message_thread_id).toBe(thread)
    expect(r.message_ids.length).toBe(2)
    expect(promptOf(await h.hub.post<PromptResult>('/prompt', body)).id).toBe(r.id)
    expect(h.tg.calls.filter(c => c.method === 'sendMessage' && c.params.text === 'Spec ready for task 1').length).toBe(1)
  })

  test('tapping a plain button answers; strangers cannot tap', async () => {
    const r = promptOf(await h.hub.post<PromptResult>('/prompt', { topic: 'proj', text: 'Open the PR?', buttons: [['Open PR', 'See diff']] }))
    const msg = await sent(t => t === 'Open the PR?')
    h.tg.groupTap(STRANGER, GROUP, 'btn:0:0', msg.result.message_id, msg.params.reply_markup, thread)
    await h.tg.waitFor(c => c.method === 'answerCallbackQuery' && c.params.text === 'Not authorized.')
    h.tg.groupTap(USER, GROUP, 'btn:0:0', msg.result.message_id, msg.params.reply_markup, thread)
    const a = await ev(orch.events, e => e.type === 'prompt_answer' && e.id === r.id)
    expect(a).toMatchObject({ label: 'Open PR', by: 'User' })
    expect(a.text).toBeUndefined()
    expect(await h.hub.post('/prompt/ack', { id: r.id })).toEqual({ ok: true })
  })

  test('a needs-text button asks for notes; the next message is the notes', async () => {
    const r = promptOf(await h.hub.post<PromptResult>('/prompt', { topic: 'proj', text: 'Spec v2', buttons: [['Continue', 'Revise']], needs_text: ['Revise'] }))
    const msg = await sent(t => t === 'Spec v2')
    h.tg.groupTap(USER, GROUP, 'btn:0:1', msg.result.message_id, msg.params.reply_markup, thread)
    await sent(t => t.startsWith('✍️ Revise: type your notes'))
    expect(orch.events.some((e: any) => e.type === 'prompt_answer' && e.id === r.id)).toBe(false)
    h.tg.groupMsg(USER, GROUP, 'use the existing users table', thread)
    expect(await ev(orch.events, e => e.type === 'prompt_answer' && e.id === r.id))
      .toMatchObject({ label: 'Revise', text: 'use the existing users table', by: '@user42' })
    await h.hub.post('/prompt/ack', { id: r.id })
  })

  test('an answer given while the orchestrator is away is sent on reconnect until acked', async () => {
    orch.close()
    await Bun.sleep(100)
    const r = promptOf(await h.hub.post<PromptResult>('/prompt', { key: 'k-away', topic: 'proj', text: 'Merge order?' }))
    const msg = await sent(t => t === 'Merge order?')
    h.tg.groupMsg(USER, GROUP, 'API first', thread, msg.result.message_id) // a typed reply to the prompt
    await h.tg.waitFor(c => c.method === 'setMessageReaction' && c.params.reaction[0].emoji === '👍')

    orch = h.connectOrchestrator()
    expect(await ev(orch.events, e => e.type === 'prompt_answer' && e.id === r.id)).toMatchObject({ key: 'k-away', text: 'API first' })
    await h.hub.post('/prompt/ack', { id: r.id })
    orch.close()
    await Bun.sleep(100)
    orch = h.connectOrchestrator()
    await ev(orch.events, e => e.type === 'hello')
    await Bun.sleep(100)
    expect(orch.events.some((e: any) => e.type === 'prompt_answer')).toBe(false)
  })

  test('cancelling a prompt removes its buttons and says why', async () => {
    const r = promptOf(await h.hub.post<PromptResult>('/prompt', { topic: 'proj', text: 'Spec for task 3', buttons: [['Continue']] }))
    const msg = await sent(t => t === 'Spec for task 3')
    expect(await h.hub.post('/prompt/cancel', { id: r.id, note: 'Task 3 cancelled' })).toEqual({ ok: true })
    await h.tg.waitFor(c => c.method === 'editMessageReplyMarkup' && c.params.message_id === msg.result.message_id)
    const note = await sent(t => t === '✖️ Task 3 cancelled')
    expect(note.params.reply_parameters.message_id).toBe(msg.result.message_id)
    expect(await h.hub.post('/prompt/cancel', { id: r.id })).toEqual({ ok: false })
  })

  test('notices go to a project topic, or to DMs without one', async () => {
    const t = await h.hub.post<NoticeResult>('/notice', { topic: 'proj', text: 'PR #12 ready: https://example.com/pr/12' })
    expect('message_ids' in t).toBe(true)
    expect((await sent(x => x.startsWith('PR #12 ready'))).params.message_thread_id).toBe(thread)
    await h.hub.post<NoticeResult>('/notice', { text: 'Quota paused until 14:00' })
    expect((await sent(x => x === 'Quota paused until 14:00')).params.chat_id).toBe(String(USER))
    expect(await h.hub.post('/notice', {})).toEqual({ error: 'text or files required' })
  })

  test('OrchestratorClient: run() receives commands and answers; prompt() posts', async () => {
    orch.close()
    await Bun.sleep(100)
    const client = new OrchestratorClient(h.dir, '')
    const events: OrchestratorEvent[] = []
    void client.run(e => events.push(e))
    await ev(events, e => e.type === 'hello')
    h.tg.groupMsg(USER, GROUP, '/cancel 7', thread)
    expect(await ev(events, e => e.type === 'command' && e.command === 'cancel')).toMatchObject({ args: '7', topic: 'proj' })

    const r = promptOf(await client.prompt({ topic: 'proj', text: 'Client prompt', buttons: [['OK']] }))
    const msg = await sent(t => t === 'Client prompt')
    h.tg.groupTap(USER, GROUP, 'btn:0:0', msg.result.message_id, msg.params.reply_markup, thread)
    expect(await ev(events, e => e.type === 'prompt_answer' && e.id === r.id)).toMatchObject({ label: 'OK' })
    expect(await client.ackPrompt(r.id)).toEqual({ ok: true })
    expect(await client.ensureTopic('proj')).toEqual({ chat_id: G, thread_id: thread })
    client.stop()
  })
})
