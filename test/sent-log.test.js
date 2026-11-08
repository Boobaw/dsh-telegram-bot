import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSentLog, SENT_LOG_MAX_AGE_MS, SENT_LOG_MAX_ENTRIES } from '../src/sent-log.js'

const tempFile = async () => join(await mkdtemp(join(tmpdir(), 'sent-log-')), 'sent.json')

test('a send split into several messages is found by any of them, in its own chat only', async () => {
  const path = await tempFile()
  const log = createSentLog({ path })
  await log.record({ chatId: 100, threadId: 7, messageIds: [11, 12, 13], text: 'long notice', job: 'nightly', fromSession: 'session-a', boundSession: 'session-b', recorded: true })
  for (const id of [11, 12, 13]) assert.equal((await log.find(100, id))?.text, 'long notice')
  assert.equal(await log.find(100, 14), undefined)
  assert.equal(await log.find(200, 12), undefined)
  assert.equal((await log.find('100', 12))?.text, 'long notice', 'chat ids compare as text')
  // A second instance reads what the first one wrote.
  await log.flush()
  const again = createSentLog({ path })
  const entry = await again.find(100, 12)
  assert.equal(entry.job, 'nightly')
  assert.equal(entry.fromSession, 'session-a')
  assert.equal(entry.boundSession, 'session-b')
})

test('a missing or broken file starts an empty log', async () => {
  const missing = createSentLog({ path: join(await mkdtemp(join(tmpdir(), 'sent-log-')), 'none', 'sent.json') })
  assert.equal(await missing.find(100, 1), undefined)
  const path = await tempFile()
  await writeFile(path, '{ not json')
  const broken = createSentLog({ path })
  assert.equal(await broken.find(100, 1), undefined)
  await broken.record({ chatId: 100, messageIds: [1], text: 'x' })
  await broken.flush()
  assert.equal(JSON.parse(await readFile(path, 'utf8')).entries.length, 1)
})

test('old and surplus sends are pruned', async () => {
  let clock = 1_800_000_000_000
  const log = createSentLog({ path: await tempFile(), now: () => clock })
  await log.record({ chatId: 1, messageIds: [1], text: 'old' })
  clock += SENT_LOG_MAX_AGE_MS + 1
  await log.record({ chatId: 1, messageIds: [2], text: 'new' })
  assert.equal(await log.find(1, 1), undefined)
  assert.equal((await log.find(1, 2))?.text, 'new')
  for (let index = 0; index < SENT_LOG_MAX_ENTRIES; index += 1) await log.record({ chatId: 1, messageIds: [100 + index], text: 't' })
  assert.equal(await log.find(1, 2), undefined)
  assert.ok(await log.find(1, 100 + SENT_LOG_MAX_ENTRIES - 1))
  await log.flush()
})
