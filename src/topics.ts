import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { withLockAsync } from './lock.ts'

/**
 * Forum topics per session/project in the configured topics group:
 * `topics.json` maps group id → topic name → message_thread_id, so reopening
 * a project reuses its topic instead of making a new one.
 *
 * Both the hub and the notification hooks create topics, so creation runs
 * under a cross-process lock: check again inside, create only if still
 * missing.
 */
type TopicMap = Record<string, Record<string, number>>

export class TopicStore {
  private readonly file: string
  private readonly lockPath: string

  constructor(private stateDir: string) {
    this.file = join(stateDir, 'topics.json')
    this.lockPath = join(stateDir, 'topics.lock')
  }

  private read(): TopicMap {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as TopicMap
    } catch {
      return {}
    }
  }

  private write(map: TopicMap): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  get(groupId: string, name: string): number | undefined {
    return this.read()[groupId]?.[name]
  }

  /** Which topic name a thread belongs to, if it's one of ours. */
  nameFor(groupId: string, threadId: number): string | undefined {
    const topics = this.read()[groupId] ?? {}
    return Object.entries(topics).find(([, id]) => id === threadId)?.[0]
  }

  /**
   * Thread id for `name`, creating the topic if needed. `created` tells the
   * caller whether to post a welcome message.
   */
  async ensure(
    groupId: string,
    name: string,
    create: (name: string) => Promise<number>,
  ): Promise<{ threadId: number; created: boolean }> {
    const known = this.get(groupId, name)
    if (known != null) return { threadId: known, created: false }
    return withLockAsync(this.lockPath, async () => {
      const again = this.get(groupId, name)
      if (again != null) return { threadId: again, created: false }
      const threadId = await create(name)
      const map = this.read()
      map[groupId] = { ...map[groupId], [name]: threadId }
      this.write(map)
      return { threadId, created: true }
    })
  }

  /** Drop a mapping whose topic was deleted in Telegram; it's recreated on next use. */
  forget(groupId: string, name: string): void {
    const map = this.read()
    if (!map[groupId]?.[name]) return
    delete map[groupId][name]
    this.write(map)
  }
}

export function topicWelcome(name: string): string {
  return `📦 ${name} — messages in this topic go to the ${name} session.`
}

/** The project a cwd belongs to: worktrees share their repo's topic. */
export function topicName(label: string): string {
  return label.split('/')[0] || label
}

/** Telegram's error when posting to a topic that no longer exists. */
export function isMissingTopic(description: string): boolean {
  return /message thread not found|TOPIC_DELETED|TOPIC_CLOSED/i.test(description)
}
