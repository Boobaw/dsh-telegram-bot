/** Durable Telegram state and topic files. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STATUS_DIR } from './constants.js'

/** Durable Telegram chat → DSH session mapping. */
const STATE_PATH = join(STATUS_DIR, 'state.json')

/**
 * Read the chat/session mapping. A missing or malformed file starts empty.
 * @returns the mapping document.
 */
async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      return {
        version: 2,
        sessions: parsed.sessions !== null && typeof parsed.sessions === 'object' ? parsed.sessions : {},
        threads: parsed.threads !== null && typeof parsed.threads === 'object' ? parsed.threads : {},
        updateLedger: parsed.updateLedger !== null && typeof parsed.updateLedger === 'object' && !Array.isArray(parsed.updateLedger) ? parsed.updateLedger : {},
        updateOffset: Number.isSafeInteger(parsed.updateOffset) && parsed.updateOffset >= 0 ? parsed.updateOffset : 0,
      }
    }
  } catch {
    // Missing or corrupt state is nonfatal; the next session creates a mapping.
  }
  return { version: 2, sessions: {}, threads: {}, updateLedger: {}, updateOffset: 0 }
}

/** Durable control-chat id for lifecycle notifications. */
const TOPICS_PATH = join(STATUS_DIR, 'topics.json')

/**
 * Read the control chat used for lifecycle notifications.
 * @returns the chat id, or 0 when absent.
 */
async function loadTopics() {
  try {
    const parsed = JSON.parse(await readFile(TOPICS_PATH, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.chatId === 'number') {
      return { chatId: parsed.chatId }
    }
  } catch {
    // The control chat is learned on the first /start.
  }
  return { chatId: 0 }
}


export { STATE_PATH, TOPICS_PATH, loadState, loadTopics }
