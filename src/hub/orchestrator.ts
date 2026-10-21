/**
 * The hub's API for an orchestrator: a long-running process on this machine
 * that takes tasks from Telegram and runs Claude Code sessions for them.
 *
 * Self-contained apart from client.ts, so an orchestrator can import it
 * from a checkout of this plugin (or copy both files). Same transport as the
 * rest of the hub: HTTP over the 0700 unix socket in the state dir.
 *
 *   const hub = new OrchestratorClient(stateDir, '/path/to/plugin/hub.ts')
 *   hub.run(e => { if (e.type === 'command') ...; if (e.type === 'prompt_answer') ... })
 *   const { id } = await hub.prompt({ key: 'task-12-gate1', topic: 'project-x', text: 'Spec ready', buttons: [['Continue', 'Revise']], needs_text: ['Revise'] })
 *   const n = await hub.notice({ topic: 'project-x', text: 'Task 12: analyzing' })
 *   if ('messages' in n) await hub.editNotice({ ...n.messages[0]!, text: 'Task 12: developing' })
 */
import { HubClient } from './client.ts'

// --- wire types ------------------------------------------------------------------

/** Bot commands that go to the orchestrator instead of a session. */
export const ORCHESTRATOR_COMMANDS = ['task', 'queue', 'cancel', 'level', 'setup'] as const
export type OrchestratorCommand = (typeof ORCHESTRATOR_COMMANDS)[number]

export type OrchestratorEvent =
  | { type: 'hello'; name: string }
  | { type: 'ping' }
  | {
      type: 'command'
      command: OrchestratorCommand
      /** Everything after the command, trimmed ("" when none). */
      args: string
      /** The project topic it was sent in; absent in DMs, the General topic and the control topic. */
      topic?: string
      /** Sent in the orchestrator's control topic. */
      control?: true
      chat_id: string
      thread_id?: number
      message_id: number
      user_id: string
      /** "@username", or the first name when there's no username. */
      user: string
      ts: string
    }
  | {
      /** A plain message in the control topic (not an answer to one of its prompts). */
      type: 'message'
      text: string
      /** The control topic's key. */
      topic: string
      chat_id: string
      thread_id: number
      message_id: number
      user_id: string
      user: string
      ts: string
      /** Set when it replies to a specific message (e.g. one of the orchestrator's notices). */
      reply_to_message_id?: number
    }
  | {
      /**
       * An ask_owner question from a session started with TELEGRAM_PLUS_ASK=orchestrator,
       * held for the orchestrator: answer it with /ask/answer, or post it with /ask/post.
       * Posted anyway after a few minutes, or at once when no orchestrator is connected.
       */
      type: 'question'
      id: string
      /** The asking session's TELEGRAM_PLUS_NAME, e.g. shop-12a. */
      asker: string
      topic?: string
      question: string
      buttons?: string[][]
      at: number
      /** When it's posted to the owner if nothing else happens. */
      until: number
    }
  | {
      type: 'prompt_answer'
      id: string
      key?: string
      /** The tapped button. Absent when the owner replied to the prompt with text only. */
      label?: string
      /** Typed text: notes after a needs-text button, or a plain reply to the prompt. */
      text?: string
      by: string
      at: number
    }

/** A project topic, or the owner's DMs when absent. */
type Target = { topic?: string }

export type PromptBody = Target & {
  /** Idempotency key: posting the same key again returns the existing prompt instead of posting twice. */
  key?: string
  text: string
  buttons?: string[][]
  /** Labels whose tap asks the owner to type text (e.g. ["Revise"]); the answer carries both. */
  needs_text?: string[]
  /** Absolute paths, sent before the prompt (e.g. a spec.md longer than a message). */
  files?: string[]
  format?: 'text' | 'html' | 'markdownv2'
}
export type PromptResult = { id: string; message_ids: number[] } | { error: string }

export type NoticeBody = Target & { text?: string; files?: string[]; format?: 'text' | 'html' | 'markdownv2' }
/** One sent message. Plain data: keep it in your own state and edit it after a restart. */
export type NoticeRef = { chat_id: string; message_id: number; thread_id?: number }
/** `messages` in send order (files first, then text chunks; one set per DM without a topic). */
export type NoticeResult = { message_ids: number[]; messages: NoticeRef[] } | { error: string }

export type EditNoticeBody = NoticeRef & { text: string; format?: 'text' | 'html' | 'markdownv2' }
export type EditNoticeResult =
  /** `unchanged`: the text was already that (counts as success). `plain`: Telegram rejected the markup, so it was edited as plain text. */
  | { ok: true; unchanged?: true; plain?: true }
  /** `gone`: the message no longer exists or can't be edited (deleted, too old, not a text message). Post a new one. */
  | { error: string; gone?: true }

/** Answer a held or posted question; the asker gets `text`. `by` is shown under it, e.g. "Lead". `ok: false` if it was already answered. */
export type AskAnswerBody = { id: string; text: string; by: string }
/** Post a held question to the owner now, with an optional note under it. `ok: false` if it isn't held anymore. */
export type AskPostBody = { id: string; note?: string }

export type TopicResult = { chat_id: string; thread_id: number } | { error: string }

/** A message for a running agent (an inbox session). `name` is its TELEGRAM_PLUS_NAME; `by` names the sender, e.g. "the orchestrator's lead". */
export type InboxSendBody = { name: string; text: string; by: string }
/** `queued`: how many messages wait for that session now. */
export type InboxSendResult = { ok: true; queued: number } | { error: string }

// --- client ------------------------------------------------------------------------

export class OrchestratorClient {
  readonly hub: HubClient
  private stopped = false

  /** `hubScript`: path to the plugin's hub.ts, used to start the hub if it isn't running. */
  constructor(stateDir: string, hubScript: string, private log: (m: string) => void = () => {}) {
    this.hub = new HubClient(stateDir, hubScript, log)
  }

  /**
   * Stay connected and call onEvent for every event, reconnecting (and
   * restarting the hub) as needed. Answers given while disconnected are
   * re-sent on reconnect until acked with ackPrompt.
   */
  async run(onEvent: (e: OrchestratorEvent) => void): Promise<void> {
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        await this.hub.ensure()
        attempt = 0
        await this.hub.stream('/orchestrator/connect', {}, e => onEvent(e as unknown as OrchestratorEvent))
        if (!this.stopped) this.log('hub stream ended — reconnecting')
      } catch (err) {
        if (!this.stopped) this.log(`hub connection failed: ${err instanceof Error ? err.message : err}`)
      }
      await Bun.sleep(Math.min(500 * 2 ** attempt, 10_000))
    }
  }

  stop(): void {
    this.stopped = true
  }

  /** Post a gate prompt. Its answer arrives as a prompt_answer event. */
  prompt(body: PromptBody): Promise<PromptResult> {
    return this.hub.post('/prompt', body, 120_000)
  }

  /** Done with an answer: stop re-sending it and forget the prompt. */
  ackPrompt(id: string): Promise<{ ok: boolean }> {
    return this.hub.post('/prompt/ack', { id })
  }

  /** Withdraw an open prompt (e.g. the task was cancelled). Its buttons go away and `note` is posted under it. */
  cancelPrompt(id: string, note?: string): Promise<{ ok: boolean }> {
    return this.hub.post('/prompt/cancel', { id, note })
  }

  /**
   * Close an open prompt that was answered somewhere else, e.g. relayed by the
   * orchestrator's lead: its buttons go away and `note` is posted under it as is.
   * `ok: false` when it's gone or the owner already answered it on Telegram.
   */
  closePrompt(id: string, note: string): Promise<{ ok: boolean }> {
    return this.hub.post('/prompt/close', { id, note })
  }

  /** Answer a session's question (a `question` event) on the owner's behalf. */
  answerQuestion(body: AskAnswerBody): Promise<{ ok: boolean } | { error: string }> {
    return this.hub.post('/ask/answer', body)
  }

  /** Post a held question to the owner now. */
  postQuestion(body: AskPostBody): Promise<{ ok: boolean } | { error: string }> {
    return this.hub.post('/ask/post', body, 120_000)
  }

  /** Post text and/or files to a project topic or the owner's DMs. */
  notice(body: NoticeBody): Promise<NoticeResult> {
    return this.hub.post('/notice', body, 120_000)
  }

  /** Replace the text of a message a notice sent (e.g. a status line edited in place). Pass a ref from notice(). */
  editNotice(body: EditNoticeBody): Promise<EditNoticeResult> {
    return this.hub.post('/notice/edit', body)
  }

  /**
   * Queue a message for a running agent session (an inbox session, by its
   * TELEGRAM_PLUS_NAME). It's delivered after the agent's current tool call
   * or turn, labelled as coming from `by`, not from the owner.
   */
  sendToAgent(body: InboxSendBody): Promise<InboxSendResult> {
    return this.hub.post('/inbox/send', body)
  }

  /** Make sure a project has a forum topic; returns where it is. */
  ensureTopic(topic: string): Promise<TopicResult> {
    return this.hub.post('/topic/ensure', { topic })
  }
}
