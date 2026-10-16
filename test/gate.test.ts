import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AccessStore, PAIRING_TTL_MS } from '../src/access.ts'
import { gate, isMentioned } from '../src/gate.ts'

let dir: string
let store: AccessStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-gate-'))
  store = new AccessStore(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const dm = (senderId: string) => ({ chatType: 'private', chatId: senderId, senderId, mentioned: () => false })

describe('gate — DMs', () => {
  test('unknown sender gets a pairing code, then one reminder, then silence', () => {
    const first = gate(store, dm('1'))
    expect(first.action).toBe('pair')
    const second = gate(store, dm('1'))
    expect(second).toMatchObject({ action: 'pair', isResend: true })
    expect(gate(store, dm('1')).action).toBe('drop')
  })

  test('allowlisted sender is delivered', () => {
    store.update(a => { a.allowFrom.push('1') })
    expect(gate(store, dm('1')).action).toBe('deliver')
  })

  test('allowlist policy drops strangers silently', () => {
    store.update(a => { a.dmPolicy = 'allowlist' })
    expect(gate(store, dm('2')).action).toBe('drop')
    expect(Object.keys(store.load().pending)).toHaveLength(0)
  })

  test('disabled drops everyone', () => {
    store.update(a => { a.dmPolicy = 'disabled'; a.allowFrom.push('1') })
    expect(gate(store, dm('1')).action).toBe('drop')
  })

  test('pending cap is configurable', () => {
    store.update(a => { a.maxPending = 2 })
    expect(gate(store, dm('1')).action).toBe('pair')
    expect(gate(store, dm('2')).action).toBe('pair')
    expect(gate(store, dm('3')).action).toBe('drop')
  })

  test('expired codes are pruned and the sender can pair again', () => {
    const now = Date.now()
    gate(store, dm('1'), now)
    gate(store, dm('1'), now) // reminder
    expect(gate(store, dm('1'), now + PAIRING_TTL_MS + 1).action).toBe('pair')
  })
})

describe('gate — groups', () => {
  const grp = (senderId: string, mentioned: boolean) => ({
    chatType: 'supergroup', chatId: '-100', senderId, mentioned: () => mentioned,
  })

  test('unknown group is dropped', () => {
    expect(gate(store, grp('1', true)).action).toBe('drop')
  })

  test('requireMention gates on mention', () => {
    store.update(a => { a.groups['-100'] = { requireMention: true, allowFrom: [] } })
    expect(gate(store, grp('1', false)).action).toBe('drop')
    expect(gate(store, grp('1', true)).action).toBe('deliver')
  })

  test('group allowFrom restricts members', () => {
    store.update(a => { a.groups['-100'] = { requireMention: false, allowFrom: ['7'] } })
    expect(gate(store, grp('1', true)).action).toBe('drop')
    expect(gate(store, grp('7', false)).action).toBe('deliver')
  })
})

describe('AccessStore', () => {
  test('corrupt file is moved aside', () => {
    writeFileSync(join(dir, 'access.json'), '{nope')
    expect(store.load().dmPolicy).toBe('pairing')
  })

  test('static mode downgrades pairing and never writes', () => {
    const s = new AccessStore(dir, true)
    expect(s.load().dmPolicy).toBe('allowlist')
    s.update(a => { a.allowFrom.push('9') })
    expect(s.load().allowFrom).toEqual([])
  })
})

describe('isMentioned', () => {
  const base = { botUsername: 'mybot', entities: [] as never[] }

  test('structured @mention, case-insensitive', () => {
    expect(isMentioned({ ...base, text: 'hi @MyBot', entities: [{ type: 'mention', offset: 3, length: 6 }] })).toBe(true)
  })
  test('reply to the bot counts', () => {
    expect(isMentioned({ ...base, text: 'ok', replyToUsername: 'mybot' })).toBe(true)
  })
  test('regex patterns, invalid ones skipped', () => {
    expect(isMentioned({ ...base, text: 'hey claude', patterns: ['(', '^hey claude'] })).toBe(true)
    expect(isMentioned({ ...base, text: 'nothing', patterns: ['^hey'] })).toBe(false)
  })
  test('nothing matches before the bot username is known', () => {
    expect(isMentioned({ ...base, botUsername: '', text: 'x', replyToUsername: '' })).toBe(false)
  })
})
