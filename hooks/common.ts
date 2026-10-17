/** Shared plumbing for the hook entry points. */
import type { Access } from '../src/access.ts'
import { STATE_DIR } from '../src/config.ts'
import { isControlTopic, isMissingTopic, TopicStore, topicWelcome } from '../src/topics.ts'

const SEND_TIMEOUT_MS = 10_000
// Overridable for end-to-end tests against a local fake Bot API.
const API_ROOT = process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org'

export async function readHookInput<T>(): Promise<T> {
  return JSON.parse(await Bun.stdin.text()) as T
}

type ApiResult<T> = { ok: boolean; result?: T; description?: string }

async function call<T>(token: string, method: string, params: object): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API_ROOT}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    return (await res.json()) as ApiResult<T>
  } catch (err) {
    return { ok: false, description: String(err) }
  }
}

/** Send plain text straight to the Bot API (sendMessage doesn't need the poller). */
async function send(token: string, chatId: string, text: string, threadId?: number): Promise<ApiResult<unknown>> {
  const r = await call(token, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(threadId != null ? { message_thread_id: threadId } : {}),
  })
  if (!r.ok) process.stderr.write(`telegram notify to ${chatId}: ${r.description}\n`)
  return r
}

/**
 * Deliver a notice into the forum topic `topic` when a
 * topics group is configured (creating the topic if needed, recreating it if
 * it was deleted), otherwise — or if that fails — to every allowlisted DM.
 */
export async function sendNotice(token: string, access: Access, topic: string, text: string): Promise<void> {
  const group = access.topicsGroup && access.topicsGroup in access.groups ? access.topicsGroup : undefined
  // The orchestrator's control topic isn't a project topic: sessions use DMs instead.
  if (group && !isControlTopic(access, topic)) {
    const name = topic
    const topics = new TopicStore(STATE_DIR)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { threadId, created } = await topics.ensure(group, name, async n => {
          const r = await call<{ message_thread_id: number }>(token, 'createForumTopic', { chat_id: group, name: n })
          if (!r.ok || !r.result) throw new Error(r.description ?? 'createForumTopic failed')
          return r.result.message_thread_id
        })
        if (created) await send(token, group, topicWelcome(name), threadId)
        const r = await send(token, group, text, threadId)
        if (r.ok) return
        if (r.description && isMissingTopic(r.description)) {
          topics.forget(group, name)
          continue
        }
      } catch (err) {
        process.stderr.write(`telegram topic for ${name}: ${err}\n`)
      }
      break
    }
  }
  await Promise.all(access.allowFrom.map(chatId => send(token, chatId, text)))
}
