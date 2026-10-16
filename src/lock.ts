import { mkdirSync, rmSync, statSync } from 'fs'

const STALE_MS = 10_000
const TIMEOUT_MS = 3_000
const sleeper = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms)
}

/**
 * One attempt at the lock: true if acquired. A lock left behind by a
 * crashed process is broken after STALE_MS.
 */
function tryAcquire(lockPath: string): boolean {
  try {
    mkdirSync(lockPath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) {
        rmSync(lockPath, { recursive: true, force: true })
        return tryAcquire(lockPath)
      }
    } catch {
      return tryAcquire(lockPath) // vanished between mkdir and stat
    }
    return false
  }
}

function release(lockPath: string): void {
  rmSync(lockPath, { recursive: true, force: true })
}

/**
 * Cross-process mutex using an atomic `mkdir`. Both the channel server and
 * the access CLI mutate access.json; without this, a pairing code written by
 * the server between the CLI's read and write gets clobbered.
 */
export function withLock<T>(lockPath: string, fn: () => T): T {
  const deadline = Date.now() + TIMEOUT_MS
  while (!tryAcquire(lockPath)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`)
    sleepSync(10)
  }
  try {
    return fn()
  } finally {
    release(lockPath)
  }
}

/**
 * Same lock, for critical sections that await (e.g. "create the forum topic
 * unless someone else already did"). Waits without blocking the event loop.
 * Keep the section short: past STALE_MS another process may break the lock.
 */
export async function withLockAsync<T>(lockPath: string, fn: () => Promise<T>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (!tryAcquire(lockPath)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`)
    await Bun.sleep(20)
  }
  try {
    return await fn()
  } finally {
    release(lockPath)
  }
}
