import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import https from 'node:https'
import { STATUS_DIR } from '../src/constants.js'
import { enqueue, waitForResult } from '../src/outbox.js'
import { resolveTopicTarget, topicNameOf } from '../src/topics.js'

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
      injected: [],
      inject(message) { this.injected.push(message) },
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
    attachments: {
      async saveFile({ data, name }) { return { attachmentId: `file-${name}`, name, bytes: data.length } },
      async saveImage({ data, name, mediaType }) { return { attachmentId: `image-${name}`, name, bytes: data.length, mediaType, width: 1, height: 1 } },
    },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  }
  const provided = {}
  const tools = new Map()
  const ctx = {
    provide(name, value) { provided[name] = value },
    logger: { info(message) { logs.push(`I ${message}`) }, warn(message) { logs.push(`W ${message}`) } },
    get: (name) => services[name],
    on(name, fn) { hostEvents.on(name, fn); return () => hostEvents.off(name, fn) },
    effect(fn) { cleanups.push(fn()) },
  }
  return { ctx, live, created, logs, makeAgent, sessionRecords, provided, tools, cleanup: () => { for (const fn of cleanups) fn?.() } }
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
      let body
      try {
        body = value.length > 0 ? JSON.parse(String(value)) : undefined
      } catch {
        // A multipart upload; keep the raw form fields for assertions.
        const raw = Buffer.from(value).toString('latin1')
        body = { raw, message_thread_id: Number(/name="message_thread_id"\r\n\r\n(\d+)/u.exec(raw)?.[1]) }
      }
      if (String(options.path).includes('/file/')) {
        setTimeout(() => {
          response.emit('data', Buffer.from('file-data'))
          response.emit('end')
          request.emit('close')
        }, 0)
        return
      }
      if (method === 'getMe') return deliver({ ok: true, result: { id: 1, username: 'testbot' } })
      if (method === 'getFile') {
        calls.push({ method, body })
        return deliver({ ok: true, result: { file_path: `files/${body.file_id}.jpg`, file_size: 9 } })
      }
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
      if (method === 'sendDocument' || method === 'sendPhoto') {
        messageId += 1
        return deliver({ ok: true, result: { message_id: messageId } })
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


test('topic targets resolve by name without case, or by thread id', () => {
  const names = { '100:7001': 'Notify', '100:7002': 'chat', '100:7003': 'Chat', '200:9': 'notify' }
  assert.deepEqual(resolveTopicTarget(names, 100, 'NOTIFY'), { threadId: 7001, name: 'Notify' })
  assert.deepEqual(resolveTopicTarget(names, 100, '7002'), { threadId: 7002, name: 'chat' })
  assert.deepEqual(resolveTopicTarget(names, 100, 4242), { threadId: 4242, name: undefined })
  assert.throws(() => resolveTopicTarget(names, 100, 'chat'), /Several topics are named "chat" \(thread ids 7002, 7003\)/)
  assert.throws(() => resolveTopicTarget(names, 100, 'missing'), /Unknown Telegram topic "missing"/)
  assert.equal(topicNameOf({ forum_topic_edited: { name: 'Alerts' } }).name, 'Alerts')
  assert.equal(topicNameOf({ reply_to_message: { forum_topic_created: { name: 'Old' } } }).authoritative, false)
})

/** State with one topic named "Notify" bound to session-notify. */
const notifyState = {
  sessions: { 'session-notify': { sessionId: 'session-notify', chatId: 100, threadId: 7100, title: 'Notify', cwd: '/tmp/default-workspace', updatedAt: 1 } },
  threads: { '100:7100': 'session-notify' },
}

test('the Host service posts into a named topic and records it in the bound session', async () => {
  const run = await start({}, notifyState)
  try {
    const agent = run.host.makeAgent('session-notify', '/tmp/default-workspace')
    const file = join(STATUS_DIR, 'report.txt')
    await writeFile(file, 'report body')
    const result = await run.host.provided.telegramTopics.send('notify', 'Backup **done**', [file], { from: { label: 'backup job' } })
    assert.equal(result.threadId, 7100)
    assert.equal(result.recorded, true)
    assert.ok(sent(run.telegram.calls, 7100).some((call) => call.body.text.includes('Backup')))
    assert.equal(run.telegram.calls.filter((call) => call.method === 'sendDocument' && call.body.message_thread_id === 7100).length, 1)
    assert.equal(agent.received.length, 0, 'no turn is started')
    assert.equal(agent.injected.length, 1)
    const content = agent.injected[0].content
    assert.match(content[0].text, /^\[Sent to the Telegram topic "Notify" by backup job\]\nBackup \*\*done\*\*/)
    assert.equal(content[1].type, 'file')
    assert.match(agent.injected[0].source.rpcId, /^telegram-post:/)
    await assert.rejects(run.host.provided.telegramTopics.send('nope', 'x'), /Unknown Telegram topic "nope"/)
  } finally {
    run.stop()
  }
})

test('a renamed topic is found by its new name and keeps its target after /new', async () => {
  const run = await start({}, notifyState)
  try {
    run.host.makeAgent('session-notify', '/tmp/default-workspace')
    run.telegram.push({ message_thread_id: 7100, forum_topic_edited: { name: 'Alerts' } })
    await wait(100)
    await assert.rejects(run.host.provided.telegramTopics.send('notify', 'x'), /Unknown Telegram topic/)
    run.telegram.push({ message_thread_id: 7100, text: '/new' })
    await wait(200)
    const result = await run.host.provided.telegramTopics.send('ALERTS', 'after new')
    assert.equal(result.threadId, 7100)
    assert.equal(result.sessionId, 'session-1')
    assert.equal(run.host.live.get('session-1').injected.length, 1)
  } finally {
    run.stop()
  }
})

test('the agent tool and the file spool use the same path', async () => {
  const run = await start({}, notifyState)
  try {
    const agent = run.host.makeAgent('session-notify', '/tmp/default-workspace')
    const tool = run.host.tools.get('telegram_send')
    assert.ok(tool, 'tool registered')
    const own = await tool.execute({ topic: 'Notify', text: 'from my own session' }, { agent: { id: 'session-notify' } })
    assert.equal(own.recorded, false, 'the sending session gets no copy of its own message')
    const other = await tool.execute({ topic: 'Notify', text: 'from elsewhere' }, { agent: { id: 'session-other' } })
    assert.equal(other.recorded, true)
    const id = await enqueue({ topic: 'notify', text: 'from cron', from: { label: 'cron' } })
    const result = await waitForResult(id, 3000)
    assert.equal(result?.ok, true, JSON.stringify(result))
    assert.equal(result.result.threadId, 7100)
    const bad = await waitForResult(await enqueue({ topic: 'missing', text: 'x' }), 3000)
    assert.equal(bad.ok, false)
    assert.match(bad.error, /Unknown Telegram topic/)
    assert.equal(agent.injected.length, 2)
  } finally {
    run.stop()
  }
})

/** Open topic 7001 bound to session-1 and wait for its first turn to end. */
async function openSessionTopic(run) {
  run.telegram.push({ message_thread_id: 1, text: 'hello' })
  await wait(250)
  return run.host.live.get('session-1')
}

const promptText = (message) => message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')

test('a reply carries the replied-to text, its author and its photo', async () => {
  const run = await start()
  try {
    const agent = await openSessionTopic(run)
    run.telegram.push({
      message_thread_id: 7001,
      is_topic_message: true,
      text: 'what does this show?',
      reply_to_message: {
        message_id: 500,
        date: 1_762_600_000,
        chat: { id: 100, type: 'private' },
        from: { id: 1, is_bot: true, first_name: 'testbot' },
        message_thread_id: 7001,
        caption: 'Weekly chart',
        photo: [{ file_id: 'small', file_size: 5 }, { file_id: 'large', file_size: 9 }],
      },
    })
    await wait(250)
    const last = agent.received.at(-1)
    const text = promptText(last)
    assert.match(text, /^\[Replying to a message from the assistant \(this bot\) \(sent 2025-11-08 11:06 UTC; contains a photo, attached\)\]\n> Weekly chart\n\nwhat does this show\?$/u)
    assert.equal(last.content.filter((block) => block.type === 'image').length, 1)
    assert.ok(run.telegram.calls.some((call) => call.method === 'getFile' && call.body.file_id === 'large'))
  } finally {
    run.stop()
  }
})

test('a partial quote replaces the full text, and the topic root is not a reply', async () => {
  const run = await start()
  try {
    const agent = await openSessionTopic(run)
    run.telegram.push({
      message_thread_id: 7001,
      is_topic_message: true,
      text: 'plain message',
      reply_to_message: { message_id: 7001, date: 1, chat: { id: 100 }, forum_topic_created: { name: 'hello' } },
    })
    await wait(250)
    assert.equal(promptText(agent.received.at(-1)), 'plain message')
    run.telegram.push({
      message_thread_id: 7001,
      is_topic_message: true,
      text: 'is this right?',
      quote: { text: 'the second step', position: 10 },
      reply_to_message: {
        message_id: 501,
        date: 1_762_600_000,
        chat: { id: 100 },
        from: { id: 77, first_name: 'Sam', username: 'sam' },
        text: 'the first step, the second step, the third step',
      },
    })
    await wait(250)
    const text = promptText(agent.received.at(-1))
    assert.match(text, /^\[Replying to a message from Sam \(@sam\) \(sent [^)]+\); the user quoted only this part\]\n> the second step\n\nis this right\?$/u)
    assert.doesNotMatch(text, /third step/u)
  } finally {
    run.stop()
  }
})

test('a reply to a mirrored Web prompt is not shown as an assistant message', async () => {
  const run = await start()
  try {
    const agent = await openSessionTopic(run)
    run.telegram.push({
      message_thread_id: 7001,
      text: 'and this one too',
      reply_to_message: { message_id: 502, date: 1, chat: { id: 100 }, from: { id: 1, is_bot: true }, text: '🖥 From Web:\nsummarize the logs' },
    })
    await wait(250)
    assert.match(promptText(agent.received.at(-1)), /^\[Replying to a message from the Web UI \(a user prompt this bot mirrored into the chat, not an assistant answer\)/u)
  } finally {
    run.stop()
  }
})

test('several forwarded messages become one prompt and never run as commands', async () => {
  const run = await start()
  try {
    const agent = await openSessionTopic(run)
    const before = agent.received.length
    run.telegram.push({
      message_thread_id: 7001,
      text: 'Release notes are out',
      forward_origin: { type: 'channel', chat: { id: -1001234, title: 'Project News', username: 'projnews', type: 'channel' }, message_id: 88, date: 1_762_000_000 },
    })
    run.telegram.push({
      message_thread_id: 7001,
      text: '/new',
      forward_origin: { type: 'user', sender_user: { id: 77, first_name: 'Sam' }, date: 1_762_000_100 },
    })
    run.telegram.push({
      message_thread_id: 7001,
      video: { file_id: 'v1' },
      caption: 'clip',
      forward_origin: { type: 'hidden_user', sender_user_name: 'Alex', date: 1_762_000_200 },
    })
    await wait(1800)
    assert.equal(agent.received.length, before + 1, 'one prompt for the whole batch')
    const text = promptText(agent.received.at(-1))
    assert.match(text, /\[Forwarded message from channel "Project News" \(@projnews\) \(originally sent [^;]+; https:\/\/t\.me\/projnews\/88\)\]\n> Release notes are out/u)
    assert.match(text, /\[Forwarded message from Sam \(originally sent [^)]+\)\]\n> \/new/u)
    assert.match(text, /\[Forwarded message from Alex \(account hidden\) \(originally sent [^;]+; contains a video, not attached\)\]\n> clip/u)
    assert.equal(run.host.created.length, 1, 'a forwarded /new is not a command')
  } finally {
    run.stop()
  }
})
