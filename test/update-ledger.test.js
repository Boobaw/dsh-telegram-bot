import assert from 'node:assert/strict'
import test from 'node:test'
import { admitText, promptRequestId } from '../src/admission.js'
import { createUpdateAdmission } from '../src/update-ledger.js'

test('update ledger persists offsets and never handles the same update twice', async () => {
  const state = { updateLedger: {}, updateOffset: 0 }
  const handled = []
  let writes = 0
  const admission = createUpdateAdmission({
    getState: () => state,
    persist: async () => { writes += 1 },
    handle: async (update) => { handled.push(update.update_id) },
  })
  await admission.accept({ update_id: 10 })
  await admission.accept({ update_id: 10 })
  await admission.accept({ update_id: 9 })
  await admission.accept({ update_id: 11 })
  assert.deepEqual(handled, [10, 11])
  assert.equal(state.updateOffset, 12)
  assert.equal(state.updateLedger['10'], 'done')
  assert.ok(writes >= 2)
})

test('pending update becomes uncertain and is not replayed', async () => {
  const state = { updateLedger: {}, updateOffset: 0 }
  const handled = []
  const first = createUpdateAdmission({
    getState: () => state,
    persist: async () => {},
    handle: async (update) => { handled.push(update.update_id); throw new Error('boom') },
  })
  await assert.rejects(first.accept({ update_id: 20 }), /boom/)
  assert.equal(state.updateLedger['20'], 'pending')

  const errors = []
  const second = createUpdateAdmission({
    getState: () => state,
    persist: async () => {},
    handle: async (update) => { handled.push(update.update_id) },
    onError: async (error, update) => { errors.push([error.message, update.update_id]) },
  })
  await second.accept({ update_id: 20 })
  assert.deepEqual(handled, [20])
  assert.equal(state.updateLedger['20'], 'uncertain')
  assert.equal(errors.length, 1)
})

test('native prompt admission uses a stable request id and queue mode', async () => {
  let captured
  const controller = {
    prompt(request, signal) {
      captured = { request, signal }
      return Promise.resolve({ accepted: true })
    },
  }
  const ctx = { get: (name) => name === 'sessionController' ? controller : undefined }
  const signal = new AbortController().signal
  const result = admitText(ctx, { sessionId: 'session-1', chatId: 99, messageId: 42, text: 'hello' }, signal)
  await result
  assert.equal(promptRequestId(99, 42), 'telegram:99:42')
  assert.equal(captured.request.sessionId, 'session-1')
  assert.equal(captured.request.requestId, 'telegram:99:42')
  assert.equal(captured.request.mode, 'queue')
  assert.deepEqual(captured.request.content, [{ type: 'text', text: 'hello' }])
})
