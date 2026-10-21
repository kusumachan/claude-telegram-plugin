/**
 * ask_owner from a session started with TELEGRAM_PLUS_ASK=orchestrator: the
 * question is held for the orchestrator, which answers it or posts it; it's
 * posted anyway when the hold runs out or no orchestrator is connected.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { AskResult, AskWaitResult } from '../src/ask.ts'
import { type Harness, startHub } from './hub-harness.ts'

const USER = 42
const GROUP = -1009
const G = String(GROUP)
let h: Harness
let orch: ReturnType<Harness['connectOrchestrator']>

const ask = (question: string, extra: object = {}) =>
  h.hub.post<AskResult>('/ask', { session: 's-12a', asker: 'shop-12a', topic: 'shop', question, via: 'orchestrator', ...extra })
const idOf = (r: AskResult) => {
  if ('error' in r) throw new Error(r.error)
  return r.id
}
const wait = (id: string, wait_ms = 3000) => h.hub.post<AskWaitResult>('/ask/wait', { id, wait_ms }, wait_ms + 5000)
const ev = (pred: (e: any) => boolean) => h.waitEvent(orch.events, pred as any) as Promise<any>
const sentText = () => h.tg.calls.filter(c => c.method === 'sendMessage').map(c => c.params.text as string)

beforeAll(async () => {
  process.env.TELEGRAM_PLUS_ASK_HOLD_MS = '1500'
  h = await startHub({ dmPolicy: 'allowlist', allowFrom: [String(USER)], groups: { [G]: { requireMention: false, allowFrom: [] } }, pending: {}, topicsGroup: G })
  delete process.env.TELEGRAM_PLUS_ASK_HOLD_MS
})
afterAll(() => h.stop())

describe('questions held for the orchestrator', () => {
  test('without an orchestrator, the question is posted at once', async () => {
    idOf(await ask('Postgres or MySQL?'))
    await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text?.includes('Postgres or MySQL?'))
  })

  test('held: the orchestrator gets it, answers it, and the owner sees question and answer', async () => {
    orch = h.connectOrchestrator()
    await ev(e => e.type === 'hello')
    const id = idOf(await ask('Reuse the users table?', { buttons: [['Yes', 'No']] }))
    const q = await ev(e => e.type === 'question' && e.id === id)
    expect(q).toMatchObject({ asker: 'shop-12a', topic: 'shop', question: 'Reuse the users table?', buttons: [['Yes', 'No']] })
    expect(q.until - q.at).toBe(1500)
    expect(sentText().some(t => t.includes('Reuse the users table?'))).toBe(false)
    // Asking again (after "no answer yet") is the same question.
    expect(idOf(await ask('Reuse the users table?', { buttons: [['Yes', 'No']] }))).toBe(id)

    expect(await h.hub.post('/ask/answer', { id, text: 'Yes, reuse it (memory shop-reuse-users)', by: 'Lead' })).toEqual({ ok: true })
    expect(await wait(id)).toEqual({ status: 'answered', answer: 'Yes, reuse it (memory shop-reuse-users)', by: 'Lead' })
    const shown = await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text?.includes('🧭 Lead: Yes, reuse it'))
    expect(shown.params.text).toStartWith('❓ shop-12a asks:\n\nReuse the users table?')
    expect(await h.hub.post('/ask/answer', { id, text: 'again', by: 'Lead' })).toEqual({ ok: false })
  })

  test('held: the orchestrator posts it with a note, and the owner answers as usual', async () => {
    const id = idOf(await ask('Which payment provider?'))
    await ev(e => e.type === 'question' && e.id === id)
    expect(await h.hub.post('/ask/post', { id, note: 'Level 0: your call. Last time you chose Midtrans.' })).toEqual({ ok: true })
    const msg = await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text?.includes('Which payment provider?'))
    expect(msg.params.text).toEndWith('🧭 Level 0: your call. Last time you chose Midtrans.')
    expect(await h.hub.post('/ask/post', { id })).toEqual({ ok: false })
    h.tg.groupMsg(USER, GROUP, 'Midtrans', msg.params.message_thread_id, msg.result.message_id)
    expect(await wait(id)).toMatchObject({ status: 'answered', answer: 'Midtrans' })
  })

  test('held: posted anyway when the hold runs out', async () => {
    const id = idOf(await ask('Delete the old migrations?'))
    await ev(e => e.type === 'question' && e.id === id)
    expect(sentText().some(t => t.includes('Delete the old migrations?'))).toBe(false)
    await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text?.includes('Delete the old migrations?'), 10_000)
    expect(await h.hub.post('/ask/post', { id })).toEqual({ ok: false })
  })
})
