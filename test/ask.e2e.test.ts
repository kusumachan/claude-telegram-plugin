/**
 * ask_owner end to end: a real server.ts in tools-only mode, driven over
 * stdio by an MCP client the way Claude Code drives it, against a real hub.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { type Harness, startHub } from './hub-harness.ts'

const USER = 42
const GROUP = -1009
const G = String(GROUP)
let h: Harness

beforeAll(async () => {
  h = await startHub({
    dmPolicy: 'allowlist', allowFrom: [String(USER)], groups: { [G]: { requireMention: false, allowFrom: [] } }, pending: {}, topicsGroup: G,
  })
})
afterAll(() => h.stop())

async function agent(env: Record<string, string>): Promise<Client> {
  const base: Record<string, string> = { ...(process.env as Record<string, string>), TELEGRAM_STATE_DIR: h.dir, TELEGRAM_API_ROOT: h.tg.apiRoot }
  delete base.TELEGRAM_BOT_TOKEN
  delete base.TELEGRAM_PLUS_CHANNEL_PID
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [join(import.meta.dir, '../server.ts')],
    cwd: '/tmp',
    env: { ...base, TELEGRAM_PLUS_ASK_HEARTBEAT_MS: '100', ...env },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(transport)
  return client
}

const text = (r: any) => r.content[0].text as string

describe('ask_owner tool', () => {
  test('is listed, sends progress while waiting, and returns the tapped label', async () => {
    const client = await agent({ CLAUDE_CODE_SESSION_ID: 'e2e-1', TELEGRAM_PLUS_NAME: 'project-x-12A', TELEGRAM_PLUS_TOPIC: 'project-x' })
    try {
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toContain('ask_owner')

      let progress = 0
      const call = client.callTool(
        { name: 'ask_owner', arguments: { question: 'Merge the migration first?', buttons: [['Yes', 'No']] } },
        undefined,
        { onprogress: () => { progress++ }, timeout: 2000, resetTimeoutOnProgress: true },
      )
      const msg = await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text?.includes('Merge the migration first?'))
      expect(msg.params.text).toStartWith('❓ project-x-12A asks:')
      await Bun.sleep(2500) // longer than the client's own timeout: only progress keeps it alive
      h.tg.groupTap(USER, GROUP, 'btn:0:1', msg.result.message_id, msg.params.reply_markup, msg.params.message_thread_id)
      const r = await call
      expect(text(r)).toBe('No')
      expect(progress).toBeGreaterThan(5)
    } finally {
      await client.close()
    }
  })

  test('returns "no answer yet" at the cap; asking again collects an answer given in between', async () => {
    const client = await agent({ CLAUDE_CODE_SESSION_ID: 'e2e-2', TELEGRAM_PLUS_TOPIC: 'project-x', TELEGRAM_PLUS_ASK_TIMEOUT_MS: '500' })
    try {
      const args = { name: 'ask_owner', arguments: { question: 'Which queue driver?' } }
      const first = await client.callTool(args)
      expect(text(first)).toStartWith('No answer yet')
      const msg = await h.tg.waitFor(c => c.method === 'sendMessage' && c.params.text?.includes('Which queue driver?'))
      h.tg.groupMsg(USER, GROUP, 'redis', msg.params.message_thread_id)
      await h.tg.waitFor(c => c.method === 'editMessageText' && c.params.text?.includes('→ redis'))
      expect(text(await client.callTool(args))).toBe('redis')
      expect(h.tg.calls.filter(c => c.method === 'sendMessage' && c.params.text?.includes('Which queue driver?')).length).toBe(1)
    } finally {
      await client.close()
    }
  })
})
