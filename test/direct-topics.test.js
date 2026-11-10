import './setup-home.js'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import https from 'node:https'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One fake DSH agent that can receive prompts and emit stream events. */
function makeAgent(id, cwd) {
  const events = new EventEmitter()
  return {
    id,
    session: { id, header: { cwd }, append() {} },
    ctx: { on: (name, fn) => { events.on(name, fn); return () => events.off(name, fn) } },
    status: 'idle',
    received: [],
    followup(message) { this.received.push(message) },
    whenIdle() { return new Promise((resolve) => setTimeout(resolve, 5000)) },
    cancel() {},
    emit(name, ...args) { events.emit(name, ...args) },
  }
}

/** Fake Host with the seams the Telegram bridge reads. */
function makeHost() {
  const cleanups = []
  const logs = []
  const live = new Map()
  const agent = makeAgent('session-1', '/tmp/default-workspace')
  live.set(agent.id, agent)
  const services = {
    credentials: { resolve: async () => ({ value: 'TEST_TOKEN' }) },
    agents: {
      get: (id) => live.get(id),
      create: async ({ sessionId, meta }) => {
        const created = makeAgent(sessionId, meta?.cwd)
        live.set(created.id, created)
        return { agent: created }
      },
      resume: async ({ resumeSessionId }) => ({ agent: live.get(resumeSessionId) ?? agent }),
    },
    sessionController: {
      createSession: async () => ({ agent }),
      resume: async () => ({ agent }),
      fork: async () => ({ sessionId: 'session-fork' }),
    },
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshot: async () => ({ title: { title: 'Generated title' } }),
      readSurface: async () => ({ events: [] }),
      readSession: async () => ({ events: [] }),
    },
    workspaceRegistry: {
      list: () => [{ id: 'workspace-default', path: '/tmp/default-workspace', title: 'default-workspace', attachSession() {} }],
      get: () => undefined,
      create: async () => ({ id: 'workspace-default', attachSession() {} }),
    },
    llm: { listModels: async () => [], resolveModel: async () => ({ context: { contextWindow: 1_000_000 } }) },
  }
  const ctx = {
    logger: { info(message) { logs.push(`I ${message}`) }, warn(message) { logs.push(`W ${message}`) } },
    get: (name) => services[name],
    on() {},
    effect(fn) { cleanups.push(fn()) },
  }
  return { ctx, live, logs, cleanup: () => { for (const fn of cleanups) fn?.() } }
}

/**
 * Fake Bot API. Direct-message-topic responses intentionally omit thread
 * fields, matching Bot API 10's private-chat behavior.
 */
function makeTelegram() {
  const calls = []
  const pending = []
  let messageId = 0
  let topicId = 7000
  let updateId = 0
  let rejectNextThread = false
  const fake = (options, callback) => {
    const method = String(options.path).split('/').pop()
    const request = new EventEmitter()
    const response = new EventEmitter()
    response.setEncoding = () => {}
    response.statusCode = 200
    request.destroy = (error) => request.emit('error', error ?? new Error('destroyed'))
    request.on = (name, fn) => EventEmitter.prototype.on.call(request, name, fn)
    process.nextTick(() => callback(response))
    const deliver = (payload, delay = 0) => {
      setTimeout(() => {
        response.emit('data', JSON.stringify(payload))
        response.emit('end')
        request.emit('close')
      }, delay)
    }
    request.end = (value = '') => {
      const body = value.length > 0 ? JSON.parse(value) : undefined
      if (method === 'getMe') return deliver({ ok: true, result: { id: 1, username: 'testbot' } })
      if (method === 'getUpdates') return deliver({ ok: true, result: pending.splice(0) }, 15)
      calls.push({ method, body })
      if (rejectNextThread && method === 'sendMessage' && typeof body?.message_thread_id === 'number') {
        rejectNextThread = false
        return deliver({ ok: false, description: 'Bad Request: message thread not found' })
      }
      if (method === 'createForumTopic') {
        topicId += 1
        return deliver({ ok: true, result: { message_thread_id: topicId, name: body.name } })
      }
      if (method === 'sendMessage' || method === 'editMessageText') {
        messageId += 1
        return deliver({ ok: true, result: { message_id: messageId } })
      }
      return deliver({ ok: true, result: true })
    }
    return request
  }
  const push = (message) => {
    updateId += 1
    messageId += 1
    pending.push({ update_id: updateId, message: { message_id: messageId, date: 1, chat: { id: 100, type: 'private' }, from: { id: 42 }, ...message } })
  }
  const pushCallback = (data) => {
    updateId += 1
    pending.push({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        from: { id: 42 },
        data,
        message: { message_id: 100, date: 1, chat: { id: 100, type: 'private' } },
      },
    })
  }
  return {
    fake,
    calls,
    push,
    pushCallback,
    rejectNextThread() { rejectNextThread = true },
  }
}

test('private-chat topics send with message_thread_id and edit by message id', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-telegram-direct-'))
  process.env.DSH_HOME = home
  // Import after DSH_HOME is set so STATUS_DIR points at this test's home.
  const { STATUS_DIR } = await import('../src/constants.js')
  await mkdir(STATUS_DIR, { recursive: true })
  await writeFile(join(STATUS_DIR, 'state.json'), JSON.stringify({
    version: 2,
    sessions: {},
    threads: {},
    updateLedger: {},
    updateOffset: 0,
    // Older versions cached a service-message id here; it must be dropped.
    directChats: { 100: true },
    directTopics: { '100:7001': 2597 },
  }))
  await writeFile(join(STATUS_DIR, 'topics.json'), JSON.stringify({ chatId: 100 }))
  const host = makeHost()
  const telegram = makeTelegram()
  const originalRequest = https.request
  https.request = telegram.fake
  const { apply } = await import('../src/index.js')
  apply(host.ctx, {
    enabled: true,
    tokenRef: 'TEST_TOKEN',
    allowedUsers: ['42'],
    allowedChats: ['100'],
    cwd: '/tmp/default-workspace',
    language: 'en',
    showThinking: true,
    showToolCalls: true,
  })
  const readState = async () => JSON.parse(await readFile(join(STATUS_DIR, 'state.json'), 'utf8'))
  try {
    await wait(150)
    const loaded = await readState()
    assert.equal(loaded.directTopics['100:7001'], undefined, 'stale private direct-topic ids are dropped on load')
    telegram.push({ message_thread_id: 1, text: 'hello' })
    await wait(300)
    const agent = host.live.get('session-1')
    assert.ok(agent !== undefined, 'the first message creates a session')
    assert.equal(agent.received.length, 1)

    // Finish the first turn so the next prompt is not queued.
    agent.emit('session/event', { id: 'session-1' }, { type: 'turn/start', data: { turn: 't0' } })
    agent.emit('agent/assistant-stream', { frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'ready' } } })
    agent.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: { turn: 't0' } })
    await wait(250)

    // Everything sent into the new private-chat topic uses the direct field.
    const createdTopicSends = telegram.calls.filter((call) =>
      call.method === 'sendMessage' && (
        call.body?.direct_messages_topic_id === 7001 || call.body?.message_thread_id === 7001
      ))
    assert.ok(createdTopicSends.length >= 2, 'topic setup and menu are sent into the topic')
    for (const call of createdTopicSends) {
      assert.equal(call.body.message_thread_id, 7001)
      assert.equal(call.body.direct_messages_topic_id, undefined, 'the direct field is only a fallback')
    }

    // A normal topic update has the thread id and no direct-topic field.
    telegram.push({ message_thread_id: 7001, text: '/id' })
    await wait(250)
    const state = await readState()
    assert.equal(state.directTopics['100:7001'], undefined)
    const idReply = telegram.calls.filter((call) =>
      call.method === 'sendMessage' && typeof call.body?.text === 'string' && call.body.text.includes('Topic:')).at(-1)
    assert.ok(idReply !== undefined, '/id replies in the topic')
    assert.equal(idReply.body.message_thread_id, 7001, 'the reply stays in the topic thread')
    assert.equal(idReply.body.direct_messages_topic_id, undefined)

    // The same topic keeps one session and one topic.
    telegram.push({ message_thread_id: 7001, text: 'stream me' })
    await wait(200)
    assert.equal(agent.received.length, 2)
    assert.equal(telegram.calls.filter((call) => call.method === 'createForumTopic').length, 1, 'no duplicate topic')
    const afterMessage = await readState()
    assert.equal(afterMessage.threads['100:7001'], 'session-1')
    agent.emit('session/event', { id: 'session-1' }, { type: 'turn/start', data: { turn: 't1' } })
    agent.emit('agent/assistant-stream', { frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Hello' } } })
    await wait(450)
    const edits = telegram.calls.filter((call) => call.method === 'editMessageText')
    assert.ok(edits.length >= 1, 'the stream is edited into the placeholder')
    for (const call of edits) {
      assert.equal(call.body.message_thread_id, 7001, 'edits stay in the topic thread')
      assert.equal(call.body.direct_messages_topic_id, undefined, 'edits do not use the direct send field')
    }
    agent.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: { turn: 't1' } })
    await wait(300)

    // Autonomous goal rounds must be mirrored into the topic too.
    agent.emit('session/event', { id: 'session-1' }, { type: 'turn/start', data: { turn: 'g1' } })
    agent.emit('session/event', { id: 'session-1' }, {
      type: 'user/message',
      data: {
        source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 },
        content: [{ type: 'text', text: '<goal_round>' }],
        role: 'user',
      },
    })
    agent.emit('agent/assistant-stream', {
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Thinking about the goal' } },
    })
    agent.emit('agent/assistant-stream', {
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Goal answer' } },
    })
    agent.emit('agent/assistant-stream', {
      frame: {
        type: 'chunk',
        chunk: { type: 'block-end', block: { type: 'tool-call', id: 'tool-1', name: 'bash', arguments: '{"command":"pwd"}' } },
      },
    })
    await wait(600)
    agent.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: { turn: 'g1', reason: { kind: 'completed' } } })
    await wait(350)
    const goalPlaceholder = telegram.calls.filter((call) =>
      call.method === 'sendMessage' && typeof call.body?.text === 'string' && call.body.text.includes('Generating')).at(-1)
    assert.ok(goalPlaceholder !== undefined, 'goal round shows the generating placeholder')
    assert.equal(goalPlaceholder.body.message_thread_id, 7001)
    assert.ok(
      telegram.calls.some((call) => (call.method === 'sendMessage' || call.method === 'editMessageText')
        && typeof call.body?.text === 'string' && call.body.text.includes('Goal answer')),
      'goal round answer is mirrored into the topic',
    )
    assert.ok(
      telegram.calls.some((call) => (call.method === 'sendMessage' || call.method === 'editMessageText')
        && typeof call.body?.text === 'string' && call.body.text.includes('bash')),
      'goal round tool call is mirrored into the topic',
    )

    // A second autonomous round must be adopted again after the first one.
    agent.emit('session/event', { id: 'session-1' }, { type: 'turn/start', data: { turn: 'g2' } })
    agent.emit('session/event', { id: 'session-1' }, {
      type: 'user/message',
      data: {
        source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 2 },
        content: [{ type: 'text', text: '<goal_round>' }],
        role: 'user',
      },
    })
    agent.emit('agent/assistant-stream', {
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Goal answer 2' } },
    })
    await wait(450)
    agent.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: { turn: 'g2', reason: { kind: 'completed' } } })
    await wait(350)
    assert.ok(
      telegram.calls.some((call) => (call.method === 'sendMessage' || call.method === 'editMessageText')
        && typeof call.body?.text === 'string' && call.body.text.includes('Goal answer 2')),
      'the second goal round is mirrored too',
    )

    // If Telegram rejects message_thread_id, the send retries with the direct
    // Bot API 10 field instead of losing the answer.
    telegram.rejectNextThread()
    telegram.push({ message_thread_id: 7001, text: '/ping' })
    await wait(250)
    const pong = telegram.calls.filter((call) =>
      call.method === 'sendMessage' && call.body?.text === 'pong').at(-1)
    assert.ok(pong !== undefined, 'pong is sent')
    assert.equal(pong.body.direct_messages_topic_id, 7001, 'the rejected thread id is retried as a direct id')
    assert.equal(pong.body.message_thread_id, undefined)

    // Continue from All must create a fresh topic: Telegram can keep echoing a
    // deleted topic's thread id, so reusing the stored binding is unsafe.
    telegram.pushCallback('c:session-1')
    await wait(600)
    assert.equal(telegram.calls.filter((call) => call.method === 'createForumTopic').length, 2, 'Continue creates a new topic')
    const reopened = await readState()
    assert.equal(reopened.threads['100:7002'], 'session-1')
    assert.equal(reopened.threads['100:7001'], undefined, 'the old topic binding is replaced')
  } finally {
    host.cleanup()
    https.request = originalRequest
    await rm(home, { recursive: true, force: true })
  }
})
