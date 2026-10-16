import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AccessStore } from '../src/access.ts'
import { gate } from '../src/gate.ts'
import { run } from '../src/cli.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-cli-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const store = () => new AccessStore(dir)

describe('cli', () => {
  test('pair approves the sender and drops the approved marker', () => {
    const r = gate(store(), { chatType: 'private', chatId: '42', senderId: '42', mentioned: () => false })
    if (r.action !== 'pair') throw new Error('expected pair')
    expect(run(['pair', r.code.toUpperCase()], dir)).toBe('approved 42')
    expect(store().load().allowFrom).toEqual(['42'])
    expect(store().load().pending).toEqual({})
    expect(existsSync(join(dir, 'approved', '42'))).toBe(true)
  })

  test('pair with unknown code fails', () => {
    expect(() => run(['pair', 'abcdef'], dir)).toThrow(/no pending pairing/)
  })

  test('pairing preserves pending codes written by the server', () => {
    const s = store()
    const a = gate(s, { chatType: 'private', chatId: '1', senderId: '1', mentioned: () => false })
    gate(s, { chatType: 'private', chatId: '2', senderId: '2', mentioned: () => false })
    if (a.action !== 'pair') throw new Error('expected pair')
    run(['pair', a.code], dir)
    expect(Object.values(store().load().pending).map(p => p.senderId)).toEqual(['2'])
  })

  test('allow / remove / policy', () => {
    run(['allow', '5'], dir)
    run(['allow', '5'], dir)
    expect(store().load().allowFrom).toEqual(['5'])
    expect(() => run(['allow', '@bob'], dir)).toThrow(/numeric/)
    run(['remove', '5'], dir)
    expect(store().load().allowFrom).toEqual([])
    run(['policy', 'allowlist'], dir)
    expect(store().load().dmPolicy).toBe('allowlist')
    expect(() => run(['policy', 'open'], dir)).toThrow()
  })

  test('group add with flags', () => {
    run(['group', 'add', '-1001', '--no-mention', '--allow', '1,2'], dir)
    expect(store().load().groups['-1001']).toEqual({ requireMention: false, allowFrom: ['1', '2'] })
    run(['group', 'rm', '-1001'], dir)
    expect(store().load().groups).toEqual({})
  })

  test('set validates values', () => {
    run(['set', 'replyToMode', 'all'], dir)
    run(['set', 'textChunkLimit', '9999'], dir)
    run(['set', 'mentionPatterns', '["^hey"]'], dir)
    run(['set', 'ackReaction', '""'], dir)
    const a = store().load()
    expect(a.replyToMode).toBe('all')
    expect(a.textChunkLimit).toBe(4096)
    expect(a.mentionPatterns).toEqual(['^hey'])
    expect(a.ackReaction).toBe('')
    expect(() => run(['set', 'mentionPatterns', '["("]'], dir)).toThrow(/invalid regex/)
    expect(() => run(['set', 'bogus', 'x'], dir)).toThrow(/unknown key/)
  })

  test('status prints a summary', () => {
    run(['allow', '5'], dir)
    expect(run([], dir)).toContain('allowFrom (1): 5')
  })
})
