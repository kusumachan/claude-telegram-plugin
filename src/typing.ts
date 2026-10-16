/** Telegram's typing indicator lasts ~5s; refresh a little before it lapses. */
const REFRESH_MS = 4_000
/** Give up eventually so a forgotten chat doesn't type forever. */
const MAX_MS = 3 * 60 * 1000

type Key = string

/**
 * Keeps "bot is typing…" alive while Claude works, until the next reply to
 * that chat (or MAX_MS). One sendChatAction only covers ~5 seconds.
 */
export class TypingTracker {
  private timers = new Map<Key, { interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }>()

  constructor(private send: (chatId: string, threadId?: number) => Promise<unknown>) {}

  start(chatId: string, threadId?: number): void {
    const key = keyOf(chatId, threadId)
    this.stop(chatId, threadId)
    const tick = () => void this.send(chatId, threadId).catch(() => {})
    tick()
    const interval = setInterval(tick, REFRESH_MS)
    const timeout = setTimeout(() => this.stop(chatId, threadId), MAX_MS)
    interval.unref?.()
    timeout.unref?.()
    this.timers.set(key, { interval, timeout })
  }

  stop(chatId: string, threadId?: number): void {
    const key = keyOf(chatId, threadId)
    const t = this.timers.get(key)
    if (!t) return
    clearInterval(t.interval)
    clearTimeout(t.timeout)
    this.timers.delete(key)
  }

  /** Stop every indicator in a chat regardless of thread. */
  stopChat(chatId: string): void {
    for (const key of [...this.timers.keys()]) {
      if (key === chatId || key.startsWith(`${chatId}:`)) {
        const [c, th] = key.split(':')
        this.stop(c!, th ? Number(th) : undefined)
      }
    }
  }

  stopAll(): void {
    for (const t of this.timers.values()) {
      clearInterval(t.interval)
      clearTimeout(t.timeout)
    }
    this.timers.clear()
  }
}

function keyOf(chatId: string, threadId?: number): Key {
  return threadId != null ? `${chatId}:${threadId}` : chatId
}
