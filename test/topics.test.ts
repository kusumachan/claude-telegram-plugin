import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { run } from '../src/cli.ts'
import { Router } from '../src/hub/router.ts'
import { isMissingTopic, TopicStore, topicName } from '../src/topics.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-topics-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('TopicStore', () => {
  test('creates a topic once and reuses it', async () => {
    const store = new TopicStore(dir)
    let made = 0
    const create = async () => 100 + made++
    expect(await store.ensure('-1009', 'api', create)).toEqual({ threadId: 100, created: true })
    expect(await new TopicStore(dir).ensure('-1009', 'api', create)).toEqual({ threadId: 100, created: false })
    expect(made).toBe(1)
    expect(store.nameFor('-1009', 100)).toBe('api')
    expect(store.nameFor('-1009', 999)).toBeUndefined()
  })

  test('concurrent ensure calls create only one topic', async () => {
    const store = new TopicStore(dir)
    let made = 0
    const create = async () => { await Bun.sleep(30); return 200 + made++ }
    const [a, b] = await Promise.all([store.ensure('-1009', 'web', create), store.ensure('-1009', 'web', create)])
    expect(made).toBe(1)
    expect(a.threadId).toBe(b.threadId)
  })

  test('forget drops a deleted topic so the next ensure recreates it', async () => {
    const store = new TopicStore(dir)
    let next = 300
    await store.ensure('-1009', 'api', async () => next++)
    store.forget('-1009', 'api')
    expect((await store.ensure('-1009', 'api', async () => next++)).threadId).toBe(301)
  })

  test('a failed create stores nothing', async () => {
    const store = new TopicStore(dir)
    await expect(store.ensure('-1009', 'api', async () => { throw new Error('not enough rights') })).rejects.toThrow()
    expect(store.get('-1009', 'api')).toBeUndefined()
  })

  test('helpers', () => {
    expect(topicName('api/fix-login')).toBe('api')
    expect(topicName('api')).toBe('api')
    expect(isMissingTopic('Bad Request: message thread not found')).toBe(true)
    expect(isMissingTopic('Bad Request: chat not found')).toBe(false)
  })
})

describe('Router with topics', () => {
  test('a session topic wins over the chat\'s active session; offline when not connected', () => {
    const r = new Router()
    r.add('a', 'api', '/a')
    r.add('b', 'web', '/b')
    r.setActive('-1009', 'b')
    expect(r.route('-1009', undefined, 'api')).toMatchObject({ kind: 'session', session: { id: 'a' } })
    expect(r.route('-1009', undefined, 'docs')).toEqual({ kind: 'offline', name: 'docs' })
    expect(r.route('-1009')).toMatchObject({ session: { id: 'b' } })
  })
})

describe('cli topicsGroup', () => {
  test('must be an enabled supergroup; group rm clears it', () => {
    expect(() => run(['set', 'topicsGroup', '-42'], dir)).toThrow(/supergroup id/)
    expect(() => run(['set', 'topicsGroup', '-1001234'], dir)).toThrow(/isn't enabled/)
    run(['group', 'add', '-1001234', '--allow', '42'], dir)
    expect(run(['set', 'topicsGroup', '-1001234'], dir)).toContain('Manage Topics')
    run(['group', 'rm', '-1001234'], dir)
    expect(run(['status'], dir)).not.toContain('topicsGroup')
  })
})
