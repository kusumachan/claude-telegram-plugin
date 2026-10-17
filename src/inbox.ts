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
  chatId: string
  messageId: number
  threadId?: number
  text: string
  by: string
  at: number
}

/** Wire types between the MCP server / hooks and the hub. */
export type InboxConnectBody = { id: string; name: string; topic: string; cwd: string }
export type InboxTakeBody = { session_id: string }
export type InboxTakeResult = { messages: { text: string; by: string }[] }

/** What the model sees, oldest first. */
export function formatInbox(messages: { text: string; by: string }[]): string {
  if (messages.length === 1) return `Message from the owner on Telegram (${messages[0]!.by}):\n${messages[0]!.text}`
  const lines = messages.map((m, i) => `[${i + 1}] ${m.text}`)
  return `${messages.length} messages from the owner on Telegram (${messages[0]!.by}), oldest first:\n${lines.join('\n')}`
}

/** Hook stdout that delivers `text`, or undefined when this event can't carry it. */
export function hookOutput(event: string, text: string): object | undefined {
  if (event === 'PostToolUse') return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }
  // Blocking the stop keeps the agent going with the message as its next input.
  if (event === 'Stop') return { decision: 'block', reason: text }
  return undefined
}
