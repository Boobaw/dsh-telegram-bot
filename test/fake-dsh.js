/**
 * Shared pieces of the fake DSH Host used by the test files. This file has no
 * tests of its own.
 */

/**
 * Model how DSH starts a turn for a queued message: every follow-up opens a
 * turn (so the session is no longer blank), and `agent/pre-step` handlers may
 * reject it before any model request, in which case the message is never
 * recorded.
 * @param agent - fake agent with `received`; gets `turns` and `rejected`.
 * @param events - the agent's event emitter.
 * @param message - the queued user message.
 */
export function followupThroughGate(agent, events, message) {
  agent.turns = (agent.turns ?? 0) + 1
  agent.received.push(message)
  const handlers = events.listeners('agent/pre-step')
  const run = (index) => index < handlers.length
    ? Promise.resolve(handlers[index]({ agent, messages: [message] }, () => run(index + 1)))
    : Promise.resolve({ kind: 'enter' })
  void run(0).then((decision) => {
    if (decision?.kind !== 'reject') return
    agent.received.splice(agent.received.indexOf(message), 1)
    agent.rejected ??= []
    agent.rejected.push(message)
  })
}

/**
 * Fake `sessionTitle` service: titles live on the session object.
 * @returns the service.
 */
export function makeTitleService() {
  return {
    get: (session) => (typeof session.title === 'string' ? { title: session.title, source: { kind: 'user' } } : undefined),
    rename: (session, title) => {
      session.title = title
      return { title, source: { kind: 'user' } }
    },
  }
}
