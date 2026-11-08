/**
 * Steering: a Telegram message sent while the bound session's turn runs goes
 * into that turn, the way the DSH Web UI sends a message during a turn. DSH
 * delivers it at the agent's next step; if the turn has already ended, DSH
 * opens a new turn for it. Fork-only code, kept out of `app.js`.
 */
import { randomUUID } from 'node:crypto'
import { promptRequestId } from './admission.js'

/** Reaction that tells the sender a message reached the running turn. */
export const STEER_REACTION = '👀'

/**
 * How Telegram messages that arrive during a running turn are handled.
 * @param value - the `busyMessages` setting.
 * @returns `queue` (the bot holds them until the turn ends) or `steer`.
 */
export function busyMode(value) {
  return value === 'queue' ? 'queue' : 'steer'
}

/**
 * The durable request id of a Telegram prompt. With a Telegram message id it is
 * the same id the native text path uses, so a redelivered update is not
 * admitted twice.
 * @param chatId - Telegram chat.
 * @param messageId - Telegram message id, when known.
 * @returns the request id recorded on the user message.
 */
export function steerRequestId(chatId, messageId) {
  return Number.isSafeInteger(chatId) && Number.isSafeInteger(messageId)
    ? promptRequestId(chatId, messageId)
    : `telegram-steer:${randomUUID()}`
}

/** @returns whether a pending or recorded message carries this request id. */
function hasRequest(agent, requestId) {
  const matches = (message) => message?.source?.kind === 'user' && message.source.rpcId === requestId
  const inbox = agent?.inbox
  if (inbox?.nextTurn?.some?.(matches) || inbox?.nextStep?.some?.(matches)) return true
  if (typeof agent?.session?.snapshotEvents !== 'function') return false
  return agent.session.snapshotEvents().some((event) => event?.type === 'user/message' && matches(event.data))
}

/**
 * Send one prompt into the session's running turn. Text goes through the
 * Session controller's `steer` mode, the Web UI's own path; attachments are
 * already stored, so a message with them goes straight to `agent.steer`, the
 * method that mode calls. Either way DSH puts the message in the next-step
 * inbox and wakes the agent: a running turn takes it at its next step, and a
 * turn that ended meanwhile is followed by a new one, so the message is never
 * dropped. A request id already admitted is skipped, so it is never sent twice.
 * @param ctx - plugin context.
 * @param agent - the session's live agent.
 * @param prompt - `{ sessionId, chatId, messageId, text, attachments }`.
 * @param signal - request lifetime.
 * @returns the request id, or `undefined` when this DSH cannot steer.
 */
export async function steerPrompt(ctx, agent, { sessionId, chatId, messageId, text, attachments = [] }, signal) {
  const requestId = steerRequestId(chatId, messageId)
  const content = [...(text.trim().length === 0 ? [] : [{ type: 'text', text }]), ...attachments]
  const controller = ctx.get('sessionController')
  if (attachments.length === 0 && content.length > 0 && typeof controller?.prompt === 'function') {
    await controller.prompt({ sessionId, requestId, mode: 'steer', content }, signal)
    return requestId
  }
  if (hasRequest(agent, requestId)) return requestId
  const message = { id: randomUUID(), role: 'user', content, source: { kind: 'user', rpcId: requestId } }
  if (typeof agent?.steer === 'function') agent.steer(message)
  else if (typeof agent?.send === 'function') agent.send(message, 'next-step', true)
  else return undefined
  return requestId
}

/**
 * Remove Telegram messages from one chat that the agent has not taken yet,
 * from both the next-step and the next-turn inbox.
 * @param agent - the session's live agent.
 * @param chatId - Telegram chat whose messages are removed.
 * @returns how many were removed.
 */
export function clearTelegramInbox(agent, chatId) {
  const inbox = agent?.inbox
  if (typeof inbox?.remove !== 'function') return 0
  const prefix = `telegram:${chatId}:`
  const ours = (message) => message?.source?.kind === 'user'
    && typeof message.source.rpcId === 'string'
    && (message.source.rpcId.startsWith(prefix) || message.source.rpcId.startsWith('telegram-steer:'))
  const pending = [...(inbox.nextStep ?? []), ...(inbox.nextTurn ?? [])].filter(ours)
  for (const message of pending) inbox.remove(message.id)
  return pending.length
}

/**
 * Whether the agent still holds input it has not taken. DSH starts another
 * turn for it right after the current one ends.
 * @param agent - live agent.
 */
export function hasPendingInput(agent) {
  const inbox = agent?.inbox
  if (inbox === undefined) return false
  if (typeof inbox.hasPending === 'boolean') return inbox.hasPending
  return (inbox.nextStep?.length ?? 0) > 0 || (inbox.nextTurn?.length ?? 0) > 0
}
