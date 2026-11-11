import './setup-home.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { enqueue, waitForResult } from '../src/outbox.js'
import { deliveredToTopic, isAutoCommandTopic, isTopicGone, resolveThreadTarget, resolveTopicTarget, topicNameOf, topicTargetFor } from '../src/topics.js'

test('topic names are learned from creation and rename messages', () => {
  assert.deepEqual(topicNameOf({ forum_topic_created: { name: 'Build' } }), { name: 'Build', authoritative: true })
  assert.deepEqual(topicNameOf({ forum_topic_edited: { name: 'Release' } }), { name: 'Release', authoritative: true })
  assert.deepEqual(topicNameOf({ reply_to_message: { forum_topic_created: { name: 'Old' } } }), { name: 'Old', authoritative: false })
  assert.equal(topicNameOf({}), undefined)
})

test('send targets are numeric thread ids the bot knows', () => {
  const known = new Set([10, 11])
  assert.equal(resolveThreadTarget(known, 10), 10)
  assert.equal(resolveThreadTarget(known, '11'), 11)
  assert.throws(() => resolveThreadTarget(known, 'Build'), /not a Telegram thread id/)
  assert.throws(() => resolveThreadTarget(known, 99), /Unknown thread id/)
})

test('/topic delete targets resolve by thread id or case-insensitive unique name', () => {
  const names = { '100:10': 'Build', '100:11': 'Release', '200:10': 'Other' }
  assert.deepEqual(resolveTopicTarget(names, 100, 10), { threadId: 10, name: 'Build' })
  assert.deepEqual(resolveTopicTarget(names, 100, 'build'), { threadId: 10, name: 'Build' })
  assert.throws(() => resolveTopicTarget({ '100:10': 'Same', '100:11': 'same' }, 100, 'SAME'), /Several topics/)
  assert.throws(() => resolveTopicTarget(names, 100, 'missing'), /Unknown Telegram topic/)
  assert.throws(() => resolveTopicTarget(names, 100, 8790387050), /not a Telegram topic id/)
})

test('only fresh chat-wide command topics are answered in All', () => {
  assert.equal(isAutoCommandTopic('/status', '/status', '/status', true), true)
  assert.equal(isAutoCommandTopic('/status', '/status', '/status', false), false)
  assert.equal(isAutoCommandTopic('/fork', '/fork', '/fork', true), false)
  assert.equal(isAutoCommandTopic('/status', 'hello', '/status', true), false)
})

test('outbox spools a request and exposes a result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-outbox-test-'))
  try {
    const id = await enqueue({ topic: 'Build', text: 'ok' }, dir)
    const resultPath = join(dir, `${id}.result.json`)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(resultPath, JSON.stringify({ ok: true, result: { messageIds: [1] } }))
    assert.deepEqual(await waitForResult(id, 1000, dir), { ok: true, result: { messageIds: [1] } })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('deleted-topic errors are recognized', () => {
  assert.equal(isTopicGone('Bad Request: message thread not found'), true)
  assert.equal(isTopicGone('Bad Request: TOPIC_ID_INVALID'), true)
  assert.equal(isTopicGone('Bad Request: TOPIC_DELETED'), true)
  assert.equal(isTopicGone('Bad Request: topic was deleted'), true)
  assert.equal(isTopicGone('Bad Request: message is too long'), false)
})

test('private-chat topics send with message_thread_id', () => {
  const directChats = { 100: true }
  const directTopics = { '100:7001': 2597 }
  assert.deepEqual(topicTargetFor(directChats, {}, 100, 7001), { message_thread_id: 7001 })
  assert.deepEqual(
    topicTargetFor(directChats, directTopics, 100, 7001),
    { message_thread_id: 7001 },
    'a stale cached direct id must not override the thread id',
  )
  assert.deepEqual(topicTargetFor({}, {}, 200, 7001), { message_thread_id: 7001 })
  assert.deepEqual(topicTargetFor({}, { '200:7001': 2597 }, 200, 7001), { direct_messages_topic_id: 2597 })
  assert.deepEqual(topicTargetFor(directChats, directTopics, 100, 1), {})
  assert.deepEqual(topicTargetFor(directChats, directTopics, 100, undefined), {})
})

test('delivery checks require evidence of the target topic', () => {
  const directChats = { 100: true }
  const directTopics = { '100:7001': 2597 }
  // No topic fields: Telegram may have silently sent the message into All.
  assert.equal(deliveredToTopic(directChats, directTopics, 100, 7001, { message_id: 1 }), false)
  assert.equal(deliveredToTopic(directChats, directTopics, 100, 7001, { message_thread_id: 7001 }), true)
  assert.equal(deliveredToTopic(directChats, directTopics, 100, 7001, { message_thread_id: 7002 }), false)
  assert.equal(deliveredToTopic(directChats, directTopics, 100, 7001, { message_thread_id: 2597 }), false)
  assert.equal(deliveredToTopic(directChats, directTopics, 100, 7001, { direct_messages_topic: { topic_id: 7001 } }), true)
  assert.equal(deliveredToTopic(directChats, directTopics, 100, 7001, { direct_messages_topic: { topic_id: 2597 } }), false)
  // Forum supergroups prove delivery with message_thread_id.
  assert.equal(deliveredToTopic({}, {}, 200, 7001, { message_thread_id: 7001 }), true)
  assert.equal(deliveredToTopic({}, {}, 200, 7001, { message_id: 1 }), false)
  // A channel direct-messages chat may use a distinct direct topic id.
  assert.equal(deliveredToTopic({}, { '200:7001': 2597 }, 200, 7001, { direct_messages_topic: { topic_id: 2597 } }), true)
})
