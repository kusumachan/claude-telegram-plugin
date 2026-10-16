import { describe, expect, test } from 'bun:test'
import { chunk, safeName, safeSnippet, toPlain } from '../src/text.ts'
import { parseEnvFile } from '../src/config.ts'

describe('chunk', () => {
  test('short text is one chunk', () => {
    expect(chunk('hello', 10, 'length')).toEqual(['hello'])
  })

  test('length mode cuts exactly at the limit', () => {
    expect(chunk('abcdefghij', 4, 'length')).toEqual(['abcd', 'efgh', 'ij'])
  })

  test('newline mode prefers paragraph boundaries', () => {
    const text = 'aaaa aaaa\n\nbbbb'
    expect(chunk(text, 12, 'newline')).toEqual(['aaaa aaaa', 'bbbb'])
  })

  test('never splits a surrogate pair', () => {
    const text = 'ab😀cd'
    const parts = chunk(text, 3, 'length')
    expect(parts.join('')).toBe(text)
    for (const p of parts) expect(p).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  test('every chunk respects the limit', () => {
    const text = 'x'.repeat(10_000)
    for (const p of chunk(text, 4096, 'newline')) expect(p.length).toBeLessThanOrEqual(4096)
  })
})

describe('sanitizers', () => {
  test('safeName strips tag delimiters', () => {
    expect(safeName('a<b>"c";\n[d]')).toBe('a_b__c____d_')
  })

  test('safeSnippet flattens whitespace and truncates', () => {
    expect(safeSnippet('a\n\nb   c', 100)).toBe('a b c')
    expect(safeSnippet('x'.repeat(20), 5)).toBe('xxxxx…')
    expect(safeSnippet(undefined)).toBeUndefined()
  })
})

describe('toPlain', () => {
  test('strips html', () => {
    expect(toPlain('<b>hi</b> &amp; <i>bye</i>', 'html')).toBe('hi & bye')
  })
  test('unescapes markdownv2', () => {
    expect(toPlain('1\\.5 \\- ok\\!', 'markdownv2')).toBe('1.5 - ok!')
  })
})

describe('parseEnvFile', () => {
  test('handles export, quotes and comments', () => {
    expect(parseEnvFile('# c\nexport A=1\nB="two"\nC=\'3\'\nbad line')).toEqual({ A: '1', B: 'two', C: '3' })
  })
})
