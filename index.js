/**
 * Host half of dsh-telegram-bot.
 *
 * It owns the editable settings namespace, the Telegram long-polling runtime,
 * the DM-topic session browser, and the bridge between Telegram topics and
 * DSH agent sessions. Keeping the runtime isolated means a bad token or a
 * conflicting poller cannot take the Host down.
 */
import z from '@deepseek-ai/schemastery'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import https from 'node:https'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import telegramifyMarkdown from 'telegramify-markdown'

/** Loader row id and settings namespace; the npm package name stays dsh-telegram-bot. */
export const name = 'telegram-bot'

/** Default credential reference holding the bot token. */
const DEFAULT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN'
/** Long-poll timeout requested from Telegram, in seconds. */
const POLL_TIMEOUT_SECONDS = 25
/** Pause after a failed poll before trying again, in milliseconds. */
const RETRY_DELAY_MS = 3000
/** Coalesce a settings write and a token write into one restart. */
const RESTART_DEBOUNCE_MS = 300

/**
 * Split one Markdown table row into trimmed cells.
 * @param line - table row.
 * @returns cells without the outer pipes.
 */
function splitTableRow(line) {
  return line.replace(/^\s*\|/u, '').replace(/\|\s*$/u, '').split('|').map((cell) => cell.trim())
}

/**
 * Whether a line is a Markdown table separator.
 * @param line - candidate line.
 * @returns true for `|---|:---:|` rows.
 */
function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line)
}

/**
 * Whether a line looks like a Markdown table row.
 * @param line - candidate line.
 * @returns true when it has at least one inner pipe.
 */
function isTableRow(line) {
  return line.includes('|') && line.trim().length > 1 && !line.includes('\u0000')
}

/**
 * Convert Markdown tables into compact Telegram-friendly lists.
 * Telegram Markdown has no table syntax, so each row becomes one bullet.
 * @param markdown - raw assistant text.
 * @returns text with tables expanded to headings and bullets.
 */
function preprocessTables(markdown) {
  const lines = markdown.split('\n')
  const out = []
  let fenced = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*```/u.test(line)) fenced = !fenced
    if (!fenced && isTableRow(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line)
      out.push(`**${headers.join(' · ')}**`)
      index += 2
      while (index < lines.length && isTableRow(lines[index]) && !isTableSeparator(lines[index])) {
        out.push(`- ${splitTableRow(lines[index]).join(' · ')}`)
        index += 1
      }
      index -= 1
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Replace Markdown links to relative workspace paths with their labels.
 * Telegram cannot open relative paths, and telegramify-markdown double-escapes
 * their labels. Absolute http/tg/mailto links are preserved.
 * @param markdown - raw assistant text.
 * @returns text without relative links.
 */
function preprocessRelativeLinks(markdown) {
  const strip = (value) => value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (whole, label, target) => {
    if (/^(?:https?:|tg:|mailto:)/iu.test(target)) return whole
    return label
  })
  const out = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced
      out.push(line)
      continue
    }
    if (fenced) {
      out.push(line)
      continue
    }
    out.push(line.split(/(`[^`]*`)/gu).map((part) => part.startsWith('`') ? part : strip(part)).join(''))
  }
  return out.join('\n')
}

/**
 * Convert assistant Markdown to Telegram MarkdownV2.
 * @param markdown - raw assistant text.
 * @returns MarkdownV2 text, or the original text if conversion fails.
 */
function toTelegramMarkdown(markdown) {
  try {
    return telegramifyMarkdown(preprocessTables(preprocessRelativeLinks(markdown)), 'escape')
  } catch {
    return markdown
  }
}

/** Maximum converted MarkdownV2 length accepted by Telegram. */
const ANSWER_MARKDOWN_LIMIT = 3900

/**
 * Find the longest prefix whose converted MarkdownV2 fits Telegram.
 * @param text - raw Markdown.
 * @param limit - converted character budget.
 * @returns a safe partial prefix.
 */
function fitAnswerText(text, limit = ANSWER_MARKDOWN_LIMIT) {
  if (text.length === 0) return ''
  if (toTelegramMarkdown(text).length <= limit) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (toTelegramMarkdown(text.slice(0, middle)).length <= limit) low = middle
    else high = middle - 1
  }
  let cut = low
  const boundary = Math.max(text.lastIndexOf('\n', cut), text.lastIndexOf(' ', cut))
  if (boundary > cut / 2) cut = boundary
  const prefix = text.slice(0, cut).trimEnd()
  return prefix.length === 0 ? '' : `${prefix}…`
}

/**
 * Parse streamed tool arguments when they form complete JSON.
 * @param raw - raw argument string.
 * @returns the object, or undefined while the stream is incomplete.
 */
function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Convert one tool argument value to a compact single-line label.
 * @param value - argument value.
 * @returns display text.
 */
function compactToolValue(value) {
  if (typeof value === 'string') return value.replace(/\s+/gu, ' ').trim()
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).slice(0, 3).map(([key, item]) => `${key}=${compactToolValue(item)}`).join(' · ')
  }
  return String(value)
}

/**
 * Pick one argument by its possible names.
 * @param args - parsed tool arguments.
 * @param names - candidate keys.
 * @returns the first present value.
 */
function toolArg(args, ...names) {
  if (args === undefined) return undefined
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name]
  }
  return undefined
}

/**
 * Wrap text into fixed-width visual lines without dropping content.
 * @param text - source text.
 * @param width - target line width.
 * @returns wrapped lines.
 */
function wrapVisualLines(text, width = 52) {
  const lines = []
  for (const sourceLine of String(text).split('\n')) {
    const words = sourceLine.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean)
    let current = ''
    for (let word of words) {
      while (word.length > width) {
        if (current.length > 0) {
          lines.push(current)
          current = ''
        }
        lines.push(word.slice(0, width))
        word = word.slice(width)
      }
      if (word.length === 0) continue
      if (current.length === 0) current = word
      else if (current.length + 1 + word.length <= width) current += ` ${word}`
      else {
        lines.push(current)
        current = word
      }
    }
    if (current.length > 0) lines.push(current)
  }
  return lines
}

/**
 * Strip HTML tags for the plain-text fallback.
 * @param value - HTML body.
 * @returns readable plain text.
 */
function htmlToPlain(value) {
  return String(value)
    .replace(/<[^>]*>/gu, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

/**
 * Trim a session preview at a line boundary so formatting is not cut mid-construct.
 * @param text - raw assistant Markdown.
 * @param limit - maximum characters.
 * @returns clipped preview.
 */
function clipPreview(text, limit = 2500) {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const newline = cut.lastIndexOf('\n')
  return newline > limit / 2 ? cut.slice(0, newline) : cut
}

/**
 * Split raw Markdown into chunks whose converted MarkdownV2 fits Telegram.
 * @param text - complete answer.
 * @param limit - converted character budget.
 * @returns chunks in reading order.
 */
function splitAnswerText(text, limit = ANSWER_MARKDOWN_LIMIT) {
  const chunks = []
  let rest = text.trim()
  while (rest.length > 0) {
    if (toTelegramMarkdown(rest).length <= limit) {
      chunks.push(rest)
      break
    }
    let cut = Math.min(rest.length, 2200)
    const boundary = Math.max(rest.lastIndexOf('\n', cut), rest.lastIndexOf(' ', cut))
    if (boundary > cut / 2) cut = boundary
    while (cut > 200 && toTelegramMarkdown(rest.slice(0, cut)).length > limit) {
      cut = Math.floor(cut * 0.8)
      const nextBoundary = Math.max(rest.lastIndexOf('\n', cut), rest.lastIndexOf(' ', cut))
      if (nextBoundary > cut / 2) cut = nextBoundary
    }
    if (cut < 1) cut = Math.min(rest.length, 500)
    const chunk = rest.slice(0, cut).trimEnd()
    if (chunk.length === 0) break
    chunks.push(chunk)
    rest = rest.slice(cut).trimStart()
  }
  return chunks
}

/** Models exposed by the account route and their short menu labels. */
const MODEL_CHOICES = [
  { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },
]

/** Reasoning efforts accepted by the DeepSeek account adapter. */
const EFFORT_CHOICES = [
  { id: 'off', label: 'Off' },
  { id: 'low', label: 'Low' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
]

/** Command menu shown by Telegram clients while the user types `/`. */
const BOT_COMMANDS = [
  { command: 'start', description: 'Start the bot and show help' },
  { command: 'help', description: 'List commands' },
  { command: 'stop', description: 'Stop the current task' },
  { command: 'status', description: 'Bot and session status' },
  { command: 'sessions', description: 'Browse workspaces and sessions' },
  { command: 'current', description: 'Show the topic session' },
  { command: 'menu', description: 'Show the model and session controls' },
  { command: 'rename', description: 'Rename this Telegram topic' },
  { command: 'last', description: 'Show the latest assistant messages' },
  { command: 'restart', description: 'Restart the Telegram bot runtime' },
  { command: 'id', description: 'Show user and chat ids' },
  { command: 'ping', description: 'Check connectivity' },
]

/** Russian command menu for clients with language_code=ru. */
const BOT_COMMANDS_RU = [
  { command: 'start', description: 'Запустить бота и показать справку' },
  { command: 'help', description: 'Список команд' },
  { command: 'stop', description: 'Остановить текущую задачу' },
  { command: 'status', description: 'Статус бота и сессии' },
  { command: 'sessions', description: 'Выбрать workspace и сессию' },
  { command: 'current', description: 'Показать сессию этого топика' },
  { command: 'menu', description: 'Показать меню модели и сессии' },
  { command: 'rename', description: 'Переименовать Telegram-топик' },
  { command: 'last', description: 'Показать последние ответы ассистента' },
  { command: 'restart', description: 'Перезапустить Telegram-бота' },
  { command: 'id', description: 'Показать user id и chat id' },
  { command: 'ping', description: 'Проверить связь' },
]

/** Bound one Telegram message body to stay under the 4096-character API limit. */
const MAX_TELEGRAM_TEXT = 3800
/** Host-local diagnostics directory; no secrets are written here. */
const STATUS_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'telegram')

export const Config = z.object({
  /**
   * Credential reference that holds the bot token. The token itself lives in
   * the credential store (or the matching environment variable for headless
   * deployments); this config only names the reference.
   */
  tokenRef: z.string().default(DEFAULT_TOKEN_REF).volatile(),
  /** Whether the Telegram runtime should poll while this profile runs. */
  enabled: z.boolean().default(true).volatile(),
  /** Language of the bot's Telegram messages. */
  language: z.string().default('en').volatile(),
  /**
   * Telegram user ids or @usernames allowed to talk to the bot.
   * Empty means nobody, except the one-time setup hint described below.
   */
  allowedUsers: z.array(z.string()).default([]).volatile(),
  /**
   * Telegram chat ids or @channelnames the bot may answer in.
   * Empty means private chats only.
   */
  allowedChats: z.array(z.string()).default([]).volatile(),
  /**
   * Monotonic value the Restart button writes. Any settings update restarts the
   * runtime, but this field lets the button request a restart even when every
   * other field is unchanged.
   */
  restartRequest: z.number().default(0).volatile(),
  /** Working directory for Telegram-created DSH sessions. */
  cwd: z.string().default(process.cwd()).volatile(),
  /** Agent preset mounted for Telegram-created sessions when presets exist. */
  agentPreset: z.string().default('standard').volatile(),
  /** Mirror model reasoning deltas into the session topic. */
  showThinking: z.boolean().default(true).volatile(),
  /** Mirror tool calls into the session topic. */
  showToolCalls: z.boolean().default(true).volatile(),
})

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
      }
    }
  } catch {
    // Missing or corrupt state is nonfatal; the next session creates a mapping.
  }
  return { version: 2, sessions: {}, threads: {} }
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

/** Last published runtime snapshot, mirrored to a local diagnostics file. */
let runtimeStatus = {
  state: 'starting',
  detail: '',
  username: '',
  updatedAt: new Date().toISOString(),
  transport: 'https-ipv4',
  version: '0.3.0',
  agentBridge: 'v1',
  codeRevision: 'helpers-restored',
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

/**
 * Mount the settings namespace and the small Telegram runtime.
 * @param ctx - Host plugin context.
 * @param config - live plugin configuration.
 */
export function apply(ctx, config) {
  /** Active runtime lifetime, if polling is running. */
  let lifetime
  /** Bot identity from getMe, when connected. */
  let me
  /** When the current runtime started, in milliseconds. */
  let startedAt = 0
  /** Pending debounced restart. */
  let restartTimer
  /** Whether a restart is currently stopping or starting. */
  let restarting = false
  /** A restart requested while another was in flight. */
  let restartQueued = false
  /** Durable chat → session mapping. */
  let state = { version: 2, sessions: {}, threads: {} }
  /** Serializes state-file writes. */
  let stateWrite = Promise.resolve()
  /** Per-chat live bridge state. */
  const chats = new Map()
  /** Agent API calls use this lifetime; the bot polling lifetime is separate. */
  const bridgeAbort = new AbortController()
  /** Control chat id used for lifecycle notifications. */
  let topics = { chatId: 0 }
  /** Resolves after the mapping and topic files have been read. */
  const stateReady = Promise.all([
    loadState().then((loaded) => { state = loaded }),
    loadTopics().then((loaded) => { topics = loaded }),
  ]).catch((error) => warn(`state load failed: ${messageOf(error)}`))

  /**
   * Persist the chat → session mapping atomically.
   * @returns the queued write.
   */
  function persistState() {
    stateWrite = stateWrite.then(async () => {
      await mkdir(STATUS_DIR, { recursive: true })
      const temporary = `${STATE_PATH}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
      await rename(temporary, STATE_PATH)
    }).catch((error) => warn(`state write failed: ${messageOf(error)}`))
    return stateWrite
  }

  /**
   * Resolve one chat's transient bridge state.
   * @param chatId - Telegram chat id.
   * @returns the chat state.
   */
  async function chatFor(chatId, threadId) {
    await stateReady
    const key = `${chatId}:${threadId ?? 0}`
    let chat = chats.get(key)
    if (chat === undefined) {
      const boundSession = state.threads[key]
      chat = {
        key,
        chatId,
        threadId,
        sessionId: boundSession,
        cwd: boundSession === undefined ? undefined : state.sessions[boundSession]?.cwd,
        selection: undefined,
        permission: boundSession === undefined ? undefined : state.sessions[boundSession]?.permission,
        busy: false,
        done: true,
        text: '',
        textSeparator: false,
        lastText: '',
        messageId: null,
        editTimer: null,
        thinkingText: '',
        thinkingShown: 0,
        thinkingMessageId: null,
        thinkingTimer: null,
        thinkingLastText: '',
        tools: [],
        toolMessageId: null,
        toolTimer: null,
        toolLastText: '',
        boundAgent: undefined,
        questionAgent: undefined,
      }
      chats.set(key, chat)
    }
    return chat
  }

  /**
   * Bind one session to a Telegram topic.
   * @param chat - chat bridge state.
   * @param sessionId - DSH session id.
   * @param title - display title.
   */
  async function bindSession(chat, sessionId, title, cwd) {
    chat.sessionId = sessionId
    if (typeof cwd === 'string' && cwd.length > 0) chat.cwd = cwd
    state.threads[chat.key] = sessionId
    state.sessions[sessionId] = {
      sessionId,
      chatId: chat.chatId,
      threadId: chat.threadId,
      title: title ?? state.sessions[sessionId]?.title ?? '',
      ...(state.sessions[sessionId]?.titleLocked === true ? { titleLocked: true } : {}),
      ...(chat.cwd === undefined ? {} : { cwd: chat.cwd }),
      ...(chat.selection?.current?.model === undefined ? {} : { model: chat.selection.current.model }),
      ...(chat.selection?.current?.reasoningEffort === undefined ? {} : { effort: chat.selection.current.reasoningEffort }),
      ...(chat.permission === undefined ? {} : { permission: chat.permission }),
      updatedAt: Date.now(),
    }
    await persistState()
  }

  /** @returns the configured session working directory. */
  function cwdOf() {
    const configured = readLive(config.cwd, process.cwd())
    return typeof configured === 'string' && configured.length > 0 ? resolve(configured) : process.cwd()
  }

  /** @returns the configured preset name, or undefined. */
  function presetOf() {
    const preset = readLive(config.agentPreset, '')
    return typeof preset === 'string' && preset.trim().length > 0 ? preset.trim() : undefined
  }

  /** @returns the current default model selection, when the service exists. */
  function modelSelection() {
    const service = ctx.get('agentDefaultModel')
    if (service === undefined) return undefined
    try {
      const selection = service.currentSelection()
      if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') return selection
    } catch {
      // A deployment without a default-model service creates a plain agent.
    }
    return undefined
  }

  /**
   * Resolve the preferred model state for one chat from durable prefs or defaults.
   * @param chat - chat bridge state.
   * @returns mutable selection state used by the model-selection listener.
   */
  function selectionForChat(chat) {
    if (chat.selection !== undefined) return chat.selection
    const record = typeof chat.sessionId === 'string' ? state.sessions[chat.sessionId] : undefined
    const fallback = modelSelection()
    const provider = record?.provider ?? fallback?.provider ?? 'deepseek-official'
    const model = record?.model ?? fallback?.model ?? 'deepseek-flash'
    const effort = record?.effort ?? fallback?.reasoningEffort ?? 'high'
    chat.selection = {
      current: {
        provider,
        model,
        reasoningEffort: effort,
      },
      assembled: undefined,
    }
    return chat.selection
  }

  /**
   * Recover the current model/effort for a selected session when state has no override.
   * @param chat - chat bridge state.
   */
  async function hydrateSelection(chat) {
    if (chat.selection !== undefined) return
    const record = typeof chat.sessionId === 'string' ? state.sessions[chat.sessionId] : undefined
    let provider = record?.provider
    let model = record?.model
    let effort = record?.effort
    if ((model === undefined || provider === undefined) && typeof chat.sessionId === 'string') {
      try {
        const snapshot = await ctx.get('sessionQuery')?.readSession(chat.sessionId)
        const events = snapshot?.events ?? []
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event?.type !== 'request/header') continue
          const config = event.data?.header?.config
          if (typeof config?.provider === 'string') provider = config.provider
          if (typeof config?.model === 'string') model = config.model
          if (typeof config?.reasoningEffort === 'string') effort = config.reasoningEffort
          break
        }
      } catch {
        // A corrupt or empty session falls back to the default selection.
      }
    }
    chat.selection = selectionForChat({
      ...chat,
      selection: {
        current: {
          provider: provider ?? modelSelection()?.provider ?? 'deepseek-official',
          model: model ?? modelSelection()?.model ?? 'deepseek-flash',
          reasoningEffort: effort ?? 'high',
        },
        assembled: undefined,
      },
    })
  }

  /** Cached provider model names, populated from the live catalog. */
  let modelChoicesCache

  /**
   * Load model ids and the exact display names used by the Web model picker.
   * @returns model choices.
   */
  async function loadModelChoices() {
    if (modelChoicesCache !== undefined) return modelChoicesCache
    try {
      const models = await ctx.get('llm')?.listModels('deepseek-official')
      const choices = []
      for (const wanted of MODEL_CHOICES) {
        const found = models?.find((entry) => entry.id === wanted.id)
        choices.push({ id: wanted.id, label: found?.name ?? wanted.label })
      }
      modelChoicesCache = choices
    } catch {
      modelChoicesCache = MODEL_CHOICES
    }
    return modelChoicesCache
  }

  /** @returns the display label for a model id. */
  function modelLabel(model) {
    return (modelChoicesCache ?? MODEL_CHOICES).find((choice) => choice.id === model)?.label ?? String(model ?? '?')
  }

  /** @returns the display label for an effort id. */
  function effortLabel(effort) {
    return EFFORT_CHOICES.find((choice) => choice.id === effort)?.label ?? 'High'
  }

  /**
   * Pick a distinct emoji for the tool currently being called.
   * @param name - tool name.
   * @returns a short visual marker.
   */
  function toolEmoji(name) {
    const tool = String(name ?? '').toLowerCase()
    if (tool.includes('bash') || tool.includes('shell') || tool.includes('pwsh')) return '💻'
    if (tool.includes('read') && !tool.includes('read_image')) return '📖'
    if (tool.includes('write') || tool.includes('edit')) return '✍️'
    if (tool.includes('read_image')) return '🖼️'
    if (tool.includes('web_fetch') || tool.includes('web_search')) return '🌐'
    if (tool.includes('grep') || tool.includes('glob') || tool.includes('search')) return '🔎'
    if (tool.includes('subagent') || tool.includes('agent')) return '🤖'
    if (tool.includes('workflow')) return '🔄'
    if (tool.includes('ask_user') || tool.includes('question')) return '💬'
    if (tool.includes('todo')) return '📋'
    if (tool.includes('goal')) return '🎯'
    if (tool.includes('schedule')) return '⏰'
    if (tool.includes('job')) return '🧵'
    if (tool.includes('present')) return '🎁'
    if (tool.includes('skill')) return '🧩'
    if (tool.includes('send_message')) return '✉️'
    if (tool.includes('working_directory')) return '📁'
    return '🔧'
  }

  /**
   * Format one tool call as a compact Telegram HTML line.
   * @param tool - tool name and streamed JSON arguments.
   * @returns HTML for the rolling tool message.
   */
  function formatToolCall(tool) {
    const name = String(tool.name || 'tool')
    const args = parseToolArguments(tool.args)
    let detail
    if (args !== undefined) {
      switch (name) {
        case 'bash':
        case 'shell':
          detail = toolArg(args, 'command', 'cmd', 'input')
          break
        case 'read':
        case 'read_image':
          detail = toolArg(args, 'path', 'file_path', 'filename')
          break
        case 'write': {
          const path = toolArg(args, 'path', 'file_path')
          const content = toolArg(args, 'content', 'text')
          detail = `${path ?? ''}${typeof content === 'string' ? ` · ${content.length} chars` : ''}`
          break
        }
        case 'edit': {
          const path = toolArg(args, 'path', 'file_path')
          detail = path === undefined ? undefined : `${path}`
          break
        }
        case 'glob': {
          const pattern = toolArg(args, 'pattern')
          const path = toolArg(args, 'path')
          detail = pattern === undefined ? path : `${pattern}${path === undefined ? '' : ` in ${path}`}`
          break
        }
        case 'grep': {
          const pattern = toolArg(args, 'pattern')
          const path = toolArg(args, 'path', 'include')
          detail = pattern === undefined ? path : `${pattern}${path === undefined ? '' : ` in ${path}`}`
          break
        }
        case 'web_search':
        case 'free_search':
          detail = toolArg(args, 'query')
          break
        case 'web_fetch':
          detail = toolArg(args, 'url')
          break
        case 'ask_user_question': {
          const questions = toolArg(args, 'questions')
          detail = Array.isArray(questions) && questions[0] !== undefined ? questions[0].question : undefined
          break
        }
        case 'subagent':
          detail = toolArg(args, 'description', 'prompt', 'label')
          break
        case 'workflow':
          detail = toolArg(args, 'name', 'description')
          break
        case 'todo_write': {
          const todos = toolArg(args, 'todos')
          detail = Array.isArray(todos) ? `${todos.length} item${todos.length === 1 ? '' : 's'}` : undefined
          break
        }
        case 'create_goal':
        case 'update_goal':
          detail = toolArg(args, 'objective')
          break
        case 'schedule_create':
        case 'schedule_update':
          detail = toolArg(args, 'title', 'prompt')
          break
        case 'present': {
          const files = toolArg(args, 'files')
          detail = Array.isArray(files) ? `${files.length} file${files.length === 1 ? '' : 's'}` : undefined
          break
        }
        case 'send_message':
          detail = toolArg(args, 'message', 'text')
          break
        case 'working_directory':
          detail = toolArg(args, 'path')
          break
        default:
          detail = Object.entries(args).slice(0, 3).map(([key, value]) => `${key}=${compactToolValue(value)}`).join(' · ')
      }
    }
    if (detail === undefined || detail === null || String(detail).trim().length === 0) {
      const raw = String(tool.args ?? '').replace(/[{}\[\]"]/gu, '').replace(/\s+/gu, ' ').trim()
      detail = raw
    }
    const label = `<b>${escapeHtml(name)}:</b>`
    if (detail === undefined || String(detail).trim().length === 0) return `${toolEmoji(name)} <b>${escapeHtml(name)}</b>`
    const compact = String(detail).replace(/\s+/gu, ' ').trim()
    const first = compact.slice(0, 36)
    const second = compact.slice(36, 80)
    return `${toolEmoji(name)} ${label} <code>${escapeHtml(first)}</code>${second.length === 0 ? '' : `\n<code>${escapeHtml(second)}</code>`}`
  }

  /**
   * Persist the selected model/effort and permission on the session record.
   * @param chat - chat bridge state.
   */
  async function persistPreferences(chat) {
    if (typeof chat.sessionId !== 'string') return
    const record = state.sessions[chat.sessionId]
    if (record === undefined) return
    const current = chat.selection?.current
    if (current !== undefined) {
      record.provider = current.provider
      record.model = current.model
      record.effort = current.reasoningEffort
    }
    if (chat.permission !== undefined) record.permission = chat.permission
    await persistState()
  }

  /** @returns the current permission preset for one chat. */
  function currentPermission(chat) {
    const service = ctx.get('permissionPresets')
    if (service !== undefined && typeof chat.sessionId === 'string') {
      const agent = ctx.get('agents')?.get(chat.sessionId)
      if (agent !== undefined) {
        try {
          return service.current(agent.session)
        } catch {
          // Fall through to the stored value.
        }
      }
    }
    return chat.permission ?? service?.defaultPreset ?? 'workspace-write'
  }

  /**
   * Append permission knob events when the preset service is remote-only.
   * @param chat - chat bridge state.
   * @param agent - live agent.
   * @param name - preset name.
   * @returns whether the fallback applied.
   */
  function applyPermissionFallback(chat, agent, name) {
    const specs = {
      'workspace-write': ['workspace-write', 'ask'],
      'danger-full-access': ['danger-full-access', 'never'],
      'read-only': ['read-only', 'ask'],
    }
    const spec = specs[name]
    if (spec === undefined) return false
    try {
      agent.session.append('permission/preset', { preset: name })
      agent.session.append('sandbox/mode', { mode: spec[0] })
      agent.session.append('approval/policy', { policy: spec[1] })
      chat.permission = name
      return true
    } catch (error) {
      warn(`permission fallback failed: ${messageOf(error)}`)
      return false
    }
  }

  /**
   * Apply the selected permission preset to a live session.
   * @param chat - chat bridge state.
   * @param agent - live agent.
   */
  async function applyPermission(chat, agent) {
    const service = ctx.get('permissionPresets')
    if (service === undefined) return
    try {
      if (chat.permission === undefined) {
        chat.permission = typeof service.current === 'function'
          ? service.current(agent.session)
          : service.defaultPreset
        await persistPreferences(chat)
        return
      }
      if (typeof service.set === 'function') {
        service.set(agent.session, chat.permission)
      } else {
        applyPermissionFallback(chat, agent, chat.permission)
      }
      await persistPreferences(chat)
    } catch (error) {
      warn(`permission set failed: ${messageOf(error)}`)
    }
  }

  /** @returns a compact token count, e.g. 1M or 12.3k. */
  function formatTokens(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '?'
    if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
    if (value >= 1000) return `${Math.round(value / 100) / 10}k`
    return String(value)
  }

  /**
   * Read context capacity and last request usage for one chat.
   * @param chat - chat bridge state.
   * @returns display summary.
   */
  async function contextSummary(chat) {
    const current = selectionForChat(chat).current
    let windowSize
    try {
      const info = await ctx.get('llm')?.resolveModel(current.provider, current.model)
      windowSize = info?.context?.contextWindow
    } catch {
      // Capacity is optional.
    }
    if (windowSize === undefined) windowSize = 1_000_000
    let used
    let inputTokens
    let cacheRead
    if (typeof chat.sessionId === 'string') {
      try {
        const surface = await ctx.get('sessionQuery')?.readSurface(chat.sessionId)
        const events = surface?.events ?? []
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event?.type !== 'assistant/message') continue
          const usage = event.data?.usage ?? event.data?.message?.usage
          if (usage !== undefined) {
            inputTokens = usage.inputTokens
            cacheRead = usage.cacheReadTokens
            used = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
            break
          }
        }
      } catch {
        // Usage is optional.
      }
    }
    return { windowSize, used, inputTokens, cacheRead }
  }

  const logger = ctx.logger
  const info = (message) => logger?.info?.(`[telegram] ${message}`)
  const warn = (message) => logger?.warn?.(`[telegram] ${message}`)

  /** @returns the configured bot language, defaulting to English. */
  function botLanguage() {
    return readLive(config.language, 'en') === 'ru' ? 'ru' : 'en'
  }

  /**
   * Pick a string for the configured bot language.
   * @param en - English text.
   * @param ru - Russian text.
   * @returns the selected text.
   */
  function tr(en, ru) {
    return botLanguage() === 'ru' ? ru : en
  }

  /**
   * Resolve the token from the credential seam, then the process environment.
   * @returns the current token, or undefined when none is configured.
   */
  async function resolveToken() {
    const ref = tokenRefOf(config)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && resolved.value.length > 0) return resolved.value
    }
    const ambient = process.env[ref]
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }

  /**
   * Call one Bot API method. Errors carry Telegram's description, never the
   * token or the request URL.
   * @param method - Bot API method.
   * @param payload - JSON body.
   * @param signal - runtime lifetime.
   * @returns the method result.
   */
  async function call(method, payload, signal, timeoutMs = 30_000) {
    const token = await resolveToken()
    if (token === undefined) throw new Error('TELEGRAM_BOT_TOKEN is not configured')
    const body = JSON.stringify(payload)
    // Mirror Hermes' Telegram fallback: try the normal IPv4 path first, then
    // the Bot API seed IPv4 literals with Host/SNI kept on api.telegram.org.
    // Some networks blackhole one family or one anycast path for long polls
    // while short requests still succeed.
    const targets = [undefined, '149.154.166.110', '149.154.167.220']
    let lastError
    for (const target of targets) {
      try {
        return await requestOnce(target, token, method, body, signal, timeoutMs)
      } catch (error) {
        lastError = error
        if (signal.aborted) throw error
        // An API-level refusal is final (not a network path problem).
        if (error?.telegram === true) throw error
      }
    }
    throw lastError ?? new Error(`Telegram ${method} failed`)
  }

  /**
   * One HTTPS Bot API request, optionally pinned to an IPv4 literal.
   * @param target - IPv4 literal, or undefined for the normal hostname.
   * @param token - bot token.
   * @param method - Bot API method.
   * @param body - serialized JSON body.
   * @param signal - runtime lifetime.
   * @param timeoutMs - socket inactivity bound.
   * @returns the Bot API result.
   */
  function requestOnce(target, token, method, body, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      const options = {
        host: target ?? 'api.telegram.org',
        port: 443,
        path: `/bot${token}/${method}`,
        method: 'POST',
        family: 4,
        servername: 'api.telegram.org',
        headers: {
          host: 'api.telegram.org',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
        agent: false,
      }
      const request = https.request(options, (response) => {
        let data = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          data += chunk
          if (data.length > 2_000_000) request.destroy(new Error('Telegram response too large'))
        })
        response.on('end', () => {
          let parsed
          try {
            parsed = JSON.parse(data)
          } catch {
            reject(new Error(`Telegram ${method} returned non-JSON HTTP ${response.statusCode}`))
            return
          }
          if (parsed?.ok !== true) {
            const error = new Error(parsed?.description ?? `Telegram API HTTP ${response.statusCode}`)
            error.telegram = true
            reject(error)
            return
          }
          resolve(parsed.result)
        })
      })
      const abort = () => request.destroy(new Error('Telegram request aborted'))
      signal.addEventListener('abort', abort, { once: true })
      const finish = (fn) => (value) => {
        signal.removeEventListener('abort', abort)
        fn(value)
      }
      request.on('timeout', () => request.destroy(new Error(`Telegram ${method} timed out`)))
      request.on('error', finish(reject))
      request.on('close', () => signal.removeEventListener('abort', abort))
      request.end(body)
    })
  }

  /**
   * Publish the command menu so Telegram clients show hints while typing `/`.
   * @param signal - runtime lifetime.
   */
  async function publishCommands(signal) {
    const language = botLanguage()
    const commands = language === 'ru' ? BOT_COMMANDS_RU : BOT_COMMANDS
    try {
      await call('setMyCommands', { commands, scope: { type: 'default' } }, signal, 15_000)
      if (language === 'ru') {
        await call('setMyCommands', { commands, scope: { type: 'default' }, language_code: 'ru' }, signal, 15_000)
      } else {
        await call('deleteMyCommands', { scope: { type: 'default' }, language_code: 'ru' }, signal, 15_000).catch(() => {})
      }
      await publishStatus({ commands: 'published', commandsLanguage: language })
    } catch (error) {
      if (!signal.aborted) warn(`setMyCommands failed: ${messageOf(error)}`)
      await publishStatus({ commands: 'failed', detail: messageOf(error) })
    }
  }

  /**
   * Send a plain-text message.
   * @param chatId - target chat.
   * @param text - body.
   * @param signal - request lifetime.
   * @param threadId - topic thread.
   * @returns the Bot API result, or undefined.
   */
  async function sendPlain(chatId, text, signal, threadId) {
    try {
      return await call('sendMessage', {
        chat_id: chatId,
        ...(threadId === undefined || threadId === 0 ? {} : { message_thread_id: threadId }),
        text,
      }, signal)
    } catch (error) {
      if (!signal.aborted) warn(`sendMessage failed: ${messageOf(error)}`)
      return undefined
    }
  }

  /**
   * Edit one plain-text message.
   * @param chatId - target chat.
   * @param messageId - message to edit.
   * @param text - new body.
   * @param signal - request lifetime.
   * @param threadId - topic thread.
   * @returns true when the edit succeeded.
   */
  async function editPlain(chatId, messageId, text, signal, threadId) {
    try {
      await call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        ...(threadId === undefined || threadId === 0 ? {} : { message_thread_id: threadId }),
        text,
      }, signal)
      return true
    } catch (error) {
      const message = messageOf(error)
      if (!signal.aborted && !/not modified/i.test(message)) warn(`editMessageText failed: ${message}`)
      return /not modified/i.test(message)
    }
  }

  /**
   * Send an assistant answer with Telegram MarkdownV2 formatting.
   * Falls back to plain text when Telegram rejects the entities.
   * @param chatId - target chat.
   * @param text - raw Markdown answer.
   * @param signal - request lifetime.
   * @param threadId - topic thread.
   * @returns the Bot API result, or undefined.
   */
  async function sendAnswer(chatId, text, signal, threadId) {
    const body = toTelegramMarkdown(text)
    try {
      return await call('sendMessage', {
        chat_id: chatId,
        ...(threadId === undefined || threadId === 0 ? {} : { message_thread_id: threadId }),
        text: body,
        parse_mode: 'MarkdownV2',
      }, signal)
    } catch (error) {
      const detail = messageOf(error)
      if (!signal.aborted) warn(`MarkdownV2 send failed, falling back to plain text: ${detail}`)
      await publishStatus({ lastFormatFallback: detail })
      return sendPlain(chatId, text, signal, threadId)
    }
  }

  /**
   * Edit an assistant answer with Telegram MarkdownV2 formatting.
   * @param chatId - target chat.
   * @param messageId - message to edit.
   * @param text - raw Markdown answer.
   * @param signal - request lifetime.
   * @param threadId - topic thread.
   * @returns true when the message was edited.
   */
  async function editAnswer(chatId, messageId, text, signal, threadId) {
    const body = toTelegramMarkdown(text)
    try {
      await call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        ...(threadId === undefined || threadId === 0 ? {} : { message_thread_id: threadId }),
        text: body,
        parse_mode: 'MarkdownV2',
      }, signal)
      return true
    } catch (error) {
      const detail = messageOf(error)
      if (!signal.aborted && !/not modified/i.test(detail)) {
        warn(`MarkdownV2 edit failed, falling back to plain text: ${detail}`)
        await publishStatus({ lastFormatFallback: detail })
      }
      return editPlain(chatId, messageId, text, signal, threadId)
    }
  }

  /**
   * Send one Markdown-formatted message with an inline keyboard.
   * @param chatId - target chat.
   * @param threadId - topic thread.
   * @param text - raw Markdown body.
   * @param keyboard - inline keyboard rows.
   * @param signal - request lifetime.
   * @returns the Bot API result, or undefined.
   */
  async function sendKeyboardMarkdown(chatId, threadId, text, keyboard, signal) {
    const body = toTelegramMarkdown(text)
    try {
      return await call('sendMessage', {
        chat_id: chatId,
        ...(threadId === undefined || threadId === 0 ? {} : { message_thread_id: threadId }),
        text: body,
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      }, signal)
    } catch (error) {
      const detail = messageOf(error)
      if (!signal.aborted) {
        warn(`MarkdownV2 keyboard send failed, falling back: ${detail}`)
        await publishStatus({ lastFormatFallback: detail })
      }
      return call('sendMessage', {
        chat_id: chatId,
        ...(threadId === undefined || threadId === 0 ? {} : { message_thread_id: threadId }),
        text,
        reply_markup: { inline_keyboard: keyboard },
      }, signal).catch(() => undefined)
    }
  }

  /**
   * Edit one Markdown-formatted message and replace its keyboard.
   * @param chatId - target chat.
   * @param threadId - topic thread.
   * @param messageId - message to edit.
   * @param text - raw Markdown body.
   * @param keyboard - inline keyboard rows.
   * @param signal - request lifetime.
   * @returns true when the edit succeeded.
   */
  async function editKeyboardMarkdown(chatId, threadId, messageId, text, keyboard, signal) {
    const body = toTelegramMarkdown(text)
    try {
      await call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        ...(threadId === undefined || threadId === 0 ? {} : { message_thread_id: threadId }),
        text: body,
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      }, signal)
      return true
    } catch (error) {
      const detail = messageOf(error)
      if (/not modified/i.test(detail)) return true
      if (!signal.aborted) {
        warn(`MarkdownV2 keyboard edit failed, falling back: ${detail}`)
        await publishStatus({ lastFormatFallback: detail })
      }
      try {
        await call('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          ...(threadId === undefined || threadId === 0 ? {} : { message_thread_id: threadId }),
          text,
          reply_markup: { inline_keyboard: keyboard },
        }, signal)
        return true
      } catch {
        return false
      }
    }
  }

  /**
   * Render a Markdown main menu, editing the previous one when possible.
   * @param chatId - target chat.
   * @param threadId - topic thread.
   * @param messageId - panel message to edit.
   * @param text - raw Markdown body.
   * @param keyboard - inline keyboard rows.
   * @param signal - request lifetime.
   * @returns resolves after the send/edit.
   */
  async function renderMenuMarkdown(chatId, threadId, messageId, text, keyboard, signal) {
    if (messageId !== undefined && await editKeyboardMarkdown(chatId, threadId, messageId, text, keyboard, signal)) return
    await sendKeyboardMarkdown(chatId, threadId, text, keyboard, signal)
  }

  /**
   * Split text into Telegram-sized chunks.
   * @param text - full response.
   * @param limit - maximum raw characters per chunk.
   * @returns chunks under the API limit.
   */
  function splitTelegramText(text, limit = MAX_TELEGRAM_TEXT) {
    const chunks = []
    let rest = text
    while (rest.length > limit) {
      let cut = rest.lastIndexOf('\n', limit)
      if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit)
      if (cut < limit / 2) cut = limit
      chunks.push(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^\s+/u, '')
    }
    if (rest.length > 0) chunks.push(rest)
    return chunks
  }

  /**
   * Render the streaming buffer for Telegram.
   * @param chat - chat bridge state.
   * @returns a bounded message body.
   */
  function renderChat(chat) {
    const text = chat.text.trim()
    if (text.length === 0) return ''
    return fitAnswerText(text)
  }

  /** Pending inline approval prompts keyed by short callback id. */
  const pendingApprovals = new Map()
  /** Pending structured user questions keyed by short callback id. */
  const pendingQuestions = new Map()

  /**
   * Resolve one pending approval and update its prompt in place.
   * @param id - short approval id.
   * @param outcome - approval outcome.
   * @returns whether a pending request was settled.
   */
  function settleApproval(id, outcome) {
    const pending = pendingApprovals.get(id)
    if (pending === undefined) return false
    pendingApprovals.delete(id)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    pending.resolve(outcome)
    const label = outcome === 'allowed-once'
      ? tr('✅ Allowed', '✅ Разрешено')
      : outcome === 'rejected'
        ? tr('❌ Denied', '❌ Отклонено')
        : tr('⏹ Request cancelled', '⏹ Запрос отменён')
    void editKeyboard(
      pending.chatId,
      pending.threadId,
      pending.messageId,
      `${label}\n\n<b>${escapeHtml(pending.toolName)}</b>`,
      [],
      bridgeAbort.signal,
    )
    return true
  }

  /**
   * Ask the Telegram user to approve one tool call.
   * @param agent - requesting agent.
   * @param chat - chat bridge state.
   * @param req - approval request.
   * @param next - downstream answerer chain.
   * @returns approval outcome.
   */
  async function requestApproval(agent, chat, req, next) {
    if (chat.boundAgent !== agent) return next()
    if (req.signal?.aborted) return 'cancelled'
    const id = randomUUID().replaceAll('-', '').slice(0, 10)
    const reason = req.displayReason?.ru
      ?? req.displayReason?.en
      ?? req.reason
      ?? tr('The tool requested approval.', 'Инструмент запросил разрешение.')
    const text =
      `🔐 <b>${tr('Approval required', 'Требуется разрешение')}</b>\n\n` +
      `<b>${tr('Tool', 'Инструмент')}:</b> <code>${escapeHtml(req.toolName)}</code>\n` +
      `<b>${tr('Session', 'Сессия')}:</b> <code>${escapeHtml(String(chat.sessionId))}</code>\n\n` +
      `<blockquote>${escapeHtml(reason)}</blockquote>`
    const result = await sendKeyboard(
      chat.chatId,
      chat.threadId,
      text,
      [[
        { text: tr('❌ Deny', '❌ Отклонить'), callback_data: `a:n:${id}` },
        { text: tr('✅ Allow', '✅ Разрешить'), callback_data: `a:y:${id}` },
      ]],
      bridgeAbort.signal,
    )
    if (result?.message_id === undefined) return 'unavailable'
    const messageId = result.message_id
    return new Promise((resolve) => {
      const onAbort = () => {
        settleApproval(id, 'cancelled')
      }
      const pending = {
        resolve,
        chatId: chat.chatId,
        threadId: chat.threadId,
        messageId,
        toolName: req.toolName,
        signal: req.signal,
        onAbort,
      }
      pendingApprovals.set(id, pending)
      if (req.signal !== undefined) req.signal.addEventListener('abort', onAbort, { once: true })
      if (req.signal?.aborted) onAbort()
    })
  }

  /**
   * Find a pending question batch for one Telegram topic.
   * @param chatId - Telegram chat id.
   * @param threadId - topic thread.
   * @returns the pending batch, if any.
   */
  function pendingQuestionFor(chatId, threadId) {
    for (const pending of pendingQuestions.values()) {
      if (pending.chatId === chatId && pending.threadId === threadId) return pending
    }
    return undefined
  }

  /**
   * Render the current question prompt as raw Markdown.
   * @param pending - in-flight question batch.
   * @returns Markdown body.
   */
  function questionText(pending) {
    const question = pending.questions[pending.index]
    const lines = []
    if (question.header !== undefined) lines.push(`**${question.header}**`)
    if (question.intent?.kind === 'plan-review') lines.push(`**${tr('Plan review', 'Проверка плана')}**`)
    lines.push(question.question)
    if (question.detail !== undefined) {
      const detail = question.detail.length > 3000 ? `${question.detail.slice(0, 2999)}…` : question.detail
      lines.push('', detail)
    }
    lines.push('', `_${tr('Question', 'Вопрос')} ${pending.index + 1}/${pending.questions.length}_`)
    if (pending.awaitingCustom) lines.push(`**${tr('Reply to this message with your answer.', 'Ответь на это сообщение своим вариантом.')}**`)
    else if ((question.options ?? []).length === 0) lines.push(`**${tr('Reply to this message with your answer.', 'Ответь на это сообщение своим вариантом.')}**`)
    return lines.join('\n')
  }

  /**
   * Build the inline keyboard for the current question.
   * @param pending - in-flight question batch.
   * @returns keyboard rows.
   */
  function questionKeyboard(pending) {
    const question = pending.questions[pending.index]
    const rows = []
    for (const [index, option] of (question.options ?? []).slice(0, 8).entries()) {
      const mark = pending.selected.has(option.label) ? '✅ ' : ''
      rows.push([{ text: `${mark}${shortLabel(option.label, 50)}`, callback_data: `q:${pending.id}:${index}` }])
    }
    if (question.multiSelect === true) {
      rows.push([{ text: tr('✅ Done', '✅ Готово'), callback_data: `q:${pending.id}:done` }])
    }
    if ((question.options ?? []).length > 0) {
      rows.push([{ text: tr('✍️ Custom answer', '✍️ Свой ответ'), callback_data: `q:${pending.id}:custom` }])
    }
    return rows
  }

  /**
   * Send or update the current question prompt in its topic.
   * @param pending - in-flight question batch.
   * @returns true when Telegram accepted the prompt.
   */
  async function sendQuestionPrompt(pending) {
    const question = pending.questions[pending.index]
    pending.awaitingCustom = (question.options ?? []).length === 0
    const keyboard = pending.awaitingCustom ? [] : questionKeyboard(pending)
    const result = await sendKeyboardMarkdown(
      pending.chatId,
      pending.threadId,
      questionText(pending),
      keyboard,
      pending.signal,
    )
    if (result?.message_id === undefined) return false
    pending.messageId = result.message_id
    return true
  }

  /**
   * Finish a question batch and resolve the DSH request.
   * @param pending - completed batch.
   */
  function finishQuestions(pending) {
    if (!pendingQuestions.delete(pending.id)) return
    pending.signal?.removeEventListener('abort', pending.onAbort)
    pending.resolve({ answers: pending.answers })
    void editKeyboardMarkdown(
      pending.chatId,
      pending.threadId,
      pending.messageId,
      `✅ **${tr('Answer recorded', 'Ответ принят')}**`,
      [],
      bridgeAbort.signal,
    )
  }

  /**
   * Record one answer and advance to the next question.
   * @param pending - in-flight batch.
   * @param selected - selected option labels.
   * @param custom - optional free-text answer.
   * @param signal - request lifetime.
   */
  async function completeQuestion(pending, selected, custom, signal) {
    if (pending.busy) return
    pending.busy = true
    try {
      const question = pending.questions[pending.index]
      pending.answers.push({
        id: question.id,
        selected,
        ...(custom === undefined || custom.length === 0 ? {} : { custom }),
      })
      const summary = [
        `✅ **${tr('Answer recorded', 'Ответ принят')}**`,
        '',
        question.question,
        ...(selected.length > 0 ? [`${tr('Selected', 'Выбрано')}: ${selected.join(', ')}`] : []),
        ...(custom !== undefined && custom.length > 0 ? [`${tr('Custom', 'Свой ответ')}: ${custom}`] : []),
      ].join('\n')
      await editKeyboardMarkdown(pending.chatId, pending.threadId, pending.messageId, summary, [], signal)
      pending.selected = new Set()
      pending.awaitingCustom = false
      pending.index += 1
      if (pending.index < pending.questions.length) {
        if (!await sendQuestionPrompt(pending)) {
          pendingQuestions.delete(pending.id)
          pending.signal?.removeEventListener('abort', pending.onAbort)
          pending.reject(new Error('Telegram could not display the next question'))
        }
      } else {
        finishQuestions(pending)
      }
    } finally {
      pending.busy = false
    }
  }

  /**
   * Ask the Telegram user one structured question batch.
   * @param agent - requesting agent.
   * @param chat - chat bridge state.
   * @param req - user-questions request.
   * @param next - downstream answerer chain.
   * @returns the structured answer.
   */
  async function requestUserQuestions(agent, chat, req, next) {
    if (chat.boundAgent !== agent || typeof chat.sessionId !== 'string') return next()
    if (pendingQuestionFor(chat.chatId, chat.threadId) !== undefined) return next()
    const signal = req.signal ?? bridgeAbort.signal
    if (signal.aborted) return next()
    const id = randomUUID().replaceAll('-', '').slice(0, 10)
    let resolvePromise
    let rejectPromise
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const pending = {
      id,
      chatId: chat.chatId,
      threadId: chat.threadId,
      signal,
      questions: Array.isArray(req.questions) ? req.questions : [],
      index: 0,
      answers: [],
      selected: new Set(),
      awaitingCustom: false,
      busy: false,
      messageId: undefined,
      resolve: resolvePromise,
      reject: rejectPromise,
      onAbort: undefined,
    }
    if (pending.questions.length === 0) return next()
    pending.onAbort = () => {
      if (!pendingQuestions.delete(id)) return
      signal.removeEventListener('abort', pending.onAbort)
      rejectPromise(signal.reason ?? new Error('User question cancelled'))
      if (pending.messageId !== undefined) {
        void editKeyboardMarkdown(
          pending.chatId,
          pending.threadId,
          pending.messageId,
          `⏹ **${tr('Question cancelled', 'Вопрос отменён')}**`,
          [],
          bridgeAbort.signal,
        )
      }
    }
    signal.addEventListener('abort', pending.onAbort, { once: true })
    pendingQuestions.set(id, pending)
    let sent = false
    try {
      sent = await sendQuestionPrompt(pending)
    } catch (error) {
      if (!signal.aborted) warn(`user question prompt failed: ${messageOf(error)}`)
    }
    if (!sent) {
      pendingQuestions.delete(id)
      signal.removeEventListener('abort', pending.onAbort)
      return next()
    }
    return promise
  }

  /**
   * Handle one callback belonging to a pending user question.
   * @param ref - callback payload after `q:`.
   * @param chatId - Telegram chat id.
   * @param threadId - topic thread.
   * @param signal - request lifetime.
   * @returns true when the callback belonged to a question.
   */
  async function handleQuestionCallback(ref, chatId, threadId, signal) {
    const colon = ref.indexOf(':')
    const id = colon === -1 ? ref : ref.slice(0, colon)
    const action = colon === -1 ? '' : ref.slice(colon + 1)
    const pending = pendingQuestions.get(id)
    if (pending === undefined || pending.chatId !== chatId || pending.threadId !== threadId) {
      await send(chatId, tr('This question is already closed.', 'Этот вопрос уже закрыт.'), signal, threadId)
      return true
    }
    if (pending.busy) return true
    const question = pending.questions[pending.index]
    if (action === 'custom') {
      pending.awaitingCustom = true
      await editKeyboardMarkdown(pending.chatId, pending.threadId, pending.messageId, questionText(pending), [], signal)
      return true
    }
    if (action === 'done') {
      await completeQuestion(pending, [...pending.selected], undefined, signal)
      return true
    }
    const optionIndex = Number.parseInt(action, 10)
    if (!Number.isFinite(optionIndex) || question.options?.[optionIndex] === undefined) return true
    const label = question.options[optionIndex].label
    if (question.multiSelect === true) {
      if (pending.selected.has(label)) pending.selected.delete(label)
      else pending.selected.add(label)
      await editKeyboardMarkdown(pending.chatId, pending.threadId, pending.messageId, questionText(pending), questionKeyboard(pending), signal)
      return true
    }
    await completeQuestion(pending, [label], undefined, signal)
    return true
  }

  /**
   * Consume a free-text answer for the active question in this topic.
   * @param chat - chat bridge state.
   * @param text - user message.
   * @param signal - request lifetime.
   * @returns true when the message was an answer.
   */
  async function consumeQuestionReply(chat, text, signal) {
    const command = text.trim().split(/\s+/u)[0]?.toLowerCase()
    if (BOT_COMMANDS.some((entry) => `/${entry.command}` === command)) return false
    const pending = pendingQuestionFor(chat.chatId, chat.threadId)
    if (pending === undefined || !pending.awaitingCustom) return false
    const question = pending.questions[pending.index]
    const selected = question.multiSelect === true ? [...pending.selected] : []
    await completeQuestion(pending, selected, text.trim(), signal)
    return true
  }

  /**
   * Cancel any pending questions in one topic.
   * @param chat - chat bridge state.
   */
  function cancelQuestionsForChat(chat) {
    for (const pending of [...pendingQuestions.values()]) {
      if (pending.chatId !== chat.chatId || pending.threadId !== chat.threadId) continue
      pendingQuestions.delete(pending.id)
      pending.signal?.removeEventListener('abort', pending.onAbort)
      pending.reject(new Error('Question cancelled by /stop'))
      if (pending.messageId !== undefined) {
        void editKeyboardMarkdown(
          pending.chatId,
          pending.threadId,
          pending.messageId,
          `⏹ **${tr('Question cancelled', 'Вопрос отменён')}**`,
          [],
          bridgeAbort.signal,
        )
      }
    }
  }

  /**
   * Register stream/error listeners on one live agent.
   * @param agent - agent to observe.
   * @param chat - chat bridge state.
   */
  function attachAgent(agent, chat) {
    if (chat.boundAgent === agent) return
    chat.boundAgent = agent
    agent.ctx.on('agent/assistant-stream', (payload) => {
      if (chat.boundAgent !== agent) return
      onFrame(chat, payload?.frame)
    })
    agent.ctx.on('agent/error', (payload) => {
      if (chat.boundAgent !== agent) return
      void failChat(chat, payload?.error)
    })
    if (chat.approvalAgent !== agent) {
      chat.approvalAgent = agent
      agent.ctx.on('approval/request', (req, next) => {
        if (chat.boundAgent !== agent) return next()
        return requestApproval(agent, chat, req, next)
      }, { prepend: true })
    }
    if (chat.questionAgent !== agent) {
      chat.questionAgent = agent
      agent.ctx.on('user-questions/request', (req, next) => {
        if (chat.boundAgent !== agent) return next()
        return requestUserQuestions(agent, chat, req, next)
      }, { prepend: true })
    }
  }

  /**
   * Install the selected provider/model on one agent, mirroring the Web session
   * controller. Without this the loop can assemble a request without the
   * caller's model selection.
   * @param agentCtx - unpublished agent scope.
   * @param selection - mutable selection state.
   */
  function installAgentSelection(agentCtx, selection) {
    agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const selected = selection.current
      const assembled = await next()
      if (selected === undefined) return assembled
      return {
        ...assembled,
        variables: {
          ...assembled.variables,
          provider: selected.provider,
          model: selected.model,
        },
      }
    })
    agentCtx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      const selected = selection.assembled
      if (selected === undefined) return resolved
      const { reasoningEffort: _inherited, ...rest } = resolved
      return {
        ...rest,
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
      }
    })
  }

  /**
   * Compose one agent's scoped world and attach the Telegram stream.
   * @param agentCtx - unpublished agent scope.
   * @param agent - unpublished agent.
   * @param chat - chat bridge state.
   */
  async function setupAgent(agentCtx, agent, chat) {
    const selection = selectionForChat(chat)
    installAgentSelection(agentCtx, selection)
    const preset = presetOf()
    const presets = ctx.get('agentPresets')
    if (preset !== undefined && presets !== undefined) {
      try {
        await presets.mount(agentCtx, preset)
      } catch (error) {
        warn(`preset ${preset} not mounted: ${messageOf(error)}`)
      }
    }
    attachAgent(agent, chat)
  }

  /**
   * Attach a Telegram-created session to the matching DSH workspace.
   * @param sessionId - session id.
   * @param cwd - session directory.
   */
  async function attachToWorkspace(sessionId, cwd) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return
    try {
      let workspace = registry.list().find((entry) => entry.path === cwd)
      if (workspace === undefined) workspace = await registry.create(cwd)
      await workspace.attachSession(sessionId)
    } catch (error) {
      warn(`workspace attach failed for ${sessionId}: ${messageOf(error)}`)
    }
  }

  /**
   * Create or resume the DSH agent for one Telegram chat.
   * @param chat - chat bridge state.
   * @returns the live agent.
   */
  async function ensureAgent(chat) {
    const agents = ctx.get('agents')
    if (agents === undefined) throw new Error('dsh-agent is not mounted in this profile')
    const controllerService = ctx.get('sessionController')
    const controller = controllerService !== null && typeof controllerService?.createSession === 'function' ? controllerService : undefined
    await hydrateSelection(chat)
    const selection = selectionForChat(chat)
    const chosen = selection.current
    const agentOptions = {
      agentOptions: {
        provider: chosen.provider,
        model: chosen.model,
        ...(chosen.reasoningEffort === undefined ? {} : { reasoningEffort: chosen.reasoningEffort }),
      },
    }
    const setup = (agentCtx, agent) => setupAgent(agentCtx, agent, chat)
    const targetCwd = chat.cwd
      ?? (typeof chat.sessionId === 'string' ? state.sessions[chat.sessionId]?.cwd : undefined)
      ?? cwdOf()

    if (typeof chat.sessionId === 'string' && chat.sessionId.length > 0) {
      const live = agents.get(chat.sessionId)
      if (live !== undefined) {
        if (typeof live.session?.header?.cwd === 'string') chat.cwd = live.session.header.cwd
        attachAgent(live, chat)
        await applyPermission(chat, live)
        return live
      }
      try {
        // The Web session controller composes the same scoped services the GUI
        // uses (model selection, preset, provider connection). Prefer it when
        // present; the raw registry path is the headless fallback.
        const resumed = controller === undefined
          ? await agents.resume({ resumeSessionId: chat.sessionId, ...agentOptions, setup })
          : await controller.resume(chat.sessionId)
        const agent = resumed?.agent ?? resumed
        if (typeof agent?.session?.header?.cwd === 'string') chat.cwd = agent.session.header.cwd
        attachAgent(agent, chat)
        await applyPermission(chat, agent)
        info(`resumed Telegram session ${chat.sessionId}`)
        return agent
      } catch (error) {
        warn(`resume failed for ${chat.sessionId}: ${messageOf(error)}`)
        const failed = chat.sessionId
        chat.sessionId = undefined
        delete state.threads[chat.key]
        if (typeof failed === 'string') delete state.sessions[failed]
        await persistState()
      }
    }

    const preset = presetOf()
    if (controller !== undefined) {
      try {
        const created = await controller.createSession({
          cwd: targetCwd,
          ...(preset === undefined ? {} : { agentPreset: preset }),
        })
        const agent = created?.agent ?? created
        const sessionId = agent.session?.id ?? agent.id
        await bindSession(chat, sessionId, '', targetCwd)
        await attachToWorkspace(sessionId, targetCwd)
        attachAgent(agent, chat)
        await applyPermission(chat, agent)
        info(`created Telegram session ${sessionId} via sessionController`)
        return agent
      } catch (error) {
        warn(`sessionController create failed, using raw agent: ${messageOf(error)}`)
      }
    }

    const sessionId = `session-${randomUUID()}`
    const meta = { cwd: targetCwd }
    if (preset !== undefined && ctx.get('agentPresets') !== undefined) meta.agentPreset = preset
    const handle = await agents.create({ sessionId, meta, ...agentOptions, setup })
    await bindSession(chat, sessionId, '', targetCwd)
    await attachToWorkspace(sessionId, meta.cwd)
    attachAgent(handle.agent, chat)
    await applyPermission(chat, handle.agent)
    info(`created Telegram session ${sessionId}`)
    return handle.agent
  }

  /** Stop a pending stream edit timer. */
  function clearEditTimer(chat) {
    if (chat.editTimer !== null) {
      clearTimeout(chat.editTimer)
      chat.editTimer = null
    }
  }

  /**
   * Throttle one streaming edit.
   * @param chat - chat bridge state.
   */
  function scheduleFlush(chat) {
    if (chat.editTimer !== null || chat.done) return
    const delay = Math.max(0, 800 - (Date.now() - (chat.lastEdit ?? 0)))
    chat.editTimer = setTimeout(() => {
      chat.editTimer = null
      void flushChat(chat)
    }, delay)
  }

  /**
   * Publish the current streaming buffer.
   * @param chat - chat bridge state.
   */
  async function flushChat(chat) {
    if (chat.done || chat.messageId === null) return
    const raw = renderChat(chat)
    if (raw.length === 0) return
    const next = toTelegramMarkdown(raw)
    if (next === chat.lastText) return
    chat.lastText = next
    chat.lastEdit = Date.now()
    chat.answerEdit = (chat.answerEdit ?? Promise.resolve()).then(async () => {
      if (chat.done || chat.messageId === null) return
      await editAnswer(chat.chatId, chat.messageId, raw, bridgeAbort.signal, chat.threadId)
    }).catch(() => {})
    await chat.answerEdit
  }

  /** Stop the thinking/tool display timers. */
  function clearAuxTimers(chat) {
    if (chat.thinkingTimer !== null) {
      clearTimeout(chat.thinkingTimer)
      chat.thinkingTimer = null
    }
    if (chat.toolTimer !== null) {
      clearTimeout(chat.toolTimer)
      chat.toolTimer = null
    }
  }

  /** Reset the per-turn reasoning and tool display buffers. */
  function resetAux(chat) {
    clearAuxTimers(chat)
    chat.textSeparator = false
    chat.thinkingText = ''
    chat.thinkingShown = 0
    chat.thinkingLastText = ''
    chat.thinkingMessageId = null
    chat.tools = []
    chat.toolLastText = ''
    chat.toolMessageId = null
  }

  /**
   * Delete one auxiliary message without failing the turn.
   * @param chatId - target chat.
   * @param threadId - topic thread.
   * @param messageId - message to delete.
   */
  async function deleteMessage(chatId, threadId, messageId) {
    if (messageId === null || messageId === undefined) return
    await call('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    }, bridgeAbort.signal).catch(() => {})
  }

  /**
   * Publish the current reasoning block as the first message.
   * @param chat - chat bridge state.
   */
  async function flushThinking(chat) {
    const full = chat.thinkingText.replace(/\r/gu, '')
    if (full.trim().length === 0) return
    if (chat.done) chat.thinkingShown = full.length
    else chat.thinkingShown = Math.min(full.length, chat.thinkingShown + 40)
    const text = full.slice(0, chat.thinkingShown).trim()
    if (text.length === 0) return
    const lines = wrapVisualLines(text, 52).slice(-10)
    const body = `💭 Thinking\n${lines.join('\n')}`
    if (body === chat.thinkingLastText) return
    chat.thinkingLastText = body
    if (chat.thinkingMessageId === null) {
      const result = await sendPlain(chat.chatId, body, bridgeAbort.signal, chat.threadId)
      chat.thinkingMessageId = result?.message_id ?? null
    } else {
      await editPlain(chat.chatId, chat.thinkingMessageId, body, bridgeAbort.signal, chat.threadId)
    }
    if (!chat.done && chat.thinkingShown < full.length) scheduleThinking(chat)
  }

  /**
   * Add one streamed tool call to the rolling list.
   * @param chat - chat bridge state.
   * @param chunk - tool-call delta or completed block.
   * @returns the tool entry.
   */
  function upsertTool(chat, chunk) {
    const id = String(chunk.id ?? '')
    let tool = chat.tools.find((entry) => entry.id === id)
    if (tool === undefined) {
      tool = { id: id.length > 0 ? id : `tool-${chat.tools.length}`, name: '', args: '' }
      chat.tools.push(tool)
    }
    if (typeof chunk.name === 'string' && chunk.name.length > 0) tool.name = chunk.name
    if (typeof chunk.argumentsDelta === 'string') tool.args += chunk.argumentsDelta
    if (typeof chunk.arguments === 'string') tool.args = chunk.arguments
    if (chat.tools.length > 10) chat.tools = chat.tools.slice(-10)
    return tool
  }

  /**
   * Publish the rolling tool-call list as the second message.
   * @param chat - chat bridge state.
   */
  async function flushTool(chat) {
    if (chat.tools.length === 0) return
    const body = chat.tools.slice(-10).map(formatToolCall).join('\n')
    if (body === chat.toolLastText) return
    chat.toolLastText = body
    if (chat.toolMessageId === null) {
      const result = await sendKeyboard(chat.chatId, chat.threadId, body, [], bridgeAbort.signal)
      chat.toolMessageId = result?.message_id ?? null
    } else {
      await editKeyboard(chat.chatId, chat.threadId, chat.toolMessageId, body, [], bridgeAbort.signal)
    }
  }

  /**
   * Throttle the thinking display.
   * @param chat - chat bridge state.
   */
  function scheduleThinking(chat) {
    if (chat.thinkingTimer !== null || chat.done) return
    chat.thinkingTimer = setTimeout(() => {
      chat.thinkingTimer = null
      void flushThinking(chat)
    }, 650)
  }

  /**
   * Throttle the tool-call display.
   * @param chat - chat bridge state.
   */
  function scheduleTool(chat) {
    if (chat.toolTimer !== null || chat.done) return
    chat.toolTimer = setTimeout(() => {
      chat.toolTimer = null
      void flushTool(chat)
    }, 1200)
  }

  /**
   * Consume one assistant stream frame.
   * @param chat - chat bridge state.
   * @param frame - stream frame.
   */
  function onFrame(chat, frame) {
    if (frame === undefined || chat.done) return
    if (frame.type === 'chunk' && frame.chunk?.type === 'block-start' && frame.chunk.blockType === 'reasoning') {
      if (chat.thinkingText.length > 0 && !chat.thinkingText.endsWith('\n')) chat.thinkingText += '\n'
      return
    }
    if (frame.type === 'chunk' && frame.chunk?.type === 'block-start' && frame.chunk.blockType === 'text') {
      chat.textSeparator = chat.text.length > 0
      return
    }
    if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') {
      const nextText = frame.chunk.text
      if (chat.textSeparator && chat.text.length > 0 && !/\s$/u.test(chat.text) && !/^\s/u.test(nextText)) {
        chat.text += '\n\n'
      } else if (chat.text.length > 0 && !/\s$/u.test(chat.text) && /[.!?…]$/u.test(chat.text) && /^[A-ZА-ЯЁ]/u.test(nextText)) {
        chat.text += ' '
      }
      chat.textSeparator = false
      chat.text += nextText
      scheduleFlush(chat)
      return
    }
    if (frame.type === 'chunk' && frame.chunk?.type === 'reasoning-delta') {
      if (readLive(config.showThinking, true) !== true) return
      chat.thinkingText += frame.chunk.text
      scheduleThinking(chat)
      return
    }
    if (frame.type === 'chunk' && frame.chunk?.type === 'tool-call-delta') {
      if (readLive(config.showToolCalls, true) !== true) return
      chat.textSeparator = chat.text.length > 0
      upsertTool(chat, frame.chunk)
      scheduleTool(chat)
      return
    }
    if (frame.type === 'chunk' && frame.chunk?.type === 'block-end' && frame.chunk.block?.type === 'tool-call') {
      if (readLive(config.showToolCalls, true) !== true) return
      chat.textSeparator = chat.text.length > 0
      upsertTool(chat, frame.chunk.block)
      scheduleTool(chat)
    }
  }

  /**
   * Rename the session topic to the latest DSH session title.
   * @param chat - chat bridge state.
   */
  async function refreshTopicTitle(chat) {
    if (typeof chat.sessionId !== 'string' || chat.threadId === undefined) return
    const title = await sessionTitle(chat.sessionId)
    const record = state.sessions[chat.sessionId]
    if (record?.titleLocked === true) return
    if (record !== undefined && record.title === title) return
    try {
      await call('editForumTopic', {
        chat_id: chat.chatId,
        message_thread_id: chat.threadId,
        name: shortLabel(title, 120),
      }, bridgeAbort.signal)
      if (record !== undefined) {
        record.title = title
        await persistState()
      }
    } catch (error) {
      if (!bridgeAbort.signal.aborted) warn(`editForumTopic failed: ${messageOf(error)}`)
    }
  }

  /**
   * Flush the final assistant text into the first answer message and split it.
   * @param chat - chat bridge state.
   */
  async function finalizeChat(chat) {
    if (chat.done) return
    chat.done = true
    chat.busy = false
    clearEditTimer(chat)
    clearAuxTimers(chat)
    if (chat.answerEdit !== undefined) await chat.answerEdit.catch(() => {})
    if (chat.thinkingText.length > 0) await flushThinking(chat)
    if (chat.tools.length > 0) await flushTool(chat)
    const text = chat.text.trim()
    const chunks = splitAnswerText(text.length > 0 ? text : tr('✅ Done.', '✅ Готово.'))
    if (chat.messageId !== null) {
      const edited = await editAnswer(chat.chatId, chat.messageId, chunks[0], bridgeAbort.signal, chat.threadId)
      if (!edited) await sendAnswer(chat.chatId, chunks[0], bridgeAbort.signal, chat.threadId)
    } else {
      await sendAnswer(chat.chatId, chunks[0], bridgeAbort.signal, chat.threadId)
    }
    for (const chunk of chunks.slice(1)) {
      await sendAnswer(chat.chatId, chunk, bridgeAbort.signal, chat.threadId)
    }
    // The final answer is the first message; remove the transient reasoning
    // and tool-call messages after it has been committed.
    if (chat.thinkingMessageId !== null) {
      await deleteMessage(chat.chatId, chat.threadId, chat.thinkingMessageId)
    }
    if (chat.toolMessageId !== null) {
      await deleteMessage(chat.chatId, chat.threadId, chat.toolMessageId)
    }
    chat.text = ''
    chat.lastText = ''
    chat.messageId = null
    resetAux(chat)
    void refreshTopicTitle(chat)
    await publishStatus({ lastOutcome: 'agent-replied' })
  }

  /**
   * Report one agent failure into the chat.
   * @param chat - chat bridge state.
   * @param error - failure.
   */
  async function failChat(chat, error) {
    if (chat.done) return
    chat.done = true
    chat.busy = false
    clearEditTimer(chat)
    clearAuxTimers(chat)
    if (chat.answerEdit !== undefined) await chat.answerEdit.catch(() => {})
    const detail = error?.cause === undefined ? messageOf(error) : `${messageOf(error)}: ${messageOf(error.cause)}`
    const message = `❌ ${detail}`.slice(0, MAX_TELEGRAM_TEXT)
    if (chat.messageId !== null) {
      await editPlain(chat.chatId, chat.messageId, message, bridgeAbort.signal, chat.threadId)
    } else {
      await sendPlain(chat.chatId, message, bridgeAbort.signal, chat.threadId)
    }
    if (chat.thinkingMessageId !== null) await deleteMessage(chat.chatId, chat.threadId, chat.thinkingMessageId)
    if (chat.toolMessageId !== null) await deleteMessage(chat.chatId, chat.threadId, chat.toolMessageId)
    chat.text = ''
    chat.lastText = ''
    chat.messageId = null
    resetAux(chat)
    await publishStatus({ lastOutcome: 'agent-error', detail })
  }

  /**
   * Send one user prompt to the chat's agent.
   * @param chat - chat bridge state.
   * @param text - prompt text.
   * @param signal - runtime lifetime.
   */
  async function runAgent(chat, text, signal) {
    if (chat.busy) {
      await send(chat.chatId, tr('⏳ Already working on a task. Send /stop to abort.', '⏳ Уже выполняю задачу. Отправь /stop, чтобы прервать.'), signal, chat.threadId)
      return
    }
    chat.busy = true
    chat.done = false
    chat.text = ''
    chat.lastText = ''
    chat.messageId = null
    clearEditTimer(chat)
    resetAux(chat)
    chat.answerEdit = Promise.resolve()
    const answer = await sendPlain(chat.chatId, tr('⏳ Generating…', '⏳ Генерирую…'), bridgeAbort.signal, chat.threadId)
    chat.messageId = answer?.message_id ?? null
    if (readLive(config.showThinking, true) === true) {
      const thinking = await sendPlain(chat.chatId, '💭 Thinking…', bridgeAbort.signal, chat.threadId)
      chat.thinkingMessageId = thinking?.message_id ?? null
    }
    try {
      const agent = await ensureAgent(chat)
      agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
      void agent.whenIdle().then(() => finalizeChat(chat)).catch((error) => failChat(chat, error))
    } catch (error) {
      await failChat(chat, error)
    }
  }


  /**
   * Escape text for Telegram HTML parse mode.
   * @param value - raw text.
   * @returns escaped text.
   */
  function escapeHtml(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  }

  /** @returns a short one-line label. */
  function shortLabel(value, max = 48) {
    const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
  }

  /**
   * Send one message with an inline keyboard.
   * @param chatId - target chat.
   * @param threadId - topic thread, if any.
   * @param text - HTML body.
   * @param keyboard - inline keyboard rows.
   * @param signal - request lifetime.
   * @returns the Bot API result, or undefined.
   */
  async function sendKeyboard(chatId, threadId, text, keyboard, signal) {
    try {
      return await call('sendMessage', {
        chat_id: chatId,
        ...(threadId === undefined || threadId === 0 ? {} : { message_thread_id: threadId }),
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard },
      }, signal)
    } catch (error) {
      if (!signal.aborted) warn(`sendKeyboard failed: ${messageOf(error)}`)
      return undefined
    }
  }

  /**
   * Edit one message and replace its inline keyboard.
   * @param chatId - target chat.
   * @param threadId - topic thread, if any.
   * @param messageId - message to edit.
   * @param text - HTML body.
   * @param keyboard - inline keyboard rows.
   * @param signal - request lifetime.
   */
  async function editKeyboard(chatId, threadId, messageId, text, keyboard, signal) {
    try {
      await call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        ...(threadId === undefined || threadId === 0 ? {} : { message_thread_id: threadId }),
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard },
      }, signal)
      return true
    } catch (error) {
      const message = messageOf(error)
      if (!signal.aborted && !/not modified/i.test(message)) warn(`editKeyboard failed: ${message}`)
      return /not modified/i.test(message)
    }
  }

  /**
   * Edit a menu message in place, or send it when there is no message to edit.
   * @param chatId - target chat.
   * @param threadId - topic thread.
   * @param messageId - existing menu message, if any.
   * @param text - HTML body.
   * @param keyboard - inline keyboard rows.
   * @param signal - request lifetime.
   */
  async function renderMenu(chatId, threadId, messageId, text, keyboard, signal) {
    if (messageId !== undefined && messageId !== null) {
      if (await editKeyboard(chatId, threadId, messageId, text, keyboard, signal)) return
    }
    await sendKeyboard(chatId, threadId, text, keyboard, signal)
  }

  /**
   * Remember the chat that owns lifecycle notifications (All, thread 0).
   * @param chatId - control chat id.
   */
  async function rememberControlChat(chatId) {
    if (topics.chatId === chatId) return
    topics = { chatId }
    await mkdir(STATUS_DIR, { recursive: true })
    await writeFile(TOPICS_PATH, JSON.stringify(topics, null, 2) + '\n', { mode: 0o600 })
  }

  /**
   * Publish a lifecycle notification into All.
   * @param text - HTML-safe body.
   * @param signal - request lifetime.
   */
  async function notifyAll(text, signal) {
    if (topics.chatId === 0) return
    await call('sendMessage', {
      chat_id: topics.chatId,
      text,
      parse_mode: 'HTML',
    }, signal).catch((error) => {
      if (!signal.aborted) warn(`lifecycle notification failed: ${messageOf(error)}`)
    })
  }

  /** @returns the display name for a permission preset. */
  function permissionLabel(value) {
    try {
      const service = ctx.get('permissionPresets')
      return service?.optionOf(value)?.name ?? value
    } catch {
      return value
    }
  }

  /**
   * Build the inline control panel for one session topic.
   * @param chat - chat bridge state.
   * @returns inline-keyboard rows.
   */
  async function controlKeyboard(chat) {
    await loadModelChoices()
    const current = selectionForChat(chat).current
    const permission = currentPermission(chat)
    const context = await contextSummary(chat)
    const contextLabel = context.used === undefined
      ? formatTokens(context.windowSize)
      : `${formatTokens(context.used)}/${formatTokens(context.windowSize)}`
    return [
      [
        { text: `🤖 ${modelLabel(current.model)}`, callback_data: 'o:model' },
        { text: `🧠 ${tr('Effort', 'Усилие')}: ${effortLabel(current.reasoningEffort)}`, callback_data: 'o:effort' },
      ],
      [
        { text: `🛡 ${permissionLabel(permission)}`, callback_data: 'o:mode' },
        { text: `📚 ${tr('Context', 'Контекст')}: ${contextLabel}`, callback_data: 'o:context' },
      ],
    ]
  }

  /**
   * Render the inline control panel, editing the previous panel when possible.
   * @param chatId - target chat.
   * @param threadId - topic thread.
   * @param chat - chat bridge state.
   * @param signal - request lifetime.
   * @param messageId - panel message to edit.
   */
  async function sendMenu(chatId, threadId, chat, signal, messageId) {
    try {
      await hydrateSelection(chat)
      const keyboard = await controlKeyboard(chat)
      const target = messageId ?? chat.panelMessageId
      if (target !== undefined && await editKeyboard(chatId, threadId, target, `<b>${tr('Session controls', 'Управление сессией')}</b>`, keyboard, signal)) {
        chat.panelMessageId = target
        return
      }
      const result = await sendKeyboard(chatId, threadId, `<b>${tr('Session controls', 'Управление сессией')}</b>`, keyboard, signal)
      if (typeof result?.message_id === 'number') chat.panelMessageId = result.message_id
    } catch (error) {
      if (!signal.aborted) warn(`sendMenu failed: ${messageOf(error)}`)
    }
  }

  /**
   * Show the model picker.
   * @param chat - chat bridge state.
   * @param signal - request lifetime.
   */
  async function showModelMenu(chat, signal, messageId) {
    await hydrateSelection(chat)
    const choices = await loadModelChoices()
    const current = selectionForChat(chat).current
    const rows = choices.map((choice) => [{
      text: `${choice.id === current.model ? '✅ ' : ''}${choice.label} · ${choice.id}`,
      callback_data: `m:${choice.id}`,
    }])
    rows.push([{ text: tr('⬅️ Back', '⬅️ Назад'), callback_data: 'b:menu' }])
    await renderMenu(chat.chatId, chat.threadId, messageId ?? chat.panelMessageId, `<b>${tr('Model', 'Модель')}</b>\n\n${tr('Choose a model for this session.', 'Выбери модель для этой сессии.')}`, rows, signal)
  }

  /**
   * Show the reasoning-effort picker.
   * @param chat - chat bridge state.
   * @param signal - request lifetime.
   */
  async function showEffortMenu(chat, signal, messageId) {
    await hydrateSelection(chat)
    const current = selectionForChat(chat).current
    const rows = []
    let row = []
    for (const choice of EFFORT_CHOICES) {
      row.push({
        text: `${choice.id === current.reasoningEffort ? '✅ ' : ''}${choice.label}`,
        callback_data: `e:${choice.id}`,
      })
      if (row.length === 2) {
        rows.push(row)
        row = []
      }
    }
    if (row.length > 0) rows.push(row)
    rows.push([{ text: tr('⬅️ Back', '⬅️ Назад'), callback_data: 'b:menu' }])
    await renderMenu(chat.chatId, chat.threadId, messageId ?? chat.panelMessageId, `<b>${tr('Reasoning effort', 'Уровень effort')}</b>\n\n${tr('Choose the effort level.', 'Выбери уровень effort.')}`, rows, signal)
  }

  /**
   * Show the permission preset picker.
   * @param chat - chat bridge state.
   * @param signal - request lifetime.
   */
  async function showModeMenu(chat, signal, messageId) {
    const service = ctx.get('permissionPresets')
    let options
    try {
      options = service?.catalog()?.options
    } catch {
      options = undefined
    }
    if (!Array.isArray(options) || options.length === 0) {
      options = [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ]
    }
    const current = currentPermission(chat)
    const rows = options.slice(0, 8).map((option) => [{
      text: `${option.value === current ? '✅ ' : ''}${option.name ?? option.value}`,
      callback_data: `p:${option.value}`,
    }])
    rows.push([{ text: tr('⬅️ Back', '⬅️ Назад'), callback_data: 'b:menu' }])
    await renderMenu(
      chat.chatId,
      chat.threadId,
      messageId ?? chat.panelMessageId,
      `<b>${tr('Access mode', 'Режим доступа')}</b>\n\n${tr('Access level for this session.', 'Уровень доступа для этой сессии.')}`,
      rows,
      signal,
    )
  }

  /**
   * Show context capacity and last usage.
   * @param chat - chat bridge state.
   * @param signal - request lifetime.
   */
  async function showContext(chat, signal, messageId) {
    await hydrateSelection(chat)
    await loadModelChoices()
    const current = selectionForChat(chat).current
    const context = await contextSummary(chat)
    const cacheHit = context.cacheRead !== undefined && context.inputTokens !== undefined
      ? `${Math.round((context.cacheRead / Math.max(1, context.inputTokens + context.cacheRead)) * 1000) / 10}%`
      : 'n/a'
    const lines = [
      `<b>${tr('Context', 'Контекст')}</b>`,
      `${tr('Model', 'Модель')}: ${escapeHtml(modelLabel(current.model))} (<code>${escapeHtml(current.model)}</code>)`,
      `${tr('Window', 'Окно')}: ${formatTokens(context.windowSize)}`,
      `${tr('Last request', 'Последний запрос')}: ${context.used === undefined ? tr('unknown', 'неизвестно') : formatTokens(context.used)}`,
      `${tr('Cache hit', 'Попадание в кэш')}: ${cacheHit}`,
      `${tr('Effort', 'Effort')}: ${effortLabel(current.reasoningEffort)}`,
      `${tr('Mode', 'Режим')}: ${escapeHtml(permissionLabel(currentPermission(chat)))}`,
    ]
    await renderMenu(
      chat.chatId,
      chat.threadId,
      messageId ?? chat.panelMessageId,
      lines.join('\n'),
      [[{ text: tr('⬅️ Back', '⬅️ Назад'), callback_data: 'b:menu' }]],
      signal,
    )
  }

  /**
   * Apply one model/effort selection to a chat.
   * @param chat - chat bridge state.
   * @param next - partial selection.
   * @param signal - request lifetime.
   */
  async function applySelection(chat, next, signal) {
    const current = selectionForChat(chat).current
    chat.selection.current = {
      ...current,
      ...next,
      provider: 'deepseek-official',
    }
    await persistPreferences(chat)
    try {
      const agent = await ensureAgent(chat)
      agent.session.append('model/selection', chat.selection.current)
    } catch (error) {
      if (!signal.aborted) warn(`model selection apply failed: ${messageOf(error)}`)
    }
  }

  /**
   * Create a DM topic in the control chat.
   * @param chatId - chat with Topics enabled.
   * @param name - topic name.
   * @param signal - request lifetime.
   * @returns thread id, or undefined.
   */
  async function createTopic(chatId, name, signal) {
    const clean = shortLabel(name, 120) || 'DSH session'
    for (const candidate of [clean, `${clean} · ${randomUUID().slice(0, 4)}`]) {
      try {
        const topic = await call('createForumTopic', { chat_id: chatId, name: candidate }, signal)
        if (typeof topic?.message_thread_id === 'number') return topic.message_thread_id
      } catch (error) {
        const message = messageOf(error).toLowerCase()
        if (message.includes('duplicate') || message.includes('already')) continue
        if (message.includes('forum') || message.includes('topic')) {
          throw new Error(tr('Enable Threaded mode in @BotFather → Bot Settings, then enable Topics in the bot chat (tap the bot name → Topics).', 'Включи Threaded mode в @BotFather → Bot Settings, затем включи Topics в чате с ботом (имя бота сверху → Topics).'))
        }
        throw error
      }
    }
    return undefined
  }

  /**
   * Read a session title, falling back to a short id.
   * @param sessionId - session id.
   * @returns display title.
   */
  async function sessionTitle(sessionId, header) {
    try {
      const snapshot = await ctx.get('sessionQuery')?.readTitleSnapshot(sessionId)
      const title = snapshot?.title?.title
      if (typeof title === 'string' && title.trim().length > 0) return title.trim()
    } catch {
      // Missing title is fine.
    }
    const base = typeof header?.cwd === 'string' && header.cwd.length > 0 ? basename(header.cwd) : tr('Session', 'Сессия')
    const date = typeof header?.createdAt === 'number'
      ? new Date(header.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
      : ''
    return date.length > 0 ? `${base} · ${date}` : `${base} · ${String(sessionId).slice(-6)}`
  }

  /**
   * Read the last assistant text from a session surface.
   * @param sessionId - session id.
   * @returns preview text.
   */
  async function lastAssistantText(sessionId) {
    try {
      const surface = await ctx.get('sessionQuery')?.readSurface(sessionId)
      const events = surface?.events ?? []
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type !== 'assistant/message') continue
        const message = event.data?.message ?? event.data
        const content = Array.isArray(message?.content) ? message.content : []
        const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
        if (text.length > 0) return text
      }
    } catch {
      // Empty preview is fine.
    }
    return ''
  }

  /**
   * Read the latest assistant messages from a session surface.
   * @param sessionId - session id.
   * @param limit - maximum number of messages.
   * @returns newest-first assistant texts.
   */
  async function recentAssistantTexts(sessionId, limit) {
    const texts = []
    try {
      const surface = await ctx.get('sessionQuery')?.readSurface(sessionId)
      const events = surface?.events ?? []
      for (let index = events.length - 1; index >= 0 && texts.length < limit; index -= 1) {
        const event = events[index]
        if (event?.type !== 'assistant/message') continue
        const message = event.data?.message ?? event.data
        const content = Array.isArray(message?.content) ? message.content : []
        const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
        if (text.length > 0) texts.push(text)
      }
    } catch {
      // Empty result is handled by the command.
    }
    return texts
  }

  /**
   * Open (or reuse) a topic for one existing session.
   * @param sessionId - session id.
   * @param chatId - control chat.
   * @param signal - request lifetime.
   * @returns topic record, or undefined.
   */
  async function deliverSessionTopic(record, chatId, signal) {
    const preview = await lastAssistantText(record.sessionId)
    const title = record.title || await sessionTitle(record.sessionId)
    const delivered = await sendKeyboardMarkdown(
      chatId,
      record.threadId,
      `📂 **${title}**\n\n${preview.length > 0 ? clipPreview(preview) : tr('No assistant messages yet.', 'Пока нет ответов ассистента.')}\n\n${tr('Send a message to continue this session.', 'Напиши сообщение, чтобы продолжить эту сессию.')}`,
      [],
      signal,
    )
    if (delivered === undefined) return false
    await sendMenu(chatId, record.threadId, await chatFor(chatId, record.threadId), signal)
    return true
  }

  async function openTopicForSession(sessionId, chatId, signal) {
    const existing = state.sessions[sessionId]
    if (existing !== undefined && existing.chatId === chatId && typeof existing.threadId === 'number') {
      // Re-open the stored topic and make it visible in Telegram. If the
      // thread was deleted, drop the stale mapping and create a fresh one.
      if (await deliverSessionTopic(existing, chatId, signal)) return existing
      delete state.sessions[sessionId]
      delete state.threads[`${chatId}:${existing.threadId}`]
      await persistState()
    }
    const title = await sessionTitle(sessionId)
    const records = await ctx.get('sessionQuery')?.listSessions(signal)
    const header = records?.find((entry) => entry.header.id === sessionId)?.header
    const threadId = await createTopic(chatId, title, signal)
    if (threadId === undefined) return undefined
    const record = { sessionId, chatId, threadId, title: await sessionTitle(sessionId, header), ...(header?.cwd === undefined ? {} : { cwd: header.cwd }), updatedAt: Date.now() }
    state.sessions[sessionId] = record
    state.threads[`${chatId}:${threadId}`] = sessionId
    await persistState()
    await notifyAll(`📂 ${tr('Session opened', 'Открыта сессия')} <code>${escapeHtml(sessionId)}</code>`, signal)
    await deliverSessionTopic(record, chatId, signal)
    return record
  }

  /**
   * Show the workspace picker in the control topic.
   * @param chatId - control chat.
   * @param threadId - control topic thread.
   * @param signal - request lifetime.
   */
  async function showWorkspaces(chatId, threadId, signal, messageId) {
    const registry = ctx.get('workspaceRegistry')
    const workspaces = registry === undefined ? [] : registry.list()
    const rows = workspaces.slice(0, 10).map((workspace) => [{
      text: `📁 ${shortLabel(workspace.title || workspace.path, 44)}`,
      callback_data: `w:${workspace.id}`,
    }])
    rows.push([{ text: tr('🌐 All sessions', '🌐 Все сессии'), callback_data: 'w:all' }])
    await renderMenu(
      chatId,
      threadId,
      messageId,
      `<b>DSH sessions</b>\n\n${tr('Choose a workspace or open all sessions.', 'Выбери workspace или открой все сессии.')}`,
      rows,
      signal,
    )
  }

  /**
   * Show sessions in one workspace (or all sessions).
   * @param chatId - control chat.
   * @param threadId - control topic thread.
   * @param workspaceRef - workspace id or `all`.
   * @param signal - request lifetime.
   */
  async function showSessions(chatId, threadId, workspaceRef, signal, messageId) {
    const query = ctx.get('sessionQuery')
    if (query === undefined) {
      await send(chatId, tr('sessionQuery is unavailable in this profile.', 'sessionQuery недоступен в этом профиле.'), signal, threadId)
      return
    }
    const registry = ctx.get('workspaceRegistry')
    const workspace = workspaceRef === 'all' || workspaceRef === undefined ? undefined : registry?.get(workspaceRef)
    const archived = new Set(registry?.archivedSessionIds ?? [])
    const records = await query.listSessions(signal)
    const matching = records
      .filter((record) => !archived.has(record.header.id))
      .filter((record) => record.header?.origin !== 'subagent')
      .filter((record) => workspace === undefined
        || workspace.sessionIds.includes(record.header.id)
        || record.header.cwd === workspace.path)
      .sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0))
      .slice(0, 12)
    const rows = []
    if (workspace !== undefined) {
      rows.push([{ text: tr('➕ New session in this workspace', '➕ Новая сессия в этом workspace'), callback_data: `n:${workspace.id}` }])
    }
    for (const record of matching) {
      const title = await sessionTitle(record.header.id, record.header)
      rows.push([{
        text: `${record.live ? '🟢' : '⚪'} ${shortLabel(title, 44)}`,
        callback_data: `s:${record.header.id}`,
      }])
    }
    rows.push([{ text: tr('⬅️ Back', '⬅️ Назад'), callback_data: 'w:root' }])
    const label = workspace === undefined ? tr('All sessions', 'Все сессии') : workspace.title
    await renderMenu(
      chatId,
      threadId,
      messageId,
      `<b>${escapeHtml(label)}</b>\n\n${matching.length === 0 ? tr('No sessions.', 'Сессий нет.') : `${tr('Found', 'Найдено')}: ${matching.length}`}`,
      rows,
      signal,
    )
  }

  /**
   * Show one session preview with a Continue button.
   * @param chatId - control chat.
   * @param threadId - control topic thread.
   * @param sessionId - selected session.
   * @param workspaceRef - workspace for the Back button.
   * @param signal - request lifetime.
   */
  async function showSessionPreview(chatId, threadId, sessionId, workspaceRef, signal, messageId) {
    const preview = await lastAssistantText(sessionId)
    const records = await ctx.get('sessionQuery')?.listSessions(signal)
    const record = records?.find((entry) => entry.header.id === sessionId)
    const title = await sessionTitle(sessionId, record?.header)
    const text =
      `**${title}**\n` +
      `${tr('Workspace', 'Workspace')}: \`${String(record?.header.cwd ?? 'unknown').replaceAll('`', '\\`')}\`\n` +
      `${tr('Status', 'Статус')}: ${record?.live ? tr('live', 'активна') : tr('persisted', 'сохранена')}\n\n` +
      `${preview.length > 0 ? clipPreview(preview) : tr('No assistant messages yet.', 'Пока нет ответов ассистента.')}`
    const workspace = ctx.get('workspaceRegistry')?.list()
      ?.find((entry) => entry.path === record?.header.cwd)
    const rows = []
    if (workspace !== undefined) {
      rows.push([{ text: tr('➕ New session in this workspace', '➕ Новая сессия в этом workspace'), callback_data: `n:${workspace.id}` }])
    }
    rows.push([{
      text: tr('▶️ Continue in Telegram', '▶️ Продолжить в Telegram'),
      callback_data: `c:${sessionId}`,
    }])
    rows.push([{
      text: tr('⬅️ Back', '⬅️ Назад'),
      callback_data: `w:${workspaceRef}`,
    }])
    await renderMenuMarkdown(chatId, threadId, messageId, text, rows, signal)
  }

  /**
   * Handle one inline-keyboard callback from a control message.
   * @param query - callback query.
   * @param signal - runtime lifetime.
   */
  async function handleCallback(query, signal) {
    const chat = query.message?.chat
    const from = query.from
    const threadId = query.message?.message_thread_id
    if (chat === undefined || from === undefined) return
    const data = String(query.data ?? '')
    await publishStatus({ lastCallback: data, lastCallbackAt: Date.now() })
    if (!userAllowed(from, allowedUsersOf(config))) {
      await call('answerCallbackQuery', { callback_query_id: query.id, text: tr('Access denied', 'Нет доступа'), show_alert: true }, signal, 5000).catch(() => {})
      return
    }
    const colon = data.indexOf(':')
    const prefix = colon === -1 ? data : data.slice(0, colon)
    const ref = colon === -1 ? '' : data.slice(colon + 1)
    await call('answerCallbackQuery', { callback_query_id: query.id }, signal, 5000).catch(() => {})
    try {
      if (prefix === 'a') {
        const [action, id] = ref.split(':')
        const pending = pendingApprovals.get(id)
        if (pending === undefined) {
          await send(chat.id, tr('This approval request is already closed.', 'Этот запрос уже закрыт.'), signal, threadId)
          return
        }
        if (pending.chatId !== chat.id || pending.threadId !== threadId) {
          await send(chat.id, tr('This approval request belongs to another topic.', 'Этот запрос относится к другому topic.'), signal, threadId)
          return
        }
        settleApproval(id, action === 'y' ? 'allowed-once' : 'rejected')
        return
      }
      if (prefix === 'q') {
        await handleQuestionCallback(ref, chat.id, threadId, signal)
        return
      }
      if (prefix === 'o') {
        const chatState = await chatFor(chat.id, threadId)
        if (typeof chatState.sessionId !== 'string') {
          await send(chat.id, tr('This topic is not bound to a session.', 'Этот topic не привязан к сессии.'), signal, threadId)
          return
        }
        if (ref === 'model') await showModelMenu(chatState, signal, query.message.message_id)
        else if (ref === 'effort') await showEffortMenu(chatState, signal, query.message.message_id)
        else if (ref === 'mode') await showModeMenu(chatState, signal, query.message.message_id)
        else if (ref === 'context') await showContext(chatState, signal, query.message.message_id)
        return
      }
      if (prefix === 'b' && ref === 'menu') {
        const chatState = await chatFor(chat.id, threadId)
        await sendMenu(chat.id, threadId, chatState, signal, query.message.message_id)
        return
      }
      if (prefix === 'm' || prefix === 'e' || prefix === 'p') {
        const chatState = await chatFor(chat.id, threadId)
        if (typeof chatState.sessionId !== 'string') {
          await send(chat.id, tr('This topic is not bound to a session.', 'Этот topic не привязан к сессии.'), signal, threadId)
          return
        }
        if (prefix === 'm') {
          if (!MODEL_CHOICES.some((choice) => choice.id === ref)) {
            await send(chat.id, tr('Unknown model.', 'Неизвестная модель.'), signal, threadId)
            return
          }
          await applySelection(chatState, { model: ref }, signal)
        } else if (prefix === 'e') {
          if (!EFFORT_CHOICES.some((choice) => choice.id === ref)) {
            await send(chat.id, tr('Unknown effort.', 'Неизвестный effort.'), signal, threadId)
            return
          }
          await applySelection(chatState, { reasoningEffort: ref }, signal)
        } else {
          const service = ctx.get('permissionPresets')
          const agent = await ensureAgent(chatState)
          if (service !== undefined && typeof service.set === 'function') {
            service.set(agent.session, ref)
            chatState.permission = ref
          } else if (!applyPermissionFallback(chatState, agent, ref)) {
            await send(chat.id, tr('Failed to apply the access mode.', 'Не удалось применить режим доступа.'), signal, threadId)
            return
          }
          await persistPreferences(chatState)
        }
        await sendMenu(chat.id, threadId, chatState, signal, query.message.message_id)
        return
      }
      if (prefix === 'w') {
        if (ref === 'root') await showWorkspaces(chat.id, threadId, signal, query.message.message_id)
        else if (ref === 'all') await showSessions(chat.id, threadId, 'all', signal, query.message.message_id)
        else await showSessions(chat.id, threadId, ref, signal, query.message.message_id)
        return
      }
      if (prefix === 's') {
        await showSessionPreview(chat.id, threadId, ref, 'all', signal, query.message.message_id)
        return
      }
      if (prefix === 'n') {
        const registry = ctx.get('workspaceRegistry')
        const target = registry?.get(ref)?.path
        if (typeof target !== 'string' || target.length === 0) {
          await send(chat.id, tr('Workspace not found. Open /sessions again.', 'Workspace не найден. Открой /sessions заново.'), signal, threadId)
          return
        }
        await createNewSessionTopic(chat.id, threadId, signal, target)
        return
      }
      if (prefix === 'c') {
        const record = await openTopicForSession(ref, chat.id, signal)
        if (record === undefined) {
          await send(chat.id, tr('Failed to create a topic. Check Topics in chat settings.', 'Не удалось создать topic. Проверь Topics в настройках чата.'), signal, threadId)
          return
        }
        await editKeyboard(
          chat.id,
          threadId,
          query.message.message_id,
          `✅ ${tr('Session opened in topic', 'Сессия открыта в topic')} «${escapeHtml(record.title)}».`,
          [],
          signal,
        )
        return
      }
      await send(chat.id, tr('Unknown button. Open /sessions again.', 'Неизвестная кнопка. Открой /sessions заново.'), signal, threadId)
    } catch (error) {
      await publishStatus({ lastCallbackError: messageOf(error) })
      await send(chat.id, `❌ ${escapeHtml(messageOf(error))}`, signal, threadId)
    }
  }

  /**
   * Create a fresh DSH session in a new topic.
   * @param chatId - control chat.
   * @param controlThreadId - thread that requested creation.
   * @param signal - request lifetime.
   */
  async function createNewSessionTopic(chatId, controlThreadId, signal, cwd) {
    let threadId
    try {
      threadId = await createTopic(chatId, 'New session', signal)
    } catch (error) {
      await send(chatId, `❌ ${escapeHtml(messageOf(error))}`, signal, controlThreadId)
      return
    }
    if (threadId === undefined) {
      await send(chatId, tr('Failed to create a topic.', 'Не удалось создать topic.'), signal, controlThreadId)
      return
    }
    const chatState = await chatFor(chatId, threadId)
    if (typeof cwd === 'string' && cwd.length > 0) chatState.cwd = cwd
    try {
      await ensureAgent(chatState)
      await sendKeyboard(
        chatId,
        threadId,
        tr('🆕 New DSH session. Send the first message.', '🆕 Новая DSH-сессия. Напиши первое сообщение.'),
        [],
        signal,
      )
      await sendMenu(chatId, threadId, chatState, signal)
    } catch (error) {
      await send(chatId, `❌ ${escapeHtml(messageOf(error))}`, signal, controlThreadId)
    }
  }

  /**
   * Handle one authorized Telegram message and dispatch its command or prompt.
   * @param message - Telegram message.
   * @param signal - runtime lifetime.
   * @param type - Telegram update key, for diagnostics.
   * @returns resolves after the reply attempt.
   */
  async function handleMessage(message, signal, type = 'message') {
    const text = message.text
    const from = message.from
    const chat = message.chat
    // Publish before every guard: if Telegram delivers an unusual update, the
    // status file must still show that it arrived and what kind it was.
    await publishStatus({
      lastMessageAt: Date.now(),
      lastChatId: chat?.id ?? null,
      lastFromId: from?.id ?? null,
      lastUpdateType: type,
      lastOutcome: 'received',
      detail: '',
    })
    if (text === undefined || from === undefined || chat === undefined) {
      await publishStatus({ lastOutcome: 'ignored' })
      return
    }

    const threadId = message.message_thread_id
    const allowedUsers = allowedUsersOf(config)
    const allowedChats = allowedChatsOf(config)
    let allowedUser
    let allowedChat
    try {
      allowedUser = userAllowed(from, allowedUsers)
      allowedChat = chatAllowed(chat, allowedChats)
    } catch (error) {
      await publishStatus({ lastOutcome: 'handler-error', detail: messageOf(error) })
      throw error
    }
    await publishStatus({
      lastOutcome: allowedUser && allowedChat ? 'allowed' : 'denied',
    })
    if (!allowedUser || !allowedChat) {
      // Setup hint: an empty user list is the first-run state. Tell a private
      // caller their ids once, so they can be pasted into Settings. Once the
      // list is non-empty, unauthorized callers get no response.
      if (allowedUsers.length === 0 && chat.type === 'private') {
        await send(
          chat.id,
          tr(
            `Setup mode.\nYour user id: <code>${from.id}</code>\nYour chat id: <code>${chat.id}</code>\n\nAdd the user id to <b>Settings → Telegram → Allowed users</b>, then press Restart.\n\nBefore opening sessions, enable <b>Threaded mode</b> in @BotFather → Bot Settings.`,
            `Режим настройки.\nТвой user id: <code>${from.id}</code>\nТвой chat id: <code>${chat.id}</code>\n\nДобавь user id в <b>Settings → Telegram → Allowed users</b> и нажми Restart.\n\nПеред открытием сессий включи <b>Threaded mode</b> в @BotFather → Bot Settings.`,
          ),
          signal,
          threadId,
        )
      }
      return
    }

    const chatState = await chatFor(chat.id, threadId)
    if (await consumeQuestionReply(chatState, text, signal)) return
    const inSession = typeof chatState.sessionId === 'string'
    const parts = text.trim().split(/\s+/u)
    const command = parts[0]?.toLowerCase()

    if (text.startsWith('🤖 Model:')) {
      if (!inSession) await send(chat.id, tr('Open a session first: /sessions.', 'Сначала открой сессию: /sessions.'), signal, threadId)
      else await showModelMenu(chatState, signal)
      return
    }
    if (text.startsWith('🧠 Effort:')) {
      if (!inSession) await send(chat.id, tr('Open a session first: /sessions.', 'Сначала открой сессию: /sessions.'), signal, threadId)
      else await showEffortMenu(chatState, signal)
      return
    }
    if (text.startsWith('🛡 Mode:')) {
      if (!inSession) await send(chat.id, tr('Open a session first: /sessions.', 'Сначала открой сессию: /sessions.'), signal, threadId)
      else await showModeMenu(chatState, signal)
      return
    }
    if (text.startsWith('📚 Context:')) {
      if (!inSession) await send(chat.id, tr('Open a session first: /sessions.', 'Сначала открой сессию: /sessions.'), signal, threadId)
      else await showContext(chatState, signal)
      return
    }

    if (command === '/start' || command === '/help') {
      await rememberControlChat(chat.id)
      await send(
        chat.id,
        `<b>DeepSeek Harness Telegram bot</b>\n\n` +
          `${tr('Connected as', 'Подключён как')} @${me?.username ?? 'unknown'}.\n` +
          `Your user id: <code>${from.id}</code>\n` +
          `This chat id: <code>${chat.id}</code>\n` +
          `${tr('Topic', 'Топик')}: <code>${threadId ?? 0}</code>\n\n` +
          (inSession
            ? `${tr('Current session', 'Текущая сессия')}: <code>${chatState.sessionId}</code>\n`
            : `${tr('Global topic. Choose a session or create a new one.', 'Глобальный чат. Выбери сессию или создай новую.')}\n`) +
          `\n<b>${tr('First run', 'Первый запуск')}:</b> @BotFather → Bot Settings → <b>Threaded mode</b> → ${tr('Enable', 'Включить')}.\n` +
          `${tr('Commands', 'Команды')}: /sessions, /current, /menu, /rename, /last, /stop, /restart, /status, /id, /ping.`,
        signal,
        threadId,
      )
      return
    }
    if (command === '/id') {
      await send(
        chat.id,
        `${tr('User', 'Пользователь')}: <code>${from.id}</code>\n${tr('Chat', 'Чат')}: <code>${chat.id}</code>\n${tr('Topic', 'Топик')}: <code>${threadId ?? 0}</code>`,
        signal,
        threadId,
      )
      return
    }
    if (command === '/menu') {
      if (!inSession) await send(chat.id, tr('The menu is available in a session topic.', 'Меню доступно в topic сессии.'), signal, threadId)
      else await sendMenu(chat.id, threadId, chatState, signal)
      return
    }
    if (command === '/sessions') {
      await showWorkspaces(chat.id, threadId, signal)
      return
    }


    if (command === '/current') {
      if (!inSession) {
        await send(chat.id, tr('This topic is not bound to a session. /sessions.', 'Этот topic не привязан к сессии. /sessions.'), signal, threadId)
        return
      }
      const title = await sessionTitle(chatState.sessionId)
      await send(
        chat.id,
        `<b>${escapeHtml(title)}</b>\nSession: <code>${chatState.sessionId}</code>\nTopic: <code>${threadId ?? 0}</code>`,
        signal,
        threadId,
      )
      return
    }
    if (command === '/last') {
      if (!inSession) {
        await send(chat.id, tr('This topic is not bound to a session. /sessions.', 'Этот topic не привязан к сессии. /sessions.'), signal, threadId)
        return
      }
      const requested = Number.parseInt(parts[1] ?? '1', 10)
      const limit = Number.isFinite(requested) ? Math.min(5, Math.max(1, requested)) : 1
      const texts = await recentAssistantTexts(chatState.sessionId, limit)
      if (texts.length === 0) {
        await send(chat.id, tr('This session has no assistant messages yet.', 'В этой сессии пока нет ответов ассистента.'), signal, threadId)
        return
      }
      const title = await sessionTitle(chatState.sessionId)
      const body = texts
        .map((text, index) => `${limit === 1 ? '' : `**${index + 1}.** `}${text.slice(0, 3500)}`)
        .join('\n\n')
      const header = limit === 1 ? `**${tr('Latest assistant answer', 'Последний ответ ассистента')}**` : `**${tr('Latest', 'Последние')} ${texts.length} ${tr('answers', 'ответа')}**`
      for (const chunk of splitAnswerText(`${header} · ${title}\n\n${body}`)) {
        await sendAnswer(chat.id, chunk, signal, threadId)
      }
      return
    }

    if (command === '/rename') {
      if (!inSession || threadId === undefined) {
        await send(chat.id, tr('Only a session topic can be renamed.', 'Переименовать можно только topic сессии.'), signal, threadId)
        return
      }
      const name = text.trim().slice('/rename'.length).trim()
      if (name.length === 0) {
        await send(chat.id, tr('Usage: <code>/rename New topic name</code>', 'Использование: <code>/rename Новое имя топика</code>'), signal, threadId)
        return
      }
      if (name.length > 128) {
        await send(chat.id, tr('Topic name must be at most 128 characters.', 'Имя топика не должно быть длиннее 128 символов.'), signal, threadId)
        return
      }
      try {
        await call('editForumTopic', {
          chat_id: chat.id,
          message_thread_id: threadId,
          name,
        }, signal)
        const record = state.sessions[chatState.sessionId]
        if (record !== undefined) {
          record.title = name
          record.titleLocked = true
          await persistState()
        }
        await send(chat.id, `✏️ ${tr('Topic renamed', 'Topic переименован')}: <b>${escapeHtml(name)}</b>`, signal, threadId)
      } catch (error) {
        await send(chat.id, `❌ ${escapeHtml(messageOf(error))}`, signal, threadId)
      }
      return
    }
    if (command === '/restart') {
      await send(chat.id, tr('♻️ Restarting the Telegram bot…', '♻️ Перезапускаю Telegram-бота…'), signal, threadId)
      scheduleRestart('command')
      return
    }
    if (command === '/stop') {
      if (!inSession) {
        await send(chat.id, tr('There is no active session in this topic.', 'В этом topic нет активной сессии.'), signal, threadId)
        return
      }
      try {
        ctx.get('agents')?.get(chatState.sessionId)?.cancel({ kind: 'user' })
      } catch {
        // Already idle or disposed.
      }
      chatState.busy = false
      chatState.done = true
      clearEditTimer(chatState)
      clearAuxTimers(chatState)
      cancelQuestionsForChat(chatState)
      if (chatState.thinkingMessageId !== null) {
        await deleteMessage(chat.id, threadId, chatState.thinkingMessageId)
        chatState.thinkingMessageId = null
      }
      if (chatState.toolMessageId !== null) {
        await deleteMessage(chat.id, threadId, chatState.toolMessageId)
        chatState.toolMessageId = null
      }
      if (chatState.messageId !== null) {
        await editPlain(chat.id, chatState.messageId, tr('⏹ Stopped.', '⏹ Остановлено.'), signal, threadId)
        chatState.messageId = null
      }
      await send(chat.id, tr('⏹ Current task stopped.', '⏹ Текущая задача остановлена.'), signal, threadId)
      return
    }
    if (command === '/status') {
      const uptime = startedAt === 0 ? 0 : Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      const live = inSession ? ctx.get('agents')?.get(chatState.sessionId) : undefined
      const title = inSession ? await sessionTitle(chatState.sessionId) : undefined
      await send(
        chat.id,
        `<b>Telegram bot status</b>\n` +
          `${tr('Bot', 'Бот')}: @${me?.username ?? 'unknown'}\n` +
          `${tr('Enabled', 'Включён')}: ${isEnabled(config) ? tr('yes', 'да') : tr('no', 'нет')}\n` +
          `${tr('Uptime', 'Аптайм')}: ${uptime}s\n` +
          `${tr('Allowed users', 'Разрешённые пользователи')}: ${allowedUsers.length}\n` +
          `${tr('Allowed chats', 'Разрешённые чаты')}: ${allowedChats.length}\n` +
          `${tr('Session', 'Сессия')}: <code>${chatState.sessionId ?? 'none'}</code>\n` +
          (title === undefined ? '' : `${tr('Title', 'Название')}: ${escapeHtml(title)}\n`) +
          `${tr('Agent', 'Агент')}: ${chatState.busy ? tr('running', 'работает') : (live?.status === 'running' ? tr('running', 'работает') : tr('idle', 'ожидает'))}`,
        signal,
        threadId,
      )
      return
    }
    if (command === '/ping') {
      await send(chat.id, 'pong', signal, threadId)
      return
    }
    if (command !== undefined && command.startsWith('/')) {
      await send(chat.id, tr('Unknown command. /help lists commands.', 'Неизвестная команда. /help — список.'), signal, threadId)
      return
    }

    if (!inSession) {
      await send(
        chat.id,
        tr('This is a global topic. Open /sessions to choose or create a session.', 'Это глобальный topic. Открой /sessions, чтобы выбрать или создать сессию.'),
        signal,
        threadId,
      )
      return
    }

    // Ordinary text in a session topic becomes a DSH agent turn.
    await runAgent(chatState, text, signal)
  }

  /**
   * Poll getUpdates until the runtime is stopped.
   * @param tokenLifetime - this runtime's lifetime.
   * @returns resolves when polling stops.
   */
  async function poll(tokenLifetime) {
    let offset = 0
    let healthy = false
    try {
      // A webhook left by another deployment silently disables getUpdates.
      // Hermes deletes it before starting polling; do the same, without
      // dropping updates that were queued while the bot was down.
      try {
        await call('deleteWebhook', { drop_pending_updates: false }, tokenLifetime.signal, 10_000)
      } catch (error) {
        if (!tokenLifetime.signal.aborted) warn(`deleteWebhook failed: ${messageOf(error)}`)
      }
      me = await call('getMe', {}, tokenLifetime.signal)
      startedAt = Date.now()
      healthy = true
      info(`connected as @${me.username ?? me.id}`)
      await publishStatus({ state: 'running', detail: '', username: me.username ?? String(me.id) })
      await publishCommands(tokenLifetime.signal)
      await notifyAll(`🟢 ${tr('Bot online', 'Бот онлайн')}: @${escapeHtml(me.username ?? String(me.id))}`, tokenLifetime.signal)
    } catch (error) {
      if (!tokenLifetime.signal.aborted) {
        warn(`getMe failed: ${messageOf(error)}`)
        await publishStatus({ state: 'error', detail: messageOf(error) })
      }
      return
    }

    while (!tokenLifetime.signal.aborted) {
      let updates
      try {
        updates = await call(
          'getUpdates',
          {
            offset,
            timeout: POLL_TIMEOUT_SECONDS,
            allowed_updates: ['message', 'edited_message', 'business_message', 'channel_post', 'callback_query'],
          },
          tokenLifetime.signal,
          35_000,
        )
      } catch (error) {
        if (tokenLifetime.signal.aborted) break
        healthy = false
        const detail = messageOf(error)
        warn(`getUpdates failed: ${detail}`)
        await publishStatus({ state: 'error', detail })
        if (detail.toLowerCase().includes('conflict')) break
        await sleep(RETRY_DELAY_MS, tokenLifetime.signal)
        continue
      }
      if (!healthy) {
        healthy = true
        await publishStatus({ state: 'running', detail: '', username: me?.username ?? String(me?.id ?? '') })
      }
      await publishStatus({ lastPollAt: Date.now() })
      if (!Array.isArray(updates)) continue
      for (const update of updates) {
        if (typeof update.update_id === 'number') offset = update.update_id + 1
        await publishStatus({ lastUpdateKeys: Object.keys(update) })
        if (update.callback_query !== undefined) {
          void handleCallback(update.callback_query, tokenLifetime.signal).catch((error) => {
            if (!tokenLifetime.signal.aborted) warn(`callback handler failed: ${messageOf(error)}`)
          })
          continue
        }
        const message = update.message ?? update.business_message ?? update.channel_post ?? update.edited_message
        if (message !== undefined) {
          const type = Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown'
          void handleMessage(message, tokenLifetime.signal, type).catch((error) => {
            if (!tokenLifetime.signal.aborted) warn(`message handler failed: ${messageOf(error)}`)
          })
        } else {
          const type = Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown'
          void publishStatus({ lastUpdateType: type, lastUpdateAt: Date.now() })
        }
      }
    }
  }

  /** Stop the active runtime and wait for its loop to settle. */
  async function stop() {
    const current = lifetime
    lifetime = undefined
    me = undefined
    startedAt = 0
    if (current === undefined) return
    current.abort()
    await current.settled
    await publishStatus({ state: 'stopped', detail: '', username: '' })
  }

  /** Start the runtime if enabled and a token is available. */
  async function start() {
    await publishStatus({
      state: 'starting',
      detail: '',
      username: '',
      tokenRef: tokenRefOf(config),
      usersCount: allowedUsersOf(config).length,
      chatsCount: allowedChatsOf(config).length,
    })
    if (!isEnabled(config)) {
      info('runtime disabled')
      await publishStatus({ state: 'disabled', detail: 'Enable bot is off' })
      return
    }
    const token = await resolveToken()
    if (token === undefined) {
      info('runtime idle: TELEGRAM_BOT_TOKEN is not configured')
      await publishStatus({ state: 'idle', detail: 'TELEGRAM_BOT_TOKEN is not configured' })
      return
    }
    const controller = new AbortController()
    const current = {
      controller,
      abort: () => controller.abort(),
    }
    current.settled = poll({ signal: controller.signal }).finally(() => {
      if (lifetime === current) {
        lifetime = undefined
        me = undefined
        startedAt = 0
      }
    })
    lifetime = current
  }

  /** Stop and start the runtime, coalescing overlapping requests. */
  async function restart(reason) {
    if (restarting) {
      restartQueued = true
      return
    }
    restarting = true
    try {
      info(
        `restart (${reason}): enabled=${isEnabled(config)}, users=${allowedUsersOf(config).length}, chats=${allowedChatsOf(config).length}`,
      )
      await stop()
      await start()
    } catch (error) {
      warn(`restart failed: ${messageOf(error)}`)
    } finally {
      restarting = false
      if (restartQueued) {
        restartQueued = false
        scheduleRestart('queued')
      }
    }
  }

  /**
   * Debounce restart requests so a settings write and a token write that arrive
   * together produce one restart.
   * @param reason - short diagnostic label.
   */
  function scheduleRestart(reason) {
    if (restartTimer !== undefined) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      void restart(reason)
    }, RESTART_DEBOUNCE_MS)
  }

  ctx.on('settings/document-updated', (ns) => {
    if (ns === name) scheduleRestart('settings')
  })
  ctx.on('credentials/reference-updated', (ref) => {
    if (ref === tokenRefOf(config)) scheduleRestart('token')
  })

  ctx.effect(
    () => {
      void start().catch((error) => warn(`start failed: ${messageOf(error)}`))
      return () => {
        if (restartTimer !== undefined) {
          clearTimeout(restartTimer)
          restartTimer = undefined
        }
        bridgeAbort.abort()
        void stop().catch((error) => warn(`stop failed: ${messageOf(error)}`))
      }
    },
    'dsh-telegram-bot: runtime',
  )
}
