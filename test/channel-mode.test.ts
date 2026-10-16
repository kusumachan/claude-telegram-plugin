import { describe, expect, test } from 'bun:test'
import { CHANNEL_ENV, isChannelSession, nearestClaudeAncestor, type ProcLookup } from '../src/channel-mode.ts'

// Process tree:
//   100 claude (channel session, launched via bin/claude-telegram)
//   ├─ 110 bun (run wrapper) ─ 111 bun server.ts
//   └─ 120 zsh ─ 130 claude -p (nested) ─ 140 bun server.ts
const tree: Record<number, { ppid: number; comm: string }> = {
  100: { ppid: 1, comm: '/Users/me/.local/bin/claude' },
  110: { ppid: 100, comm: 'bun' },
  111: { ppid: 110, comm: 'bun' },
  120: { ppid: 100, comm: '-zsh' },
  130: { ppid: 120, comm: 'claude' },
  140: { ppid: 130, comm: 'bun' },
}
const lookup: ProcLookup = pid => tree[pid]

describe('nearestClaudeAncestor', () => {
  test('finds the closest claude, matching by executable basename', () => {
    expect(nearestClaudeAncestor(111, lookup)).toBe(100)
    expect(nearestClaudeAncestor(140, lookup)).toBe(130)
  })
  test('undefined when there is none', () => {
    expect(nearestClaudeAncestor(999, lookup)).toBeUndefined()
  })
})

describe('isChannelSession', () => {
  const env = { [CHANNEL_ENV]: '100' }

  test('false without the launcher env var', () => {
    expect(isChannelSession({}, 111, lookup)).toBe(false)
  })
  test('true for processes of the launched session', () => {
    expect(isChannelSession(env, 111, lookup)).toBe(true)
  })
  test('false for a nested claude that inherited the env var', () => {
    expect(isChannelSession(env, 140, lookup)).toBe(false)
  })
  test('trusts the env var when no claude ancestor is visible', () => {
    expect(isChannelSession(env, 999, lookup)).toBe(true)
  })
})
