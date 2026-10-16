/**
 * Runs the real hub.ts against a fake Bot API and drives it like two Claude
 * Code sessions plus a PermissionRequest hook would.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { type HubEvent, HubClient, type HookPermissionResult } from '../src/hub/client.ts'
import { FakeTelegram } from './fake-telegram.ts'

const USER = 42
let tg: FakeTelegram
let dir: string
let hub: HubClient
let hubProc: ReturnType<typeof Bun.spawn>
const events: Record<string, HubEvent[]> = { A: [], B: [] }
const aborts: AbortController[] = []

/** Env for a hub under test: fake API, temp state dir, token only from its .env. */
function hubEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TELEGRAM_STATE_DIR: dir, TELEGRAM_API_ROOT: tg.apiRoot }
  delete env.TELEGRAM_BOT_TOKEN
  return env
}

/** Connect a fake session; events land in events[key]. */
function connect(key: 'A' | 'B', name: string): void {
  const ac = new AbortController()
  aborts.push(ac)
  void fetch('http://hub/session/connect', {
    unix: hub.socket,
    method: 'POST',
    body: JSON.stringify({ id: `session-${key}`, name, cwd: `/code/${name}` }),
    signal: ac.signal,
  }).then(async res => {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of res.body!) {
      buf += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        events[key]!.push(JSON.parse(buf.slice(0, nl)))
        buf = buf.slice(nl + 1)
      }
    }
  }).catch(() => {})
}

async function waitEvent(key: 'A' | 'B', pred: (e: HubEvent) => boolean, timeoutMs = 5000): Promise<HubEvent> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = events[key]!.find(pred)
    if (hit) return hit
    if (Date.now() > deadline) throw new Error(`no matching event for ${key}: ${JSON.stringify(events[key])}`)
    await Bun.sleep(25)
  }
}

const inbound = (text: string) => (e: HubEvent) => e.type === 'inbound' && e.content === text

beforeAll(async () => {
  tg = new FakeTelegram()
  dir = mkdtempSync('/tmp/tgp-it-')
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=1:test\n')
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(USER)], groups: {}, pending: {} }))
  hubProc = Bun.spawn(['bun', join(import.meta.dir, '../hub.ts')], {
    env: hubEnv(),
    stderr: 'pipe',
  })
  hub = new HubClient(dir, '')
  for (let i = 0; i < 100 && !(await hub.healthy(200)); i++) await Bun.sleep(50)
  await tg.waitFor(c => c.method === 'setMyCommands') // polling started
})

afterAll(async () => {
  for (const ac of aborts) ac.abort()
  hubProc.kill()
  await hubProc.exited
  tg.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('hub', () => {
  test('a second hub on the same state dir exits instead of fighting', async () => {
    const dup = Bun.spawn(['bun', join(import.meta.dir, '../hub.ts')], {
      env: hubEnv(),
      stderr: 'ignore',
    })
    expect(await dup.exited).toBe(0)
    expect(await hub.healthy()).toBe(true)
  })

  test('with no session connected, a DM gets told so', async () => {
    tg.dm(USER, 'anyone there?')
    const c = await tg.waitFor(c => c.method === 'sendMessage' && /No Claude Code session/.test(c.params.text))
    expect(c.params.chat_id).toBe(String(USER))
  })

  test('one session: messages go straight to it', async () => {
    connect('A', 'api')
    await waitEvent('A', e => e.type === 'hello')
    tg.dm(USER, 'hello A')
    const e = await waitEvent('A', inbound('hello A'))
    expect(e.type === 'inbound' && e.meta.chat_id).toBe(String(USER))
  })

  test('two sessions: message is held, picker sent, tap delivers it to the choice', async () => {
    connect('B', 'web')
    await waitEvent('B', e => e.type === 'hello')
    tg.dm(USER, 'which one?')
    const picker = await tg.waitFor(c => c.method === 'sendMessage' && c.params.text === 'Which session should get this?')
    const buttons = picker.params.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)
    expect(buttons).toEqual(['use:session-A', 'use:session-B'])
    expect(events.B!.some(inbound('which one?'))).toBe(false)

    tg.tap(USER, 'use:session-B', 1)
    await waitEvent('B', inbound('which one?'))
    tg.dm(USER, 'still B')
    await waitEvent('B', inbound('still B'))
  })

  test('replies are prefixed with the session name; replying to them routes back to that session', async () => {
    const res = await hub.post<any>('/tool', { session: 'session-A', name: 'reply', args: { chat_id: String(USER), text: 'from A' } })
    expect(res.isError).toBeUndefined()
    const sent = await tg.waitFor(c => c.method === 'sendMessage' && c.params.text === '[api] from A')
    const sentId = Number(res.content[0].text.match(/id: (\d+)/)[1])
    expect(sent).toBeTruthy()

    tg.dm(USER, 'answer to A', sentId) // B is active, but this replies to A's message
    await waitEvent('A', inbound('answer to A'))
  })

  test('/use switches the chat to a session by name', async () => {
    tg.dm(USER, '/use api')
    await tg.waitFor(c => c.method === 'sendMessage' && c.params.text === 'Now talking to api.')
    tg.dm(USER, 'back to A')
    await waitEvent('A', inbound('back to A'))
  })

  test('tool calls from an unknown session are refused', async () => {
    const res = await hub.post<any>('/tool', { session: 'nope', name: 'reply', args: { chat_id: String(USER), text: 'x' } })
    expect(res.isError).toBe(true)
  })

  test('hook approval: buttons go out, a tap answers the waiting hook', async () => {
    const pending = hub.post<HookPermissionResult>('/hook/permission', {
      session_id: 'cli-session', cwd: '/code/api', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' },
    })
    const prompt = await tg.waitFor(c => c.method === 'sendMessage' && /\[api\] Permission: Bash/.test(c.params.text))
    const allow = prompt.params.reply_markup.inline_keyboard.flat().find((b: any) => b.callback_data.startsWith('perm:allow:'))
    tg.tap(USER, allow.callback_data, 2000)
    expect(await pending).toEqual({ behavior: 'allow' })
  })

  test('hook approval: a turn boundary closes the prompt and releases the hook', async () => {
    const pending = hub.post<HookPermissionResult>('/hook/permission', {
      session_id: 'cli-2', cwd: '/code/web', tool_name: 'Write', tool_input: { file_path: '/x' },
    })
    await tg.waitFor(c => c.method === 'sendMessage' && /\[web\] Permission: Write/.test(c.params.text))
    await hub.post('/hook/event', { session_id: 'cli-2', hook_event_name: 'Stop' })
    expect(await pending).toEqual({})
    await tg.waitFor(c => c.method === 'editMessageText' && /Answered in the terminal/.test(c.params.text))
  })

  test('a channel session\'s relayed prompt comes back as a verdict on its stream', async () => {
    await hub.post('/permission/request', {
      session: 'session-B', request_id: 'qwert', tool_name: 'Edit', description: 'edit file', input_preview: '{}',
    })
    await tg.waitFor(c => c.method === 'sendMessage' && /\[web\] Permission: Edit/.test(c.params.text))
    tg.dm(USER, 'no qwert')
    const v = await waitEvent('B', e => e.type === 'permission_verdict')
    expect(v).toEqual({ type: 'permission_verdict', request_id: 'qwert', behavior: 'deny' })
  })

  test('"yes sweet" with no such pending prompt reaches Claude as chat', async () => {
    tg.dm(USER, 'yes sweet')
    await waitEvent('A', inbound('yes sweet'))
  })

  test('a disconnected session is dropped from routing', async () => {
    aborts[0]!.abort() // session A
    for (let i = 0; i < 40; i++) {
      const s = await (await fetch('http://hub/status', { unix: hub.socket })).json() as any
      if (s.sessions.length === 1) break
      await Bun.sleep(50)
    }
    tg.dm(USER, 'only B left')
    await waitEvent('B', inbound('only B left'))
  })
})
