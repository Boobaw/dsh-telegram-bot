/** Topic names known to the bot, send targets and topic errors. */

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
 * created for that very message: users who may create topics get one for any
 * message sent in All, named after the message.
 * @param command - normalized command token, such as `/start`.
 * @param text - full message text.
 * @param topicName - known name of the message's topic, if any.
 * @param fresh - whether the topic has no session and no earlier activity.
 * @returns true when the command should be answered in All.
 */
export function isAutoCommandTopic(command, text, topicName, fresh) {
  if (!fresh || !CHAT_COMMANDS.has(command)) return false
  if (typeof topicName !== 'string' || typeof text !== 'string') return false
  const name = topicName.trim()
  // Telegram names the topic after the message, cut to 128 characters.
  return name.startsWith('/') && text.trim().startsWith(name)
}

/**
 * Resolve a send target to a thread the bot knows in this chat. Only numeric
 * thread ids are accepted; topic names are display text, not addresses.
 * @param known - thread ids the bot knows in the chat.
 * @param target - thread id, as a number or a string of digits.
 * @returns the thread id.
 */
export function resolveThreadTarget(known, target) {
  const raw = typeof target === 'number' ? String(target) : String(target ?? '').trim()
  if (raw.length === 0) throw new Error('A Telegram thread id is required.')
  if (!/^\d+$/u.test(raw)) throw new Error(`"${raw}" is not a Telegram thread id. Topics are addressed by their numeric thread id; /id in a topic shows it.`)
  const threadId = Number(raw)
  if (!known.has(threadId)) throw new Error(`Unknown thread id ${threadId}: the bot knows no topic with that id in its chat. /id in a topic shows its thread id.`)
  return threadId
}

/**
 * Whether a Bot API error means the topic itself no longer exists, so its
 * binding can never work again. A closed topic is not gone: it can be reopened.
 * @param description - Telegram's error description.
 * @returns true for a deleted or invalid topic.
 */
export function isTopicGone(description) {
  return /message thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/iu.test(String(description ?? ''))
}
