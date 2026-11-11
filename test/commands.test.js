import './setup-home.js'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import https from 'node:https'
import { STATUS_DIR } from '../src/constants.js'
import { followupThroughGate } from './fake-dsh.js'

function makeAgent(id, cwd, idleMs) {
  const events = new EventEmitter()
  return {
    session: { id, header: { cwd }, append() {} },
    ctx: { on: (...args) => events.on(...args) },
    events,
    status: 'idle',
    received: [],
    followup(message) { followupThroughGate(this, events, message) },
    // A turn whose message was rejected before the model ends at once.
    whenIdle() {
      return new Promise((resolve) => setImmediate(resolve))
        .then(() => (this.received.length === 0 ? undefined : new Promise((resolve) => setTimeout(resolve, idleMs))))
    },
    cancel() {},
    emit(name, ...args) { events.emit(name, ...args) },
  }
}

function makeContext(agent) {
  const logs = []
  const cleanups = []
  const attachments = {
    async saveFile({ data, name }) { return { attachmentId: 'file-1', name: name ?? 'file', bytes: data.length } },
    async saveImage({ data, name, mediaType }) { return { attachmentId: 'image-1', name: name ?? 'image', bytes: data.length, mediaType, width: 1, height: 1 } },
  }
  const goalCalls = []
  const goalState = {
    current: {
      id: 'goal-old',
      revision: 1,
      objective: 'old blocked goal',
      phase: 'blocked',
      activation: 'disarmed',
      roundsStarted: 3,
      maxGoalRounds: 256,
      blockedReason: { code: 'test', message: 'blocked' },
    },
  }
  const services = {
    credentials: { resolve: async () => ({ value: 'TEST_TOKEN' }) },
    goals: {
      get: () => goalState.current,
      create: (_agent, { objective }) => {
        goalCalls.push({ op: 'create', objective })
        goalState.current = {
          id: 'goal-new',
          revision: 1,
          objective,
          phase: 'active',
          activation: 'armed',
          roundsStarted: 0,
          maxGoalRounds: 256,
        }
        return goalState.current
      },
      clear: (_agent, ref) => {
        goalCalls.push({ op: 'clear', ref })
        goalState.current = undefined
        return { id: ref.id, revision: ref.revision + 1 }
      },
      edit: (_agent, _ref, { objective }) => {
        goalCalls.push({ op: 'edit', objective })
        goalState.current = { ...goalState.current, objective }
        return goalState.current
      },
      pause: () => {
        goalCalls.push({ op: 'pause' })
        goalState.current = { ...goalState.current, phase: 'paused', activation: 'disarmed' }
        return goalState.current
      },
      resume: () => {
        goalCalls.push({ op: 'resume' })
        goalState.current = { ...goalState.current, phase: 'active', activation: 'armed' }
        return goalState.current
      },
    },
    agents: { get: () => undefined, create: async () => ({ agent }), resume: async () => ({ agent }) },
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
      create: async () => ({ id: 'workspace-default' }),
    },
    attachments,
    llm: { listModels: async () => [], resolveModel: async () => ({ context: { contextWindow: 1_000_000 } }) },
  }
  return {
    ctx: {
      logger: { info(message) { logs.push(`I ${message}`) }, warn(message) { logs.push(`W ${message}`) } },
      get: (name) => services[name],
      on() {},
      effect(fn) { cleanups.push(fn()) },
    },
    logs,
    goalCalls,
    goalState,
    cleanup: () => { for (const fn of cleanups) fn?.() },
  }
}

function makeTelegram(updates) {
  const calls = []
  let messageId = 0
  let topicId = 7000
  let updateIndex = 0
  const fake = (options, callback) => {
    const method = String(options.path).split('/').pop()
    const request = new EventEmitter()
    const response = new EventEmitter()
    response.setEncoding = () => {}
    response.statusCode = 200
    request.destroy = () => {}
    request.on = (name, fn) => EventEmitter.prototype.on.call(request, name, fn)
    process.nextTick(() => callback(response))

    const deliver = (payload) => {
      setImmediate(() => {
        response.emit('data', payload)
        response.emit('end')
        request.emit('close')
      })
    }

    let body = ''
    request.end = (value = '') => {
      body = value
      if (String(options.path).includes('/file/')) {
        setImmediate(() => {
          response.emit('data', Buffer.from('file-data'))
          response.emit('end')
          request.emit('close')
        })
        return
      }
      if (method === 'getMe') {
        deliver(JSON.stringify({ ok: true, result: { id: 1, username: 'testbot' } }))
        return
      }
      if (method === 'getFile') {
        calls.push({ method, body: body.length > 0 ? JSON.parse(body) : undefined })
        deliver(JSON.stringify({ ok: true, result: { file_path: 'files/test.txt', file_size: 9 } }))
        return
      }
      if (method === 'getUpdates') {
        const update = updates[updateIndex]
        if (update === undefined) {
          deliver(JSON.stringify({ ok: false, description: 'Conflict: terminated by other getUpdates request' }))
          return
        }
        updateIndex += 1
        setTimeout(() => deliver(JSON.stringify({ ok: true, result: [update] })), update.delay ?? 0)
        return
      }
      let result = true
      if (method === 'createForumTopic') {
        topicId += 1
        result = { message_thread_id: topicId }
      } else if (method === 'editForumTopic') {
        calls.push({ method, body: JSON.parse(body) })
        result = true
      } else if (method === 'sendMessage' || method === 'editMessageText') {
        messageId += 1
        result = { message_id: messageId }
      }
      calls.push({ method, body: body.length > 0 ? JSON.parse(body) : undefined })
      deliver(JSON.stringify({ ok: true, result }))
    }
    return request
  }
  return { fake, calls, get calls() { return calls } }
}

async function runScenario(updates, idleMs = 20, waitMs = 400, afterReady) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-telegram-command-'))
  process.env.DSH_HOME = home
  await mkdir(STATUS_DIR, { recursive: true })
  await writeFile(join(STATUS_DIR, 'state.json'), JSON.stringify({ version: 2, sessions: {}, threads: {}, updateLedger: {}, updateOffset: 0 }))
  const agent = makeAgent('session-one', '/tmp/default-workspace', idleMs)
  const context = makeContext(agent)
  const telegram = makeTelegram(updates)
  const originalRequest = https.request
  https.request = telegram.fake
  try {
    const { apply } = await import('../src/index.js')
    apply(context.ctx, {
      enabled: true,
      tokenRef: 'TEST_TOKEN',
      allowedUsers: ['42'],
      allowedChats: ['100'],
      cwd: '/tmp/default-workspace',
      language: 'en',
      showThinking: false,
    })
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    if (afterReady !== undefined) await afterReady({ agent, calls: telegram.calls })
    return {
      calls: telegram.calls,
      agent,
      telegram,
      logs: context.logs,
      goalCalls: context.goalCalls,
      goalState: context.goalState,
      cleanup: context.cleanup,
    }
  } catch (error) {
    context.cleanup()
    throw error
  } finally {
    https.request = originalRequest
  }
}

const all = (text) => ({
  update_id: 1,
  message: { message_id: 1, date: 1, chat: { id: 100, type: 'private' }, from: { id: 42 }, message_thread_id: 1, text },
})
const topic = (threadId, text, delay = 100) => ({
  delay,
  update_id: 2,
  message: { message_id: 2, date: 1, chat: { id: 100, type: 'private' }, from: { id: 42 }, message_thread_id: threadId, text },
})
const topicAt = (updateId, threadId, text, delay = 100) => ({
  delay,
  update_id: updateId,
  message: { message_id: updateId + 1, date: 1, chat: { id: 100, type: 'private' }, from: { id: 42 }, message_thread_id: threadId, text },
})
const topicFile = (threadId, delay = 100) => ({
  delay,
  update_id: 2,
  message: {
    message_id: 2,
    date: 1,
    chat: { id: 100, type: 'private' },
    from: { id: 42 },
    message_thread_id: threadId,
    caption: 'read this file',
    document: { file_id: 'f1', file_name: 'test.txt', mime_type: 'text/plain', file_size: 9 },
  },
})

test('/restart in All never creates a session topic', async () => {
  const result = await runScenario([all('/restart@boobawnebot')], 20, 500)
  try {
    const topics = result.calls.filter((call) => call.method === 'createForumTopic')
    assert.equal(topics.length, 0)
  } finally {
    result.cleanup()
  }
})

test('/clear in All does not create a session topic', async () => {
  const result = await runScenario([all('/clear')], 20, 300)
  try {
    assert.equal(result.calls.filter((call) => call.method === 'createForumTopic').length, 0)
  } finally {
    result.cleanup()
  }
})

test('fork creates one new topic with the requested name', async () => {
  const result = await runScenario([all('hello'), topic(7001, '/fork branch', 400)], 20, 900)
  try {
    const topics = result.calls.filter((call) => call.method === 'createForumTopic')
    assert.equal(topics.length, 2, 'initial topic plus fork topic')
    assert.equal(topics[1].body.name, 'branch')
    assert.equal(result.logs.filter((line) => line.startsWith('W ') && !line.includes('getUpdates failed')).length, 0, result.logs.join('\n'))
  } finally {
    result.cleanup()
  }
})

test('a provider title event leaves the topic name alone', async () => {
  const result = await runScenario([all('hello')], 20, 350, async ({ agent }) => {
    agent.events.emit('session/event', { id: 'session-one' }, {
      type: 'session/title',
      data: { title: 'Provider title' },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
  try {
    const edits = result.calls.filter((call) => call.method === 'editForumTopic')
    assert.equal(edits.length, 0, 'topic names belong to the user')
  } finally {
    result.cleanup()
  }
})

test('stop settles a running Telegram turn without duplicates', async () => {
  const result = await runScenario([
    all('slow task'),
    topic(7001, '/stop', 120),
    topic(7001, '/stop', 160),
  ], 1000, 500)
  try {
    assert.equal(result.logs.some((line) => line.includes('warn is not defined')), false)
    const stopped = result.calls.filter((call) =>
      call.method === 'sendMessage' && typeof call.body?.text === 'string' && call.body.text.includes('Stopped.'),
    )
    assert.equal(stopped.length, 1)
  } finally {
    result.cleanup()
  }
})

test('/goal replaces a non-complete goal', async () => {
  const result = await runScenario([all('hello'), topicAt(2, 7001, '/goal new task', 200)], 20, 900)
  try {
    assert.deepEqual(result.goalCalls.map((entry) => entry.op), ['edit', 'resume'])
    assert.equal(result.goalState.current.phase, 'active')
    assert.equal(result.goalState.current.objective, 'new task')
    const newPanels = result.calls.filter((call) =>
      call.method === 'sendMessage'
      && typeof call.body?.text === 'string'
      && call.body.text.includes('🎯 <b>Goal</b>')
      && call.body.text.includes('new task'))
    assert.equal(newPanels.length, 1, '/goal posts exactly one new panel')
    assert.ok(result.calls.some((call) => call.method === 'deleteMessage'), 'the old panel is removed')
  } finally {
    result.cleanup()
  }
})

test('Continue inside a topic reuses that topic', async () => {
  const callback = {
    delay: 300,
    update_id: 3,
    callback_query: {
      id: 'callback-3',
      from: { id: 42 },
      data: 'c:session-one',
      message: { message_id: 1, date: 1, chat: { id: 100, type: 'private' }, message_thread_id: 7001 },
    },
  }
  const result = await runScenario([all('hello'), callback], 20, 1000)
  try {
    assert.equal(result.calls.filter((call) => call.method === 'createForumTopic').length, 1, 'no additional topic is created')
    // Continue inside a topic binds the session there the way the topic's
    // session picker does; this topic already shows it.
    assert.ok(result.calls.some((call) =>
      (call.method === 'sendMessage' || call.method === 'editMessageText')
      && typeof call.body?.text === 'string'
      && call.body.text.includes('This topic already uses that session')), 'the current topic confirms the session')
  } finally {
    result.cleanup()
  }
})

test('/goal edit updates and resumes a blocked goal', async () => {
  const result = await runScenario([all('hello'), topicAt(2, 7001, '/goal edit new objective', 200)], 20, 900)
  try {
    assert.deepEqual(result.goalCalls.map((entry) => entry.op), ['edit', 'resume'])
    assert.equal(result.goalState.current.objective, 'new objective')
    assert.equal(result.goalState.current.phase, 'active')
  } finally {
    result.cleanup()
  }
})

test('/goal creates a goal and /goal edit updates the same panel', async () => {
  const result = await runScenario([
    all('hello'),
    topicAt(2, 7001, '/goal clear', 150),
    topicAt(3, 7001, '/goal first task', 350),
    topicAt(4, 7001, '/goal edit second task', 650),
  ], 20, 1800)
  try {
    assert.deepEqual(result.goalCalls.map((entry) => entry.op), ['clear', 'create', 'edit'])
    assert.equal(result.goalState.current.objective, 'second task')
    assert.equal(result.goalState.current.phase, 'active')
    const firstPanels = result.calls.filter((call) =>
      call.method === 'sendMessage'
      && typeof call.body?.text === 'string'
      && call.body.text.includes('🎯 <b>Goal</b>')
      && call.body.text.includes('first task'))
    assert.equal(firstPanels.length, 1, 'create posts a new panel')
    const secondPanels = result.calls.filter((call) =>
      call.method === 'sendMessage'
      && typeof call.body?.text === 'string'
      && call.body.text.includes('🎯 <b>Goal</b>')
      && call.body.text.includes('second task'))
    assert.equal(secondPanels.length, 1, 'edit posts exactly one new panel')
    assert.equal(result.calls.filter((call) => call.method === 'pinChatMessage').length, 0, 'nothing is pinned')
  } finally {
    result.cleanup()
  }
})

test('a goal change updates the panel immediately', async () => {
  const result = await runScenario([
    all('hello'),
    topicAt(2, 7001, '/goal clear', 150),
    topicAt(3, 7001, '/goal task', 350),
  ], 20, 1200)
  const originalRequest = https.request
  https.request = result.telegram.fake
  try {
    result.goalState.current = {
      ...result.goalState.current,
      phase: 'complete',
      activation: 'disarmed',
    }
    result.agent.emit('session/event', { id: 'session-one' }, {
      type: 'goal/change',
      data: { operation: 'complete', goal: result.goalState.current },
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.ok(result.calls.some((call) =>
      call.method === 'editMessageText'
      && typeof call.body?.text === 'string'
      && call.body.text.includes('complete')), 'the panel shows the completed phase')
    assert.equal(result.calls.filter((call) => call.method === 'pinChatMessage').length, 0, 'nothing is pinned')
  } finally {
    https.request = originalRequest
    result.cleanup()
  }
})

test('/goal without arguments prints status then hints', async () => {
  const result = await runScenario([all('hello'), topicAt(2, 7001, '/goal', 300)], 20, 900)
  try {
    const help = result.calls.filter((call) =>
      call.method === 'sendMessage'
      && typeof call.body?.text === 'string'
      && call.body.text.includes('Hints')).at(-1)
    assert.ok(help !== undefined, 'the bare /goal prints hints')
    assert.ok(help.body.text.includes('Status:'), 'status is included')
    assert.ok(help.body.text.includes('/goal edit'), 'edit hint is included')
    assert.ok(help.body.text.includes('/goal resume'), 'resume hint is included')
    assert.ok(help.body.text.indexOf('Status:') < help.body.text.indexOf('Hints'), 'status comes before hints')
  } finally {
    result.cleanup()
  }
})

test('/goal clear removes the current goal', async () => {
  const result = await runScenario([
    all('hello'),
    topicAt(2, 7001, '/goal clear', 150),
    topicAt(3, 7001, '/goal task', 350),
    topicAt(4, 7001, '/goal clear', 650),
  ], 20, 1600)
  try {
    assert.deepEqual(result.goalCalls.map((entry) => entry.op), ['clear', 'create', 'clear'])
    assert.equal(result.goalState.current, undefined)
    assert.ok(result.calls.some((call) =>
      call.method === 'sendMessage'
      && typeof call.body?.text === 'string'
      && call.body.text.includes('Goal cleared')), 'the bot confirms clearing')
    assert.ok(result.calls.some((call) => call.method === 'deleteMessage'), 'the panel is removed')
  } finally {
    result.cleanup()
  }
})

test('/goal pause and resume manage the current goal', async () => {
  const result = await runScenario([
    all('hello'),
    topicAt(2, 7001, '/goal clear', 100),
    topicAt(3, 7001, '/goal task', 150),
    topicAt(4, 7001, '/goal pause', 250),
    topicAt(5, 7001, '/goal resume', 350),
  ], 20, 2000)
  try {
    assert.deepEqual(result.goalCalls.map((entry) => entry.op), ['clear', 'create', 'pause', 'resume'])
    assert.equal(result.goalState.current.phase, 'active')
  } finally {
    result.cleanup()
  }
})

test('a document in All reaches the agent as a file attachment', async () => {
  const result = await runScenario([topicFile(1, 0)], 20, 500)
  try {
    assert.equal(result.calls.filter((call) => call.method === 'createForumTopic').length, 1)
    assert.equal(result.agent.received.length, 1)
    const content = result.agent.received[0].content
    assert.equal(content.some((part) => part.type === 'file'), true)
    assert.equal(content.find((part) => part.type === 'file').attachment.name, 'test.txt')
  } finally {
    result.cleanup()
  }
})
