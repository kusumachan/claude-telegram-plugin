import { InlineKeyboard } from 'grammy'
import type { InlineKeyboardMarkup } from 'grammy/types'

/**
 * Choice buttons Claude attaches to a message. Callback data only carries the
 * button's position (`btn:<row>:<col>`); the label is read back from the
 * message's own reply_markup when tapped. No server-side state, so taps still
 * work after a restart.
 */
export const BUTTON_CALLBACK_RE = /^btn:(\d{1,2}):(\d{1,2})$/

export const BUTTONS_SCHEMA = {
  type: 'array',
  description:
    'Inline buttons under the message, as rows. Each button is a label string (tapping it sends the label back to you as a new message with button_choice meta) or {"text": "...", "url": "https://..."} for a link. Example: [["Yes", "No"], [{"text": "Docs", "url": "https://example.com"}]]. Use for quick choices instead of asking the user to type.',
  items: {
    type: 'array',
    items: {
      anyOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: { text: { type: 'string' }, url: { type: 'string' } },
          required: ['text', 'url'],
        },
      ],
    },
  },
}

const MAX_ROWS = 10
const MAX_PER_ROW = 8
const MAX_LABEL = 64

export function buildKeyboard(raw: unknown): InlineKeyboard | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) throw new Error('buttons must be an array of rows')
  if (raw.length === 0) return undefined
  // Accept a flat list as a single row — an easy mistake to make.
  const rows = raw.every(r => !Array.isArray(r)) ? [raw] : raw
  if (rows.length > MAX_ROWS) throw new Error(`at most ${MAX_ROWS} button rows`)

  const kb = new InlineKeyboard()
  rows.forEach((row, r) => {
    if (!Array.isArray(row) || row.length === 0) throw new Error(`button row ${r + 1} must be a non-empty array`)
    if (row.length > MAX_PER_ROW) throw new Error(`at most ${MAX_PER_ROW} buttons per row`)
    if (r > 0) kb.row()
    row.forEach((b: unknown, c: number) => {
      if (typeof b === 'string') {
        kb.text(label(b), `btn:${r}:${c}`)
      } else if (b && typeof b === 'object' && 'url' in b && 'text' in b) {
        const url = String((b as { url: unknown }).url)
        if (!/^(https?|tg):\/\//i.test(url)) throw new Error(`button url must be http(s):// or tg://, got ${url}`)
        kb.url(label(String((b as { text: unknown }).text)), url)
      } else {
        throw new Error(`invalid button at row ${r + 1}, position ${c + 1}`)
      }
    })
  })
  return kb
}

function label(s: string): string {
  const t = s.trim()
  if (!t) throw new Error('button label cannot be empty')
  return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1)}…` : t
}

/** Resolve a tapped `btn:r:c` back to its label using the message's keyboard. */
export function labelFor(markup: InlineKeyboardMarkup | undefined, data: string): string | undefined {
  const m = BUTTON_CALLBACK_RE.exec(data)
  if (!m || !markup) return undefined
  const btn = markup.inline_keyboard[Number(m[1])]?.[Number(m[2])]
  return btn && 'callback_data' in btn && btn.callback_data === data ? btn.text : undefined
}
