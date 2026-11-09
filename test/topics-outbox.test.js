import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { enqueue, waitForResult } from '../src/outbox.js'
import { isAutoCommandTopic, resolveThreadTarget, topicNameOf } from '../src/topics.js'

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
