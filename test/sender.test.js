import './setup-home.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { admitText } from '../src/admission.js'
import { createPrincipalTagger, sentNotice, telegramUserPrincipal, withPrincipal } from '../src/sender.js'

test('a Telegram user principal names the user and the topic, without empty fields', () => {
  assert.deepEqual(
    telegramUserPrincipal({ id: 42, first_name: 'Ana', last_name: ' ', username: 'ana' }, { chatId: 100, threadId: 7001, topic: 'Notify' }),
    { kind: 'telegram-user', channel: 'telegram', id: '42', name: 'Ana', username: 'ana', chat: { id: '100', thread: 7001, name: 'Notify' } },
  )
  assert.deepEqual(telegramUserPrincipal({ id: 7 }, { chatId: 7 }), { kind: 'telegram-user', channel: 'telegram', id: '7', chat: { id: '7' } })
  assert.equal(telegramUserPrincipal(undefined), undefined)
  assert.equal(telegramUserPrincipal({ first_name: 'no id' }), undefined)
})

test('withPrincipal keeps the message and freezes the copy', () => {
  const message = Object.freeze({ id: 'm', role: 'user', content: [], source: Object.freeze({ kind: 'user', rpcId: 'r' }) })
  const copy = withPrincipal(message, { kind: 'telegram-user', channel: 'telegram', id: '1' })
  assert.deepEqual(copy, { ...message, source: { kind: 'user', rpcId: 'r', principal: { kind: 'telegram-user', channel: 'telegram', id: '1' } } })
  assert.ok(Object.isFrozen(copy) && Object.isFrozen(copy.source) && Object.isFrozen(copy.source.principal))
  assert.equal(withPrincipal(message, undefined), message)
})

test('the tagger records a remembered sender once, on the matching request only', async () => {
  const tagger = createPrincipalTagger(2)
  const principal = { kind: 'telegram-user', channel: 'telegram', id: '42' }
  const ours = { id: 'a', role: 'user', content: [], source: { kind: 'user', rpcId: 'telegram:100:5' } }
  const other = { id: 'b', role: 'user', content: [], source: { kind: 'user', rpcId: 'web-1' } }
  const context = { id: 'c', role: 'user', content: [], source: { kind: 'time-context' } }
  tagger.remember('telegram:100:5', { principal })
  const enter = (messages) => tagger.preStep({ messages }, async () => ({ kind: 'enter', messages }))
  const decision = await enter([context, ours, other])
  assert.equal(decision.messages[0], context)
  assert.deepEqual(decision.messages[1].source.principal, principal)
  assert.equal(decision.messages[1].id, 'a')
  assert.equal(decision.messages[2], other)
  assert.equal(tagger.size, 0)
  const again = [ours]
  assert.equal((await enter(again)).messages[0], ours)
  // Rejected steps pass through and keep what is remembered.
  tagger.remember('telegram:100:6', { principal })
  assert.deepEqual(await tagger.preStep({ messages: [] }, async () => ({ kind: 'reject' })), { kind: 'reject' })
  assert.equal(tagger.size, 1)
  // The oldest entry goes past the bound.
  tagger.remember('x', { principal })
  tagger.remember('y', { principal })
  assert.equal(tagger.size, 2)
})

test('a remembered send time puts a notice right before its prompt', async () => {
  const tagger = createPrincipalTagger()
  const principal = { kind: 'telegram-user', channel: 'telegram', id: '42' }
  const ours = { id: 'a', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user', rpcId: 'telegram:100:5' } }
  const other = { id: 'b', role: 'user', content: [], source: { kind: 'user', rpcId: 'web-1' } }
  tagger.remember('telegram:100:5', { principal, sentAt: 'Mon 2026-03-02 09:41 UTC+01:00' })
  const messages = (await tagger.preStep({}, async () => ({ kind: 'enter', messages: [ours, other] }))).messages
  assert.equal(messages.length, 3)
  assert.equal(messages[0].content[0].text, '[Telegram message, sent Mon 2026-03-02 09:41 UTC+01:00]')
  assert.deepEqual({ kind: messages[0].source.kind, form: messages[0].source.form }, { kind: 'telegram-sender', form: 'notice' })
  assert.ok(Object.isFrozen(messages[0]))
  assert.equal(messages[1].id, 'a')
  assert.deepEqual(messages[1].source.principal, principal)
  assert.equal(messages[2], other)
  assert.equal(tagger.size, 0)
  // Nothing is remembered without a sender or a time.
  tagger.remember('telegram:100:6', {})
  assert.equal(tagger.size, 0)
  assert.equal(sentNotice(' '), undefined)
  assert.equal(sentNotice(undefined), undefined)
})

test('a prompt admitted with a client zone carries it to the session controller', () => {
  const requests = []
  const ctx = { get: () => ({ prompt: (request) => requests.push(request) }) }
  admitText(ctx, { sessionId: 's', chatId: 100, messageId: 5, text: 'hi', clientTimeZone: 'Europe/Berlin' })
  admitText(ctx, { sessionId: 's', chatId: 100, messageId: 6, text: 'hi' })
  assert.equal(requests[0].clientTimeZone, 'Europe/Berlin')
  assert.equal(requests[0].requestId, 'telegram:100:5')
  assert.equal('clientTimeZone' in requests[1], false)
})
