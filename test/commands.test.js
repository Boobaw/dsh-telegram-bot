import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import https from 'node:https'
import { STATUS_DIR } from '../src/constants.js'

function makeAgent(id, cwd, idleMs) {
  const events = new EventEmitter()
  return {
    session: { id, header: { cwd }, append() {} },
    ctx: { on: (...args) => events.on(...args) },
    events,
    status: 'idle',
    received: [],
    followup(message) { this.received.push(message) },
    whenIdle() { return new Promise((resolve) => setTimeout(resolve, idleMs)) },
    cancel() {},
  }
}

function makeContext(agent) {
  const logs = []
  const cleanups = []
  const attachments = {
    async saveFile({ data, name }) { return { attachmentId: 'file-1', name: name ?? 'file', bytes: data.length } },
    async saveImage({ data, name, mediaType }) { return { attachmentId: 'image-1', name: name ?? 'image', bytes: data.length, mediaType, width: 1, height: 1 } },
  }
  const services = {
    credentials: { resolve: async () => ({ value: 'TEST_TOKEN' }) },
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
    return { calls: telegram.calls, agent, logs: context.logs, cleanup: context.cleanup }
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

test('a provider title event renames the existing topic', async () => {
  const result = await runScenario([all('hello')], 20, 350, async ({ agent }) => {
    agent.events.emit('session/event', { id: 'session-one' }, {
      type: 'session/title',
      data: { title: 'Provider title' },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
  try {
    const edits = result.calls.filter((call) => call.method === 'editForumTopic')
    assert.equal(edits.length > 0, true)
    assert.equal(edits.at(-1).body.name, 'Provider title')
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
