import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import https from 'node:https'
import { STATUS_DIR } from '../src/constants.js'
import { followupThroughGate, makeTitleService } from './fake-dsh.js'
import { senderLabel } from '../src/message-context.js'
import { enqueue, waitForResult } from '../src/outbox.js'
import { isAutoCommandTopic, isTopicGone, resolveThreadTarget, topicNameOf } from '../src/topics.js'

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
      followup(message) { followupThroughGate(this, events, message) },
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
    sessionTitle: makeTitleService(),
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
  /** Thread id -> Bot API error for every call into that topic. */
  const goneThreads = new Map()
  const undeletable = new Set()
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
      if (goneThreads.has(body?.message_thread_id)) return deliver({ ok: false, description: goneThreads.get(body.message_thread_id) })
      if (method === 'createForumTopic') {
        topicId += 1
        return deliver({ ok: true, result: { message_thread_id: topicId, name: body.name } })
      }
      if (method === 'editForumTopic') {
        if (missingThreads.has(body.message_thread_id)) return deliver({ ok: false, description: 'Bad Request: message thread not found' })
        return deliver({ ok: true, result: true })
      }
      if (method === 'deleteForumTopic' && undeletable.has(body.message_thread_id)) {
        return deliver({ ok: false, description: 'Bad Request: not enough rights to delete the topic' })
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
  return { fake, calls, push, pushCallback, missingThreads, goneThreads, undeletable }
}

/** Start the plugin against fresh fakes and an optional initial state. */
async function start(config = {}, initialState = {}, topicsFile = { chatId: 100 }) {
  await mkdir(STATUS_DIR, { recursive: true })
  // Message ids restart with every fake bot; old sends must not match them.
  await rm(join(STATUS_DIR, 'sent-messages.json'), { force: true })
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

const SENDER = '[Telegram message from user id 42]\n'
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
    assert.equal(run.host.live.get('session-2').received.at(-1).content[0].text, '[Telegram message from user id 42]\nsecond')
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
    assert.equal(run.host.live.get('session-1').received[0].content[0].text, '[Telegram message from user id 42]\nfirst question')
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
    assert.equal(run.host.live.get('session-old').received.at(-1).content[0].text, '[Telegram message from user id 42]\ncontinue here')
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
    assert.equal(agent.received.at(-1).content[0].text, '[Telegram message from user id 42]\nqueued from phone')
  } finally {
    run.stop()
  }
})


test('send targets are thread ids the bot knows; names are not addresses', () => {
  const known = new Set([7001, 7002])
  assert.equal(resolveThreadTarget(known, '7002'), 7002)
  assert.equal(resolveThreadTarget(known, 7001), 7001)
  assert.throws(() => resolveThreadTarget(known, 'Notify'), /"Notify" is not a Telegram thread id/)
  assert.throws(() => resolveThreadTarget(known, 4242), /Unknown thread id 4242/)
  assert.throws(() => resolveThreadTarget(known, ' '), /thread id is required/)
  assert.equal(topicNameOf({ forum_topic_edited: { name: 'Alerts' } }).name, 'Alerts')
  assert.equal(topicNameOf({ reply_to_message: { forum_topic_created: { name: 'Old' } } }).authoritative, false)
  assert.equal(isTopicGone('Bad Request: message thread not found'), true)
  assert.equal(isTopicGone('Bad Request: TOPIC_ID_INVALID'), true)
  assert.equal(isTopicGone('Bad Request: TOPIC_DELETED'), true)
  assert.equal(isTopicGone('Bad Request: TOPIC_CLOSED'), false, 'a closed topic can be reopened')
})

/** State with one topic named "Notify" bound to session-notify. */
const notifyState = {
  sessions: { 'session-notify': { sessionId: 'session-notify', chatId: 100, threadId: 7100, title: 'Notify', cwd: '/tmp/default-workspace', updatedAt: 1 } },
  threads: { '100:7100': 'session-notify' },
}

test('the Host service posts into a topic by thread id and records it in the bound session', async () => {
  const run = await start({}, notifyState)
  try {
    const agent = run.host.makeAgent('session-notify', '/tmp/default-workspace')
    const file = join(STATUS_DIR, 'report.txt')
    await writeFile(file, 'report body')
    const result = await run.host.provided.telegramTopics.send({ to: 7100, text: 'Backup **done**', files: [file], from: { label: 'backup job' } })
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
    await assert.rejects(run.host.provided.telegramTopics.send({ to: 4242, text: 'x' }), (error) => /Unknown thread id 4242/.test(error.message) && error.retryable === false)
    await assert.rejects(run.host.provided.telegramTopics.send({ to: 'notify', text: 'x' }), (error) => /not a Telegram thread id/.test(error.message) && error.retryable === false)
    await assert.rejects(run.host.provided.telegramTopics.send({ to: 7100, text: 'x', files: [join(STATUS_DIR, 'missing.txt')] }), (error) => error.retryable === false)
    await assert.rejects(run.host.provided.telegramTopics.send({ to: 7100, text: ' ' }), (error) => /Nothing to send/.test(error.message) && error.retryable === false)
  } finally {
    run.stop()
  }
})

test('send({ to, text, files, from }) takes a thread id and names the job and its session as the sender', async () => {
  const run = await start({}, notifyState)
  try {
    const agent = run.host.makeAgent('session-notify', '/tmp/default-workspace')
    const result = await run.host.provided.telegramTopics.send({ to: '7100', text: 'Nothing new today', files: [], from: { job: 'Check-in', sessionId: 'session-job' } })
    assert.equal(result.threadId, 7100)
    assert.equal(result.recorded, true)
    assert.match(agent.injected[0].content[0].text, /^\[Sent to the Telegram topic "Notify" by job "Check-in" from session session-job\]\nNothing new today$/u)
  } finally {
    run.stop()
  }
})

test('a renamed topic keeps its thread id after /new, and the name only labels it', async () => {
  const run = await start({}, notifyState)
  try {
    run.host.makeAgent('session-notify', '/tmp/default-workspace')
    run.telegram.push({ message_thread_id: 7100, forum_topic_edited: { name: 'Alerts' } })
    await wait(100)
    run.telegram.push({ message_thread_id: 7100, text: '/new' })
    await wait(200)
    const result = await run.host.provided.telegramTopics.send({ to: '7100', text: 'after new' })
    assert.equal(result.threadId, 7100)
    assert.equal(result.sessionId, 'session-1')
    assert.match(run.host.live.get('session-1').injected[0].content[0].text, /^\[Sent to the Telegram topic "Alerts"\]/u)
    assert.deepEqual(run.host.provided.telegramTopics.topics(), [{ threadId: 7100, name: 'Alerts', sessionId: 'session-1' }])
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
    const own = await tool.execute({ thread: '7100', text: 'from my own session' }, { agent: { id: 'session-notify' } })
    assert.equal(own.recorded, false, 'the sending session gets no copy of its own message')
    const other = await tool.execute({ thread: '7100', text: 'from elsewhere' }, { agent: { id: 'session-other' } })
    assert.equal(other.recorded, true)
    const id = await enqueue({ to: '7100', text: 'from cron', from: { label: 'cron' } })
    const result = await waitForResult(id, 3000)
    assert.equal(result?.ok, true, JSON.stringify(result))
    assert.equal(result.result.threadId, 7100)
    const bad = await waitForResult(await enqueue({ to: '4242', text: 'x' }), 3000)
    assert.equal(bad.ok, false)
    assert.match(bad.error, /Unknown thread id 4242/)
    assert.equal(agent.injected.length, 2)
  } finally {
    run.stop()
  }
})

test('a long send from a job is recorded with its sender, and a reply after /new gets it in full', async () => {
  const run = await start({}, notifyState)
  try {
    const old = run.host.makeAgent('session-notify', '/tmp/default-workspace')
    const long = Array.from({ length: 900 }, (_, index) => `word${index}`).join(' ')
    const id = await enqueue({ to: '7100', text: long, from: { job: 'Morning digest', sessionId: 'session-cron' } })
    const result = (await waitForResult(id, 3000)).result
    assert.ok(result.messageIds.length >= 2, 'split into several messages')
    assert.equal(result.recorded, true)
    assert.equal(old.received.length, 0, 'no turn is started')
    assert.match(old.injected[0].content[0].text, /^\[Sent to the Telegram topic "Notify" by job "Morning digest" from session session-cron\]\nword0 /u)
    run.telegram.push({ message_thread_id: 7100, text: '/new' })
    await wait(200)
    const fresh = run.host.live.get('session-1')
    run.telegram.push({
      message_thread_id: 7100,
      is_topic_message: true,
      text: 'thanks',
      reply_to_message: { message_id: result.messageIds.at(-1), date: 1, chat: { id: 100 }, from: { id: 1, is_bot: true, first_name: 'testbot' }, message_thread_id: 7100, text: 'word899' },
    })
    await wait(250)
    const text = promptText(fresh.received.at(-1))
    assert.match(text, /\[The replied-to message was posted by the bot on behalf of another sender \(sent [^;]+; by job "Morning digest"; from DSH session session-cron; \d+ Telegram messages; recorded in session session-notify, not this one\)\. Full text:\]\n> word0 word1 /u)
    assert.match(text, /word899\n\(For more context, open session session-cron or session-notify\.\)\n\nthanks$/u)
    // A reply to an ordinary bot message adds no such block.
    run.telegram.push({
      message_thread_id: 7100,
      is_topic_message: true,
      text: 'and this?',
      reply_to_message: { message_id: 9999, date: 1, chat: { id: 100 }, from: { id: 1, is_bot: true, first_name: 'testbot' }, message_thread_id: 7100, text: 'an answer' },
    })
    await wait(250)
    assert.doesNotMatch(promptText(fresh.received.at(-1)), /on behalf of/u)
  } finally {
    run.stop()
  }
})

test('a known topic without a session gets one like /new, and a session that cannot record still gets the message', async () => {
  const run = await start({}, { threads: {}, topicNames: { '100:7200': 'Loose' } })
  try {
    const unbound = await run.host.provided.telegramTopics.send({ to: '7200', text: 'hello', files: [], from: { job: 'probe' } })
    assert.equal(sent(run.telegram.calls, 7200).length, 1)
    assert.equal(unbound.sessionId, 'session-1')
    assert.equal(unbound.recorded, true)
    assert.equal(unbound.note, undefined)
    assert.equal(run.host.created[0].cwd, '/tmp/default-workspace', 'the configured working directory')
    const opened = run.host.live.get('session-1')
    assert.equal(opened.turns, 1, 'never left blank')
    assert.equal(opened.received.length, 0)
    assert.equal(opened.session.title, 'TG · Loose')
    assert.match(opened.injected[0].content[0].text, /^\[Sent to the Telegram topic "Loose" by job "probe"\]\nhello$/u)
    const state = await run.readState()
    assert.equal(state.threads['100:7200'], 'session-1')
  } finally {
    run.stop()
  }
  const broken = await start({}, notifyState)
  try {
    const agent = broken.host.makeAgent('session-notify', '/tmp/default-workspace')
    agent.inject = () => { throw new Error('session closed') }
    const result = await broken.host.provided.telegramTopics.send({ to: '7100', text: 'still sent' })
    assert.equal(result.recorded, false)
    assert.equal(result.recordError, 'session closed')
    assert.ok(sent(broken.telegram.calls, 7100).some((call) => call.body.text.includes('still sent')))
  } finally {
    broken.stop()
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
    assert.match(text, /^\[Telegram message from user id 42\]\n\[Replying to a message from the assistant \(this bot\) \(sent 2025-11-08 11:06 UTC; contains a photo, attached\)\]\n> Weekly chart\n\nwhat does this show\?$/u)
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
    assert.equal(promptText(agent.received.at(-1)), '[Telegram message from user id 42]\nplain message')
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
    assert.match(text, /^\[Telegram message from user id 42\]\n\[Replying to a message from Sam \(@sam\) \(sent [^)]+\); the user quoted only this part\]\n> the second step\n\nis this right\?$/u)
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
    assert.match(promptText(agent.received.at(-1)), /^\[Telegram message from user id 42\]\n\[Replying to a message from the Web UI \(a user prompt this bot mirrored into the chat, not an assistant answer\)/u)
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

test('isAutoCommandTopic matches only chat-wide commands in a fresh topic named after them', () => {
  assert.equal(isAutoCommandTopic('/start', '/start', '/start', true), true)
  assert.equal(isAutoCommandTopic('/sessions', '/sessions@testbot', '/sessions@testbot', true), true)
  assert.equal(isAutoCommandTopic('/start', '/start', '/start', false), false, 'a topic with a session or activity')
  assert.equal(isAutoCommandTopic('/start', '/start', 'My topic', true), false, 'a topic the user named')
  assert.equal(isAutoCommandTopic('/start', '/start', undefined, true), false, 'unknown topic name')
  assert.equal(isAutoCommandTopic('/new', '/new', '/new', true), false, '/new belongs to the topic')
  assert.equal(isAutoCommandTopic(undefined, 'hello', 'hello', true), false)
})

/** The two messages Telegram delivers when a user sends text in All with topic creation on. */
function pushAutoTopic(run, threadId, text) {
  run.telegram.push({ message_thread_id: threadId, forum_topic_created: { name: text, icon_color: 1 } })
  run.telegram.push({
    message_thread_id: threadId,
    is_topic_message: true,
    text,
    reply_to_message: { message_id: threadId, chat: { id: 100, type: 'private' }, forum_topic_created: { name: text, icon_color: 1 } },
  })
}

test('a chat-wide command that Telegram turned into a topic is answered in All and the topic is deleted', async () => {
  const run = await start()
  try {
    pushAutoTopic(run, 9100, '/start')
    await wait(200)
    const replies = run.telegram.calls.filter((call) => call.method === 'sendMessage' && !/Polling started/u.test(call.body.text))
    assert.equal(replies.length, 1)
    assert.equal(replies[0].body.message_thread_id, undefined, 'the reply goes to All')
    assert.match(replies[0].body.text, /send a message here in All/u)
    assert.match(replies[0].body.text, /pick the workspace, then a new session or an existing one/u)
    const deleted = run.telegram.calls.filter((call) => call.method === 'deleteForumTopic')
    assert.deepEqual(deleted.map((call) => call.body), [{ chat_id: 100, message_thread_id: 9100 }])
    assert.equal(picker(run.telegram.calls, 'tw:'), undefined, 'no workspace picker')
    const state = await run.readState()
    assert.equal(state.topicNames['100:9100'], undefined, 'the deleted topic is forgotten')
    assert.equal(run.host.created.length, 0)

    pushAutoTopic(run, 9110, '/sessions')
    await wait(200)
    const last = run.telegram.calls.filter((call) => call.method === 'sendMessage').at(-1)
    assert.equal(last.body.message_thread_id, undefined, '/sessions answers in All')
    assert.equal(run.telegram.calls.filter((call) => call.method === 'deleteForumTopic').length, 2)
  } finally {
    run.stop()
  }
})

test('an ordinary message in a fresh auto-created topic still asks for the workspace', async () => {
  const run = await start()
  try {
    pushAutoTopic(run, 9120, 'what is on my list today')
    await wait(200)
    assert.ok(picker(run.telegram.calls, 'tw:'), 'workspace picker shown')
    assert.equal(sent(run.telegram.calls, 9120).length >= 1, true, 'the picker is in the topic')
    assert.equal(run.telegram.calls.filter((call) => call.method === 'deleteForumTopic').length, 0)
  } finally {
    run.stop()
  }
})

test('a command in a topic that already has a session stays in that topic', async () => {
  const run = await start({}, {
    sessions: { 'session-old': { sessionId: 'session-old', chatId: 100, threadId: 9130, title: '/status', cwd: '/tmp/notes', updatedAt: 1 } },
    threads: { '100:9130': 'session-old' },
    topicNames: { '100:9130': '/status' },
  })
  try {
    run.host.makeAgent('session-old', '/tmp/notes')
    run.telegram.push({ message_thread_id: 9130, text: '/status' })
    await wait(200)
    assert.equal(sent(run.telegram.calls, 9130).length, 1)
    assert.equal(run.telegram.calls.filter((call) => call.method === 'deleteForumTopic').length, 0)
  } finally {
    run.stop()
  }
})

test('when the auto-created topic cannot be deleted, a short note is left in it', async () => {
  const run = await start()
  try {
    run.telegram.undeletable.add(9140)
    pushAutoTopic(run, 9140, '/ping')
    await wait(200)
    const all = run.telegram.calls.filter((call) => call.method === 'sendMessage' && call.body.message_thread_id === undefined)
    assert.equal(all.at(-1).body.text, 'pong')
    const note = sent(run.telegram.calls, 9140)
    assert.equal(note.length, 1)
    assert.match(note[0].body.text, /The answer is in All/u)
    assert.ok(run.host.logs.some((line) => /auto-topic-delete/u.test(line)), 'the failure is logged')
  } finally {
    run.stop()
  }
})

test('senderLabel names the Telegram user compactly', () => {
  assert.equal(senderLabel({ id: 7, first_name: 'Livia', last_name: 'Li', username: 'lia' }), '[Telegram message from Livia Li (@lia, user id 7)]')
  assert.equal(senderLabel({ id: 8, first_name: 'Sam' }), '[Telegram message from Sam (user id 8)]')
  assert.equal(senderLabel({ id: 9 }), '[Telegram message from user id 9]')
  assert.equal(senderLabel(undefined), undefined)
})

test('every Telegram prompt says who wrote it, once per forwarded batch', async () => {
  const run = await start()
  try {
    run.telegram.push({ message_thread_id: 1, text: 'hello', from: { id: 42, first_name: 'Livia', username: 'lia' } })
    await wait(200)
    const agent = run.host.live.get('session-1')
    assert.equal(promptText(agent.received[0]), '[Telegram message from Livia (@lia, user id 42)]\nhello')
    const before = agent.received.length
    run.telegram.push({ message_thread_id: 7001, text: 'one', forward_origin: { type: 'hidden_user', sender_user_name: 'A', date: 1 } })
    run.telegram.push({ message_thread_id: 7001, text: 'two', forward_origin: { type: 'hidden_user', sender_user_name: 'B', date: 2 } })
    await wait(1800)
    assert.equal(agent.received.length, before + 1)
    const text = promptText(agent.received.at(-1))
    assert.equal(text.match(/\[Telegram message from/gu).length, 1, 'one label for the batch')
    assert.ok(text.startsWith(SENDER))
  } finally {
    run.stop()
  }
})

test('a session opened for a topic is never blank and carries the topic title', async () => {
  const run = await start({}, notifyState)
  try {
    run.host.makeAgent('session-notify', '/tmp/default-workspace')
    run.telegram.push({ message_thread_id: 7100, forum_topic_edited: { name: 'Alerts' } })
    await wait(100)
    run.telegram.push({ message_thread_id: 7100, text: '/new' })
    await wait(250)
    const fresh = run.host.live.get('session-1')
    // DSH reuses a session for the Web UI's New conversation until it has
    // started a turn; the bot runs one at once, rejected before any model call.
    assert.equal(fresh.turns, 1, 'one turn started right after creation')
    assert.equal(fresh.received.length, 0, 'nothing reached the model')
    assert.equal(fresh.rejected.length, 1)
    assert.match(fresh.rejected[0].source.rpcId, /^telegram-claim:/u)
    assert.equal(fresh.session.title, 'TG · Alerts')
    const before = run.telegram.calls.length
    run.telegram.push({ message_thread_id: 7100, text: 'real question' })
    await wait(200)
    assert.equal(fresh.received.at(-1).content[0].text, `${SENDER}real question`, 'later prompts pass the gate')
    assert.equal(run.telegram.calls.slice(before).filter((call) => String(call.body?.text ?? '').includes('belongs to the Telegram topic')).length, 0, 'the marker is not shown in the topic')
  } finally {
    run.stop()
  }
})

test('the session title follows a topic rename unless someone chose another title', async () => {
  const run = await start()
  try {
    const agent = await openSessionTopic(run)
    const state = await run.readState()
    assert.equal(agent.session.title, `TG · ${state.topicNames['100:7001']}`)
    run.telegram.push({ message_thread_id: 7001, forum_topic_edited: { name: 'Ops' } })
    await wait(100)
    assert.equal(agent.session.title, 'TG · Ops')
    agent.session.title = 'My own title'
    run.telegram.push({ message_thread_id: 7001, forum_topic_edited: { name: 'Ops 2' } })
    await wait(100)
    assert.equal(agent.session.title, 'My own title')
    assert.equal(run.telegram.calls.filter((call) => call.method === 'editForumTopic').length, 0, 'the topic itself is never renamed')
  } finally {
    run.stop()
  }
})

test('a send into a deleted topic drops its binding and name', async () => {
  const run = await start({}, { ...notifyState, topicNames: { '100:7100': 'Notify', '100:7200': 'Other' } })
  try {
    run.host.makeAgent('session-notify', '/tmp/default-workspace')
    run.telegram.goneThreads.set(7100, 'Bad Request: message thread not found')
    await assert.rejects(run.host.provided.telegramTopics.send({ to: 7100, text: 'x' }), (error) => /no longer exists/.test(error.message) && error.retryable === false)
    await wait(50)
    const state = await run.readState()
    assert.equal(state.threads['100:7100'], undefined)
    assert.equal(state.sessions['session-notify'], undefined)
    assert.equal(state.topicNames['100:7100'], undefined)
    assert.equal(state.topicNames['100:7200'], 'Other', 'other topics are kept')
    assert.ok(run.host.logs.some((line) => line.includes('topic 7100 no longer exists') && line.includes('session-notify')))
    await assert.rejects(run.host.provided.telegramTopics.send({ to: 7100, text: 'x' }), /Unknown thread id 7100/)
  } finally {
    run.stop()
  }
})

test('any Telegram call into a deleted topic, such as a mirrored turn, drops its binding', async () => {
  const run = await start()
  try {
    const agent = await openSessionTopic(run)
    run.telegram.goneThreads.set(7001, 'Bad Request: TOPIC_ID_INVALID')
    await playExternalTurn(agent, 2, { id: 'web-9', role: 'user', content: [{ type: 'text', text: 'from web' }], source: { kind: 'user', rpcId: 'rpc-web-9' } }, 'web answer')
    await wait(100)
    const state = await run.readState()
    assert.equal(state.threads['100:7001'], undefined)
    assert.equal(state.sessions['session-1'], undefined)
    assert.equal(state.topicNames['100:7001'], undefined)
  } finally {
    run.stop()
  }
})

test('a voice message reaches the agent as a transcript plus the audio file', async () => {
  const command = [process.execPath, '-e', 'process.stdout.write("buy oat milk")', '{file}']
  const run = await start({ transcriber: 'command', transcribeCommand: command })
  try {
    const agent = await openSessionTopic(run)
    run.telegram.push({ message_thread_id: 7001, is_topic_message: true, voice: { file_id: 'voice-1', duration: 3, mime_type: 'audio/ogg' } })
    await wait(400)
    const content = agent.received.at(-1).content
    const note = content.find((block) => block.type === 'text' && block.text.includes('voice message'))
    assert.ok(note, JSON.stringify(content))
    assert.match(note.text, /transcribed by the configured transcription command; the transcript may contain mistakes, and the file is attached/u)
    assert.match(note.text, /\nbuy oat milk$/u)
    assert.equal(content.find((block) => block.type === 'file').attachment.name.endsWith('.ogg'), true)
    assert.doesNotMatch(promptText(agent.received.at(-1)), /Analyze the attached file/u)
  } finally {
    run.stop()
  }
})

test('a voice message that cannot be transcribed still passes the file and says why', async () => {
  const run = await start({ transcriber: 'dsh' })
  try {
    const agent = await openSessionTopic(run)
    run.telegram.push({ message_thread_id: 7001, is_topic_message: true, video_note: { file_id: 'round-1', duration: 4 } })
    await wait(400)
    const content = agent.received.at(-1).content
    assert.ok(content.some((block) => block.type === 'text' && /video message .*not transcribed \(the DSH speech-to-text service is not enabled\); the file is attached/u.test(block.text)), JSON.stringify(content))
    assert.ok(content.some((block) => block.type === 'file'))
  } finally {
    run.stop()
  }
})
