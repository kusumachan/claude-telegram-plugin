import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { PromptStore } from '../src/prompts.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync('/tmp/tgp-prompts-') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const msg = { chatId: '-1009', messageId: 5, threadId: 7, buttons: true }

describe('PromptStore', () => {
  test('open → awaiting text → answered → removed, and lookups along the way', () => {
    const s = new PromptStore(dir)
    const p = s.add({ key: 'k1', topic: 'proj', needsText: ['Revise'], messages: [msg] })
    expect(s.byKey('k1')?.id).toBe(p.id)
    expect(s.byMessage('-1009', 5)?.id).toBe(p.id)
    expect(s.openCount).toBe(1)
    expect(s.awaitingIn('-1009', 7)).toEqual([])

    s.awaitText(p.id, 'Revise')
    expect(s.awaitingIn('-1009', 7).map(x => x.pendingLabel)).toEqual(['Revise'])
    expect(s.answer(p.id, { label: 'Revise', text: 'notes', by: '@o', at: 1 })).toBe(true)
    expect(s.answer(p.id, { label: 'Continue', by: '@o', at: 2 })).toBe(false)
    expect(s.openCount).toBe(0)
    expect(s.answered().map(x => x.answer?.text)).toEqual(['notes'])
    expect(s.remove(p.id)?.id).toBe(p.id)
    expect(s.get(p.id)).toBeUndefined()
  })

  test('survives a restart', () => {
    const p = new PromptStore(dir).add({ needsText: [], messages: [msg] })
    new PromptStore(dir).answer(p.id, { label: 'Continue', by: '@o', at: 1 })
    expect(new PromptStore(dir).answered()[0]?.answer?.label).toBe('Continue')
  })

  test('prune drops month-old prompts', () => {
    const s = new PromptStore(dir)
    const old = s.add({ needsText: [], messages: [msg] }, 0)
    const fresh = s.add({ needsText: [], messages: [msg] }, 31 * 24 * 3600_000)
    expect(s.prune(31 * 24 * 3600_000).map(p => p.id)).toEqual([old.id])
    expect(s.get(fresh.id)).toBeTruthy()
  })
})
