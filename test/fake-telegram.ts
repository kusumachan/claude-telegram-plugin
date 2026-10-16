/**
 * A tiny fake Bot API for integration tests: records every call, serves
 * getUpdates from a queue, and lets tests inject user messages and taps.
 */

export type ApiCall = { method: string; params: Record<string, any> }

export class FakeTelegram {
  calls: ApiCall[] = []
  private updates: object[] = []
  private nextUpdateId = 1
  private nextMessageId = 1000
  private server: ReturnType<typeof Bun.serve>
  private waiters: (() => void)[] = []

  constructor(port = 0) {
    this.server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: async req => {
        const url = new URL(req.url)
        // Control endpoints for out-of-process e2e tests.
        if (url.pathname === '/_ctl/dm') {
          const b = await req.json() as { user: number; text: string; replyTo?: number }
          this.dm(b.user, b.text, b.replyTo)
          return Response.json({ ok: true })
        }
        if (url.pathname === '/_ctl/tap') {
          const b = await req.json() as { user: number; data: string; messageId: number }
          this.tap(b.user, b.data, b.messageId)
          return Response.json({ ok: true })
        }
        if (url.pathname === '/_ctl/calls') return Response.json(this.calls)
        const method = url.pathname.split('/').pop()!
        const text = await req.text()
        let params: Record<string, any> = {}
        try {
          params = text ? JSON.parse(text) : {}
        } catch {}
        if (method === 'getUpdates') return Response.json({ ok: true, result: await this.takeUpdates() })
        this.calls.push({ method, params })
        for (const w of this.waiters.splice(0)) w()
        return Response.json({ ok: true, result: this.result(method, params) })
      },
    })
  }

  get apiRoot(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  stop(): void {
    this.server.stop(true)
  }

  private result(method: string, params: Record<string, any>): unknown {
    switch (method) {
      case 'getMe':
        return { id: 1, is_bot: true, first_name: 'Bot', username: 'test_bot' }
      case 'sendMessage':
        return {
          message_id: this.nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(params.chat_id), type: 'private' },
          text: params.text,
        }
      default:
        return true
    }
  }

  private async takeUpdates(): Promise<object[]> {
    for (let i = 0; i < 20 && this.updates.length === 0; i++) await Bun.sleep(25)
    return this.updates.splice(0)
  }

  /** A DM from `userId`, optionally replying to one of the bot's messages. */
  dm(userId: number, text: string, replyToMessageId?: number): void {
    const from = { id: userId, is_bot: false, first_name: 'User', username: `user${userId}` }
    this.updates.push({
      update_id: this.nextUpdateId++,
      message: {
        message_id: this.nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: 'private', first_name: 'User' },
        from,
        text,
        ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}),
        ...(replyToMessageId != null
          ? { reply_to_message: { message_id: replyToMessageId, date: 0, chat: { id: userId, type: 'private' }, from: { id: 1, is_bot: true, first_name: 'Bot', username: 'test_bot' }, text: '…' } }
          : {}),
      },
    })
  }

  /** A button tap by `userId` on the bot message `messageId` in their DM. */
  tap(userId: number, data: string, messageId: number, messageText = '…'): void {
    this.updates.push({
      update_id: this.nextUpdateId++,
      callback_query: {
        id: String(this.nextUpdateId),
        from: { id: userId, is_bot: false, first_name: 'User' },
        chat_instance: 'x',
        data,
        message: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: userId, type: 'private', first_name: 'User' },
          text: messageText,
        },
      },
    })
  }

  /** Wait until a call matching `pred` was made, then return it. */
  async waitFor(pred: (c: ApiCall) => boolean, timeoutMs = 5000): Promise<ApiCall> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.calls.find(pred)
      if (hit) return hit
      if (Date.now() > deadline) {
        throw new Error(`timed out; calls so far: ${this.calls.map(c => `${c.method}(${JSON.stringify(c.params).slice(0, 80)})`).join(', ')}`)
      }
      await new Promise<void>(r => {
        this.waiters.push(r)
        setTimeout(r, 100)
      })
    }
  }
}

// `bun test/fake-telegram.ts <port>` runs it standalone for e2e tests.
if (import.meta.main) {
  const tg = new FakeTelegram(Number(process.argv[2] ?? 8799))
  console.log(`fake Bot API on ${tg.apiRoot}`)
}
