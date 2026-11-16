/**
 * Who sent a message, as data on the message itself.
 *
 * DSH's field for the caller behind a user message is `source.principal`:
 * the session controller writes it for callers other than the owner, so an
 * absent principal means the owner. The bot admits every Telegram prompt as
 * the owner, so it fills the field itself. Readers of the session log then
 * know which allowed user wrote each prompt.
 *
 * The principal has `kind`, `channel` and `id`, and `name`, `username` and
 * `chat` when known. None of it is a credential, so it is safe in a session log.
 *
 * With a `timeZone` configured, the model also learns when each message was
 * sent, from a short notice message placed right before the prompt rather
 * than a line inside it: DSH titles a session from the first words of its
 * first human message, and those must be the person's own.
 */

import { randomUUID } from 'node:crypto'

/** Remembered prompts waiting for their step; the oldest go first past this. */
export const MAX_PENDING_PRINCIPALS = 1024

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * The Telegram user who wrote a message, and where.
 * @param user - Telegram `from` of the message.
 * @param where - `{ chatId, threadId, topic }`: the chat, its topic thread and the topic's name.
 * @returns the principal, or undefined without a sender.
 */
export function telegramUserPrincipal(user, { chatId, threadId, topic } = {}) {
  if (user === undefined || user === null || user.id === undefined || user.id === null) return undefined
  const name = [user.first_name, user.last_name].map(nonEmpty).filter((part) => part !== undefined).join(' ')
  const username = nonEmpty(user.username)
  const chat = chatId === undefined || chatId === null
    ? undefined
    : {
        id: String(chatId),
        ...(Number.isSafeInteger(threadId) && threadId > 0 ? { thread: threadId } : {}),
        ...(nonEmpty(topic) === undefined ? {} : { name: nonEmpty(topic) }),
      }
  return {
    kind: 'telegram-user',
    channel: 'telegram',
    id: String(user.id),
    ...(name.length > 0 ? { name } : {}),
    ...(username === undefined ? {} : { username }),
    ...(chat === undefined ? {} : { chat }),
  }
}

/**
 * A frozen copy of a message whose source records its sender.
 * @param message - the user message.
 * @param principal - its sender.
 * @returns the copy; the message itself when there is no principal.
 */
export function withPrincipal(message, principal) {
  if (principal === undefined) return message
  return Object.freeze({ ...message, source: Object.freeze({ ...message.source, principal: deepFreeze(principal) }) })
}

/** Source kind of the notice placed before a Telegram prompt. */
export const SENDER_NOTICE_KIND = 'telegram-sender'

/**
 * The notice that tells the model when a Telegram message was sent. A message
 * can reach the agent long after it was written (the bot's queue, a backlog
 * after a restart), so the time is Telegram's own.
 * @param sentAt - when the message was sent, as text (see `formatMoment`).
 * @returns the notice, or undefined without a time.
 */
export function sentNotice(sentAt) {
  const time = nonEmpty(sentAt)
  if (time === undefined) return undefined
  const text = `[Telegram message, sent ${time}]`
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SENDER_NOTICE_KIND, form: 'notice', summary: text },
  })
}

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Principals for prompts the bot hands to DSH's session controller, which
 * builds the message itself. The bot remembers the sender (and the send time,
 * when shown) by request id before the hand-over; `preStep`, an
 * `agent/pre-step` listener, records the sender on the message as it enters a
 * step, so it is in the session log with the message, and puts the time
 * notice before it (DSH lets that hook replace the messages of a step).
 * @param limit - most principals remembered at once.
 */
export function createPrincipalTagger(limit = MAX_PENDING_PRINCIPALS) {
  const pending = new Map()
  return {
    /**
     * Remember the sender and send time of the prompt with this request id.
     * @param requestId - the prompt's request id.
     * @param details - `{ principal, sentAt }`, each optional.
     */
    remember(requestId, { principal, sentAt } = {}) {
      if (typeof requestId !== 'string' || (principal === undefined && sentAt === undefined)) return
      pending.delete(requestId)
      pending.set(requestId, { principal, sentAt })
      if (pending.size > limit) pending.delete(pending.keys().next().value)
    },
    /** Pending prompts, for tests. */
    get size() {
      return pending.size
    },
    /**
     * `agent/pre-step` listener: record remembered senders on the step's
     * messages and put each remembered send time in a notice before its prompt.
     */
    async preStep(_payload, next) {
      const decision = await next()
      if (decision?.kind !== 'enter' || pending.size === 0 || !Array.isArray(decision.messages)) return decision
      let changed = false
      const messages = []
      for (const original of decision.messages) {
        const rpcId = original?.source?.kind === 'user' ? original.source.rpcId : undefined
        const entry = typeof rpcId === 'string' ? pending.get(rpcId) : undefined
        if (entry === undefined) {
          messages.push(original)
          continue
        }
        pending.delete(rpcId)
        const notice = sentNotice(entry.sentAt)
        if (notice !== undefined) messages.push(notice)
        const tagged = entry.principal === undefined || original.source.principal !== undefined
          ? original
          : withPrincipal(original, entry.principal)
        messages.push(tagged)
        changed = changed || notice !== undefined || tagged !== original
      }
      return changed ? { ...decision, messages } : decision
    },
  }
}
