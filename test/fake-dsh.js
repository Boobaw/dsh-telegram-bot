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
 * Fake `sessionTitle` service: the latest title lives on the session object
 * (`title`, `titleSource`, `titleSeqs`). Titles are written through
 * `session.append('session/title', ...)` when the fake session has one, so
 * listeners see the event as in DSH. `refresh` stands in for the title model.
 * @returns the service.
 */
export function makeTitleService() {
  const write = (session, data) => {
    if (typeof session.append === 'function' && Array.isArray(session.events)) session.append('session/title', data)
    else Object.assign(session, { title: data.title, titleSource: data.source, titleSeqs: data.messageSeqs })
  }
  const service = {
    refreshed: [],
    get: (session) => (typeof session.title === 'string'
      ? { title: session.title, source: session.titleSource ?? { kind: 'user' }, messageSeqs: session.titleSeqs ?? [] }
      : undefined),
    rename: (session, title) => {
      write(session, { title, messageSeqs: [], source: { kind: 'user' } })
      return service.get(session)
    },
    async refresh(session) {
      service.refreshed.push(session.id)
      write(session, { title: session.nextGeneratedTitle ?? 'Generated task', messageSeqs: [1], source: { kind: 'provider', provider: 'fake' } })
      return service.get(session)
    },
  }
  return service
}
