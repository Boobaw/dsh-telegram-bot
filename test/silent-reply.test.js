import './setup-home.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { start, wait } from './fakes.js'

const THREAD = 7001
const SESSION = 'session-silent'
const bound = {
  sessions: { [SESSION]: { chatId: 100, threadId: THREAD, cwd: '/tmp/default-workspace', title: 'Quiet' } },
  threads: { [`100:${THREAD}`]: SESSION },
}

/** Send one Telegram message and let the agent answer it with `answer`. */
async function askAndAnswer(run, answer) {
  const agent = run.host.makeAgent(SESSION, '/tmp/default-workspace')
  let finish
  agent.whenIdle = () => new Promise((resolve) => { finish = resolve })
  run.telegram.push({ message_thread_id: THREAD, text: 'hello' })
  await wait(200)
  const before = run.telegram.calls.length
  const session = { id: SESSION }
  agent.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  agent.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'block-start', blockType: 'text' } } })
  agent.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: answer } } })
  await wait(100)
  agent.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  finish()
  await wait(250)
  return run.telegram.calls.slice(before).filter((call) => call.body?.message_thread_id === THREAD)
}

/** Message texts as the person reads them: Telegram's MarkdownV2 escapes removed. */
const shownTexts = (calls) => calls
  .filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText')
  .map((call) => call.body.text.replace(/\\(.)/gu, '$1').trim())

test('an answer of exactly [SILENT] posts nothing and leaves no placeholder', async () => {
  const run = await start({}, bound)
  try {
    const calls = await askAndAnswer(run, '[SILENT]')
    assert.deepEqual(shownTexts(calls).filter((text) => text.includes('SILENT') || text.includes('Done')), [])
    const sends = calls.filter((call) => call.method === 'sendMessage').length
    const deletes = calls.filter((call) => call.method === 'deleteMessage').length
    assert.ok(deletes >= sends, 'any message the turn opened is deleted again')
  } finally {
    run.stop()
  }
})

test('a trailing [SILENT] is cut and the text before it is kept', async () => {
  const run = await start({}, bound)
  try {
    const calls = await askAndAnswer(run, 'Sent the file.\n\n[SILENT]')
    const texts = shownTexts(calls)
    assert.equal(texts.at(-1), 'Sent the file.')
    assert.ok(!texts.some((text) => text.includes('SILENT')), 'the marker is never shown, not even while streaming')
  } finally {
    run.stop()
  }
})

test('an answer that only mentions [SILENT] in the middle is posted as written', async () => {
  const run = await start({}, bound)
  try {
    const calls = await askAndAnswer(run, 'Use [SILENT] to stay quiet.')
    assert.equal(shownTexts(calls).at(-1), 'Use [SILENT] to stay quiet.')
  } finally {
    run.stop()
  }
})
