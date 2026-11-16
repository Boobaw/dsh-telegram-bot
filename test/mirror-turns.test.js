import './setup-home.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { start, sent, wait } from './fakes.js'

const THREAD = 7001
const SESSION = 'session-web'
const bound = {
  sessions: { [SESSION]: { chatId: 100, threadId: THREAD, cwd: '/tmp/default-workspace', title: 'Shared' } },
  threads: { [`100:${THREAD}`]: SESSION },
}

/** Play one turn on a live agent, the way DSH reports it. */
function playTurn(agent, turn, source, prompt, answer) {
  agent.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn } })
  agent.emit('session/event', { id: agent.id }, { type: 'user/message', data: { id: `m-${turn}`, role: 'user', content: [{ type: 'text', text: prompt }], source } })
  agent.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'block-start', blockType: 'text' } } })
  agent.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: answer } } })
  agent.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

/** Every text the bot sent or wrote into the topic. */
const topicTexts = (calls) => calls
  .filter((call) => (call.method === 'sendMessage' || call.method === 'editMessageText') && call.body.message_thread_id === THREAD)
  .map((call) => call.body.text.trim())

test('turns started outside Telegram stay out of the topic by default', async () => {
  const run = await start({}, bound)
  try {
    const agent = run.host.makeAgent(SESSION, '/tmp/default-workspace')
    const before = run.telegram.calls.length
    playTurn(agent, 1, { kind: 'user', rpcId: 'web-1' }, 'hello from the web', 'web answer')
    playTurn(agent, 2, { kind: 'schedule' }, 'nightly check', 'all good')
    await wait(150)
    assert.deepEqual(run.telegram.calls.slice(before).filter((call) => call.body?.message_thread_id === THREAD), [])
  } finally {
    run.stop()
  }
})

test('mirrorTurns shows a Web turn in its topic: the prompt, then the answer once', async () => {
  const run = await start({ mirrorTurns: true }, bound)
  try {
    run.telegram.push({ message_thread_id: THREAD, text: 'first from telegram' })
    await wait(200)
    const agent = run.host.live.get(SESSION)
    assert.ok(agent !== undefined, 'the Telegram message resumed the session, so per-agent listeners are attached too')
    const before = run.telegram.calls.length
    playTurn(agent, 4, { kind: 'user', rpcId: 'web-4' }, 'hello from the web', 'web answer')
    await wait(200)
    const texts = topicTexts(run.telegram.calls.slice(before))
    assert.equal(texts[0], '🖥 From Web:\nhello from the web')
    assert.equal(texts[1], '⏳ Generating…')
    assert.equal(texts.at(-1), 'web answer', 'one stream, not doubled by the per-agent listener')
    const sends = sent(run.telegram.calls.slice(before), THREAD)
    assert.equal(sends.length, 2, 'the prompt and one answer message')
    assert.equal(agent.received.length, 1, 'nothing is sent to the session')
  } finally {
    run.stop()
  }
})

test('mirrorTurns shows scheduled turns with their own label', async () => {
  const run = await start({ mirrorTurns: true }, bound)
  try {
    const agent = run.host.makeAgent(SESSION, '/tmp/default-workspace')
    const before = run.telegram.calls.length
    playTurn(agent, 1, { kind: 'schedule' }, 'nightly check', 'all good')
    await wait(200)
    const texts = topicTexts(run.telegram.calls.slice(before))
    assert.equal(texts[0], '⏰ Scheduled task:\nnightly check')
    assert.equal(texts.at(-1), 'all good')
  } finally {
    run.stop()
  }
})

test('mirrorTurns does not echo turns that came from Telegram', async () => {
  const run = await start({ mirrorTurns: true }, bound)
  try {
    const agent = run.host.makeAgent(SESSION, '/tmp/default-workspace')
    let idle
    agent.whenIdle = () => new Promise((resolve) => { idle = resolve })
    run.telegram.push({ message_thread_id: THREAD, text: 'from telegram' })
    await wait(200)
    const before = run.telegram.calls.length
    // The Telegram turn as DSH reports it, while the bridge is waiting on it.
    playTurn(agent, 1, { kind: 'user', principal: { kind: 'telegram-user', id: '42' } }, 'from telegram', 'telegram answer')
    await wait(200)
    idle?.()
    // A Telegram prompt admitted through the session queue, seen while the topic is idle.
    playTurn(agent, 2, { kind: 'user', rpcId: 'telegram:100:99' }, 'queued from telegram', 'second answer')
    await wait(150)
    const texts = topicTexts(run.telegram.calls.slice(before))
    assert.ok(!texts.some((text) => text.includes('From Web')), 'no Telegram prompt is echoed back')
    assert.equal(texts.filter((text) => text === 'telegram answer').length, 1, 'the Telegram answer is written once')
    assert.ok(!texts.includes('second answer'), 'a Telegram-admitted turn is not adopted by the mirror')
    assert.equal(sent(run.telegram.calls.slice(before), THREAD).length, 0, 'no extra messages beyond the Telegram turn')
  } finally {
    run.stop()
  }
})
