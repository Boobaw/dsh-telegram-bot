/**
 * Describe what an incoming Telegram message replies to, quotes or forwards,
 * as short labelled plain text the agent reads before the message itself.
 */

/** Longest quoted or forwarded text passed to the agent, in characters. */
export const QUOTE_LIMIT = 2000

/** Longest text of a message sent on someone's behalf passed to the agent, in characters. */
export const SENT_TEXT_LIMIT = 8000

/** Largest file Telegram lets a bot download (getFile). */
export const DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024

/** Labels the bridge puts on prompts it mirrors from other clients. */
const MIRROR_LABELS = [
  ['🖥 From Web:', 'the Web UI (a user prompt this bot mirrored into the chat, not an assistant answer)'],
  ['🖥 Из Web:', 'the Web UI (a user prompt this bot mirrored into the chat, not an assistant answer)'],
  ['⏰ Scheduled task:', 'a scheduled task (a prompt this bot mirrored into the chat, not an assistant answer)'],
  ['⏰ Задача по расписанию:', 'a scheduled task (a prompt this bot mirrored into the chat, not an assistant answer)'],
]

/**
 * Text or caption of a message.
 * @param message - Telegram message or external reply.
 * @returns the text, or an empty string.
 */
export function messageBody(message) {
  if (typeof message?.text === 'string') return message.text
  if (typeof message?.caption === 'string') return message.caption
  return ''
}

/**
 * True when the message was forwarded from somewhere else.
 * @param message - Telegram message.
 */
export function isForwarded(message) {
  return originOf(message) !== undefined
}

/**
 * The photo, document or spoken recording (voice, audio, round video) of a
 * message, when the bot can download it.
 * @param message - Telegram message or external reply.
 * @returns the file kind and size, or undefined.
 */
export function downloadableFile(message) {
  const photo = Array.isArray(message?.photo) ? message.photo.at(-1) : undefined
  const candidates = [['photo', photo], ['document', message?.document], ['voice', message?.voice], ['video_note', message?.video_note], ['audio', message?.audio]]
  const found = candidates.find(([, file]) => typeof file?.file_id === 'string')
  if (found === undefined) return undefined
  const [kind, file] = found
  return { kind, size: typeof file.file_size === 'number' ? file.file_size : undefined }
}

/**
 * The message a reply points at, ignoring the topic's own first message,
 * which Telegram sets as the reply target of every message in a topic.
 * @param message - Telegram message.
 * @returns the replied-to message, or undefined.
 */
export function repliedMessage(message) {
  const target = message?.reply_to_message
  if (target === undefined || target === null) return undefined
  if (target.forum_topic_created !== undefined) return undefined
  if (message.is_topic_message === true && target.message_id === message.message_thread_id) return undefined
  return target
}

/**
 * Chat and message id of the message a reply points at, for looking it up
 * in the sent-message log.
 * @param message - Telegram message.
 * @returns { chatId, messageId }, or undefined when it is not a reply.
 */
export function replyReference(message) {
  if (originOf(message) !== undefined) return undefined
  const target = repliedMessage(message)
  if (target !== undefined) return { chatId: target.chat?.id ?? message.chat?.id, messageId: target.message_id }
  const external = message?.external_reply
  if (external?.chat?.id !== undefined && Number.isSafeInteger(external.message_id)) return { chatId: external.chat.id, messageId: external.message_id }
  return undefined
}

/**
 * Build the prompt text for one message: context lines, then the message.
 * A forwarded message is shown in full inside its context block.
 * @param message - Telegram message.
 * @param options - botId: this bot's user id; replyFile: outcome of attaching
 *   the replied-to file ('attached', 'too-large', 'failed'); ownFile: true when
 *   the message's own photo or document is attached; maxQuote: text limit;
 *   sent: the sent-message log entry the replied-to message belongs to;
 *   currentSession: the session now bound to the topic.
 * @returns the prompt text, possibly empty.
 */
export function composePrompt(message, options = {}) {
  const body = messageBody(message).trim()
  const forward = describeForward(message, body, options)
  const reply = forward === undefined ? describeReply(message, options) : undefined
  const sent = reply === undefined ? undefined : describeSent(options.sent, { currentSession: options.currentSession })
  const blocks = [reply, sent, forward].filter((block) => block !== undefined)
  if (forward === undefined && body.length > 0) blocks.push(body)
  return blocks.join('\n\n')
}

/**
 * The line that tells the agent who wrote a Telegram message. Several allowed
 * users can talk to the same bot, each in their own chat.
 * @param user - Telegram `from` of the message.
 * @returns a one-line label, or undefined without a sender.
 */
export function senderLabel(user) {
  if (user === undefined || user === null || user.id === undefined) return undefined
  const name = [user.first_name, user.last_name].filter((part) => typeof part === 'string' && part.trim().length > 0).join(' ').trim()
  const details = []
  if (typeof user.username === 'string' && user.username.length > 0) details.push(`@${user.username}`)
  details.push(`user id ${user.id}`)
  return name.length > 0 ? `[Telegram message from ${name} (${details.join(', ')})]` : `[Telegram message from ${details.join(', ')}]`
}

/**
 * Describe the replied-to or externally replied message, if any.
 * @returns the context block, or undefined.
 */
export function describeReply(message, options = {}) {
  const limit = options.maxQuote ?? QUOTE_LIMIT
  const quote = typeof message?.quote?.text === 'string' && message.quote.text.trim().length > 0 ? message.quote.text : undefined
  const target = repliedMessage(message)
  if (target !== undefined) {
    const details = [`sent ${formatDate(target.date)}`]
    const origin = originOf(target)
    if (origin !== undefined) details.push(`forwarded from ${describeOrigin(origin, message, options)}${origin.date === undefined ? '' : `, originally sent ${formatDate(origin.date)}`}`)
    const media = mediaNote(target, options.replyFile)
    if (media !== undefined) details.push(media)
    const text = quote ?? messageBody(target)
    const label = quote === undefined ? '' : '; the user quoted only this part'
    const head = `[Replying to a message from ${describeSender(target, message, options)} (${details.join('; ')})${label}]`
    return text.trim().length === 0 ? head : `${head}\n${quoteLines(text, limit)}`
  }
  const external = message?.external_reply
  if (external === undefined || external === null) {
    if (message?.reply_to_story !== undefined) return '[Replying to a Telegram story]'
    return undefined
  }
  const details = []
  if (external.origin !== undefined) {
    details.push(`from ${describeOrigin(external.origin, message, options)}`)
    if (external.origin.date !== undefined) details.push(`sent ${formatDate(external.origin.date)}`)
  }
  if (external.chat !== undefined && external.origin?.type !== 'channel') details.push(`in ${chatName(external.chat)}`)
  const link = messageLink(external.chat, external.message_id)
  if (link !== undefined) details.push(link)
  const media = mediaNote(external, options.replyFile)
  if (media !== undefined) details.push(media)
  const head = `[Replying to a message from another chat${details.length === 0 ? '' : ` (${details.join('; ')})`}${quote === undefined ? '' : '; the user quoted this part'}]`
  if (quote !== undefined) return `${head}\n${quoteLines(quote, limit)}`
  return `${head}\n(The bot cannot see the text of messages in other chats unless the user quotes it.)`
}

/**
 * Describe a forwarded message together with its content.
 * @returns the context block, or undefined when the message is not forwarded.
 */
export function describeForward(message, body = messageBody(message).trim(), options = {}) {
  const origin = originOf(message)
  if (origin === undefined) return undefined
  const details = []
  if (origin.date !== undefined) details.push(`originally sent ${formatDate(origin.date)}`)
  const link = origin.type === 'channel' ? messageLink(origin.chat, origin.message_id) : undefined
  if (link !== undefined) details.push(link)
  const media = mediaNote(message, options.ownFile === true ? 'attached' : undefined)
  if (media !== undefined) details.push(media)
  const head = `[Forwarded message from ${describeOrigin(origin, message, options)}${details.length === 0 ? '' : ` (${details.join('; ')})`}]`
  return body.length === 0 ? head : `${head}\n${quoteLines(body, options.maxQuote ?? QUOTE_LIMIT)}`
}

/**
 * Describe a message the bot sent into a topic on someone's behalf (a script,
 * a job, a plugin or another session): who sent it, when, where it was
 * recorded, and its full text, which may span several Telegram messages.
 * @param sent - entry from the sent-message log.
 * @param options - currentSession: session now bound to the topic; limit: text limit.
 * @returns the context block, or undefined.
 */
export function describeSent(sent, options = {}) {
  if (sent === undefined || sent === null) return undefined
  const details = []
  const time = Date.parse(sent.sentAt ?? '')
  details.push(Number.isFinite(time) ? `sent ${formatDate(time / 1000)}` : 'sent at an unknown time')
  if (typeof sent.job === 'string' && sent.job.length > 0) details.push(`by job "${sent.job}"`)
  if (typeof sent.fromSession === 'string' && sent.fromSession.length > 0) details.push(`from DSH session ${sent.fromSession}`)
  else if (typeof sent.label === 'string' && sent.label.length > 0 && sent.job == null) details.push(`by ${sent.label}`)
  if (Array.isArray(sent.messageIds) && sent.messageIds.length > 1) details.push(`${sent.messageIds.length} Telegram messages`)
  if (Array.isArray(sent.files) && sent.files.length > 0) details.push(`with ${sent.files.length === 1 ? 'file' : 'files'} ${sent.files.map((name) => `"${name}"`).join(', ')}`)
  const bound = typeof sent.boundSession === 'string' ? sent.boundSession : undefined
  if (bound !== undefined && sent.recorded === true && bound !== options.currentSession) details.push(`recorded in session ${bound}, not this one`)
  else if (bound === undefined) details.push('the topic had no session then')
  const head = `[The replied-to message was posted by the bot on behalf of another sender (${details.join('; ')}). Full text:]`
  const body = typeof sent.text === 'string' && sent.text.trim().length > 0
    ? quoteLines(sent.text, options.limit ?? SENT_TEXT_LIMIT) + (sent.textCut > 0 ? `\n> […${sent.textCut} more characters not kept]` : '')
    : '> (no text)'
  const sessions = [sent.fromSession, bound !== options.currentSession && sent.recorded === true ? bound : undefined]
    .filter((id, index, all) => typeof id === 'string' && id.length > 0 && all.indexOf(id) === index)
  const hint = sessions.length === 0 ? '' : `\n(For more context, open session ${sessions.join(' or ')}.)`
  return `${head}\n${body}${hint}`
}

/** Forward origin of a message, including the fields older Bot API versions used. */
function originOf(message) {
  if (message?.forward_origin !== undefined && message.forward_origin !== null) return message.forward_origin
  const date = message?.forward_date
  if (message?.forward_from_chat !== undefined) {
    return { type: message.forward_from_chat.type === 'channel' ? 'channel' : 'chat', chat: message.forward_from_chat, sender_chat: message.forward_from_chat, message_id: message.forward_from_message_id, author_signature: message.forward_signature, date }
  }
  if (message?.forward_from !== undefined) return { type: 'user', sender_user: message.forward_from, date }
  if (typeof message?.forward_sender_name === 'string') return { type: 'hidden_user', sender_user_name: message.forward_sender_name, date }
  return undefined
}

/** Who wrote a replied-to message, from the reader's point of view. */
function describeSender(target, message, options) {
  const from = target.from
  if (from !== undefined && options.botId !== undefined && from.id === options.botId) {
    const text = messageBody(target)
    const mirrored = MIRROR_LABELS.find(([label]) => text.startsWith(label))
    return mirrored === undefined ? 'the assistant (this bot)' : mirrored[1]
  }
  if (target.sender_chat !== undefined) return chatName(target.sender_chat)
  if (from !== undefined && message?.from !== undefined && from.id === message.from.id) return 'the user (their own earlier message)'
  if (from !== undefined) return personName(from)
  return 'an unknown sender'
}

/** Name the origin of a forwarded message. */
function describeOrigin(origin, message, options) {
  const signature = typeof origin.author_signature === 'string' && origin.author_signature.length > 0 ? `, signed ${origin.author_signature}` : ''
  if (origin.type === 'user') {
    const user = origin.sender_user
    if (user !== undefined && options.botId !== undefined && user.id === options.botId) return 'the assistant (this bot)'
    if (user !== undefined && message?.from !== undefined && user.id === message.from.id) return 'the user themselves'
    return user === undefined ? 'a user' : personName(user)
  }
  if (origin.type === 'hidden_user') return `${origin.sender_user_name ?? 'a user'} (account hidden)`
  if (origin.type === 'channel') return `channel ${chatName(origin.chat)}${signature}`
  if (origin.type === 'chat') return `${chatName(origin.sender_chat)}${signature}`
  return 'an unknown source'
}

function personName(user) {
  const name = [user.first_name, user.last_name].filter((part) => typeof part === 'string' && part.length > 0).join(' ')
  const handle = typeof user.username === 'string' && user.username.length > 0 ? `@${user.username}` : ''
  const label = name.length > 0 ? (handle.length > 0 ? `${name} (${handle})` : name) : (handle.length > 0 ? handle : 'a user')
  return user.is_bot === true ? `${label}, a bot` : label
}

function chatName(chat) {
  if (chat === undefined || chat === null) return 'a chat'
  const title = typeof chat.title === 'string' && chat.title.length > 0
    ? `"${chat.title}"`
    : [chat.first_name, chat.last_name].filter(Boolean).join(' ')
  const handle = typeof chat.username === 'string' && chat.username.length > 0 ? `@${chat.username}` : ''
  if (title.length > 0) return handle.length > 0 ? `${title} (${handle})` : title
  return handle.length > 0 ? handle : 'a chat'
}

/** Public link to a channel or supergroup message, when one exists. */
function messageLink(chat, messageId) {
  if (chat === undefined || chat === null || !Number.isSafeInteger(messageId)) return undefined
  if (typeof chat.username === 'string' && chat.username.length > 0) return `https://t.me/${chat.username}/${messageId}`
  const id = String(chat.id ?? '')
  if (id.startsWith('-100')) return `https://t.me/c/${id.slice(4)}/${messageId}`
  return undefined
}

/** Note the media a message carries and whether it was attached. */
function mediaNote(message, fileOutcome) {
  const kind = mediaKind(message)
  if (kind === undefined) return undefined
  if (downloadableFile(message) === undefined) return `contains ${kind}, not attached`
  if (fileOutcome === 'attached') return `contains ${kind}, attached`
  if (fileOutcome === 'too-large') return `contains ${kind}, too large to attach`
  if (fileOutcome === 'failed') return `contains ${kind}, could not be downloaded`
  return `contains ${kind}`
}

function mediaKind(message) {
  if (message === undefined || message === null) return undefined
  if (Array.isArray(message.photo) && message.photo.length > 0) return 'a photo'
  if (message.document !== undefined && message.animation === undefined) {
    return typeof message.document.file_name === 'string' ? `a file "${message.document.file_name}"` : 'a file'
  }
  if (message.video !== undefined) return 'a video'
  if (message.animation !== undefined) return 'a GIF'
  if (message.audio !== undefined) {
    const title = [message.audio.performer, message.audio.title].filter(Boolean).join(' - ')
    return title.length > 0 ? `audio "${title}"` : 'audio'
  }
  if (message.voice !== undefined) return 'a voice message'
  if (message.video_note !== undefined) return 'a video message'
  if (message.sticker !== undefined) return `a sticker${typeof message.sticker.emoji === 'string' ? ` ${message.sticker.emoji}` : ''}`
  if (message.poll !== undefined) return `a poll "${message.poll.question ?? ''}"`
  if (message.venue !== undefined) return `a venue "${message.venue.title ?? ''}"`
  if (message.location !== undefined) return `a location (${message.location.latitude}, ${message.location.longitude})`
  if (message.contact !== undefined) return `a contact (${[message.contact.first_name, message.contact.last_name].filter(Boolean).join(' ')})`
  if (message.story !== undefined) return 'a story'
  if (message.paid_media !== undefined) return 'paid media'
  if (message.dice !== undefined) return `a dice roll ${message.dice.emoji ?? ''}`.trim()
  if (message.checklist !== undefined) return 'a checklist'
  if (message.game !== undefined) return 'a game'
  if (message.invoice !== undefined) return 'an invoice'
  return undefined
}

/** UTC date for a Telegram unix timestamp. */
function formatDate(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'at an unknown time'
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** Quote text line by line, cut at a word boundary near the limit. */
function quoteLines(text, limit) {
  let shown = text.trim()
  let note = ''
  if (shown.length > limit) {
    let cut = shown.lastIndexOf(' ', limit)
    const newline = shown.lastIndexOf('\n', limit)
    if (newline > cut) cut = newline
    if (cut < limit * 0.8) cut = limit
    note = `\n> […truncated, ${shown.length - cut} more characters]`
    shown = shown.slice(0, cut).trimEnd()
  }
  return shown.split('\n').map((line) => `> ${line}`).join('\n') + note
}
