/** Topic names known to the bot and how send targets resolve to threads. */

/**
 * Pick the topic name a Telegram message announces, if any.
 * @param message - Telegram message, including service messages.
 * @returns `{ name, authoritative }`, or undefined.
 */
export function topicNameOf(message) {
  const created = message?.forum_topic_created?.name
  if (typeof created === 'string' && created.trim().length > 0) return { name: created.trim(), authoritative: true }
  const edited = message?.forum_topic_edited?.name
  if (typeof edited === 'string' && edited.trim().length > 0) return { name: edited.trim(), authoritative: true }
  // Replies in a topic often carry its creation message; use it only to fill
  // a gap, because it shows the name the topic was created with.
  const original = message?.reply_to_message?.forum_topic_created?.name
  if (typeof original === 'string' && original.trim().length > 0) return { name: original.trim(), authoritative: false }
  return undefined
}

/**
 * Resolve a send target: a numeric thread id, or a topic name compared
 * without regard to case.
 * @param names - `{ "<chatId>:<threadId>": name }`.
 * @param chatId - chat the topics live in.
 * @param target - topic name or thread id.
 * @returns `{ threadId, name }`.
 */
export function resolveTopicTarget(names, chatId, target) {
  const raw = typeof target === 'number' ? String(target) : String(target ?? '').trim()
  if (raw.length === 0) throw new Error('A topic name or thread id is required.')
  const known = Object.entries(names ?? {})
    .filter(([key]) => key.startsWith(`${chatId}:`))
    .map(([key, name]) => ({ threadId: Number(key.slice(String(chatId).length + 1)), name: String(name) }))
  if (/^\d+$/u.test(raw)) {
    const threadId = Number(raw)
    return { threadId, name: known.find((entry) => entry.threadId === threadId)?.name }
  }
  const wanted = raw.toLocaleLowerCase()
  const matches = known.filter((entry) => entry.name.trim().toLocaleLowerCase() === wanted)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(`Several topics are named "${raw}" (thread ids ${matches.map((entry) => entry.threadId).join(', ')}). Send to a thread id instead.`)
  }
  const list = known.map((entry) => `"${entry.name}" (${entry.threadId})`).join(', ')
  throw new Error(`Unknown Telegram topic "${raw}". ${list.length > 0 ? `Known topics: ${list}.` : 'The bot knows no topic names yet.'} Rename the topic in Telegram or with /rename so the bot learns its name, or send to its thread id (/id in the topic).`)
}
