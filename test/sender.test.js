import './setup-home.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createPrincipalTagger, telegramUserPrincipal, withPrincipal } from '../src/sender.js'

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
  tagger.remember('telegram:100:5', principal)
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
  tagger.remember('telegram:100:6', principal)
  assert.deepEqual(await tagger.preStep({ messages: [] }, async () => ({ kind: 'reject' })), { kind: 'reject' })
  assert.equal(tagger.size, 1)
  // The oldest entry goes past the bound.
  tagger.remember('x', principal)
  tagger.remember('y', principal)
  assert.equal(tagger.size, 2)
})
