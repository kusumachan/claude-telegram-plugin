import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { withLock } from '../src/lock.ts'

let dir: string
let lock: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-lock-'))
  lock = join(dir, 'access.lock')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('withLock', () => {
  test('runs fn, returns its value and releases the lock', () => {
    expect(withLock(lock, () => 42)).toBe(42)
    expect(existsSync(lock)).toBe(false)
  })

  test('releases the lock when fn throws', () => {
    expect(() => withLock(lock, () => { throw new Error('boom') })).toThrow('boom')
    expect(existsSync(lock)).toBe(false)
  })

  test('breaks a stale lock left by a crashed process', () => {
    mkdirSync(lock)
    const old = (Date.now() - 60_000) / 1000
    utimesSync(lock, old, old)
    expect(withLock(lock, () => 'got it')).toBe('got it')
  })

  test('waits for a live lock and times out instead of hanging', () => {
    mkdirSync(lock) // fresh → not stale
    const start = Date.now()
    expect(() => withLock(lock, () => 'never')).toThrow(/timed out/)
    expect(Date.now() - start).toBeGreaterThanOrEqual(2900)
  })

  test('a second process waits for the first to release', async () => {
    const holder = Bun.spawn(['bun', '-e', `
      const { withLock } = await import(${JSON.stringify(join(import.meta.dir, '../src/lock.ts'))})
      withLock(${JSON.stringify(lock)}, () => { console.log('held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500) })
    `], { stdout: 'pipe' })
    const reader = holder.stdout.getReader()
    await reader.read() // "held"
    const start = Date.now()
    expect(withLock(lock, () => 'after')).toBe('after')
    expect(Date.now() - start).toBeGreaterThan(100)
    await holder.exited
  })
})
