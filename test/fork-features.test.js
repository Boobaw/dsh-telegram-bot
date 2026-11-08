import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import https from 'node:https'
import { STATUS_DIR } from '../src/constants.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fake Host with live agents. Agent-scoped events also reach listeners that
 * the plugin registered with `{ global: true }`, as in the real event bus.
 */
function makeHost() {
  const hostEvents = new EventEmitter()
  hostEvents.setMaxListeners(100)
  const live = new Map()
  const created = []
  const logs = []
  const cleanups = []
  let sequence = 0
  const sessionRecords = []
  const workspaces = [
    { id: 'workspace-default', path: '/tmp/default-workspace', title: 'default-workspace', sessionIds: [], attachSession() {} },
    { id: 'workspace-notes', path: '/tmp/notes', title: 'notes', sessionIds: [], attachSession() {} },
  ]

  function makeAgent(id, cwd) {
    const events = new EventEmitter()
    events.setMaxListeners(100)
    const agent = {
      id,
      session: { id, header: { cwd }, append() {} },
      ctx: { on: (name, fn) => { events.on(name, fn); return () => events.off(name, fn) } },
      status: 'idle',
      received: [],
      followup(message) { this.received.push(message) },
      whenIdle() { return wait(20) },
      cancel() {},
      /** Emit one agent-scoped event to the agent and to global listeners. */
      emit(name, ...args) {
        events.emit(name, ...args)
        hostEvents.emit(name, ...args)
      },
    }
    live.set(id, agent)
    return agent
  }

  const services = {
    credentials: { resolve: async () => ({ value: 'TEST_TOKEN' }) },
    agents: {
      get: (id) => live.get(id),
      create: async ({ sessionId, meta }) => ({ agent: makeAgent(sessionId, meta?.cwd) }),
      resume: async ({ resumeSessionId }) => ({ agent: live.get(resumeSessionId) ?? makeAgent(resumeSessionId, undefined) }),
    },
    sessionController: {
      createSession: async (options) => {
        sequence += 1
        created.push(options)
        return { agent: makeAgent(`session-${sequence}`, options.cwd) }
      },
      resume: async (id) => ({ agent: live.get(id) ?? makeAgent(id, undefined) }),
      fork: async () => ({ sessionId: 'session-fork' }),
    },
    sessionQuery: {
      listSessions: async () => sessionRecords,
      readTitleSnapshot: async () => ({ title: { title: 'Generated title' } }),
      readSurface: async () => ({ events: [] }),
      readSession: async () => ({ events: [] }),
    },
    workspaceRegistry: {
      list: () => workspaces,
      get: (id) => workspaces.find((workspace) => workspace.id === id),
      create: async () => ({ id: 'workspace-new', attachSession() {} }),
    },
    llm: { listModels: async () => [], resolveModel: async () => ({ context: { contextWindow: 1_000_000 } }) },
  }
  const ctx = {
    logger: { info(message) { logs.push(`I ${message}`) }, warn(message) { logs.push(`W ${message}`) } },
    get: (name) => services[name],
    on(name, fn) { hostEvents.on(name, fn); return () => hostEvents.off(name, fn) },
    effect(fn) { cleanups.push(fn()) },
  }
  return { ctx, live, created, logs, makeAgent, sessionRecords, cleanup: () => { for (const fn of cleanups) fn?.() } }
}

/**
 * Fake Bot API. Updates are pushed by the test; getUpdates long-polls briefly.
 */
function makeTelegram() {
  const calls = []
  const pending = []
  const missingThreads = new Set()
  let messageId = 0
  let topicId = 7000
  let updateId = 0
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
      if (method === 'createForumTopic') {
        topicId += 1
        return deliver({ ok: true, result: { message_thread_id: topicId, name: body.name } })
      }
      if (method === 'editForumTopic') {
        if (missingThreads.has(body.message_thread_id)) return deliver({ ok: false, description: 'Bad Request: message thread not found' })
        return deliver({ ok: true, result: true })
      }
      if (method === 'sendMessage' || method === 'editMessageText') {
        messageId += 1
        calls.at(-1).result = { message_id: messageId }
        return deliver({ ok: true, result: { message_id: messageId } })
      }
      return deliver({ ok: true, result: true })
    }
    return request
  }
  const pushCallback = (threadId, data, callbackMessageId) => {
    updateId += 1
    pending.push({
      update_id: updateId,
      callback_query: {
        id: `cb-${updateId}`,
        from: { id: 42 },
        data,
        message: { message_id: callbackMessageId, chat: { id: 100, type: 'private' }, message_thread_id: threadId },
      },
    })
  }
  const push = (message) => {
    updateId += 1
    messageId += 1
    pending.push({ update_id: updateId, message: { message_id: messageId, date: 1, chat: { id: 100, type: 'private' }, from: { id: 42 }, ...message } })
  }
  return { fake, calls, push, pushCallback, missingThreads }
}

/** Start the plugin against fresh fakes and an optional initial state. */
async function start(config = {}, initialState = {}, topicsFile = { chatId: 100 }) {
  await mkdir(STATUS_DIR, { recursive: true })
  await writeFile(join(STATUS_DIR, 'state.json'), JSON.stringify({ version: 2, sessions: {}, threads: {}, updateLedger: {}, updateOffset: 0, ...initialState }))
  await writeFile(join(STATUS_DIR, 'topics.json'), JSON.stringify(topicsFile))
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
    showThinking: false,
    showToolCalls: false,
    ...config,
  })
  await wait(80)
  return {
    host,
    telegram,
    readState: async () => JSON.parse(await readFile(join(STATUS_DIR, 'state.json'), 'utf8')),
    stop: () => {
      host.cleanup()
      https.request = originalRequest
    },
  }
}

/** Find the latest message whose inline keyboard has a button with this callback prefix. */
function picker(calls, prefix) {
  const found = calls.filter((call) => (call.method === 'sendMessage' || call.method === 'editMessageText')
    && (call.body.reply_markup?.inline_keyboard ?? []).flat().some((button) => String(button.callback_data).startsWith(prefix)))
  const last = found.at(-1)
  if (last === undefined) return undefined
  return {
    messageId: last.body.message_id ?? last.result?.message_id,
    buttons: last.body.reply_markup.inline_keyboard.flat(),
  }
}

const sent = (calls, threadId) => calls.filter((call) => call.method === 'sendMessage' && call.body.message_thread_id === threadId)

test('/new binds a fresh session to the same topic and keeps the old one in DSH', async () => {
  const run = await start()
  try {
    run.telegram.push({ message_thread_id: 1, text: 'hello' })
    await wait(200)
    let state = await run.readState()
    assert.equal(state.threads['100:7001'], 'session-1')
    run.telegram.push({ message_thread_id: 7001, text: '/new' })
    await wait(200)
    state = await run.readState()
    assert.equal(state.threads['100:7001'], 'session-2', 'the topic is bound to the new session')
    assert.equal(state.sessions['session-1'], undefined, 'the old session no longer claims the topic')
    assert.equal(state.sessions['session-2'].threadId, 7001)
    assert.equal(run.host.created.length, 2)
    assert.equal(run.host.created[1].cwd, '/tmp/default-workspace', '/new keeps the workspace')
    assert.equal(run.telegram.calls.filter((call) => call.method === 'createForumTopic').length, 1, '/new creates no topic')
    run.telegram.push({ message_thread_id: 7001, text: 'second' })
    await wait(150)
    assert.equal(run.host.live.get('session-2').received.at(-1).content[0].text, 'second')
    assert.equal(run.host.live.get('session-1').received.length, 1)
  } finally {
    run.stop()
  }
})

test('/new in All opens a new session topic', async () => {
  const run = await start()
  try {
    run.telegram.push({ message_thread_id: 1, text: '/new' })
    await wait(200)
    const topics = run.telegram.calls.filter((call) => call.method === 'createForumTopic')
    assert.equal(topics.length, 1)
    assert.equal(run.host.created.length, 1)
  } finally {
    run.stop()
  }
})

test('a new topic asks for a workspace, then runs the waiting message in a new session', async () => {
  const run = await start()
  try {
    run.telegram.push({ message_thread_id: 9001, text: 'first question' })
    await wait(120)
    const workspaces = picker(run.telegram.calls, 'tw:')
    assert.ok(workspaces, 'workspace picker shown')
    assert.deepEqual(workspaces.buttons.map((button) => button.callback_data), ['tw:workspace-default', 'tw:workspace-notes'])
    assert.equal(run.host.created.length, 0, 'no session before the choice')
    run.telegram.pushCallback(9001, 'tw:workspace-notes', workspaces.messageId)
    await wait(120)
    const sessions = picker(run.telegram.calls, 'tn:')
    assert.ok(sessions, 'new-or-existing picker shown')
    run.telegram.pushCallback(9001, 'tn:workspace-notes', sessions.messageId)
    await wait(200)
    assert.equal(run.host.created.length, 1)
    assert.equal(run.host.created[0].cwd, '/tmp/notes')
    const state = await run.readState()
    assert.equal(state.threads['100:9001'], 'session-1')
    assert.equal(run.host.live.get('session-1').received[0].content[0].text, 'first question')
    assert.equal(run.telegram.calls.filter((call) => call.method === 'createForumTopic').length, 0)
  } finally {
    run.stop()
  }
})

test('a topic can bind an existing session, which leaves its old topic', async () => {
  const existing = {
    'session-old': { sessionId: 'session-old', chatId: 100, threadId: 5000, title: 'Old topic', cwd: '/tmp/notes', updatedAt: 1 },
  }
  const run = await start({}, { sessions: existing, threads: { '100:5000': 'session-old' } })
  try {
    run.host.makeAgent('session-old', '/tmp/notes')
    run.host.sessionRecords.push({ header: { id: 'session-old', cwd: '/tmp/notes', createdAt: 1 }, live: true })
    run.telegram.push({ message_thread_id: 9002, text: 'continue here' })
    await wait(120)
    run.telegram.pushCallback(9002, 'tw:workspace-notes', picker(run.telegram.calls, 'tw:').messageId)
    await wait(120)
    const sessions = picker(run.telegram.calls, 'tb:')
    assert.ok(sessions.buttons.some((button) => button.callback_data === 'tb:session-old'))
    run.telegram.pushCallback(9002, 'tb:session-old', sessions.messageId)
    await wait(200)
    const state = await run.readState()
    assert.equal(state.threads['100:9002'], 'session-old')
    assert.equal(state.threads['100:5000'], undefined, 'one session is bound to one topic')
    assert.equal(state.sessions['session-old'].threadId, 9002)
    assert.equal(run.host.created.length, 0)
    assert.equal(run.host.live.get('session-old').received.at(-1).content[0].text, 'continue here')
  } finally {
    run.stop()
  }
})

test('/workspace switches the topic to a session in another workspace', async () => {
  const run = await start()
  try {
    run.telegram.push({ message_thread_id: 1, text: 'hello' })
    await wait(200)
    run.telegram.push({ message_thread_id: 7001, text: '/workspace' })
    await wait(120)
    run.telegram.pushCallback(7001, 'tw:workspace-notes', picker(run.telegram.calls, 'tw:').messageId)
    await wait(120)
    run.telegram.pushCallback(7001, 'tn:workspace-notes', picker(run.telegram.calls, 'tn:').messageId)
    await wait(200)
    const state = await run.readState()
    assert.equal(state.threads['100:7001'], 'session-2')
    assert.equal(state.sessions['session-2'].cwd, '/tmp/notes')
    assert.equal(state.sessions['session-1'], undefined)
  } finally {
    run.stop()
  }
})

test('session titles never rename the topic', async () => {
  const run = await start()
  try {
    run.telegram.push({ message_thread_id: 1, text: 'hello' })
    await wait(200)
    run.host.live.get('session-1').emit('session/event', { id: 'session-1' }, { type: 'session/title', data: { title: 'Provider title' } })
    await wait(80)
    assert.equal(run.telegram.calls.filter((call) => call.method === 'editForumTopic').length, 0)
  } finally {
    run.stop()
  }
})

/** Play one complete turn that another client started in a session. */
async function playExternalTurn(agent, turn, userMessage, answer) {
  const session = { id: agent.id }
  agent.emit('session/event', session, { type: 'turn/start', data: { turn } })
  if (userMessage !== undefined) agent.emit('session/event', session, { type: 'user/message', data: userMessage })
  agent.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'block-start', blockType: 'text' } } })
  agent.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: answer.slice(0, 4) } } })
  await wait(30)
  agent.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: answer.slice(4) } } })
  agent.emit('session/event', session, { type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } } })
  agent.emit('session/event', session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  await wait(120)
}

const texts = (calls, threadId) => [
  ...calls.filter((call) => (call.method === 'sendMessage' || call.method === 'editMessageText') && (call.body.message_thread_id === threadId)),
].map((call) => call.body.text)

test('a turn started in the Web UI appears in the bound topic', async () => {
  const run = await start()
  try {
    run.telegram.push({ message_thread_id: 1, text: 'hello' })
    await wait(200)
    const agent = run.host.live.get('session-1')
    const before = run.telegram.calls.length
    await playExternalTurn(agent, 2, { id: 'web-1', role: 'user', content: [{ type: 'text', text: 'question from web' }], source: { kind: 'user', rpcId: 'rpc-web-1' } }, 'answer for web')
    const shown = texts(run.telegram.calls.slice(before), 7001)
    assert.ok(shown.some((text) => text.includes('From Web') && text.includes('question from web')), shown.join('\n---\n'))
    assert.ok(shown.some((text) => text.includes('answer for web')), shown.join('\n---\n'))
    assert.equal(shown.filter((text) => text.includes('From Web')).length, 1, 'the prompt is shown once')
    const answerSends = run.telegram.calls.slice(before).filter((call) => call.method === 'sendMessage' && !String(call.body.text).includes('From Web'))
    assert.equal(answerSends.length, 1, 'one answer message, then edits')
  } finally {
    run.stop()
  }
})

test('messages sent from Telegram are not echoed back', async () => {
  const run = await start()
  try {
    run.telegram.push({ message_thread_id: 1, text: 'hello' })
    await wait(200)
    const agent = run.host.live.get('session-1')
    const legacyId = agent.received[0].id
    const before = run.telegram.calls.length
    agent.emit('session/event', { id: 'session-1' }, { type: 'user/message', data: { id: legacyId, role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } })
    agent.emit('session/event', { id: 'session-1' }, { type: 'user/message', data: { id: 'x', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user', rpcId: 'telegram:100:1' } } })
    agent.emit('session/event', { id: 'session-1' }, { type: 'user/message', data: { id: 'y', role: 'user', content: [{ type: 'text', text: 'now is 10:00' }], source: { kind: 'time-context' } } })
    await wait(80)
    assert.deepEqual(texts(run.telegram.calls.slice(before), 7001), [])
  } finally {
    run.stop()
  }
})

test('scheduled turns are labelled, and mirroring can be turned off', async () => {
  const run = await start()
  try {
    run.telegram.push({ message_thread_id: 1, text: 'hello' })
    await wait(200)
    const agent = run.host.live.get('session-1')
    let before = run.telegram.calls.length
    await playExternalTurn(agent, 3, { id: 's-1', role: 'user', content: [{ type: 'text', text: 'daily check' }], source: { kind: 'schedule' } }, 'all good')
    const shown = texts(run.telegram.calls.slice(before), 7001)
    assert.ok(shown.some((text) => text.includes('Scheduled task') && text.includes('daily check')))
    assert.ok(shown.some((text) => text.includes('all good')))
  } finally {
    run.stop()
  }
  const quiet = await start({ mirrorTurns: false })
  try {
    quiet.telegram.push({ message_thread_id: 1, text: 'hello' })
    await wait(200)
    const before = quiet.telegram.calls.length
    await playExternalTurn(quiet.host.live.get('session-1'), 2, { id: 'w', role: 'user', content: [{ type: 'text', text: 'web' }], source: { kind: 'user' } }, 'hidden answer')
    assert.deepEqual(texts(quiet.telegram.calls.slice(before), 7001), [])
  } finally {
    quiet.stop()
  }
})

test('a Telegram message during a Web turn waits for that turn', async () => {
  const run = await start()
  try {
    run.telegram.push({ message_thread_id: 1, text: 'hello' })
    await wait(200)
    const agent = run.host.live.get('session-1')
    agent.emit('session/event', { id: 'session-1' }, { type: 'turn/start', data: { turn: 5 } })
    run.telegram.push({ message_thread_id: 7001, text: 'queued from phone' })
    await wait(100)
    assert.equal(agent.received.length, 1, 'not sent while the Web turn runs')
    agent.emit('session/event', { id: 'session-1' }, { type: 'assistant/message', data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: 'done on web' }] } } })
    agent.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await wait(150)
    assert.equal(agent.received.at(-1).content[0].text, 'queued from phone')
  } finally {
    run.stop()
  }
})
