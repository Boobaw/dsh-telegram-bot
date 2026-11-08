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

/** Joins a topic name and the task part of a topic session's title. */
export const TITLE_SEPARATOR = ' · '

/** The title form earlier versions gave topic sessions: "TG · <topic name>". */
const LEGACY_PREFIX = 'TG · '

/**
 * The DSH title of a topic session: the topic name, then what the
 * conversation is about once DSH has titled it.
 * @param prefix - the topic's name.
 * @param task - the conversation's own title, or empty before one exists.
 * @returns the session title.
 */
export function topicTitle(prefix, task) {
  const rest = typeof task === 'string' ? task.trim() : ''
  return rest.length === 0 ? prefix : `${prefix}${TITLE_SEPARATOR}${rest}`
}

/**
 * Whether a title is one the bot set before any conversation title existed:
 * a bare topic name (current or earlier) or the old "TG · <name>" form.
 * @param title - current session title.
 * @param names - topic names the title may carry.
 * @returns true for a bot placeholder.
 */
export function isPlaceholderTitle(title, names) {
  return typeof title === 'string' && (title.startsWith(LEGACY_PREFIX) || names.includes(title))
}

/**
 * The conversation part of a title, without a topic-name prefix the bot added.
 * @param title - current session title.
 * @param names - topic names a prefix may carry, current name first.
 * @returns the task part; empty when the title is only a prefix.
 */
export function topicTask(title, names) {
  if (isPlaceholderTitle(title, names)) return ''
  // Longest name first, so "Chat · 2" wins over "Chat" for "Chat · 2 · Fix".
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (title.startsWith(`${name}${TITLE_SEPARATOR}`)) return title.slice(name.length + TITLE_SEPARATOR.length).trim()
  }
  return title
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
