import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { type Access, defaultAccess } from '../src/access.ts'
import { decide, formatDuration, type HookInput, notifyEnabled, projectLabel, readSessionState, writeSessionState } from '../src/notify.ts'

const access: Access = { ...defaultAccess(), allowFrom: ['1'] }
const base = { session_id: 's1', cwd: '/home/me/code/api' }
const T0 = 1_000_000

describe('decide', () => {
  test('UserPromptSubmit records the turn start', () => {
    const d = decide({ ...base, hook_event_name: 'UserPromptSubmit' }, access, {}, T0)
    expect(d).toMatchObject({ send: false, state: { turnStart: T0 } })
  })

  test('Stop after a long turn sends a finished notice with preview', () => {
    const d = decide(
      { ...base, hook_event_name: 'Stop', last_assistant_message: 'Done: PR #87' },
      access, { turnStart: T0 }, T0 + 125_000,
    )
    expect(d.send).toBe(true)
    if (d.send) expect(d.text).toBe('✅ api · finished (2m 5s)\n\nDone: PR #87')
    expect(d.state?.stopNotifiedAt).toBe(T0 + 125_000)
  })

  test('Stop after a short turn stays quiet', () => {
    const d = decide({ ...base, hook_event_name: 'Stop' }, access, { turnStart: T0 }, T0 + 5_000)
    expect(d.send).toBe(false)
  })

  test('Stop threshold 0 notifies every turn; preview can be turned off', () => {
    const d = decide(
      { ...base, hook_event_name: 'Stop', last_assistant_message: 'secret stuff' },
      { ...access, notifyStopAfterSeconds: 0, notifyPreview: 'off' }, {}, T0,
    )
    expect(d.send).toBe(true)
    if (d.send) expect(d.text).toBe('✅ api · finished')
  })

  test('Stop continuing from another stop hook is skipped', () => {
    expect(decide({ ...base, hook_event_name: 'Stop', stop_hook_active: true }, access, { turnStart: 0 }, T0).send).toBe(false)
  })

  test('permission prompt notifies with title and message', () => {
    const input: HookInput = {
      ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt',
      title: 'Permission needed', message: 'Claude needs your permission to use Bash',
    }
    const d = decide(input, access, {}, T0)
    expect(d.send).toBe(true)
    if (d.send) expect(d.text).toBe('🔐 api · Permission needed\nClaude needs your permission to use Bash')
  })

  test('idle prompt right after a finished notice is suppressed', () => {
    const input: HookInput = { ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' }
    expect(decide(input, access, { turnStart: T0, stopNotifiedAt: T0 + 10 }, T0 + 70_000).send).toBe(false)
    expect(decide(input, access, { turnStart: T0 + 20 }, T0 + 70_000).send).toBe(true)
  })

  test('uninteresting notification types are ignored', () => {
    expect(decide({ ...base, hook_event_name: 'Notification', notification_type: 'auth_success' }, access, {}, T0).send).toBe(false)
  })
})

describe('helpers', () => {
  test('projectLabel handles worktrees', () => {
    expect(projectLabel('/code/api')).toBe('api')
    expect(projectLabel('/code/api/.claude/worktrees/fix-login/src')).toBe('api/fix-login')
    expect(projectLabel(undefined)).toBe('session')
  })

  test('formatDuration', () => {
    expect(formatDuration(42_000)).toBe('42s')
    expect(formatDuration(3_725_000)).toBe('1h 2m')
  })

  test('notifyEnabled needs someone to notify', () => {
    expect(notifyEnabled(access)).toBe(true)
    expect(notifyEnabled(defaultAccess())).toBe(false)
    expect(notifyEnabled({ ...access, notify: 'off' })).toBe(false)
    expect(notifyEnabled({ ...access, dmPolicy: 'disabled' })).toBe(false)
  })
})

describe('on-disk state', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-notify-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('session state round-trips', () => {
    expect(readSessionState(dir, 's/../x')).toEqual({})
    writeSessionState(dir, 's/../x', { turnStart: 5 })
    expect(readSessionState(dir, 's/../x')).toEqual({ turnStart: 5 })
  })
})
