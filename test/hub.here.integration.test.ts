/**
 * /here: an allowlisted owner makes a group the topics group from Telegram,
 * before the group is registered.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { type Harness, startHub } from './hub-harness.ts'

const USER = 42
const STRANGER = 99
const GROUP = -1009
const OTHER = -1010
const G = String(GROUP)
let h: Harness

const access = () => JSON.parse(readFileSync(join(h.dir, 'access.json'), 'utf8'))
const said = (chat: number, pred: (text: string) => boolean) =>
  h.tg.waitFor(c => c.method === 'sendMessage' && String(c.params.chat_id) === String(chat) && pred(c.params.text ?? ''))

beforeAll(async () => {
  h = await startHub({ dmPolicy: 'allowlist', allowFrom: [String(USER)], groups: {}, pending: {} })
})
afterAll(() => h.stop())

describe('/here', () => {
  test('from someone not allowlisted it is dropped silently', async () => {
    h.tg.groupMsg(STRANGER, GROUP, '/here')
    await Bun.sleep(300)
    expect(h.tg.calls.some(c => String(c.params.chat_id) === G || c.method === 'getChatMember')).toBe(false)
    expect(access().groups).toEqual({})
  })

  test('with Topics off and the bot not an admin, it says what to fix and changes nothing', async () => {
    h.tg.nonForumChats.add(GROUP)
    h.tg.botMember = { status: 'member' }
    h.tg.groupMsg(USER, GROUP, '/here')
    const r = await said(GROUP, t => t.includes("can't be the topics group"))
    expect(r.params.text).toContain('Turn on Topics in the group settings.')
    expect(r.params.text).toContain('Make me an admin with Manage Topics.')
    expect(access().groups).toEqual({})
    expect(access().topicsGroup).toBeUndefined()
  })

  test('an admin without Manage Topics is not enough', async () => {
    h.tg.nonForumChats.delete(GROUP)
    h.tg.botMember = { status: 'administrator', can_manage_topics: false }
    const before = h.tg.calls.length
    h.tg.groupMsg(USER, GROUP, '/here')
    await h.tg.waitFor(c => h.tg.calls.indexOf(c) >= before && c.method === 'sendMessage' && String(c.params.chat_id) === G)
    const r = h.tg.calls.slice(before).find(c => c.method === 'sendMessage')!
    expect(r.params.text).toContain('Make me an admin with Manage Topics.')
    expect(r.params.text).not.toContain('Turn on Topics')
    expect(access().groups).toEqual({})
  })

  test('with everything in place it registers the group as the topics group', async () => {
    h.tg.botMember = { status: 'administrator', can_manage_topics: true }
    h.tg.groupMsg(USER, GROUP, '/here@test_bot')
    await said(GROUP, t => t === '✅ This group is now the topics group.')
    expect(access().groups).toEqual({ [G]: { requireMention: false, allowFrom: [String(USER)] } })
    expect(access().topicsGroup).toBe(G)
  })

  test('in the registered group it reports the status', async () => {
    h.tg.groupMsg(USER, GROUP, '/here')
    await said(GROUP, t => t === '✅ This group is the topics group.')
  })

  test('another group does not replace the topics group already set', async () => {
    h.tg.groupMsg(USER, OTHER, '/here')
    const r = await said(OTHER, t => t.includes('A topics group is already set'))
    expect(r.params.text).toContain(`(${G})`)
    expect(r.params.text).toContain(`/telegram-plus:access set topicsGroup ${OTHER}`)
    expect(access().groups).toEqual({ [G]: { requireMention: false, allowFrom: [String(USER)] } })
    expect(access().topicsGroup).toBe(G)
  })

  test('/here addressed to another bot is ignored', async () => {
    const before = h.tg.calls.length
    h.tg.groupMsg(USER, OTHER, '/here@other_bot')
    await Bun.sleep(300)
    expect(h.tg.calls.slice(before).some(c => String(c.params.chat_id) === String(OTHER))).toBe(false)
  })
})
