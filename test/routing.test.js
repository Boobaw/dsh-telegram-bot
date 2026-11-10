import './setup-home.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { __testing } from '../src/index.js'
import { wrapThinkingLines } from '../src/formatting.js'

const { classifyError, isAllThread, isTelegramParseError, normalizeCommand, routeMessage, splitAnswerText } = __testing

test('General and All thread ids route to a new topic', () => {
  for (const threadId of [undefined, null, 0, 1]) {
    assert.equal(isAllThread(threadId), true, `thread ${threadId}`)
    assert.equal(routeMessage({ threadId, inSession: false }), 'new-topic')
    assert.equal(routeMessage({ threadId, inSession: true }), 'new-topic')
  }
})

test('an existing session topic never creates another topic', () => {
  assert.equal(routeMessage({ threadId: 53193, inSession: true }), 'continue')
  assert.equal(routeMessage({ threadId: 53193, inSession: true, hasAttachment: true }), 'continue')
})

test('a sessionless non-All topic is adopted instead of duplicated', () => {
  assert.equal(routeMessage({ threadId: 53193, inSession: false }), 'current-topic')
  assert.equal(routeMessage({ threadId: 53193, inSession: false, hasAttachment: true }), 'current-topic')
})

test('one All message creates exactly one topic, then the topic continues', () => {
  const first = routeMessage({ threadId: 1, inSession: false })
  assert.equal(first, 'new-topic')

  // After creating/binding the topic, subsequent messages are in a session.
  const second = routeMessage({ threadId: 53193, inSession: true })
  assert.equal(second, 'continue')
  assert.notEqual(second, 'new-topic')
})

test('Telegram parse errors are the only formatting fallback', () => {
  assert.equal(isTelegramParseError("Bad Request: can't parse entities: Character '.' is reserved"), true)
  assert.equal(isTelegramParseError('Bad Request: unsupported start tag'), true)
  assert.equal(isTelegramParseError('Bad Request: message thread not found'), false)
  assert.equal(isTelegramParseError('Bad Request: message is not modified'), false)
  assert.equal(isTelegramParseError('fetch failed'), false)
})

test('operational failures are not classified as formatting failures', () => {
  assert.equal(classifyError(Object.assign(new Error("can't parse entities"), { telegram: true })), 'format')
  assert.equal(classifyError(Object.assign(new Error('message thread not found'), { telegram: true })), 'telegram')
  assert.equal(classifyError(new Error('agent turn failed')), 'agent')
  assert.equal(classifyError(Object.assign(new Error('ENOENT: state.json'), { code: 'ENOENT' })), 'storage')
  assert.equal(classifyError(new Error('unexpected')), 'runtime')
})


test('commands from mobile may include @botname', () => {
  assert.equal(normalizeCommand('/last@boobawnebot'), '/last')
  assert.equal(normalizeCommand('/FORK@boobawnebot'), '/fork')
  assert.equal(normalizeCommand('/last'), '/last')
  assert.equal(normalizeCommand('hello'), 'hello')
})


test('long fenced code stays balanced across answer messages', () => {
  const text = 'intro\n```js\n' + 'const value = 1\n'.repeat(600) + '```\noutro'
  const chunks = splitAnswerText(text)
  assert.equal(chunks.length > 1, true)
  for (const chunk of chunks) {
    const fences = chunk.match(/^ {0,3}(?:`{3,}|~{3,})/gmu) ?? []
    assert.equal(fences.length % 2, 0, chunk.slice(0, 80))
  }
})


test('invisible characters do not turn commands into prompts', () => {
  assert.equal(normalizeCommand('/restart\u200b'), '/restart')
  assert.equal(normalizeCommand('/last\ufeff@boobawnebot'), '/last')
})


test('thinking lines have a hard width and count boundary', () => {
  const text = ('x'.repeat(100) + '\n').repeat(20)
  const tail = wrapThinkingLines(text, 40, 9)
  const lines = tail.split('\n')
  assert.equal(lines.length <= 9, true)
  assert.equal(lines.every((line) => line.length <= 40), true)
  assert.equal(lines.at(-1).length <= 30, true)
  assert.equal(lines.length <= 9, true)
})
