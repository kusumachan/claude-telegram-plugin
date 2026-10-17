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
      /** The project topic it was sent in; absent in DMs and the General topic. */
      topic?: string
      chat_id: string
      thread_id?: number
      message_id: number
      user_id: string
      /** "@username", or the first name when there's no username. */
      user: string
      ts: string
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
export type NoticeResult = { message_ids: number[] } | { error: string }

export type TopicResult = { chat_id: string; thread_id: number } | { error: string }

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

  /** Post text and/or files to a project topic or the owner's DMs. */
  notice(body: NoticeBody): Promise<NoticeResult> {
    return this.hub.post('/notice', body, 120_000)
  }

  /** Make sure a project has a forum topic; returns where it is. */
  ensureTopic(topic: string): Promise<TopicResult> {
    return this.hub.post('/topic/ensure', { topic })
  }
}
