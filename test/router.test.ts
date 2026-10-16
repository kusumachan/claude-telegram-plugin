import { describe, expect, test } from 'bun:test'
import { Router, sanitizeName } from '../src/hub/router.ts'

describe('Router', () => {
  test('no sessions → none; one → it; several → pick', () => {
    const r = new Router()
    expect(r.route('1')).toEqual({ kind: 'none' })
    r.add('a', 'api', '/code/api', 1)
    expect(r.route('1')).toMatchObject({ kind: 'session', session: { id: 'a' } })
    r.add('b', 'web', '/code/web', 2)
    expect(r.route('1')).toEqual({ kind: 'pick' })
  })

  test('active session wins over pick, per chat', () => {
    const r = new Router()
    r.add('a', 'api', '/a')
    r.add('b', 'web', '/b')
    expect(r.setActive('1', 'b')).toBe(true)
    expect(r.route('1')).toMatchObject({ session: { id: 'b' } })
    expect(r.route('2')).toEqual({ kind: 'pick' })
    expect(r.setActive('1', 'zzz')).toBe(false)
  })

  test('a reply to a session\'s message goes to that session, even if another is active', () => {
    const r = new Router()
    r.add('a', 'api', '/a')
    r.add('b', 'web', '/b')
    r.setActive('1', 'b')
    r.recordOwner('1', [10, 11], 'a')
    expect(r.route('1', 11)).toMatchObject({ session: { id: 'a' } })
    expect(r.route('1', 99)).toMatchObject({ session: { id: 'b' } })
  })

  test('removing a session clears its active choices and its owned messages stop routing', () => {
    const r = new Router()
    r.add('a', 'api', '/a')
    r.add('b', 'web', '/b')
    r.setActive('1', 'a')
    r.recordOwner('1', [10], 'a')
    r.remove('a')
    expect(r.route('1', 10)).toMatchObject({ session: { id: 'b' } })
  })

  test('names are unique among live sessions; reconnect keeps the name', () => {
    const r = new Router()
    expect(r.add('a', 'api', '/a').name).toBe('api')
    expect(r.add('b', 'api', '/a2').name).toBe('api-2')
    expect(r.add('a', 'whatever', '/a').name).toBe('api')
    expect(r.findByName('API-2')?.id).toBe('b')
  })

  test('sanitizeName', () => {
    expect(sanitizeName('  my project!! ')).toBe('my-project')
    expect(sanitizeName('???')).toBe('session')
    expect(sanitizeName('x'.repeat(50))).toHaveLength(32)
  })
})
