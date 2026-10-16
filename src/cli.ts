#!/usr/bin/env bun
/**
 * Access management CLI used by the /telegram-plus:access skill.
 *
 * Every mutation goes through AccessStore.update, which holds the same lock
 * the channel server uses — so approving a pairing can't clobber a pending
 * code the server wrote a millisecond earlier.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { type Access, AccessStore, pruneExpired } from './access.ts'
import { STATE_DIR } from './config.ts'

export class CliError extends Error {}

const REPLY_TO_MODES = ['off', 'first', 'all']
const CHUNK_MODES = ['length', 'newline']
const POLICIES = ['pairing', 'allowlist', 'disabled']

export function run(argv: string[], stateDir = STATE_DIR, now = Date.now()): string {
  const store = new AccessStore(stateDir)
  const [cmd, ...rest] = argv

  switch (cmd) {
    case undefined:
    case 'status':
      return status(store.update(a => (pruneExpired(a, now), a)), now)

    case 'pair': {
      const code = need(rest[0], 'pair <code>').toLowerCase()
      const senderId = store.update(a => {
        const p = a.pending[code]
        if (!p || p.expiresAt < now) throw new CliError(`no pending pairing with code ${code} (unknown or expired)`)
        if (!a.allowFrom.includes(p.senderId)) a.allowFrom.push(p.senderId)
        delete a.pending[code]
        return p.senderId
      })
      // The server polls approved/ and sends "Paired!" to the user.
      const approved = join(stateDir, 'approved')
      mkdirSync(approved, { recursive: true, mode: 0o700 })
      writeFileSync(join(approved, senderId), senderId)
      return `approved ${senderId}`
    }

    case 'deny': {
      const code = need(rest[0], 'deny <code>').toLowerCase()
      const existed = store.update(a => {
        const had = code in a.pending
        delete a.pending[code]
        return had
      })
      return existed ? `discarded pending code ${code}` : `no pending code ${code}`
    }

    case 'allow': {
      const id = userId(need(rest[0], 'allow <userId>'))
      store.update(a => { if (!a.allowFrom.includes(id)) a.allowFrom.push(id) })
      return `allowed ${id}`
    }

    case 'remove': {
      const id = need(rest[0], 'remove <userId>')
      const removed = store.update(a => {
        const before = a.allowFrom.length
        a.allowFrom = a.allowFrom.filter(x => x !== id)
        return before !== a.allowFrom.length
      })
      return removed ? `removed ${id}` : `${id} was not in the allowlist`
    }

    case 'policy': {
      const mode = need(rest[0], 'policy <pairing|allowlist|disabled>')
      if (!POLICIES.includes(mode)) throw new CliError(`policy must be one of: ${POLICIES.join(', ')}`)
      store.update(a => { a.dmPolicy = mode as Access['dmPolicy'] })
      return `dmPolicy = ${mode}`
    }

    case 'group': {
      const [sub, groupId, ...flags] = rest
      if (sub === 'add') {
        const id = userId(need(groupId, 'group add <groupId> [--no-mention] [--allow id1,id2]'))
        const allowIdx = flags.indexOf('--allow')
        const allowFrom = allowIdx >= 0
          ? need(flags[allowIdx + 1], '--allow id1,id2').split(',').map(s => userId(s.trim())).filter(Boolean)
          : []
        const requireMention = !flags.includes('--no-mention')
        store.update(a => { a.groups[id] = { requireMention, allowFrom } })
        return `group ${id} enabled (requireMention=${requireMention}${allowFrom.length ? `, allowFrom=${allowFrom.join(',')}` : ''})` +
          (requireMention ? '' : '\nnote: --no-mention also requires disabling privacy mode in @BotFather (/setprivacy → Disable)')
      }
      if (sub === 'rm' || sub === 'remove') {
        const id = need(groupId, 'group rm <groupId>')
        store.update(a => { delete a.groups[id] })
        return `group ${id} disabled`
      }
      throw new CliError('usage: group add <groupId> [--no-mention] [--allow id1,id2] | group rm <groupId>')
    }

    case 'set': {
      const key = need(rest[0], 'set <key> <value>')
      const value = rest.slice(1).join(' ')
      const parsed = parseSetting(key, value)
      store.update(a => {
        if (parsed === undefined) delete (a as Record<string, unknown>)[key]
        else (a as Record<string, unknown>)[key] = parsed
      })
      return `${key} = ${JSON.stringify(parsed ?? null)}`
    }

    default:
      throw new CliError(`unknown command: ${cmd}`)
  }
}

function need(v: string | undefined, usage: string): string {
  if (!v) throw new CliError(`usage: ${usage}`)
  return v
}

function userId(v: string): string {
  if (!/^-?\d+$/.test(v)) throw new CliError(`expected a numeric Telegram id, got ${JSON.stringify(v)}`)
  return v
}

export function parseSetting(key: string, value: string): unknown {
  switch (key) {
    case 'ackReaction':
      return value === '""' || value === "''" ? '' : value
    case 'replyToMode':
      if (!REPLY_TO_MODES.includes(value)) throw new CliError(`replyToMode must be one of: ${REPLY_TO_MODES.join(', ')}`)
      return value
    case 'chunkMode':
      if (!CHUNK_MODES.includes(value)) throw new CliError(`chunkMode must be one of: ${CHUNK_MODES.join(', ')}`)
      return value
    case 'notify':
    case 'notifyPreview':
      if (value !== 'on' && value !== 'off') throw new CliError(`${key} must be on or off`)
      return value
    case 'notifyStopAfterSeconds': {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 0) throw new CliError(`${key} must be a non-negative integer (0 = every turn)`)
      return n
    }
    case 'textChunkLimit':
    case 'maxPending': {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1) throw new CliError(`${key} must be a positive integer`)
      return key === 'textChunkLimit' ? Math.min(n, 4096) : n
    }
    case 'mentionPatterns': {
      let arr: unknown
      try {
        arr = JSON.parse(value)
      } catch {
        throw new CliError('mentionPatterns must be a JSON array of regex strings')
      }
      if (!Array.isArray(arr) || !arr.every(x => typeof x === 'string')) {
        throw new CliError('mentionPatterns must be a JSON array of regex strings')
      }
      for (const p of arr) {
        try {
          new RegExp(p)
        } catch {
          throw new CliError(`invalid regex: ${p}`)
        }
      }
      return arr.length ? arr : undefined
    }
    default:
      throw new CliError(
        `unknown key ${key}. Supported: ackReaction, replyToMode, chunkMode, textChunkLimit, maxPending, mentionPatterns, notify, notifyStopAfterSeconds, notifyPreview`,
      )
  }
}

function status(a: Access, now: number): string {
  const lines = [
    `dmPolicy: ${a.dmPolicy}`,
    `allowFrom (${a.allowFrom.length}): ${a.allowFrom.join(', ') || '—'}`,
  ]
  const pending = Object.entries(a.pending)
  lines.push(`pending (${pending.length}):`)
  for (const [code, p] of pending) {
    const age = Math.round((now - p.createdAt) / 60000)
    lines.push(`  ${code}  sender=${p.senderId}  age=${age}m`)
  }
  const groups = Object.entries(a.groups)
  lines.push(`groups (${groups.length}):`)
  for (const [id, g] of groups) {
    lines.push(`  ${id}  requireMention=${g.requireMention}  allowFrom=${g.allowFrom.join(',') || 'any'}`)
  }
  const extras = (['ackReaction', 'replyToMode', 'chunkMode', 'textChunkLimit', 'maxPending', 'mentionPatterns', 'notify', 'notifyStopAfterSeconds', 'notifyPreview'] as const)
    .filter(k => a[k] !== undefined)
    .map(k => `${k}: ${JSON.stringify(a[k])}`)
  if (extras.length) lines.push(...extras)
  return lines.join('\n')
}

if (import.meta.main) {
  try {
    console.log(run(process.argv.slice(2)))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
