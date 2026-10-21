/** Runs hooks/notify.ts as Claude Code would (stdin JSON) against a fake Bot API. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { FakeTelegram } from './fake-telegram.ts'

const G = '-1009'
let tg: FakeTelegram
let dir: string

beforeEach(() => {
  tg = new FakeTelegram()
  dir = mkdtempSync('/tmp/tgp-hook-')
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=1:test\n')
})
afterEach(() => {
  tg.stop()
  rmSync(dir, { recursive: true, force: true })
})

function setAccess(extra: object): void {
  writeFileSync(join(dir, 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist', allowFrom: ['42'], groups: { [G]: { requireMention: false, allowFrom: ['42'] } }, pending: {},
    notifyStopAfterSeconds: 0, ...extra,
  }))
}

async function runHook(input: object, extraEnv: Record<string, string> = {}): Promise<void> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TELEGRAM_STATE_DIR: dir, TELEGRAM_API_ROOT: tg.apiRoot }
  delete env.TELEGRAM_BOT_TOKEN
  delete env.TELEGRAM_PLUS_CHANNEL_PID
  delete env.TELEGRAM_PLUS_NOTIFY
  Object.assign(env, extraEnv)
  const p = Bun.spawn(['bun', join(import.meta.dir, '../hooks/notify.ts')], { env, stdin: new Blob([JSON.stringify(input)]) })
  await p.exited
}

const stop = (cwd: string) => ({ session_id: 's1', cwd, hook_event_name: 'Stop', last_assistant_message: 'All done' })

describe('notify hook', () => {
  test('without a topics group, notices go to allowlisted DMs', async () => {
    setAccess({})
    await runHook(stop('/code/api'))
    const sent = tg.calls.filter(c => c.method === 'sendMessage')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.params.chat_id).toBe('42')
    expect(sent[0]!.params.text).toStartWith('✅ api · finished')
  })

  test('with a topics group, notices go to the project topic (created once)', async () => {
    setAccess({ topicsGroup: G })
    await runHook(stop('/code/api/.claude/worktrees/fix'))
    await runHook(stop('/code/api'))
    expect(tg.calls.filter(c => c.method === 'createForumTopic')).toHaveLength(1)
    const notices = tg.calls.filter(c => c.method === 'sendMessage' && c.params.text.startsWith('✅'))
    expect(notices.map(c => [c.params.chat_id, c.params.message_thread_id])).toEqual([[G, 500], [G, 500]])
    expect(JSON.parse(readFileSync(join(dir, 'topics.json'), 'utf8'))).toEqual({ [G]: { api: 500 } })
  })

  test('a deleted topic is recreated', async () => {
    setAccess({ topicsGroup: G })
    writeFileSync(join(dir, 'topics.json'), JSON.stringify({ [G]: { api: 77 } }))
    tg.deletedThreads.add(77)
    await runHook(stop('/code/api'))
    const ok = tg.calls.filter(c => c.method === 'sendMessage' && c.params.text.startsWith('✅') && c.params.message_thread_id === 500)
    expect(ok).toHaveLength(1)
  })

  test('TELEGRAM_PLUS_NOTIFY=attention skips the finished notice', async () => {
    setAccess({})
    await runHook(stop('/code/api'), { TELEGRAM_PLUS_NOTIFY: 'attention' })
    expect(tg.calls.filter(c => c.method === 'sendMessage')).toHaveLength(0)
  })
})
