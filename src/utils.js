/** Small dependency-free helpers. */
import { DEFAULT_TOKEN_REF } from './constants.js'

/**
 * Read one error without ever touching the token.
 * @param error - a thrown value.
 * @returns a short diagnostic.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Sleep that settles early when the runtime is stopped.
 * @param ms - delay in milliseconds.
 * @param signal - runtime lifetime.
 * @returns resolves after the delay or the abort.
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * Normalize one allowlist entry for case-insensitive comparison.
 * @param value - id or @username.
 * @returns normalized value.
 */
function normalizeEntry(value) {
  return String(value).trim().toLowerCase()
}

/**
 * Read a Config field that may be a plain value or a volatile live reference.
 * @param value - Config field or Volatile reference.
 * @param fallback - value used when the field is absent.
 * @returns the current value.
 */
function readLive(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const current = value.get()
      return current === undefined ? fallback : current
    } catch {
      return fallback
    }
  }
  return value === undefined || value === null ? fallback : value
}

/** @returns the live credential reference for the bot token. */
function tokenRefOf(config) {
  const value = readLive(config.tokenRef, DEFAULT_TOKEN_REF)
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : DEFAULT_TOKEN_REF
}

/** @returns whether the runtime is enabled in the live Config. */
function isEnabled(config) {
  return readLive(config.enabled, true) !== false
}

/** @returns the live allowed-user list. */
function allowedUsersOf(config) {
  const value = readLive(config.allowedUsers, [])
  return Array.isArray(value) ? value : []
}

/** @returns the live allowed-chat list. */
function allowedChatsOf(config) {
  const value = readLive(config.allowedChats, [])
  return Array.isArray(value) ? value : []
}

/**
 * Whether one user is on the allowlist.
 * @param from - Telegram user.
 * @param allowedUsers - configured entries.
 * @returns whether the user may talk to the bot.
 */
function userAllowed(from, allowedUsers) {
  if (from === undefined || !Array.isArray(allowedUsers)) return false
  const id = String(from.id)
  const username = typeof from.username === 'string' ? `@${from.username.toLowerCase()}` : undefined
  return allowedUsers.some((entry) => entry === id || (username !== undefined && normalizeEntry(entry) === username))
}

/**
 * Whether one chat is on the allowlist. An empty chat list allows private
 * chats only; a non-empty list requires the chat itself to match.
 * @param chat - Telegram chat.
 * @param allowedChats - configured entries.
 * @returns whether the bot may answer in this chat.
 */
function chatAllowed(chat, allowedChats) {
  if (!Array.isArray(allowedChats) || allowedChats.length === 0) return chat.type === 'private'
  const id = String(chat.id)
  const username = typeof chat.username === 'string' ? `@${chat.username.toLowerCase()}` : undefined
  return allowedChats.some((entry) => entry === id || (username !== undefined && normalizeEntry(entry) === username))
}


export {
  messageOf,
  sleep,
  normalizeEntry,
  readLive,
  tokenRefOf,
  isEnabled,
  allowedUsersOf,
  allowedChatsOf,
  userAllowed,
  chatAllowed,
}
