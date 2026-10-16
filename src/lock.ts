import { mkdirSync, rmSync, statSync } from 'fs'

const STALE_MS = 10_000
const TIMEOUT_MS = 3_000
const sleeper = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms)
}

/**
 * Cross-process mutex using an atomic `mkdir`. Both the channel server and
 * the access CLI mutate access.json; without this, a pairing code written by
 * the server between the CLI's read and write gets clobbered.
 *
 * A lock left behind by a crashed process is broken after STALE_MS.
 */
export function withLock<T>(lockPath: string, fn: () => T): T {
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    try {
      mkdirSync(lockPath)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true })
          continue
        }
      } catch {
        continue // vanished between mkdir and stat — retry immediately
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`)
      sleepSync(10)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lockPath, { recursive: true, force: true })
  }
}
