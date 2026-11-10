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
 * Commands about the chat as a whole rather than one topic. When one of them
 * is sent in All, Telegram turns it into a topic of its own; the bot answers
 * in All instead and removes that topic.
 */
export const CHAT_COMMANDS = new Set(['/start', '/help', '/sessions', '/status', '/menu', '/id', '/ping', '/restart'])

/**
 * Whether a message is a chat-wide command that Telegram moved into a topic it
 * created for that very message.
 */
export function isAutoCommandTopic(command, text, topicName, fresh) {
  if (!fresh || !CHAT_COMMANDS.has(command)) return false
  if (typeof topicName !== 'string' || typeof text !== 'string') return false
  const name = topicName.trim()
  return name.startsWith('/') && text.trim().startsWith(name)
}

/** True when Telegram says the topic no longer exists. */
export function isTopicGone(description) {
  return /message thread not found|(?:topic|thread)[^.]{0,40}(?:not found|deleted)|TOPIC_ID_INVALID|TOPIC_DELETED/iu.test(String(description ?? ''))
}

/** True when a thread id denotes the chat-wide All topic. */
function isAllTopic(threadId) {
  return threadId === undefined || threadId === null || threadId === 0 || threadId === 1
}

/**
 * Outbound topic fields for send methods. Private-chat and forum topics use
 * `message_thread_id`; a cached direct id is used only for chats without a
 * forum thread (for example channel direct-messages chats).
 * @param directChats - `{ "<chatId>": true }` for private chats with topics.
 * @param directTopics - `{ "<chatId>:<threadId>": directTopicId }`.
 * @param chatId - chat holding the topic.
 * @param threadId - stored topic thread id.
 * @returns `{}`, `{ message_thread_id }` or `{ direct_messages_topic_id }`.
 */
export function topicTargetFor(directChats, directTopics, chatId, threadId) {
  if (isAllTopic(threadId)) return {}
  // Private-chat topics use message_thread_id. If Telegram rejects it with
  // "message thread not found", call() retries with direct_messages_topic_id.
  if (directChats?.[String(chatId)] === true) return { message_thread_id: threadId }
  const direct = directTopics?.[`${chatId}:${threadId}`]
  if (Number.isSafeInteger(direct)) return { direct_messages_topic_id: direct }
  return { message_thread_id: threadId }
}

/**
 * Whether a Bot API message proves it reached the expected topic. A response
 * without any topic field is not proof: Telegram may have silently sent the
 * message into All after the topic was deleted.
 * @param directChats - `{ "<chatId>": true }` for private chats with topics.
 * @param directTopics - `{ "<chatId>:<threadId>": directTopicId }`.
 * @param chatId - chat holding the topic.
 * @param threadId - stored topic thread id.
 * @param delivered - Bot API result for the sent message.
 * @returns whether the message belongs to the expected topic.
 */
export function deliveredToTopic(directChats, directTopics, chatId, threadId, delivered) {
  if (delivered === null || typeof delivered !== 'object') return false
  if (typeof delivered.message_thread_id === 'number') return delivered.message_thread_id === threadId
  const direct = delivered.direct_messages_topic?.topic_id
  if (typeof direct === 'number') {
    if (directChats?.[String(chatId)] === true) return direct === threadId
    const expected = directTopics?.[`${chatId}:${threadId}`]
    return typeof expected !== 'number' || direct === expected
  }
  // No topic fields at all: Telegram silently drops a message into All when
  // the topic is gone, so this is not proof of delivery.
  return false
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
    if (!Number.isSafeInteger(threadId) || threadId <= 0 || threadId > 2_147_483_647) {
      const list = known.map((entry) => `"${entry.name}" (${entry.threadId})`).join(', ')
      throw new Error(`"${raw}" is not a Telegram topic id. Topic ids are message-thread ids (for example 55221).${list.length > 0 ? ` Known topics: ${list}.` : ''} Send /id inside the topic to see its id.`)
    }
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
