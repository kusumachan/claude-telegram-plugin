import { describe, expect, test } from 'bun:test'
import { buildKeyboard, labelFor } from '../src/buttons.ts'
import { defaultAccess } from '../src/access.ts'
import { callbackAllowed } from '../src/gate.ts'

const markupOf = (raw: unknown) => ({ inline_keyboard: buildKeyboard(raw)!.inline_keyboard })

describe('buildKeyboard', () => {
  test('rows of labels become callback buttons with positional data', () => {
    const kb = markupOf([['Yes', 'No'], ['Maybe']])
    expect(kb.inline_keyboard).toEqual([
      [{ text: 'Yes', callback_data: 'btn:0:0' }, { text: 'No', callback_data: 'btn:0:1' }],
      [{ text: 'Maybe', callback_data: 'btn:1:0' }],
    ])
  })

  test('a flat list is treated as one row', () => {
    expect(markupOf(['A', 'B']).inline_keyboard).toHaveLength(1)
  })

  test('url buttons are allowed, other schemes are not', () => {
    expect(markupOf([[{ text: 'Docs', url: 'https://x.dev' }]]).inline_keyboard[0]![0]).toEqual({ text: 'Docs', url: 'https://x.dev' })
    expect(() => buildKeyboard([[{ text: 'x', url: 'javascript:alert(1)' }]])).toThrow(/http/)
  })

  test('validation', () => {
    expect(buildKeyboard(undefined)).toBeUndefined()
    expect(buildKeyboard([])).toBeUndefined()
    expect(() => buildKeyboard('Yes')).toThrow()
    expect(() => buildKeyboard([['  ']])).toThrow(/empty/)
    expect(() => buildKeyboard([[42]])).toThrow(/invalid button/)
    expect(() => buildKeyboard(Array.from({ length: 11 }, () => ['x']))).toThrow(/rows/)
  })

  test('long labels are truncated', () => {
    const text = markupOf([['x'.repeat(100)]]).inline_keyboard[0]![0]!.text
    expect(text.length).toBe(64)
  })
})

describe('labelFor', () => {
  const markup = markupOf([['Yes', 'No'], [{ text: 'Docs', url: 'https://x.dev' }]])

  test('resolves a tap back to its label', () => {
    expect(labelFor(markup, 'btn:0:1')).toBe('No')
  })

  test('unknown position, url button or missing markup → undefined', () => {
    expect(labelFor(markup, 'btn:5:0')).toBeUndefined()
    expect(labelFor(markup, 'btn:1:0')).toBeUndefined()
    expect(labelFor(undefined, 'btn:0:0')).toBeUndefined()
    expect(labelFor(markup, 'perm:allow:abcde')).toBeUndefined()
  })
})

describe('callbackAllowed', () => {
  const access = { ...defaultAccess(), allowFrom: ['1'], groups: { '-100': { requireMention: true, allowFrom: [] }, '-200': { requireMention: false, allowFrom: ['7'] } } }

  test('DMs: allowlisted only', () => {
    expect(callbackAllowed(access, 'private', '1', '1')).toBe(true)
    expect(callbackAllowed(access, 'private', '2', '2')).toBe(false)
  })

  test('groups: enabled group, respecting member allowFrom, ignoring requireMention', () => {
    expect(callbackAllowed(access, 'supergroup', '-100', '9')).toBe(true)
    expect(callbackAllowed(access, 'supergroup', '-200', '9')).toBe(false)
    expect(callbackAllowed(access, 'supergroup', '-200', '7')).toBe(true)
    expect(callbackAllowed(access, 'supergroup', '-300', '1')).toBe(false)
  })

  test('disabled policy blocks everything', () => {
    expect(callbackAllowed({ ...access, dmPolicy: 'disabled' }, 'private', '1', '1')).toBe(false)
  })
})
