import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { enqueue, waitForResult } from '../src/outbox.js'
import { isAutoCommandTopic, topicNameOf, resolveTopicTarget } from '../src/topics.js'

test('topic names are learned from creation and rename messages', () => {
  assert.deepEqual(topicNameOf({ forum_topic_created: { name: 'Build' } }), { name: 'Build', authoritative: true })
  assert.deepEqual(topicNameOf({ forum_topic_edited: { name: 'Release' } }), { name: 'Release', authoritative: true })
  assert.deepEqual(topicNameOf({ reply_to_message: { forum_topic_created: { name: 'Old' } } }), { name: 'Old', authoritative: false })
  assert.equal(topicNameOf({}), undefined)
})

test('send targets resolve by thread id or case-insensitive unique name', () => {
  const names = { '100:10': 'Build', '100:11': 'Release', '200:10': 'Other' }
  assert.deepEqual(resolveTopicTarget(names, 100, 10), { threadId: 10, name: 'Build' })
  assert.deepEqual(resolveTopicTarget(names, 100, 'build'), { threadId: 10, name: 'Build' })
  assert.throws(() => resolveTopicTarget({ '100:10': 'Same', '100:11': 'same' }, 100, 'SAME'), /Several topics/)
  assert.throws(() => resolveTopicTarget(names, 100, 'missing'), /Unknown Telegram topic/)
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
