import { messageOf } from './utils.js'

/**
 * Serialize one Telegram update stream and persist its cursor before side effects.
 * A pending entry left by a crash is marked uncertain and never replayed.
 */
export function createUpdateAdmission({ getState, persist, handle, onError = () => {} }) {
  let tail = Promise.resolve()

  async function process(update, signal) {
    if (!Number.isSafeInteger(update?.update_id)) return
    const state = getState()
    state.updateLedger ??= {}
    state.updateOffset ??= 0
    const key = String(update.update_id)
    const previous = state.updateLedger[key]
    if (previous !== undefined) {
      if (previous === 'pending') {
        state.updateLedger[key] = 'uncertain'
        state.updateOffset = Math.max(state.updateOffset, update.update_id + 1)
        await persist()
        try {
          await onError(new Error(`Update ${update.update_id} has an uncertain outcome; refusing to replay`), update, signal)
        } catch {
          // Error reporting must never replay the update.
        }
      }
      return
    }
    if (update.update_id < state.updateOffset) return
    state.updateLedger[key] = 'pending'
    await persist()
    try {
      await handle(update, signal)
      state.updateLedger[key] = 'done'
      state.updateOffset = Math.max(state.updateOffset, update.update_id + 1)
      const keys = Object.keys(state.updateLedger).sort((a, b) => Number(b) - Number(a))
      for (const old of keys.slice(256)) delete state.updateLedger[old]
      await persist()
    } catch (error) {
      // Keep `pending`: after restart it becomes `uncertain`, not replayed.
      throw error
    }
  }

  return {
    accept(update, signal) {
      const result = tail.then(() => process(update, signal))
      tail = result.catch(() => {})
      return result
    },
    idle() {
      return tail.then(() => undefined)
    },
  }
}

export { messageOf }
