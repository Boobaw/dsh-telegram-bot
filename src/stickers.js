/**
 * Sticker library: stickers the bot has seen or loaded from a set, keyed by
 * Telegram's `file_unique_id`, with the `file_id` needed to send them again
 * and a meaning note the agent writes, so it can pick a sticker by what it
 * says rather than by id.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATUS_DIR } from './constants.js'

/** Default library file. */
export const STICKER_LIBRARY_PATH = join(STATUS_DIR, 'stickers.json')
/** Folder for cached preview images. */
export const STICKER_PREVIEW_DIR = join(STATUS_DIR, 'sticker-previews')
/** Longest meaning note kept, in characters. */
export const STICKER_MEANING_MAX = 1000

/**
 * The kind of a Telegram sticker.
 * @param sticker - Bot API Sticker.
 * @returns `static`, `animated` (.tgs) or `video` (.webm).
 */
export function stickerKind(sticker) {
  if (sticker?.is_video === true) return 'video'
  if (sticker?.is_animated === true) return 'animated'
  return 'static'
}

/**
 * One line that names a sticker for the agent.
 * @param entry - library entry.
 * @returns e.g. `😀 from set "cats" (sticker AgAD..., animated)`.
 */
export function describeSticker(entry) {
  const parts = []
  if (typeof entry?.emoji === 'string' && entry.emoji.length > 0) parts.push(entry.emoji)
  if (typeof entry?.setName === 'string' && entry.setName.length > 0) {
    parts.push(`from set "${entry.setName}"${typeof entry.setTitle === 'string' && entry.setTitle.length > 0 && entry.setTitle !== entry.setName ? ` (${entry.setTitle})` : ''}`)
  }
  parts.push(`(sticker ${entry?.id}${entry?.kind === 'static' || entry?.kind === undefined ? '' : `, ${entry.kind}`})`)
  return parts.join(' ')
}

/**
 * Open the library. Reading happens once, on first use; a missing or broken
 * file starts an empty library.
 * @param options.path - library file.
 * @param options.now - clock, for tests.
 * @param options.onError - reports a failed write.
 * @returns the library API.
 */
export function createStickerLibrary({ path = STICKER_LIBRARY_PATH, now = Date.now, onError = () => {} } = {}) {
  let stickers
  let loading
  let writing = Promise.resolve()

  async function load() {
    if (stickers !== undefined) return stickers
    loading ??= (async () => {
      try {
        const data = JSON.parse(await readFile(path, 'utf8'))
        stickers = data?.stickers !== null && typeof data?.stickers === 'object' ? data.stickers : {}
      } catch {
        stickers = {}
      }
      return stickers
    })()
    return loading
  }

  function save() {
    const snapshot = JSON.stringify({ version: 1, stickers }, null, 1) + '\n'
    writing = writing.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.tmp`
      await writeFile(temporary, snapshot, { mode: 0o600 })
      await rename(temporary, path)
    }).catch(onError)
    return writing
  }

  /**
   * Add or refresh stickers without saving.
   * @returns the stored entries.
   */
  function upsert(list, { setTitle, source }) {
    const time = new Date(now()).toISOString()
    const stored = []
    for (const sticker of list) {
      const id = sticker?.file_unique_id
      if (typeof id !== 'string' || id.length === 0 || typeof sticker.file_id !== 'string') continue
      const old = stickers[id]
      const entry = {
        id,
        fileId: sticker.file_id,
        setName: typeof sticker.set_name === 'string' ? sticker.set_name : (old?.setName ?? null),
        setTitle: typeof setTitle === 'string' ? setTitle : (old?.setTitle ?? null),
        emoji: typeof sticker.emoji === 'string' ? sticker.emoji : (old?.emoji ?? null),
        kind: stickerKind(sticker),
        thumbnailId: sticker.thumbnail?.file_id ?? sticker.thumb?.file_id ?? old?.thumbnailId ?? null,
        meaning: old?.meaning ?? '',
        source: old?.source ?? source ?? 'received',
        addedAt: old?.addedAt ?? time,
        updatedAt: time,
      }
      stickers[id] = entry
      stored.push(entry)
    }
    return stored
  }

  return {
    /**
     * Add or refresh stickers (a received one, or a whole set). The meaning
     * already written for a sticker is kept.
     * @param list - Bot API Sticker objects.
     * @param options - `{ setTitle, source }`: set title, and `received` or `set`.
     * @returns the stored entries.
     */
    async remember(list, options = {}) {
      await load()
      const stored = upsert(Array.isArray(list) ? list : [list], options)
      if (stored.length > 0) await save()
      return stored
    },
    /**
     * @param id - `file_unique_id`.
     * @returns the entry, or undefined.
     */
    async get(id) {
      await load()
      return typeof id === 'string' ? stickers[id] : undefined
    },
    /**
     * Write what a sticker means and when to use it.
     * @param id - `file_unique_id`.
     * @param meaning - free text; empty clears it.
     * @returns the entry.
     * @throws when the sticker is not in the library.
     */
    async setMeaning(id, meaning) {
      await load()
      const entry = typeof id === 'string' ? stickers[id] : undefined
      if (entry === undefined) throw new Error(`Sticker ${id} is not in the library.`)
      entry.meaning = String(meaning ?? '').trim().slice(0, STICKER_MEANING_MAX)
      entry.updatedAt = new Date(now()).toISOString()
      await save()
      return entry
    },
    /**
     * Find stickers. Every given filter must match; `query` matches any of its
     * words in the meaning, emoji, set name or title, and better matches come
     * first. Without filters, the latest stickers come first.
     * @param filters - `{ query, emoji, set, limit }`.
     * @returns `{ total, stickers }`.
     */
    async find({ query, emoji, set, limit = 20 } = {}) {
      await load()
      const words = String(query ?? '').toLowerCase().split(/\s+/u).filter((word) => word.length > 0)
      const wantedEmoji = typeof emoji === 'string' && emoji.trim().length > 0 ? emoji.trim() : undefined
      const wantedSet = typeof set === 'string' && set.trim().length > 0 ? set.trim().toLowerCase() : undefined
      const scored = []
      for (const entry of Object.values(stickers)) {
        if (wantedEmoji !== undefined && !String(entry.emoji ?? '').includes(wantedEmoji)) continue
        if (wantedSet !== undefined && String(entry.setName ?? '').toLowerCase() !== wantedSet && String(entry.setTitle ?? '').toLowerCase() !== wantedSet) continue
        let score = 0
        if (words.length > 0) {
          const meaning = String(entry.meaning ?? '').toLowerCase()
          const other = [entry.emoji, entry.setName, entry.setTitle].map((value) => String(value ?? '').toLowerCase()).join(' ')
          for (const word of words) {
            if (meaning.includes(word)) score += 2
            else if (other.includes(word)) score += 1
          }
          if (score === 0) continue
        }
        scored.push({ entry, score })
      }
      scored.sort((left, right) => right.score - left.score || String(right.entry.updatedAt).localeCompare(String(left.entry.updatedAt)))
      const count = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20
      return { total: scored.length, stickers: scored.slice(0, count).map(({ entry }) => entry) }
    },
    /** Wait for pending writes (tests and shutdown). */
    flush: () => writing,
  }
}
