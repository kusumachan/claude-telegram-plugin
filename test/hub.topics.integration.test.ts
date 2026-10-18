/**
 * Forum topics: each channel session gets its own topic in the topics group,
 * messages there route to that session, approvals go to the project's topic.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { HookPermissionResult } from '../src/hub/client.ts'
import { type Harness, inbound, startHub } from './hub-harness.ts'

const USER = 42
const GROUP = -1009
const G = String(GROUP)
let h: Harness
let api: ReturnType<Harness['connect']>
let web: ReturnType<Harness['connect']>
const topicThreads: Record<string, number> = {}
const topicThread = (name: string) => topicThreads[name]

beforeAll(async () => {
  h = await startHub(
    {
      dmPolicy: 'allowlist',
      allowFrom: [String(USER)],
      groups: { [G]: { requireMention: false, allowFrom: [String(USER)] } },
      pending: {},
      topicsGroup: G,
    },
    // A topic left over from an earlier session that isn't running now.
    { 'topics.json': JSON.stringify({ [G]: { docs: 777 } }) },
  )
})

afterAll(() => h.stop())

/** Thread id the hub created for `name` (from the welcome message it posted). */
async function createdThread(name: string): Promise<number> {
  const welcome = await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text?.startsWith(`📦 ${name} —`))
  topicThreads[name] = welcome.params.message_thread_id
  return welcome.params.message_thread_id
}

describe('hub with forum topics', () => {
  test('a connecting session gets its own topic with a welcome message', async () => {
    api = h.connect('session-api', 'api')
    await h.waitEvent(api.events, e => e.type === 'hello')
    const create = await h.tg.waitFor(c => c.method === 'createForumTopic' && c.params.name === 'api')
    expect(create.params.chat_id).toBe(G)
    expect(await createdThread('api')).toBeGreaterThan(0)
  })

  test('messages in a session\'s topic go to it, even with another session active', async () => {
    web = h.connect('session-web', 'web')
    await h.waitEvent(web.events, e => e.type === 'hello')
    await createdThread('web')
    h.tg.groupMsg(USER, GROUP, 'hi api', topicThread('api'))
    h.tg.groupMsg(USER, GROUP, 'hi web', topicThread('web'))
    const e = await h.waitEvent(api.events, inbound('hi api'))
    await h.waitEvent(web.events, inbound('hi web'))
    expect(e.type === 'inbound' && e.meta.thread_id).toBe(String(topicThread('api')))
  })

  test('no [name] prefix when replying in the session\'s own topic; prefix elsewhere', async () => {
    await h.hub.post('/tool', {
      session: 'session-api', name: 'reply',
      args: { chat_id: G, thread_id: String(topicThread('api')), text: 'in my topic' },
    })
    await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text === 'in my topic')
    await h.hub.post('/tool', { session: 'session-api', name: 'reply', args: { chat_id: String(USER), text: 'in DM' } })
    await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text === '[api] in DM')
  })

  test('a topic whose session isn\'t running gets an "isn\'t connected" reply', async () => {
    h.tg.groupMsg(USER, GROUP, 'anyone?', 777)
    const c = await h.tg.waitFor(c => c.method === 'sendMessage' && /docs isn't connected/.test(c.params.text))
    expect(c.params.message_thread_id).toBe(777)
  })

  test('hook approvals go to the project\'s topic; only allowlisted users can tap', async () => {
    const pending = h.hub.post<HookPermissionResult>('/hook/permission', {
      session_id: 'worker-1', cwd: '/code/web/.claude/worktrees/fix', tool_name: 'Bash', tool_input: { command: 'npm test' },
    })
    const prompt = await h.tg.waitFor(c => c.method === 'sendMessage' && /\[web\] Permission: Bash/.test(c.params.text))
    expect(prompt.params.chat_id).toBe(G)
    expect(prompt.params.message_thread_id).toBe(topicThread('web'))
    const allow = prompt.params.reply_markup.inline_keyboard.flat().find((b: any) => b.callback_data.startsWith('perm:allow:'))

    h.tg.groupTap(99, GROUP, allow.callback_data, 5000) // not allowlisted
    await h.tg.waitFor(c => c.method === 'answerCallbackQuery' && c.params.text === 'Not authorized.')
    h.tg.groupTap(USER, GROUP, allow.callback_data, 5000)
    expect(await pending).toEqual({ behavior: 'allow' })
  })

  test('a project with no session yet gets a topic created for its approvals', async () => {
    const pending = h.hub.post<HookPermissionResult>('/hook/permission', {
      session_id: 'worker-2', cwd: '/code/mobile', tool_name: 'Write', tool_input: { file_path: '/x' },
    })
    await h.tg.waitFor(c => c.method === 'createForumTopic' && c.params.name === 'mobile')
    const thread = await createdThread('mobile')
    await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.message_thread_id === thread && /Permission: Write/.test(c.params.text))
    await h.hub.post('/hook/event', { session_id: 'worker-2', hook_event_name: 'Stop' })
    expect(await pending).toEqual({})
  })

  test('a deleted topic is recreated and the approval goes there', async () => {
    const old = topicThread('mobile')!
    h.tg.deletedThreads.add(old)
    const before = h.tg.calls.filter(c => c.method === 'createForumTopic' && c.params.name === 'mobile').length
    const pending = h.hub.post<HookPermissionResult>('/hook/permission', {
      session_id: 'worker-3', cwd: '/code/mobile', tool_name: 'Edit', tool_input: {},
    })
    await h.tg.waitFor(() => h.tg.calls.filter(c => c.method === 'createForumTopic' && c.params.name === 'mobile').length > before)
    const thread = h.tg.calls.filter(c => c.method === 'createForumTopic' && c.params.name === 'mobile').at(-1)!.result.message_thread_id
    topicThreads.mobile = thread
    expect(thread).not.toBe(old)
    await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.message_thread_id === thread && /Permission: Edit/.test(c.params.text))
    expect(h.tg.calls.some(c => c.method === 'sendMessage' && c.params.chat_id === String(USER) && /Permission: Edit/.test(c.params.text))).toBe(false)
    await h.hub.post('/hook/event', { session_id: 'worker-3', hook_event_name: 'Stop' })
    await pending
  })

  test('a reconnecting session reuses its topic', async () => {
    api.close()
    await Bun.sleep(200)
    const before = h.tg.calls.filter(c => c.method === 'createForumTopic' && c.params.name === 'api').length
    api = h.connect('session-api-2', 'api')
    await h.waitEvent(api.events, e => e.type === 'hello')
    h.tg.groupMsg(USER, GROUP, 'welcome back', topicThread('api'))
    await h.waitEvent(api.events, inbound('welcome back'))
    expect(h.tg.calls.filter(c => c.method === 'createForumTopic' && c.params.name === 'api').length).toBe(before)
  })
})
