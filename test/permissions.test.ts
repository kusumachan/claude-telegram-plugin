import { describe, expect, test } from 'bun:test'
import type { Api } from 'grammy'
import { PERMISSION_TTL_MS, PermissionRelay } from '../src/permissions.ts'

function fakeApi() {
  let nextId = 100
  const sent: { chatId: string; text: string }[] = []
  const edits: { chatId: string; messageId: number; text: string }[] = []
  const api = {
    sendMessage: async (chatId: string, text: string) => {
      sent.push({ chatId, text })
      return { message_id: nextId++ }
    },
    editMessageText: async (chatId: string, messageId: number, text: string) => {
      edits.push({ chatId, messageId, text })
      return true
    },
  } as unknown as Api
  return { api, sent, edits }
}

const req = { request_id: 'abcde', tool_name: 'Bash', description: 'run ls', input_preview: '{"command":"ls"}' }

describe('PermissionRelay', () => {
  test('resolve notifies, closes every prompt and forgets the request', async () => {
    const { api, sent, edits } = fakeApi()
    const notified: string[] = []
    const relay = new PermissionRelay(api, async (id, b) => { notified.push(`${id}:${b}`) })
    await relay.request(req, ['1', '2'])
    expect(sent).toHaveLength(2)
    await relay.resolve('abcde', 'allow', '@me')
    expect(notified).toEqual(['abcde:allow'])
    expect(edits.map(e => e.chatId).sort()).toEqual(['1', '2'])
    expect(edits[0]!.text).toContain('Allowed by @me')
    expect(relay.size).toBe(0)
  })

  test('has() only knows ids we sent, so "yes sweet" stays ordinary chat', async () => {
    const { api } = fakeApi()
    const relay = new PermissionRelay(api, async () => {})
    await relay.request(req, ['1'])
    expect(relay.has('abcde')).toBe(true)
    expect(relay.has('sweet')).toBe(false)
  })

  test('details pretty-prints the input', async () => {
    const { api } = fakeApi()
    const relay = new PermissionRelay(api, async () => {})
    await relay.request(req, ['1'])
    expect(relay.details('abcde')).toContain('"command": "ls"')
    expect(relay.details('zzzzz')).toBeUndefined()
  })

  test('prune expires stale requests', async () => {
    const { api, edits } = fakeApi()
    const relay = new PermissionRelay(api, async () => {})
    const t0 = Date.now()
    await relay.request(req, ['1'], t0)
    await relay.prune(t0 + PERMISSION_TTL_MS + 1)
    expect(relay.size).toBe(0)
    expect(edits[0]!.text).toContain('Expired')
  })
})
