/** Native DSH prompt admission helpers. */
export function promptRequestId(chatId, messageId) {
  if (!Number.isSafeInteger(chatId)) throw new Error('Telegram chat id is required')
  if (!Number.isSafeInteger(messageId)) throw new Error('Telegram message id is required')
  return `telegram:${chatId}:${messageId}`
}

/**
 * Admit text into the native session queue. Returns false when the mounted
 * controller has no prompt method so the caller can use its legacy path.
 */
export function admitText(ctx, { sessionId, chatId, messageId, text }, signal) {
  const controller = ctx.get('sessionController')
  if (typeof controller?.prompt !== 'function') return false
  return controller.prompt({
    sessionId,
    requestId: promptRequestId(chatId, messageId),
    mode: 'queue',
    content: text.trim().length > 0 ? [{ type: 'text', text }] : [],
  }, signal)
}
