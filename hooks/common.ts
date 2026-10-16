/** Shared plumbing for the hook entry points. */

const SEND_TIMEOUT_MS = 10_000
// Overridable for end-to-end tests against a local fake Bot API.
const API_ROOT = process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org'

export async function readHookInput<T>(): Promise<T> {
  return JSON.parse(await Bun.stdin.text()) as T
}

/** Send plain text straight to the Bot API (sendMessage doesn't need the poller). */
export async function sendDirect(token: string, chatIds: string[], text: string): Promise<void> {
  await Promise.all(chatIds.map(async chatId => {
    try {
      const res = await fetch(`${API_ROOT}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      if (!res.ok) process.stderr.write(`telegram notify to ${chatId}: HTTP ${res.status}\n`)
    } catch (err) {
      process.stderr.write(`telegram notify to ${chatId} failed: ${err}\n`)
    }
  }))
}
