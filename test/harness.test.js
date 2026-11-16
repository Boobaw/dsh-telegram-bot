import './setup-home.js'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import https from 'node:https'
import { STATUS_DIR } from '../src/constants.js'

/**
 * One fake DSH agent that settles a Telegram turn without model streaming.
 */
function makeAgent(id, cwd) {
  const events = new EventEmitter()
  return {
    session: { id, header: { cwd }, append() {} },
    ctx: { on: (...args) => events.on(...args) },
    status: 'idle',
    received: [],
    followup(message) { this.received.push(message) },
    whenIdle() { return new Promise((resolve) => setTimeout(resolve, 20)) },
    cancel() {},
  }
}

/**
 * Build a fake Host context with the seams the Telegram bridge reads.
 */
function makeContext(agent) {
  const cleanups = []
  const logs = []
  const listeners = new Map()
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
      list: () => [{ id: 'workspace-default', path: '/tmp/default-workspace', title: 'default-workspace' }],
      get: () => undefined,
      create: async () => ({ id: 'workspace-default' }),
    },
    llm: {
      listModels: async () => [],
      resolveModel: async () => ({ context: { contextWindow: 1_000_000 } }),
    },
  }
  return {
    ctx: {
      logger: { info(message) { logs.push(`I ${message}`) }, warn(message) { logs.push(`W ${message}`) } },
      get: (name) => services[name],
      on(name, fn) { listeners.set(name, fn) },
      effect(fn) {
        cleanups.push(fn())
      },
    },
    logs,
    listeners,
    cleanup: () => {
      for (const fn of cleanups) fn?.()
    },
    services,
  }
}

/**
 * Start the bridge, deliver one message from All and wait for its prompt.
 * @param extraConfig - plugin config on top of the defaults.
 * @returns the fake agent, Telegram calls, Host listeners and a finish callback.
 */
async function sendFromAll(extraConfig = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-telegram-test-'))
  process.env.DSH_HOME = home
  await mkdir(STATUS_DIR, { recursive: true })
  await writeFile(join(STATUS_DIR, 'state.json'), JSON.stringify({ version: 2, sessions: {}, threads: {}, updateLedger: {}, updateOffset: 0 }))
  const agent = makeAgent('session-one', '/tmp/default-workspace')
  const { ctx, cleanup, listeners } = makeContext(agent)
  const calls = []
  let getUpdatesCalls = 0
  let updateConsumed = false
  const originalRequest = https.request
  https.request = (options, callback) => {
    const method = String(options.path).split('/').pop()
    const request = new EventEmitter()
    const response = new EventEmitter()
    response.setEncoding = () => {}
    response.statusCode = 200
    let body = ''
    request.end = (value = '') => {
      body = value
      let result = {}
      let error
      if (method === 'getMe') result = { id: 1, username: 'testbot' }
      else if (method === 'createForumTopic') {
        calls.push({ method, body: JSON.parse(body) })
        result = { message_thread_id: 7001 }
      } else if (method === 'sendMessage' || method === 'editMessageText') {
        calls.push({ method, body: JSON.parse(body) })
        result = { message_id: calls.length }
      } else if (method === 'getUpdates') {
        getUpdatesCalls += 1
        if (!updateConsumed) {
          updateConsumed = true
          result = [{
              update_id: 1,
              message: {
                message_id: 1,
                date: 1_772_440_872,
                chat: { id: 100, type: 'private' },
                from: { id: 42, first_name: 'Ana', username: 'ana' },
                message_thread_id: 1,
                text: 'hello from All',
              },
            }]
        } else {
          error = { ok: false, description: 'Conflict: terminated by other getUpdates request' }
        }
      } else {
        result = true
      }
      // Deliver only after https.request has invoked its response callback.
      setImmediate(() => {
        response.emit('data', JSON.stringify(error ?? { ok: true, result }))
        response.emit('end')
        request.emit('close')
      })
    }
    request.destroy = () => {}
    request.on = (name, fn) => EventEmitter.prototype.on.call(request, name, fn)
    process.nextTick(() => callback(response))
    return request
  }
  const finish = async () => {
    cleanup()
    https.request = originalRequest
    await rm(home, { recursive: true, force: true })
  }
  try {
    const { apply } = await import('../src/index.js')
    apply(ctx, {
      enabled: true,
      tokenRef: 'TEST_TOKEN',
      allowedUsers: ['42'],
      allowedChats: ['100'],
      cwd: '/tmp/default-workspace',
      language: 'en',
      showThinking: false,
      ...extraConfig,
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
  } catch (error) {
    await finish()
    throw error
  }
  return { agent, calls, listeners, finish }
}

/** Run the Host's `agent/pre-step` listener over the messages a step would enter with. */
async function enterStep(listeners, messages) {
  const decision = await listeners.get('agent/pre-step')({}, async () => ({ kind: 'enter', messages }))
  return decision.messages
}

test('All message creates one topic, then the same topic continues', async () => {
  const { agent, calls, listeners, finish } = await sendFromAll()
  try {
    const topicCalls = calls.filter((entry) => entry.method === 'createForumTopic')
    assert.equal(topicCalls.length, 1, 'All message must create exactly one topic')
    assert.equal(topicCalls[0].body.name, 'New session')
    assert.equal(agent.received.length, 1, 'the initial prompt must reach the new agent')
    assert.equal(agent.received[0].content[0].text, 'hello from All')
    const principal = agent.received[0].source.principal
    assert.equal(principal.kind, 'telegram-user')
    assert.equal(principal.id, '42')
    assert.equal(principal.name, 'Ana')
    assert.equal(principal.username, 'ana')
    assert.equal(principal.chat.id, '100')
    assert.equal(principal.chat.thread, 7001)
    // Message times are off without a timeZone.
    assert.equal(agent.received[0].source.clientTimeZone, undefined)
    assert.deepEqual(await enterStep(listeners, agent.received), agent.received)
  } finally {
    await finish()
  }
})

test('with a timeZone, a notice before the prompt says when the message was sent', async () => {
  const { agent, listeners, finish } = await sendFromAll({ timeZone: 'Asia/Tokyo' })
  try {
    assert.equal(agent.received.length, 1)
    const prompt = agent.received[0]
    assert.equal(prompt.content[0].text, 'hello from All', 'the prompt holds only what the person wrote')
    // The zone reaches DSH on the prompt, for its clock context.
    assert.equal(prompt.source.clientTimeZone, 'Asia/Tokyo')
    assert.equal(prompt.source.rpcId, 'telegram:100:1')
    const messages = await enterStep(listeners, agent.received)
    assert.equal(messages.length, 2)
    // Telegram's own send time, in the configured zone.
    assert.equal(messages[0].content[0].text, '[Telegram message, sent Mon 2026-03-02 17:41 UTC+09:00]')
    assert.deepEqual({ kind: messages[0].source.kind, form: messages[0].source.form }, { kind: 'telegram-sender', form: 'notice' })
    assert.equal(messages[1].id, prompt.id)
    assert.equal(messages[1].source.principal.id, '42')
  } finally {
    await finish()
  }
})
