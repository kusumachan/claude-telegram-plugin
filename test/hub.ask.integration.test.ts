/**
 * ask_owner through the hub: questions go to the project's topic (or DMs),
 * the owner answers with a button or by typing, and the asker collects it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { AskResult, AskWaitResult } from '../src/ask.ts'
import type { HookPermissionResult } from '../src/hub/client.ts'
import { type Harness, startHub } from './hub-harness.ts'

const USER = 42
const STRANGER = 99
const GROUP = -1009
const G = String(GROUP)

const ask = (h: Harness, question: string, extra: object = {}) =>
  h.hub.post<AskResult>('/ask', { session: 's-12A', asker: 'project-x-12A', topic: 'project-x', question, ...extra })
const wait = (h: Harness, id: string, wait_ms = 3000) =>
  h.hub.post<AskWaitResult>('/ask/wait', { id, wait_ms }, wait_ms + 5000)
const idOf = (r: AskResult) => {
  if ('error' in r) throw new Error(r.error)
  return r.id
}

describe('ask_owner with forum topics', () => {
  let h: Harness
  let thread: number
  const posted = (text: string) => h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text?.includes(text))

  beforeAll(async () => {
    h = await startHub({
      dmPolicy: 'allowlist',
      allowFrom: [String(USER)],
      // Anyone in the group passes the group gate; only USER may answer.
      groups: { [G]: { requireMention: false, allowFrom: [] } },
      pending: {},
      topicsGroup: G,
    })
  })
  afterAll(() => h.stop())

  test('posts to the project topic with buttons; asking again does not post twice', async () => {
    const id = idOf(await ask(h, 'Use Postgres or MySQL?', { buttons: [['Postgres', 'MySQL']] }))
    await h.tg.waitFor(c => c.method === 'createForumTopic' && c.params.name === 'project-x')
    const msg = await posted('Use Postgres or MySQL?')
    thread = msg.params.message_thread_id
    expect(msg.params.chat_id).toBe(G)
    expect(msg.params.text).toStartWith('❓ project-x-12A asks:')
    expect(msg.params.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Postgres', 'MySQL'])

    expect(idOf(await ask(h, 'Use  Postgres or MySQL? ', { buttons: [['Postgres', 'MySQL']] }))).toBe(id)
    expect(h.tg.calls.filter(c => c.method === 'sendMessage' && c.params.text?.includes('Use Postgres')).length).toBe(1)
    expect(await wait(h, id, 200)).toEqual({ status: 'pending' })
  })

  test('a question to a deleted topic recreates it and is posted there', async () => {
    idOf(await ask(h, 'First for project-y?', { topic: 'project-y' }))
    const old = (await posted('First for project-y?')).params.message_thread_id
    h.tg.deletedThreads.add(old)
    idOf(await ask(h, 'Second for project-y?', { topic: 'project-y' }))
    const fresh = h.tg.calls.filter(c => c.method === 'createForumTopic' && c.params.name === 'project-y').at(-1)!.result.message_thread_id
    expect(fresh).not.toBe(old)
    const q = await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text?.includes('Second for project-y?') && c.params.message_thread_id === fresh)
    expect(q.params.chat_id).toBe(G)
    expect(h.tg.calls.some(c => c.method === 'sendMessage' && c.params.chat_id === String(USER) && c.params.text?.includes('Second for project-y?'))).toBe(false)
  })

  test('only allowlisted users can tap; the tap answers a waiting call', async () => {
    const id = idOf(await ask(h, 'Use Postgres or MySQL?'))
    const msg = await posted('Use Postgres or MySQL?')
    const messageId = msg.result.message_id
    const markup = msg.params.reply_markup
    const waiting = wait(h, id)

    h.tg.groupTap(STRANGER, GROUP, 'btn:0:0', messageId, markup, thread)
    await h.tg.waitFor(c => c.method === 'answerCallbackQuery' && c.params.text === 'Not authorized.')
    h.tg.groupTap(USER, GROUP, 'btn:0:0', messageId, markup, thread)
    expect(await waiting).toEqual({ status: 'answered', answer: 'Postgres', by: 'User' })

    const edit = await h.tg.waitFor(c => c.method === 'editMessageText' && c.params.text?.includes('→ Postgres'))
    expect(edit.params.reply_markup).toEqual({ inline_keyboard: [] })
    // Collected: asking the same question now is a new question.
    expect(await wait(h, id, 0)).toEqual({ status: 'unknown' })
  })

  test('a typed message in the topic answers the one open question, even with nobody waiting', async () => {
    const id = idOf(await ask(h, 'Which port should the API use?'))
    await posted('Which port should the API use?')
    h.tg.groupMsg(STRANGER, GROUP, 'port 80!', thread) // not allowlisted: not an answer
    h.tg.groupMsg(USER, GROUP, '8080', thread, thread) // topic messages "reply" to the topic root
    await h.tg.waitFor(c => c.method === 'setMessageReaction' && c.params.reaction?.[0]?.emoji === '👍')
    expect(await wait(h, id, 0)).toEqual({ status: 'answered', answer: '8080', by: '@user42' })
  })

  test('with two questions open, a plain message gets a hint and a reply picks one', async () => {
    const a = idOf(await ask(h, 'Question A?'))
    const b = idOf(await ask(h, 'Question B?'))
    const msgB = await posted('Question B?')
    const messageIdB = msgB.result.message_id

    h.tg.groupMsg(USER, GROUP, 'yes', thread)
    await posted('2 questions are open here')
    h.tg.groupMsg(USER, GROUP, 'B it is', thread, messageIdB)
    expect(await wait(h, b)).toEqual({ status: 'answered', answer: 'B it is', by: '@user42' })
    expect(await wait(h, a, 100)).toEqual({ status: 'pending' })
  })

  test('approval hooks honor the topic the session was given', async () => {
    const pending = h.hub.post<HookPermissionResult>('/hook/permission', {
      session_id: 'agent-1', cwd: '/srv/elsewhere', topic: 'project-x', tool_name: 'Bash', tool_input: { command: 'ls' },
    })
    const prompt = await h.tg.waitFor(c => c.method === 'sendMessage' && /Permission: Bash/.test(c.params.text))
    expect(prompt.params.message_thread_id).toBe(thread)
    await h.hub.post('/hook/event', { session_id: 'agent-1', hook_event_name: 'Stop' })
    expect(await pending).toEqual({})
  })

  test('rejects a question without anyone to answer it or with bad buttons', async () => {
    expect(await ask(h, 'x?', { buttons: [[{ text: 'a', url: 'https://a' }]] })).toEqual({ error: expect.stringContaining('button row 1') })
    expect(await ask(h, 'y'.repeat(4000))).toEqual({ error: expect.stringContaining('keep it under') })
  })
})

describe('ask_owner without a topics group', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHub({ dmPolicy: 'allowlist', allowFrom: [String(USER)], groups: {}, pending: {} })
  })
  afterAll(() => h.stop())

  test('goes to allowlisted DMs and is answered by a reply', async () => {
    const id = idOf(await ask(h, 'Deploy now?'))
    const msg = await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text?.includes('Deploy now?'))
    expect(msg.params.chat_id).toBe(String(USER))
    const messageId = msg.result.message_id
    h.tg.dm(USER, 'not yet', messageId)
    expect(await wait(h, id)).toEqual({ status: 'answered', answer: 'not yet', by: '@user42' })
  })
})
