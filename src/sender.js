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
 */

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

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Principals for prompts the bot hands to DSH's session controller, which
 * builds the message itself. The bot remembers the sender by request id
 * before the hand-over; `preStep`, an `agent/pre-step` listener, records it
 * on the message as it enters a step, so it is in the session log with the
 * message (DSH lets that hook replace the messages of a step).
 * @param limit - most principals remembered at once.
 */
export function createPrincipalTagger(limit = MAX_PENDING_PRINCIPALS) {
  const pending = new Map()
  return {
    /** Remember the sender of the prompt with this request id. */
    remember(requestId, principal) {
      if (typeof requestId !== 'string' || principal === undefined) return
      pending.delete(requestId)
      pending.set(requestId, principal)
      if (pending.size > limit) pending.delete(pending.keys().next().value)
    },
    /** Pending principals, for tests. */
    get size() {
      return pending.size
    },
    /** `agent/pre-step` listener: record remembered senders on the step's messages. */
    async preStep(_payload, next) {
      const decision = await next()
      if (decision?.kind !== 'enter' || pending.size === 0 || !Array.isArray(decision.messages)) return decision
      let changed = false
      const messages = decision.messages.map((message) => {
        const rpcId = message?.source?.kind === 'user' ? message.source.rpcId : undefined
        const principal = typeof rpcId === 'string' ? pending.get(rpcId) : undefined
        if (principal === undefined || message.source.principal !== undefined) return message
        pending.delete(rpcId)
        changed = true
        return withPrincipal(message, principal)
      })
      return changed ? { ...decision, messages } : decision
    },
  }
}
