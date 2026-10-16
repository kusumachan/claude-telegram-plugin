import { GrammyError } from 'grammy'
import type { ChunkMode } from './access.ts'

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * Split text into chunks of at most `limit` UTF-16 units (what Telegram
 * counts). 'newline' mode prefers paragraph, then line, then word boundaries.
 * Never splits a surrogate pair, so emoji survive a hard cut.
 */
export function chunk(text: string, limit: number, mode: ChunkMode): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    if (cut > 1 && isHighSurrogate(rest.charCodeAt(cut - 1))) cut--
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

export type Format = 'text' | 'markdownv2' | 'html'

export function parseModeFor(format: string | undefined): 'MarkdownV2' | 'HTML' | undefined {
  if (format === 'markdownv2') return 'MarkdownV2'
  if (format === 'html') return 'HTML'
  return undefined
}

/** Telegram rejected the markup (bad escaping, unbalanced tags, chunk split mid-entity). */
export function isParseError(err: unknown): boolean {
  return err instanceof GrammyError
    && err.error_code === 400
    && /can't parse entities|can't find end/i.test(err.description)
}

/** Best-effort plain-text rendering used when Telegram rejects the markup. */
export function toPlain(text: string, format: string | undefined): string {
  if (format === 'html') {
    return text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
  }
  if (format === 'markdownv2') return text.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1')
  return text
}

/**
 * Uploader-controlled strings (filenames, titles, quoted text) land inside the
 * <channel> notification meta — delimiter chars would let the sender break out
 * of the tag or forge a second meta entry.
 */
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;"]/g, '_')
}

/** safeName + length cap, for longer free text like quoted replies. */
export function safeSnippet(s: string | undefined, max = 500): string | undefined {
  if (!s) return undefined
  const flat = safeName(s.replace(/\s+/g, ' ').trim())!
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
