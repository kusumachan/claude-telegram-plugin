import { randomBytes } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * ask_owner: a session asks the owner a question on Telegram and blocks
 * until they answer (button tap or typed reply).
 *
 * The hub owns the questions. They live in `questions.json` so that an
 * answer survives the asking tool call timing out, the session asking again,
 * or the hub restarting. A question is open until it's answered; an answer is
 * kept until the session collects it, so it isn't lost if no call is
 * waiting at the time.
 */

export const ASK_OWNER_DEFINITION = {
  name: 'ask_owner',
  description:
    "Ask the owner a question on Telegram and wait for the answer. Use it when you're blocked on a decision only the owner can make. " +
    "The question goes to this project's forum topic (or the owner's DMs), optionally with buttons; the owner taps one or types a reply. " +
    'Returns the answer text: the button label, or what they typed. This call blocks while waiting. ' +
    'If it returns "No answer yet", call ask_owner again with exactly the same question to keep waiting. It is not posted twice, and an answer given in between is not lost.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, self-contained: the owner reads it on their phone without your context.' },
      buttons: {
        type: 'array',
        description: 'Optional answer buttons as rows of labels, e.g. [["Yes", "No"], ["Show me the diff"]]. The owner can always type a different answer instead.',
        items: { type: 'array', items: { type: 'string' } },
      },
    },
    required: ['question'],
  },
}

export const DEFAULT_ASK_TIMEOUT_MINUTES = 240
/** Longest question we post; Telegram caps a message at 4096 chars and we add a header and hint. */
export const MAX_QUESTION_CHARS = 3500
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export const NO_ANSWER_YET =
  'No answer yet; the question is still open on Telegram. Call ask_owner again with exactly the same question to keep waiting.'

export type QuestionMessage = { chatId: string; messageId: number; threadId?: number }

export type Question = {
  id: string
  /** Claude Code session id of the asker. */
  session: string
  /** Who's asking, shown in the prompt (e.g. "project-x-12A"). */
  asker: string
  question: string
  askedAt: number
  messages: QuestionMessage[]
  answer?: { text: string; by: string; at: number }
}

/** The ask_owner wire types between the MCP server and the hub. */
export type AskBody = { session: string; asker: string; topic: string; question: string; buttons?: string[][] }
export type AskResult = { id: string } | { error: string }
export type AskWaitBody = { id: string; wait_ms: number }
export type AskWaitResult =
  | { status: 'answered'; answer: string; by: string }
  | { status: 'pending' }
  | { status: 'unknown' }

/** Same question from the same session → the same open question. */
function sameQuestion(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ')
  return norm(a) === norm(b)
}

export class QuestionStore {
  private readonly file: string
  private questions: Question[]

  constructor(private stateDir: string) {
    this.file = join(stateDir, 'questions.json')
    this.questions = this.read()
  }

  private read(): Question[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private write(): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.questions, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** Questions still waiting for the owner (answered-but-uncollected ones don't count). */
  get openCount(): number {
    return this.questions.filter(q => !q.answer).length
  }

  get(id: string): Question | undefined {
    return this.questions.find(q => q.id === id)
  }

  /** An earlier, uncollected ask of the same question by the same session. */
  find(session: string, question: string): Question | undefined {
    return this.questions.find(q => q.session === session && sameQuestion(q.question, question))
  }

  add(q: Omit<Question, 'id'>): Question {
    const full = { ...q, id: randomBytes(6).toString('hex') }
    this.questions.push(full)
    this.write()
    return full
  }

  /** The question a Telegram message (the prompt itself) belongs to. */
  byMessage(chatId: string, messageId: number): Question | undefined {
    return this.questions.find(q => q.messages.some(m => m.chatId === chatId && m.messageId === messageId))
  }

  /** Unanswered questions posted in this chat (and forum topic). */
  openIn(chatId: string, threadId: number | undefined): Question[] {
    return this.questions.filter(q => !q.answer && q.messages.some(m => m.chatId === chatId && m.threadId === threadId))
  }

  /** Record the owner's answer. False if it was already answered. */
  answer(id: string, text: string, by: string, now = Date.now()): boolean {
    const q = this.get(id)
    if (!q || q.answer) return false
    q.answer = { text, by, at: now }
    this.write()
    return true
  }

  /** Hand the answer to the asker and forget the question. */
  take(id: string): Question['answer'] {
    const q = this.get(id)
    if (!q?.answer) return undefined
    this.questions = this.questions.filter(x => x.id !== id)
    this.write()
    return q.answer
  }

  /** Drop questions nobody came back for. Returns the unanswered ones dropped, to close their prompts. */
  prune(now = Date.now()): Question[] {
    const old = this.questions.filter(q => now - q.askedAt > MAX_AGE_MS)
    if (old.length === 0) return []
    this.questions = this.questions.filter(q => now - q.askedAt <= MAX_AGE_MS)
    this.write()
    return old.filter(q => !q.answer)
  }
}

/** Validate ask_owner buttons: rows of non-empty labels (a flat list is one row). */
export function parseAskButtons(raw: unknown): string[][] | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) throw new Error('buttons must be an array of rows of labels')
  if (raw.length === 0) return undefined
  const rows = raw.every(r => !Array.isArray(r)) ? [raw] : raw
  return rows.map((row, r) => {
    if (!Array.isArray(row) || !row.every(b => typeof b === 'string' && b.trim())) {
      throw new Error(`button row ${r + 1} must be an array of non-empty labels`)
    }
    return row as string[]
  })
}

export function questionHeader(asker: string, question: string): string {
  return `❓ ${asker} asks:\n\n${question}`
}

export function questionText(asker: string, question: string, hasButtons: boolean): string {
  return `${questionHeader(asker, question)}\n\n${hasButtons ? 'Tap a button or type' : 'Type'} your answer here.`
}
