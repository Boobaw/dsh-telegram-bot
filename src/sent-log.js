/**
 * Remember messages sent into topics through the plugin (the Host service,
 * the `telegram_send` tool and the `dsh-telegram-send` spool), so a later
 * reply to one of them can tell the agent what was sent, when and by whom,
 * even when the topic's session has changed since.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATUS_DIR } from './constants.js'

/** Default file of the log. */
export const SENT_LOG_PATH = join(STATUS_DIR, 'sent-messages.json')
/** Most sends kept; older ones are dropped first. */
export const SENT_LOG_MAX_ENTRIES = 1000
/** Sends older than this are dropped. */
export const SENT_LOG_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000
/** Longest text kept per send, in characters. */
export const SENT_LOG_MAX_TEXT = 20_000

/**
 * Open the log. Reading happens once, on first use; a missing or broken file
 * starts an empty log.
 * @param options.path - log file.
 * @param options.now - clock, for tests.
 * @param options.onError - reports a failed write.
 * @returns `{ record, find }`.
 */
export function createSentLog({ path = SENT_LOG_PATH, now = Date.now, onError = () => {} } = {}) {
  let entries
  let loading
  let writing = Promise.resolve()

  async function load() {
    if (entries !== undefined) return entries
    loading ??= (async () => {
      try {
        const data = JSON.parse(await readFile(path, 'utf8'))
        entries = Array.isArray(data?.entries) ? data.entries.filter((entry) => entry !== null && typeof entry === 'object') : []
      } catch {
        entries = []
      }
      return entries
    })()
    return loading
  }

  function prune() {
    const oldest = now() - SENT_LOG_MAX_AGE_MS
    entries = entries.filter((entry) => Date.parse(entry.sentAt ?? '') >= oldest)
    if (entries.length > SENT_LOG_MAX_ENTRIES) entries = entries.slice(-SENT_LOG_MAX_ENTRIES)
  }

  function save() {
    const snapshot = JSON.stringify({ version: 1, entries }) + '\n'
    writing = writing.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.tmp`
      await writeFile(temporary, snapshot, { mode: 0o600 })
      await rename(temporary, path)
    }).catch(onError)
    return writing
  }

  return {
    /**
     * Remember one send.
     * @param entry - `{ chatId, threadId, topic, messageIds, text, files,
     *   fromSession, job, label, boundSession, recorded }`.
     */
    async record(entry) {
      await load()
      const text = typeof entry.text === 'string' ? entry.text : ''
      entries.push({
        chatId: entry.chatId,
        threadId: entry.threadId ?? null,
        topic: entry.topic ?? null,
        messageIds: Array.isArray(entry.messageIds) ? entry.messageIds : [],
        sentAt: new Date(now()).toISOString(),
        text: text.length > SENT_LOG_MAX_TEXT ? text.slice(0, SENT_LOG_MAX_TEXT) : text,
        textCut: text.length > SENT_LOG_MAX_TEXT ? text.length - SENT_LOG_MAX_TEXT : 0,
        files: Array.isArray(entry.files) ? entry.files : [],
        fromSession: entry.fromSession ?? null,
        job: entry.job ?? null,
        label: entry.label ?? null,
        boundSession: entry.boundSession ?? null,
        recorded: entry.recorded === true,
      })
      prune()
      await save()
    },
    /**
     * Find the send one Telegram message belongs to.
     * @param chatId - chat of the message.
     * @param messageId - its id.
     * @returns the entry, or undefined.
     */
    async find(chatId, messageId) {
      if (chatId === undefined || chatId === null || !Number.isSafeInteger(messageId)) return undefined
      await load()
      const chat = String(chatId)
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]
        if (String(entry.chatId) === chat && entry.messageIds.includes(messageId)) return entry
      }
      return undefined
    },
    /** Wait for pending writes (tests and shutdown). */
    flush: () => writing,
  }
}
