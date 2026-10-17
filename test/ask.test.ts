import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { parseAskButtons, QuestionStore } from '../src/ask.ts'
import { sessionTopic } from '../src/topics.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync('/tmp/tgp-ask-') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ask = (over: object = {}) => ({
  session: 's1', asker: 'x-12A', question: 'Ship it?', askedAt: 1000,
  messages: [{ chatId: '-1009', messageId: 5, threadId: 7 }], ...over,
})

describe('QuestionStore', () => {
  test('finds the same open question from the same session, ignoring whitespace', () => {
    const s = new QuestionStore(dir)
    const q = s.add(ask())
    expect(s.find('s1', '  Ship   it? ')?.id).toBe(q.id)
    expect(s.find('s2', 'Ship it?')).toBeUndefined()
    expect(s.find('s1', 'Ship it now?')).toBeUndefined()
  })

  test('looks questions up by their message and by chat/topic', () => {
    const s = new QuestionStore(dir)
    const q = s.add(ask())
    expect(s.byMessage('-1009', 5)?.id).toBe(q.id)
    expect(s.byMessage('-1009', 6)).toBeUndefined()
    expect(s.openIn('-1009', 7).map(x => x.id)).toEqual([q.id])
    expect(s.openIn('-1009', 8)).toEqual([])
    expect(s.openIn('-1009', undefined)).toEqual([])
  })

  test('an answer is recorded once, kept until taken, then the question is gone', () => {
    const s = new QuestionStore(dir)
    const q = s.add(ask())
    expect(s.openCount).toBe(1)
    expect(s.answer(q.id, 'Yes', '@owner')).toBe(true)
    expect(s.answer(q.id, 'No', '@owner')).toBe(false)
    expect(s.openCount).toBe(0)
    expect(s.openIn('-1009', 7)).toEqual([])
    expect(s.find('s1', 'Ship it?')?.id).toBe(q.id) // asking again collects it
    expect(s.take(q.id)?.text).toBe('Yes')
    expect(s.get(q.id)).toBeUndefined()
    expect(s.take(q.id)).toBeUndefined()
  })

  test('survives a restart (persisted)', () => {
    const q = new QuestionStore(dir).add(ask())
    new QuestionStore(dir).answer(q.id, 'Later', '@owner')
    expect(new QuestionStore(dir).take(q.id)?.text).toBe('Later')
  })

  test('prune drops week-old questions and returns the unanswered ones', () => {
    const s = new QuestionStore(dir)
    const old = s.add(ask({ askedAt: 0 }))
    const oldAnswered = s.add(ask({ askedAt: 0, question: 'B?' }))
    s.answer(oldAnswered.id, 'ok', 'me')
    const fresh = s.add(ask({ askedAt: 8 * 24 * 3600_000, question: 'C?' }))
    expect(s.prune(8 * 24 * 3600_000).map(q => q.id)).toEqual([old.id])
    expect(s.get(oldAnswered.id)).toBeUndefined()
    expect(s.get(fresh.id)).toBeTruthy()
  })
})

describe('parseAskButtons', () => {
  test('accepts rows, a flat list as one row, and nothing', () => {
    expect(parseAskButtons([['Yes', 'No'], ['Later']])).toEqual([['Yes', 'No'], ['Later']])
    expect(parseAskButtons(['Yes', 'No'])).toEqual([['Yes', 'No']])
    expect(parseAskButtons(undefined)).toBeUndefined()
    expect(parseAskButtons([])).toBeUndefined()
  })

  test('rejects non-label buttons', () => {
    expect(() => parseAskButtons('Yes')).toThrow()
    expect(() => parseAskButtons([['Yes', '']])).toThrow()
    expect(() => parseAskButtons([[{ text: 'x', url: 'https://x' }]])).toThrow()
  })
})

describe('sessionTopic', () => {
  test('TELEGRAM_PLUS_TOPIC wins, else the project folder (worktrees share it)', () => {
    expect(sessionTopic('/code/project-x', {})).toBe('project-x')
    expect(sessionTopic('/code/project-x/.claude/worktrees/fix', {})).toBe('project-x')
    expect(sessionTopic('/tmp/whatever', { TELEGRAM_PLUS_TOPIC: 'project-x' })).toBe('project-x')
    expect(sessionTopic('/code/api', { TELEGRAM_PLUS_TOPIC: '  ' })).toBe('api')
  })
})
