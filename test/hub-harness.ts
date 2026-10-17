/** Runs a real hub.ts against a FakeTelegram for integration tests. */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { type HubEvent, HubClient } from '../src/hub/client.ts'
import { FakeTelegram } from './fake-telegram.ts'

export type Harness = {
  tg: FakeTelegram
  hub: HubClient
  dir: string
  /** Connect a fake channel session; returns its event log and a disconnect fn. */
  connect(id: string, name: string, cwd?: string): { events: HubEvent[]; close(): void }
  /** Connect as the orchestrator. */
  connectOrchestrator(): { events: HubEvent[]; close(): void }
  /** Register an inbox session (what server.ts does with TELEGRAM_PLUS_INBOX=1). */
  connectInbox(id: string, name: string, topic: string): { events: HubEvent[]; close(): void }
  waitEvent(events: HubEvent[], pred: (e: HubEvent) => boolean, timeoutMs?: number): Promise<HubEvent>
  stop(): Promise<void>
}

export async function startHub(access: object, files: Record<string, string> = {}): Promise<Harness> {
  const tg = new FakeTelegram()
  const dir = mkdtempSync('/tmp/tgp-it-')
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=1:test\n')
  writeFileSync(join(dir, 'access.json'), JSON.stringify(access))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)

  const env: Record<string, string> = { ...(process.env as Record<string, string>), TELEGRAM_STATE_DIR: dir, TELEGRAM_API_ROOT: tg.apiRoot }
  delete env.TELEGRAM_BOT_TOKEN // token only from the temp .env
  // HUB_DEBUG_LOG=path keeps the hub's stderr for debugging a failing test.
  const proc = Bun.spawn(['bun', join(import.meta.dir, '../hub.ts')], {
    env,
    stderr: process.env.HUB_DEBUG_LOG ? Bun.file(process.env.HUB_DEBUG_LOG) : 'ignore',
  })

  const hub = new HubClient(dir, '')
  for (let i = 0; i < 100 && !(await hub.healthy(200)); i++) await Bun.sleep(50)
  await tg.waitFor(c => c.method === 'setMyCommands') // polling started

  const aborts: AbortController[] = []

  return {
    tg,
    hub,
    dir,
    connect(id, name, cwd = `/code/${name}`) {
      return stream('/session/connect', { id, name, cwd })
    },
    connectOrchestrator() {
      return stream('/orchestrator/connect', {})
    },
    connectInbox(id, name, topic) {
      return stream('/inbox/connect', { id, name, topic, cwd: `/code/${topic}` })
    },
    async waitEvent(events, pred, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const hit = events.find(pred)
        if (hit) return hit
        if (Date.now() > deadline) throw new Error(`no matching event: ${JSON.stringify(events)}`)
        await Bun.sleep(25)
      }
    },
    async stop() {
      for (const ac of aborts) ac.abort()
      proc.kill()
      await proc.exited
      tg.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }

  function stream(path: string, body: object): { events: HubEvent[]; close(): void } {
    const events: HubEvent[] = []
    const ac = new AbortController()
    aborts.push(ac)
    void fetch(`http://hub${path}`, {
      unix: hub.socket,
      method: 'POST',
      body: JSON.stringify(body),
      signal: ac.signal,
    }).then(async res => {
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body!) {
        buf += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          events.push(JSON.parse(buf.slice(0, nl)))
          buf = buf.slice(nl + 1)
        }
      }
    }).catch(() => {})
    return { events, close: () => ac.abort() }
  }
}

export const inbound = (text: string) => (e: HubEvent) => e.type === 'inbound' && e.content === text
