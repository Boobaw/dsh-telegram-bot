import './setup-home.js'
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
      listSessions: async () => [],
      readTitleSnapshot: async () => ({ title: { title: 'Generated title' } }),
      readSurface: async () => ({ events: [] }),
      readSession: async () => ({ events: [] }),
    },
    workspaceRegistry: {
      list: () => [{ id: 'workspace-default', path: '/tmp/default-workspace', title: 'default-workspace', attachSession() {} }],
      get: () => undefined,
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
  return { ctx, live, created, logs, makeAgent, cleanup: () => { for (const fn of cleanups) fn?.() } }
}

/**
 * Fake Bot API. Updates are pushed by the test; getUpdates long-polls briefly.
 */
function makeTelegram() {
  const calls = []
  const pending = []
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
      if (method === 'editForumTopic') return deliver({ ok: true, result: true })
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
  return { fake, calls, push }
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

const sent = (calls, threadId) => calls.filter((call) => call.method === 'sendMessage' && call.body.message_thread_id === threadId)

test('/new binds a fresh session to the same topic and keeps the old one in DSH', async () => {
  const run = await start()
  try {
    run.telegram.push({ message_thread_id: 1, text: 'hello' })
    await wait(200)
    let state = await run.readState()
    assert.equal(state.threads['100:7001'], 'session-1')
    run.host.live.get('session-1').emit('session/event', { id: 'session-1' }, { type: 'session/title', data: { title: 'First chat' } })
    await wait(60)
    run.telegram.push({ message_thread_id: 7001, text: '/new' })
    await wait(200)
    state = await run.readState()
    assert.equal(state.threads['100:7001'], 'session-2', 'the topic is bound to the new session')
    assert.equal(state.sessions['session-1'], undefined, 'the old session no longer claims the topic')
    assert.equal(state.sessions['session-2'].threadId, 7001)
    assert.equal(state.sessions['session-2'].title, 'First chat', 'the topic keeps its name')
    assert.equal(state.sessions['session-2'].titleLocked, true)
    assert.equal(run.host.created.length, 2)
    assert.equal(run.host.created[1].cwd, '/tmp/default-workspace')
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
