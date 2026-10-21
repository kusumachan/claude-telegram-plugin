/**
 * Owner-message inbox: lets the owner correct a running session that isn't
 * a channel session ("stop, wrong approach", "also handle X").
 *
 * A session opts in with TELEGRAM_PLUS_INBOX=1. Its MCP server then
 * registers with the hub under its project topic; owner messages in that
 * topic (or replies to the session's messages) are queued in the hub, and
 * the plugin's PostToolUse and Stop hooks hand them to the model. Nothing
 * can push into a non-channel session, so delivery waits for the current
 * tool call or turn to end.
 */

export const INBOX_ENV = 'TELEGRAM_PLUS_INBOX'

export function inboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[INBOX_ENV]?.trim().toLowerCase()
  return !!v && v !== '0' && v !== 'false' && v !== 'off'
}

export type InboxMessage = {
  /** Empty for a relayed message, which has no Telegram message behind it. */
  chatId: string
  messageId: number
  threadId?: number
  text: string
  by: string
  /** Sent through POST /inbox/send by the orchestrator (src/hub/orchestrator.ts), not typed by the owner; `by` names the sender. */
  relayed?: true
  at: number
}

/** Wire types between the MCP server / hooks and the hub. */
export type InboxConnectBody = { id: string; name: string; topic: string; cwd: string }
export type InboxTakeBody = { session_id: string }
export type InboxTakeResult = { messages: { text: string; by: string; relayed?: true }[] }

/** What the model sees, oldest first. */
export function formatInbox(messages: { text: string; by: string; relayed?: true }[]): string {
  const from = (m: { by: string; relayed?: true }) => (m.relayed ? m.by : `the owner on Telegram (${m.by})`)
  if (messages.length === 1) return `Message from ${from(messages[0]!)}:\n${messages[0]!.text}`
  const one = new Set(messages.map(from)).size === 1
  const lines = messages.map((m, i) => `[${i + 1}] ${one ? '' : `(${from(m)}) `}${m.text}`)
  return `${messages.length} messages${one ? ` from ${from(messages[0]!)}` : ''}, oldest first:\n${lines.join('\n')}`
}

/** Hook stdout that delivers `text`, or undefined when this event can't carry it. */
export function hookOutput(event: string, text: string): object | undefined {
  if (event === 'PostToolUse') return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }
  // Blocking the stop keeps the agent going with the message as its next input.
  if (event === 'Stop') return { decision: 'block', reason: text }
  return undefined
}
