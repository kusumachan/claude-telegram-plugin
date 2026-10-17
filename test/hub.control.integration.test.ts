/**
 * The orchestrator's control topic: plain messages there go to the
 * orchestrator, sessions can't claim it, prompts and notices can post there.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { AskResult } from '../src/ask.ts'
import type { PromptResult } from '../src/hub/orchestrator.ts'
import { type Harness, startHub } from './hub-harness.ts'

const USER = 42
const STRANGER = 99
const GROUP = -1009
const G = String(GROUP)
let h: Harness
let control: number
let orch: ReturnType<Harness['connectOrchestrator']>

const ev = (pred: (e: any) => boolean) => h.waitEvent(orch.events, pred as any) as Promise<any>
const sent = (pred: (text: string) => boolean) => h.tg.waitFor(c => c.method === 'sendMessage' && pred(c.params.text ?? ''))

beforeAll(async () => {
  h = await startHub({
    dmPolicy: 'allowlist', allowFrom: [String(USER)], groups: { [G]: { requireMention: false, allowFrom: [] } }, pending: {}, topicsGroup: G,
  })
})
afterAll(() => h.stop())

describe('orchestrator control topic', () => {
  test('connecting creates the control topic', async () => {
    orch = h.connectOrchestrator()
    await ev(e => e.type === 'hello')
    await h.tg.waitFor(c => c.method === 'createForumTopic' && c.params.name === '🎛 Orchestrator')
    control = (await sent(t => t.startsWith('🎛 Orchestrator control'))).params.message_thread_id
  })

  test('a plain message there is a message event (👀), not routed anywhere else', async () => {
    const m = h.tg.groupMsg(USER, GROUP, 'shop: add a wishlist', control, control)
    const e = await ev(e => e.type === 'message')
    expect(e).toEqual({
      type: 'message', text: 'shop: add a wishlist', topic: 'Orchestrator', chat_id: G, thread_id: control,
      message_id: m, user_id: String(USER), user: '@user42', ts: expect.any(String),
    })
    await h.tg.waitFor(c => c.method === 'setMessageReaction' && c.params.message_id === m && c.params.reaction[0].emoji === '👀')
    expect(h.tg.calls.some(c => c.method === 'sendMessage' && /isn't connected/.test(c.params.text))).toBe(false)
  })

  test('notices post there, and a reply to one carries reply_to_message_id', async () => {
    const r = await h.hub.post<{ message_ids: number[] }>('/notice', { topic: 'Orchestrator', text: 'Daily summary: 2 tasks done' })
    const notice = await sent(t => t.startsWith('Daily summary'))
    expect(notice.params.message_thread_id).toBe(control)
    h.tg.groupMsg(USER, GROUP, 'details?', control, r.message_ids[0])
    expect(await ev(e => e.type === 'message' && e.text === 'details?')).toMatchObject({ reply_to_message_id: r.message_ids[0] })
  })

  test('answers to its own prompts there are prompt_answer, not message', async () => {
    const r = await h.hub.post<PromptResult>('/prompt', {
      topic: 'Orchestrator', text: 'Which project is "add a wishlist" for?', buttons: [['shop', 'blog'], ['Other']], needs_text: ['Other'],
    })
    if ('error' in r) throw new Error(r.error)
    const msg = await sent(t => t.startsWith('Which project'))
    expect(msg.params.message_thread_id).toBe(control)
    h.tg.groupTap(USER, GROUP, 'btn:1:0', msg.result.message_id, msg.params.reply_markup, control)
    await sent(t => t.startsWith('✍️ Other'))
    h.tg.groupMsg(USER, GROUP, 'storefront', control)
    expect(await ev(e => e.type === 'prompt_answer' && e.id === r.id)).toMatchObject({ label: 'Other', text: 'storefront' })
    expect(orch.events.some((e: any) => e.type === 'message' && e.text === 'storefront')).toBe(false)
  })

  test('commands there are flagged control: /setup and /task are accepted', async () => {
    h.tg.groupMsg(USER, GROUP, '/setup shop git@github.com:me/shop.git', control)
    const setup = await ev(e => e.type === 'command' && e.command === 'setup')
    expect(setup).toMatchObject({ control: true, args: 'shop git@github.com:me/shop.git', thread_id: control })
    expect(setup.topic).toBeUndefined()
    h.tg.groupMsg(USER, GROUP, '/task shop: add search', control)
    expect(await ev(e => e.type === 'command' && e.command === 'task')).toMatchObject({ control: true, args: 'shop: add search' })
  })

  test('strangers are ignored; attachments are refused', async () => {
    h.tg.groupMsg(STRANGER, GROUP, 'hello?', control)
    h.tg.groupDocument(USER, GROUP, 'logo', control)
    await sent(t => t === "Attachments aren't supported here. Send text.")
    expect(orch.events.some((e: any) => e.type === 'message' && e.text === 'hello?')).toBe(false)
  })

  test('sessions cannot claim the control topic', async () => {
    const agent = h.connectInbox('sess-X', 'x-1A', 'orchestrator') // case doesn't matter
    await h.waitEvent(agent.events, e => e.type === 'hello')
    h.tg.groupMsg(USER, GROUP, 'still for the orchestrator', control)
    await ev(e => e.type === 'message' && e.text === 'still for the orchestrator')
    expect((await h.hub.post<{ messages: unknown[] }>('/inbox/take', { session_id: 'sess-X' })).messages).toEqual([])

    const asked = await h.hub.post<AskResult>('/ask', { session: 'sess-X', asker: 'x-1A', topic: 'Orchestrator', question: 'Q from X?' })
    expect('id' in asked).toBe(true)
    const q = await sent(t => t.includes('Q from X?'))
    expect(q.params.chat_id).toBe(String(USER)) // a DM, not the control topic
    agent.close()

    const ch = h.connect('sess-Y', 'Orchestrator')
    await h.waitEvent(ch.events, e => e.type === 'hello')
    h.tg.groupMsg(USER, GROUP, 'not for the channel session', control)
    await ev(e => e.type === 'message' && e.text === 'not for the channel session')
    expect(ch.events.some(e => e.type === 'inbound')).toBe(false)
    ch.close()
  })

  test('without the orchestrator, plain messages there get "not running"', async () => {
    orch.close()
    await Bun.sleep(100)
    h.tg.groupMsg(USER, GROUP, 'anyone home?', control)
    const r = await sent(t => t === 'Orchestrator is not running.')
    expect(r.params.message_thread_id).toBe(control)
  })
})
