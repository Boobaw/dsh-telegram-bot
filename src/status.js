/** Local runtime diagnostics snapshot. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STATUS_DIR } from './constants.js'

/** Last published runtime snapshot, mirrored to a local diagnostics file. */
let runtimeStatus = {
  state: 'starting',
  detail: '',
  username: '',
  updatedAt: new Date().toISOString(),
  transport: 'https-ipv4',
  version: '0.3.0',
  agentBridge: 'v1',
  codeRevision: 'topic-error-fallback',
  lastPollAt: 0,
  lastMessageAt: 0,
  lastChatId: null,
  lastFromId: null,
  lastUpdateType: null,
  lastUpdateAt: 0,
  lastOutcome: null,
}

/**
 * Persist a local runtime snapshot for diagnostics. This file is intentionally
 * separate from the user settings: status changes must never rewrite the
 * profile patch or trigger a configuration reload.
 * @param patch - fields to merge into the current snapshot.
 * @returns resolves after the best-effort write.
 */
async function publishStatus(patch) {
  runtimeStatus = { ...runtimeStatus, ...patch, updatedAt: new Date().toISOString() }
  try {
    await mkdir(STATUS_DIR, { recursive: true })
    await writeFile(join(STATUS_DIR, 'status.json'), JSON.stringify(runtimeStatus, null, 2) + '\n', { mode: 0o600 })
  } catch {
    // Diagnostics must never take the runtime down.
  }
}


export { runtimeStatus, publishStatus }
