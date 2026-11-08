/** Host runtime: Telegram polling, topic routing and the DSH session bridge. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import {
  BOT_COMMANDS,
  BOT_COMMANDS_RU,
  EFFORT_CHOICES,
  FORWARD_BATCH_MS,
  MAX_TELEGRAM_TEXT,
  MODEL_CHOICES,
  POLL_TIMEOUT_SECONDS,
  RESTART_DEBOUNCE_MS,
  RETRY_DELAY_MS,
  STATUS_DIR,
  name,
} from './constants.js'
import { classifyError } from './errors.js'
import {
  clipPreview,
  compactToolValue,
  fitAnswerText,
  htmlToPlain,
  isAllThread,
  isTelegramParseError,
  localImagePaths,
  normalizeCommand,
  parseToolArguments,
  routeMessage,
  wrapThinkingLines,
  splitAnswerText,
  toTelegramMarkdown,
  toolArg,
} from './formatting.js'
import { admitText } from './admission.js'
import { STEER_REACTION, busyMode, clearTelegramInbox, hasPendingInput, steerPrompt } from './steer.js'
import { loadState, loadTopics, STATE_PATH, TOPICS_PATH } from './state.js'
import { createUpdateAdmission } from './update-ledger.js'
import { publishStatus } from './status.js'
import { createOutbox } from './outbox.js'
import { isAutoCommandTopic, isPlaceholderTitle, isTopicGone, resolveThreadTarget, topicNameOf, topicTask, topicTitle } from './topics.js'
import { spokenMediaOf, transcribe, transcriptNote } from './voice.js'
import { composePrompt, DOWNLOAD_LIMIT_BYTES, downloadableFile, isForwarded, messageBody, repliedMessage, replyReference, senderLabel } from './message-context.js'
import { createSentLog } from './sent-log.js'
import {
  allowedChatsOf,
  allowedUsersOf,
  chatAllowed,
  isEnabled,
  messageOf,
  readLive,
  sleep,
  tokenRefOf,
  userAllowed,
} from './utils.js'

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
  /** Retry timer for a missing or not-yet-ready credential. */
  let startRetryTimer
  /** Coalesces concurrent start requests into one poller. */
  let startInFlight
  /** Invalidates a start that was overtaken by stop/restart. */
  let startEpoch = 0
  /** Durable chat → session mapping. */
  let state = { version: 2, sessions: {}, threads: {}, updateLedger: {}, updateOffset: 0, topicNames: {} }
  /** Serializes state-file writes. */
  let stateWrite = Promise.resolve()
  /** Per-chat live bridge state. */
  const chats = new Map()
  /** Per-chat token buckets for outbound Bot API traffic. */
  const outboundStates = new Map()
  /** Agent API calls use this lifetime; the bot polling lifetime is separate. */
  const bridgeAbort = new AbortController()
  /** Control chat id used for lifecycle notifications. */
  let topics = { chatId: 0 }
  /** Resolves after the mapping and topic files have been read. */
  /** True once state.json has been read; Host event listeners need a synchronous lookup. */
  let stateLoaded = false
  const stateReady = Promise.all([
    loadState().then((loaded) => { state = loaded }),
    loadTopics().then((loaded) => { topics = loaded }),
  ]).catch((error) => warn(`state load failed: ${messageOf(error)}`))
    .finally(() => {
      stateLoaded = true
      // Earlier versions renamed topics after their session title, so a stored
      // title is the best known name of an existing topic.
      state.topicNames ??= {}
      for (const record of Object.values(state.sessions)) {
        if (typeof record?.chatId !== 'number' || typeof record.threadId !== 'number') continue
        const key = `${record.chatId}:${record.threadId}`
        if (state.topicNames[key] === undefined && typeof record.title === 'string' && record.title.trim().length > 0) {
          state.topicNames[key] = record.title.trim()
        }
      }
    })
  /** Ids of legacy follow-up messages the bridge submitted from Telegram. */
  const telegramMessageIds = new Set()

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
    return chatForLoaded(chatId, threadId)
  }

  /**
   * Find the topic currently bound to a session, without waiting.
   * @param sessionId - DSH session id.
   * @returns the topic's chat state, or undefined when no topic shows it.
   */
  function chatForSession(sessionId) {
    if (!stateLoaded || typeof sessionId !== 'string') return undefined
    const record = state.sessions[sessionId]
    if (record === undefined || typeof record.chatId !== 'number' || typeof record.threadId !== 'number') return undefined
    if (state.threads[`${record.chatId}:${record.threadId}`] !== sessionId) return undefined
    return chatForLoaded(record.chatId, record.threadId)
  }

  /**
   * Resolve one topic's transient bridge state after state.json is loaded.
   * @param chatId - Telegram chat id.
   * @param threadId - topic thread.
   * @returns the chat state.
   */
  function chatForLoaded(chatId, threadId) {
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
        turnSource: undefined,
        awaitingTurn: false,
        pendingPrompts: [],
        turnEpoch: 0,
        activeTurn: undefined,
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
        toolEpoch: 0,
        toolEdit: Promise.resolve(),
        thinkingEdit: Promise.resolve(),
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

  /** @returns the default Workspace path, or the configured fallback cwd. */
  function defaultWorkspaceCwd() {
    try {
      const workspaces = ctx.get('workspaceRegistry')?.list() ?? []
      const preferred = workspaces.find((entry) => basename(entry.path) === 'default-workspace') ?? workspaces[0]
      if (typeof preferred?.path === 'string' && preferred.path.length > 0) return preferred.path
    } catch {
      // Fall through to the agent default.
    }
    return cwdOf()
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
    // No forced effort: without a saved or default choice the model's own default applies.
    const effort = record?.effort ?? fallback?.reasoningEffort
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
          reasoningEffort: effort ?? modelSelection()?.reasoningEffort,
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
    if (effort === undefined) return tr('Default', 'По умолчанию')
    return EFFORT_CHOICES.find((choice) => choice.id === effort)?.label ?? String(effort)
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
    if (detail === undefined || String(detail).trim().length === 0) return `${toolEmoji(name)} <b>${escapeHtml(name)}</b>`
    const compact = String(detail)
      .replace(/\s+/gu, ' ')
      .replace(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?=&&|;|\|\||$)/u, '[workspace] ')
      .trim()
    // Three mobile lines: command text starts on the header line, then two
    // continuation lines. Extra detail is cut to keep the phone layout compact.
    const first = compact.slice(0, 25)
    const second = compact.slice(25, 58)
    const third = compact.slice(58, 91)
    return `${toolEmoji(name)} <b>${escapeHtml(name)}:</b> <code>${escapeHtml(first)}</code>${second.length === 0 ? '' : `\n<code>${escapeHtml(second)}</code>`}${third.length === 0 ? '' : `\n<code>${escapeHtml(third)}</code>`}`
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

  /**
   * Record one background failure. Diagnostics must never take the runtime down.
   * @param scope - short operation label.
   * @param error - failure.
   */
  function reportError(scope, error) {
    const detail = messageOf(error)
    const kind = classifyError(error)
    warn(`${scope} [${kind}]: ${detail}`)
    void publishStatus({
      lastError: { scope, kind, detail, at: new Date().toISOString() },
      lastErrorKind: kind,
      lastErrorScope: scope,
    })
  }

  /**
   * Run a fire-and-forget task with a rejection boundary.
   * @param scope - short operation label.
   * @param task - task factory.
   */
  function fireAndForget(scope, task) {
    Promise.resolve().then(task).catch((error) => reportError(scope, error))
  }

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
   * Per-chat adaptive token bucket. Four quick writes are allowed as a burst;
   * sustained traffic is paced, and a 429 tightens the bucket further.
   * @param chatId - target chat.
   * @param signal - request lifetime.
   */
  async function paceOutbound(chatId, signal) {
    const key = String(chatId)
    let state = outboundStates.get(key)
    if (state === undefined) {
      state = { tokens: 10, capacity: 10, intervalMs: 50, minDelayMs: 20, updatedAt: Date.now(), tail: Promise.resolve() }
      outboundStates.set(key, state)
    }
    const previous = state.tail
    let release
    state.tail = new Promise((resolve) => { release = resolve })
    await previous
    try {
      const now = Date.now()
      state.tokens = Math.min(state.capacity, state.tokens + (now - state.updatedAt) / state.intervalMs)
      state.updatedAt = now
      let wait = state.minDelayMs
      if (state.tokens < 1) {
        wait = Math.max(state.minDelayMs, Math.ceil((1 - state.tokens) * state.intervalMs))
        state.tokens = 0
      } else {
        state.tokens -= 1
      }
      await sleep(wait, signal)
      state.updatedAt = Date.now()
    } finally {
      release()
    }
  }

  /**
   * Tighten one chat's bucket after Telegram asks us to slow down.
   * @param chatId - target chat.
   * @param retryAfter - Telegram retry_after seconds, when present.
   */
  function noteRateLimit(chatId, retryAfter) {
    const key = String(chatId)
    const state = outboundStates.get(key)
    if (state === undefined) return
    state.tokens = 0
    state.updatedAt = Date.now()
    state.intervalMs = Math.min(5000, Math.max(20, Math.ceil((retryAfter ?? 1) * 1000)))
    state.capacity = Math.min(state.capacity, 2)
  }

  /**
   * Call one Bot API method. Errors carry Telegram's description, never the
   * token or the request URL.
   * @param method - Bot API method.
   * @param payload - JSON body.
   * @param signal - runtime lifetime.
   * @returns the method result.
   */
  async function call(method, payload, signal, timeoutMs = 30_000, encoded) {
    const token = await resolveToken()
    if (token === undefined) throw new Error('TELEGRAM_BOT_TOKEN is not configured')
    if (process.env.NODE_ENV !== 'test' && payload !== null && typeof payload === 'object' && payload.chat_id !== undefined && method !== 'getUpdates') {
      await paceOutbound(payload.chat_id, signal)
    }
    // `encoded` carries a prepared body (a file upload); `payload` then only
    // names the chat for pacing.
    const body = encoded?.body ?? JSON.stringify(payload)
    const contentType = encoded?.contentType ?? 'application/json'
    // Mirror Hermes' Telegram fallback: try the normal IPv4 path first, then
    // the Bot API seed IPv4 literals with Host/SNI kept on api.telegram.org.
    // Some networks blackhole one family or one anycast path for long polls
    // while short requests still succeed.
    const targets = [undefined, '149.154.166.110', '149.154.167.220']
    let lastError
    let rateLimitRetries = 0
    for (let attempt = 0; attempt < targets.length + 4; attempt += 1) {
      const target = targets[attempt % targets.length]
      try {
        return await requestOnce(target, token, method, body, signal, timeoutMs, contentType)
      } catch (error) {
        lastError = error
        if (signal.aborted) throw error
        if (error?.telegram === true) {
          if (payload !== null && typeof payload === 'object' && payload.chat_id !== undefined) {
            noteRateLimit(payload.chat_id, error.retryAfter)
            // Any call into a deleted topic means its binding is dead for good.
            if (isTopicGone(error.message)) forgetGoneTopic(payload.chat_id, payload.message_thread_id, method)
          }
          // Telegram asks the caller to back off explicitly. Retrying a few
          // times keeps a final answer from being lost during bursts of edits.
          if (Number.isFinite(error.retryAfter) && error.retryAfter <= 60 && rateLimitRetries < 3) {
            rateLimitRetries += 1
            await sleep((Math.max(1, error.retryAfter) + 1) * 1000, signal)
            continue
          }
          throw error
        }
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
  function requestOnce(target, token, method, body, signal, timeoutMs, contentType = 'application/json') {
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
          'content-type': contentType,
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
            if (typeof parsed?.parameters?.retry_after === 'number') {
              error.retryAfter = parsed.parameters.retry_after
            }
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
   * Send one HTML message without a keyboard.
   * @param chatId - target chat.
   * @param text - HTML body.
   * @param signal - request lifetime.
   * @param threadId - topic thread.
   * @returns the Bot API result, or undefined.
   */
  async function send(chatId, text, signal, threadId) {
    return sendKeyboard(chatId, threadId, text, [], signal)
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
   * Download one Telegram file by id.
   * @param fileId - Telegram file id.
   * @param signal - request lifetime.
   * @returns exact bytes.
   */
  async function downloadTelegramFile(fileId, signal) {
    const token = await resolveToken()
    if (token === undefined) throw new Error('TELEGRAM_BOT_TOKEN is not configured')
    const info = await call('getFile', { file_id: fileId }, signal)
    const filePath = info?.file_path
    if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('Telegram returned no file path')
    if (typeof info.file_size === 'number' && info.file_size > 20 * 1024 * 1024) {
      throw new Error('Telegram file is larger than the 20 MB bot download limit')
    }
    return new Promise((resolve, reject) => {
      const request = https.request({
        host: 'api.telegram.org',
        port: 443,
        path: `/file/bot${token}/${filePath}`,
        method: 'GET',
        family: 4,
        timeout: 30_000,
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`Telegram file download returned HTTP ${response.statusCode}`))
          return
        }
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > 20 * 1024 * 1024) {
            request.destroy(new Error('Telegram file is larger than the 20 MB bot download limit'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => resolve(Buffer.concat(chunks)))
        response.on('error', reject)
      })
      const abort = () => request.destroy(new Error('Telegram file download aborted'))
      signal.addEventListener('abort', abort, { once: true })
      request.on('timeout', () => request.destroy(new Error('Telegram file download timed out')))
      request.on('error', reject)
      request.on('close', () => signal.removeEventListener('abort', abort))
      request.end()
    })
  }

  /**
   * Save one spoken recording (voice, audio, round video) as a file and
   * transcribe it. A failed transcription still passes the file, with a note.
   * @param message - Telegram message carrying the recording.
   * @param media - result of spokenMediaOf.
   * @param signal - request lifetime.
   * @returns the file block, the transcript block and the display name.
   */
  async function saveSpokenMedia(message, media, signal) {
    const attachments = ctx.get('attachments')
    const bytes = await downloadTelegramFile(media.file.file_id, signal)
    const attachment = await attachments.saveFile({ data: bytes, name: media.name })
    let path
    try {
      path = attachments.fileHostPath?.(attachment)
    } catch {
      path = undefined
    }
    let scratch
    let outcome
    try {
      // Decoders and commands read a file; use a private copy when the store has no host path.
      if (typeof path !== 'string') {
        scratch = await mkdtemp(join(tmpdir(), 'dsh-telegram-voice-'))
        await writeFile(join(scratch, basename(media.name)), bytes)
      }
      const result = await transcribe({
        mode: readLive(config.transcriber, 'dsh'),
        path: path ?? join(scratch, basename(media.name)),
        language: readLive(config.transcribeLanguage, ''),
        command: readLive(config.transcribeCommand, []),
        ffmpeg: readLive(config.ffmpegPath, 'ffmpeg'),
        speech: ctx.get('speechToText'),
        signal,
      })
      outcome = { path, ...result }
    } catch (error) {
      if (signal.aborted) throw error
      warn(`${media.kind} ${media.name} not transcribed: ${messageOf(error)}`)
      outcome = { path, error: messageOf(error) }
    } finally {
      if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
    }
    return {
      block: { type: 'file', attachment },
      note: { type: 'text', text: transcriptNote(media, outcome) },
      name: media.name,
    }
  }

  /**
   * Save one Telegram attachment and return its DSH content blocks.
   * @param message - Telegram message carrying a photo, document or recording.
   * @param signal - request lifetime.
   * @returns prompt content block, a transcript note for recordings, and the display name.
   */
  async function saveTelegramAttachment(message, signal) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new Error('DSH attachment store is unavailable')
    const spoken = spokenMediaOf(message)
    if (spoken !== undefined && message.document === undefined && !Array.isArray(message.photo)) return saveSpokenMedia(message, spoken, signal)
    const photo = Array.isArray(message.photo) ? message.photo.at(-1) : undefined
    const document = message.document
    const fileId = photo?.file_id ?? document?.file_id
    if (typeof fileId !== 'string') throw new Error('Telegram message has no downloadable file')
    const name = photo !== undefined
      ? `telegram-photo-${message.message_id ?? Date.now()}.jpg`
      : String(document?.file_name ?? `telegram-file-${message.message_id ?? Date.now()}`)
    const mediaType = photo !== undefined ? 'image/jpeg' : String(document?.mime_type ?? '')
    const bytes = await downloadTelegramFile(fileId, signal)
    if (mediaType === 'image/jpeg' || mediaType === 'image/png' || mediaType === 'image/webp' || mediaType === 'image/gif') {
      const attachment = await attachments.saveImage({ data: bytes, mediaType, name })
      return { block: { type: 'image', attachment }, name }
    }
    const attachment = await attachments.saveFile({ data: bytes, name })
    return { block: { type: 'file', attachment }, name }
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
      if (!isTelegramParseError(detail)) throw error
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
      if (/not modified/i.test(detail)) return true
      if (!isTelegramParseError(detail)) throw error
      if (!signal.aborted) {
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
      if (!isTelegramParseError(detail)) throw error
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
      if (!isTelegramParseError(detail)) throw error
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
  /** In-flight topic opens keyed by chat and DSH session. */
  const openingTopics = new Map()
  /** Short workspace codes for callback_data (Telegram limit is 64 bytes). */
  const workspaceCodes = new Map()
  let workspaceCodeSeq = 0

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
    fireAndForget('question-ui', () => editKeyboardMarkdown(
      pending.chatId,
      pending.threadId,
      pending.messageId,
      `✅ **${tr('Answer recorded', 'Ответ принят')}**`,
      [],
      bridgeAbort.signal,
    ))
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
        fireAndForget('question-ui', () => editKeyboardMarkdown(
          pending.chatId,
          pending.threadId,
          pending.messageId,
          `⏹ **${tr('Question cancelled', 'Вопрос отменён')}**`,
          [],
          bridgeAbort.signal,
        ))
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
    const command = normalizeCommand(text.trim().split(/\s+/u)[0])
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
        fireAndForget('question-ui', () => editKeyboardMarkdown(
          pending.chatId,
          pending.threadId,
          pending.messageId,
          `⏹ **${tr('Question cancelled', 'Вопрос отменён')}**`,
          [],
          bridgeAbort.signal,
        ))
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
    // Older versions titled topic sessions "TG · <name>"; move them to the
    // current form when the session is next used.
    if (agent.session !== undefined && typeof chat.threadId === 'number' && topicOfSession(agent.session.id) !== undefined) {
      fireAndForget('topic-title', () => syncTopicTitle(agent.session, chat.chatId, chat.threadId))
    }
    agent.ctx.on('session/event', (session, event) => {
      try {
        if (chat.boundAgent !== agent || session?.id !== chat.sessionId) return
        if (event.type === 'turn/start' && chat.turnSource === 'telegram' && chat.awaitingTurn) {
          chat.activeTurn = event.data?.turn
          chat.awaitingTurn = false
          return
        }
        if (event.type === 'turn/end' && chat.turnSource === 'telegram' && event.data?.turn === chat.activeTurn) {
          chat.activeTurn = undefined
          finalizeSafely(chat)
        }
      } catch (error) {
        reportError('session-event', error)
      }
    })
    agent.ctx.on('agent/assistant-stream', (payload) => {
      try {
        // Turns started elsewhere reach the topic through the Host-wide mirror.
        if (chat.boundAgent !== agent || chat.turnSource !== 'telegram') return
        onFrame(chat, payload?.frame)
      } catch (error) {
        reportError('assistant-stream', error)
      }
    })
    agent.ctx.on('agent/error', (payload) => {
      if (chat.boundAgent !== agent || chat.turnSource !== 'telegram') return
      fireAndForget('agent-error', () => failChat(chat, payload?.error))
    })
    if (chat.approvalAgent !== agent) {
      chat.approvalAgent = agent
      agent.ctx.on('approval/request', (req, next) => {
        if (chat.boundAgent !== agent || chat.turnSource !== 'telegram') return next()
        return Promise.resolve(requestApproval(agent, chat, req, next)).catch((error) => {
          reportError('approval', error)
          return next()
        })
      }, { prepend: true })
    }
    if (chat.questionAgent !== agent) {
      chat.questionAgent = agent
      agent.ctx.on('user-questions/request', (req, next) => {
        if (chat.boundAgent !== agent || chat.turnSource !== 'telegram') return next()
        return Promise.resolve(requestUserQuestions(agent, chat, req, next)).catch((error) => {
          reportError('user-questions', error)
          return next()
        })
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
   * Make a session the bot just created for a topic its own: give it the
   * topic's title and end its blank state.
   *
   * DSH reuses a "blank" session (one that has never started a turn) for the
   * next New conversation in the Web UI, and only a `turn/start` event ends
   * that state; titles and queued messages do not. A topic session that waits
   * for its first Telegram message would otherwise be handed to whoever clicks
   * New in the Web UI, and their chat would be mirrored into the topic. So the
   * bot runs one empty turn right away: it queues a marker message and rejects
   * it at `agent/pre-step`, before any model request (the same gate DSH uses to
   * stop turns in archived sessions). The turn ends as `blocked` and the marker
   * is never recorded as a message.
   * Call it before the session is bound, so the mirror ignores this turn.
   * @param agent - the new session's agent.
   * @param chat - topic state.
   */
  async function claimForTopic(agent, chat) {
    const session = agent?.session
    if (session !== undefined && typeof chat.threadId === 'number') {
      const service = ctx.get('sessionTitle')
      let current
      try {
        current = service?.get(session)
      } catch {
        current = undefined
      }
      if (service !== undefined && current === undefined) setSessionTitle(session, topicPrefixOf(chat.chatId, chat.threadId))
    }
    if (typeof agent?.followup !== 'function' || typeof agent?.ctx?.on !== 'function') {
      warn(`session ${session?.id ?? agent?.id} cannot run an empty turn; DSH may treat it as blank`)
      return
    }
    const id = randomUUID()
    const dispose = agent.ctx.on('agent/pre-step', (payload, next) => {
      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      if (messages.length > 0 && messages.every((message) => message?.id === id)) return Promise.resolve({ kind: 'reject' })
      return next()
    })
    agent.followup({
      id,
      role: 'user',
      content: [{ type: 'text', text: `[This session belongs to the Telegram topic ${chat.threadId}]` }],
      source: { kind: 'user', rpcId: `telegram-claim:${id}` },
    })
    // The gate stays until the turn is over, so the marker can never reach a model.
    const idle = typeof agent.whenIdle === 'function' ? agent.whenIdle() : Promise.resolve()
    void idle.catch(() => undefined).finally(() => { if (typeof dispose === 'function') dispose() })
    let timer
    await Promise.race([
      idle.catch(() => undefined),
      new Promise((resolveWait) => { timer = setTimeout(resolveWait, 10_000) }),
    ])
    clearTimeout(timer)
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
        await claimForTopic(agent, chat)
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
    await claimForTopic(handle.agent, chat)
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
      fireAndForget('stream-flush', () => flushChat(chat))
    }, delay)
  }

  /**
   * Publish the current streaming buffer.
   * @param chat - chat bridge state.
   */
  async function flushChat(chat) {
    if (chat.done) return
    // A mirrored turn has no "Generating" placeholder; its first flush sends
    // the answer message.
    if (chat.messageId === null && chat.turnSource !== 'mirror') return
    const raw = renderChat(chat)
    if (raw.length === 0) return
    const next = toTelegramMarkdown(raw)
    if (next === chat.lastText) return
    chat.lastText = next
    chat.lastEdit = Date.now()
    chat.answerEdit = (chat.answerEdit ?? Promise.resolve()).then(async () => {
      if (chat.done) return
      if (chat.messageId === null) {
        const result = await sendAnswer(chat.chatId, raw, bridgeAbort.signal, chat.threadId)
        if (result?.message_id !== undefined) chat.messageId = result.message_id
        return
      }
      await editAnswer(chat.chatId, chat.messageId, raw, bridgeAbort.signal, chat.threadId)
    }).catch((error) => {
      if (!bridgeAbort.signal.aborted) reportError('stream-edit', error)
    })
    await chat.answerEdit
  }

  /**
   * How often "typing…" is renewed; Telegram shows it for about 5 seconds.
   * Tests use a short period, as they skip outbound pacing.
   */
  const TYPING_REFRESH_MS = process.env.NODE_ENV === 'test' ? 100 : 4000

  /**
   * Show "typing…" in the topic while its turn runs. Each topic has its own
   * timer; it stops itself as soon as the topic is no longer busy, so a
   * missed stop costs at most one extra refresh.
   * @param chat - topic state.
   */
  function startTyping(chat) {
    if (chat.typingTimer !== undefined && chat.typingTimer !== null) return
    const tick = () => {
      if (!chat.busy || chat.done || lifetime === undefined || bridgeAbort.signal.aborted) {
        stopTyping(chat)
        return
      }
      // A slow or rate-limited call is not stacked with a second one.
      if (chat.typingInFlight === true) return
      chat.typingInFlight = true
      call('sendChatAction', {
        chat_id: chat.chatId,
        ...(chat.threadId === undefined || chat.threadId === 0 ? {} : { message_thread_id: chat.threadId }),
        action: 'typing',
      }, bridgeAbort.signal, 10_000)
        .catch((error) => {
          if (!bridgeAbort.signal.aborted) warn(`sendChatAction failed: ${messageOf(error)}`)
        })
        .finally(() => { chat.typingInFlight = false })
    }
    chat.typingTimer = setInterval(tick, TYPING_REFRESH_MS)
    chat.typingTimer.unref?.()
    tick()
  }

  /** Stop renewing "typing…" for one topic. */
  function stopTyping(chat) {
    if (chat.typingTimer !== undefined && chat.typingTimer !== null) clearInterval(chat.typingTimer)
    chat.typingTimer = null
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
    return queueAuxEdit(chat, 'thinkingEdit', 'thinking-edit', async () => {
      const full = chat.thinkingText.replace(/\r/gu, '')
      if (full.trim().length === 0) return
      if (chat.done) chat.thinkingShown = full.length
      else chat.thinkingShown = Math.min(full.length, chat.thinkingShown + 40)
      const text = full.slice(0, chat.thinkingShown).trim()
      if (text.length === 0) return
      // Header counts as one line; keep at most nine wrapped content lines.
      const bounded = wrapThinkingLines(text, 40, 9).trimEnd()
      const body = `💭 Thinking\n${bounded}`
      if (body === chat.thinkingLastText) return
      chat.thinkingLastText = body
      if (chat.thinkingMessageId === null) {
        const result = await sendPlain(chat.chatId, body, bridgeAbort.signal, chat.threadId)
        if (chat.done) {
          if (result?.message_id !== undefined) await deleteMessage(chat.chatId, chat.threadId, result.message_id)
          return
        }
        chat.thinkingMessageId = result?.message_id ?? null
      } else {
        await editPlain(chat.chatId, chat.thinkingMessageId, body, bridgeAbort.signal, chat.threadId)
      }
      if (!chat.done && chat.thinkingShown < full.length) scheduleThinking(chat)
    })
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
    if (chat.tools.length > 5) chat.tools = chat.tools.slice(-5)
    return tool
  }

  /**
   * Publish the rolling tool-call list as the second message.
   * @param chat - chat bridge state.
   */
  function queueAuxEdit(chat, field, label, task) {
    chat[field] = chat[field].then(task).catch((error) => reportError(label, error))
    return chat[field]
  }

  async function flushTool(chat) {
    return queueAuxEdit(chat, 'toolEdit', 'tool-edit', async () => {
      if (chat.done || chat.tools.length === 0) return
      const epoch = chat.toolEpoch ?? 0
      const lines = chat.tools.slice(-5).map(formatToolCall).join('\n').split('\n')
      if (lines.length > 0) lines[lines.length - 1] = lines.at(-1).slice(0, 26).trimEnd()
      const body = lines.join('\n')
      if (body === chat.toolLastText) return
      chat.toolLastText = body
      if (chat.toolMessageId === null) {
        const result = await sendKeyboard(chat.chatId, chat.threadId, body, [], bridgeAbort.signal)
        if (chat.done || (chat.toolEpoch ?? 0) !== epoch) {
          if (result?.message_id !== undefined) await deleteMessage(chat.chatId, chat.threadId, result.message_id)
          return
        }
        chat.toolMessageId = result?.message_id ?? null
      } else {
        await editKeyboard(chat.chatId, chat.threadId, chat.toolMessageId, body, [], bridgeAbort.signal)
      }
    })
  }

  /**
   * Throttle the thinking display.
   * @param chat - chat bridge state.
   */
  function scheduleThinking(chat) {
    if (chat.thinkingTimer !== null || chat.done) return
    chat.thinkingTimer = setTimeout(() => {
      chat.thinkingTimer = null
      fireAndForget('thinking-flush', () => flushThinking(chat))
    }, 650)
  }

  /**
   * Consume one assistant stream frame.
   * @param chat - chat bridge state.
   * @param frame - stream frame.
   */
  function onFrame(chat, frame) {
    if (frame === undefined || chat.done || (chat.turnSource !== 'telegram' && chat.turnSource !== 'mirror')) return
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
      // Tool arguments are only useful once complete; wait for block-end.
      chat.textSeparator = chat.text.length > 0
      return
    }
    if (frame.type === 'chunk' && frame.chunk?.type === 'block-end' && frame.chunk.block?.type === 'tool-call') {
      if (readLive(config.showToolCalls, true) !== true) return
      chat.textSeparator = chat.text.length > 0
      upsertTool(chat, frame.chunk.block)
      fireAndForget('tool-flush-now', () => flushTool(chat))
    }
  }

  /** Finalize one turn and surface a finalization failure instead of hanging. */
  function finalizeSafely(chat) {
    fireAndForget('finalize', async () => {
      try {
        await finalizeChat(chat)
      } catch (error) {
        reportError('finalize', error)
        await failChat(chat, error, true)
      }
    })
  }

  /**
   * Flush the final assistant text into the first answer message and split it.
   * @param chat - chat bridge state.
   */
  async function finalizeChat(chat) {
    if (chat.done) return
    chat.done = true
    const source = chat.turnSource
    const turn = chat.activeTurn
    clearEditTimer(chat)
    clearAuxTimers(chat)
    if (chat.answerEdit !== undefined) await chat.answerEdit.catch(() => {})
    // Take the finished turn out of the chat state before any network wait,
    // so the next turn (from any client) starts with clean buffers.
    let text = chat.text.trim()
    if (source === 'mirror') {
      // Durable assistant messages are complete even when stream frames were
      // missed, so they win for turns started outside Telegram.
      const recorded = (chat.mirrorTexts?.get(turn) ?? []).join('\n\n').trim()
      if (recorded.length > 0) text = recorded
      chat.mirrorTexts?.delete(turn)
    }
    const messageId = chat.messageId
    const thinkingId = chat.thinkingMessageId
    const toolId = chat.toolMessageId
    chat.text = ''
    chat.lastText = ''
    chat.messageId = null
    resetAux(chat)
    chat.busy = false
    stopTyping(chat)
    chat.turnSource = undefined
    chat.awaitingTurn = false
    chat.activeTurn = undefined
    const deferred = chat.deferredMirrorTurn
    chat.deferredMirrorTurn = undefined
    if (deferred !== undefined) startMirrorTurn(chat, deferred.turn)
    // The final text is already available: remove auxiliary messages now,
    // before spending time on answer edits and sends.
    if (thinkingId !== null) await deleteMessage(chat.chatId, chat.threadId, thinkingId)
    if (toolId !== null) await deleteMessage(chat.chatId, chat.threadId, toolId)
    // A turn started elsewhere that produced no text adds nothing to the topic.
    if (text.length > 0 || source !== 'mirror' || messageId !== null) {
      const chunks = splitAnswerText(text.length > 0 ? text : tr('✅ Done.', '✅ Готово.'))
      if (messageId !== null) {
        const edited = await editAnswer(chat.chatId, messageId, chunks[0], bridgeAbort.signal, chat.threadId)
        if (!edited) await sendAnswer(chat.chatId, chunks[0], bridgeAbort.signal, chat.threadId)
      } else {
        await sendAnswer(chat.chatId, chunks[0], bridgeAbort.signal, chat.threadId)
      }
      for (const chunk of chunks.slice(1)) {
        await sendAnswer(chat.chatId, chunk, bridgeAbort.signal, chat.threadId)
      }
    }
    // Local images in the reply show inline in the Web UI only; upload them.
    const images = localImagePaths(text)
    if (images.length > 0) {
      await forwardFiles(chat, images, { sessionId: chat.sessionId, turn, label: 'reply image', quiet: true })
    }
    if (deferred?.ended === true) finalizeSafely(chat)
    // A turn that started meanwhile keeps the queue; its own end runs it.
    const next = chat.busy ? undefined : chat.pendingPrompts?.shift()
    if (next !== undefined) {
      await runAgent(chat, next.text, bridgeAbort.signal, next.attachments ?? [], next.messageId)
    }
    await publishStatus({ lastOutcome: 'agent-replied' })
  }

  /**
   * Start showing a turn that began outside Telegram in its topic.
   * @param chat - topic state.
   * @param turn - DSH turn number.
   */
  function startMirrorTurn(chat, turn) {
    chat.busy = true
    chat.done = false
    chat.turnSource = 'mirror'
    chat.awaitingTurn = false
    chat.activeTurn = turn
    chat.turnEpoch = (chat.turnEpoch ?? 0) + 1
    chat.toolEpoch = (chat.toolEpoch ?? 0) + 1
    chat.text = ''
    chat.lastText = ''
    chat.messageId = null
    clearEditTimer(chat)
    resetAux(chat)
    // Keep the chain: a mirrored prompt may already be queued on it.
    chat.answerEdit ??= Promise.resolve()
    startTyping(chat)
  }

  /**
   * Show a user message that reached the session from another client.
   * Messages the bridge itself submitted are skipped, so nothing echoes back.
   * @param chat - topic state.
   * @param message - durable user message.
   */
  function mirrorUserMessage(chat, message) {
    const source = message?.source
    let label
    if (source?.kind === 'user') {
      if (typeof source.rpcId === 'string' && source.rpcId.startsWith('telegram')) return
      if (telegramMessageIds.delete(message.id)) return
      label = tr('🖥 From Web', '🖥 Из Web')
    } else if (source?.kind === 'schedule') {
      label = tr('⏰ Scheduled task', '⏰ Задача по расписанию')
    } else {
      // Context injected by plugins (time, runtime notes, replies) is not a
      // message anyone typed.
      return
    }
    const content = Array.isArray(message.content) ? message.content : []
    const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
    const files = content.filter((block) => block?.type === 'image' || block?.type === 'file').length
    if (text.length === 0 && files === 0) return
    const body = `${label}:\n${clipPreview(text, 3000)}${files === 0 ? '' : `\n📎 ${files}`}`
    // Queue behind the answer stream so the prompt stays above its answer.
    chat.answerEdit = (chat.answerEdit ?? Promise.resolve())
      .then(() => sendPlain(chat.chatId, body, bridgeAbort.signal, chat.threadId))
      .catch((error) => reportError('mirror-user', error))
  }

  /**
   * Mirror turns that started outside Telegram into the session's topic.
   * Telegram-started turns are handled by the per-agent listeners.
   * @param session - session that appended the event.
   * @param event - durable session event.
   */
  function onMirrorEvent(session, event) {
    if (lifetime === undefined) return
    const chat = chatForSession(session?.id)
    if (chat === undefined) return
    // A steered message may open a turn of its own (the previous one ended as
    // it landed); that turn is shown even with mirroring off. Once a turn ends
    // with nothing left in the inbox, every steered message has been taken.
    const follow = readLive(config.mirrorTurns, true) === true || chat.steerFollow === true
    if (event.type === 'turn/end' && chat.steerFollow === true && !hasPendingInput(ctx.get('agents')?.get(session.id))) {
      chat.steerFollow = false
    }
    if (event.type === 'deliverables/presented') {
      // Presented files show in the Web UI; send them to the topic too, for
      // Telegram turns and for mirrored ones.
      if (!follow && chat.turnSource !== 'telegram') return
      const paths = (Array.isArray(event.data?.files) ? event.data.files : [])
        .map((file) => file?.path)
        .filter((path) => typeof path === 'string' && path.length > 0)
      if (paths.length === 0) return
      const options = { sessionId: session.id, turn: event.data?.turn, label: 'present' }
      // Queue behind the topic's other output so messages keep their order.
      chat.answerEdit = (chat.answerEdit ?? Promise.resolve())
        .catch(() => {})
        .then(() => forwardFiles(chat, paths, options))
        .catch((error) => reportError('forward-file', error))
      return
    }
    if (!follow) return
    const turn = event.data?.turn
    if (event.type === 'user/message') {
      mirrorUserMessage(chat, event.data)
      return
    }
    if (event.type === 'assistant/message') {
      const message = event.data?.message ?? event.data
      const content = Array.isArray(message?.content) ? message.content : []
      const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
      if (text.length === 0) return
      if (chat.turnSource !== 'mirror' && chat.deferredMirrorTurn?.turn !== turn) return
      chat.mirrorTexts ??= new Map()
      const texts = chat.mirrorTexts.get(turn) ?? []
      texts.push(text)
      chat.mirrorTexts.set(turn, texts)
      return
    }
    if (event.type === 'turn/start') {
      if (!chat.busy) startMirrorTurn(chat, turn)
      // The previous turn is still being finalized: start right after it.
      else if (chat.done) chat.deferredMirrorTurn = { turn, ended: false }
      return
    }
    if (event.type === 'turn/end') {
      if (chat.deferredMirrorTurn?.turn === turn) {
        chat.deferredMirrorTurn.ended = true
        return
      }
      if (chat.turnSource !== 'mirror' || turn !== chat.activeTurn) return
      const reason = event.data?.reason
      const recorded = chat.mirrorTexts?.get(turn) ?? []
      if (reason?.kind === 'error' && recorded.length === 0 && chat.text.trim().length === 0) {
        chat.mirrorTexts?.delete(turn)
        fireAndForget('mirror-error', () => failChat(chat, new Error(reason.error?.message ?? 'turn failed')))
        return
      }
      finalizeSafely(chat)
    }
  }

  /**
   * Report one agent failure into the chat.
   * @param chat - chat bridge state.
   * @param error - failure.
   */
  async function failChat(chat, error, force = false) {
    if (chat.done && !force) return
    chat.done = true
    chat.busy = false
    stopTyping(chat)
    chat.turnSource = undefined
    chat.awaitingTurn = false
    chat.activeTurn = undefined
    chat.pendingPrompts = []
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
    await publishStatus({
      lastOutcome: 'agent-error',
      detail,
      lastError: { scope: 'agent', kind: classifyError(error), detail, at: new Date().toISOString() },
      lastErrorKind: classifyError(error),
      lastErrorScope: 'agent',
    })
  }

  /**
   * Send one user prompt to the chat's agent.
   * @param chat - chat bridge state.
   * @param text - prompt text.
   * @param signal - runtime lifetime.
   */
  async function runAgent(chat, text, signal, attachments = [], messageId) {
    const nativeText = attachments.length === 0 && Number.isSafeInteger(messageId)
    // A prompt that is still being handed to DSH goes first, so a quick second
    // message cannot overtake it.
    while (chat.admission !== undefined) await chat.admission
    if (chat.busy && busyMode(readLive(config.busyMessages, 'steer')) === 'steer') {
      if (await steerAgent(chat, text, signal, attachments, messageId)) return
    }
    if (chat.busy) {
      chat.pendingPrompts ??= []
      chat.pendingPrompts.push({ text, attachments, messageId })
      await sendPlain(chat.chatId, tr('📥 Accepted into the session queue. Send /clear to cancel.', '📥 Принято в очередь сессии. Отправь /clear, чтобы отменить.'), signal, chat.threadId)
      return
    }
    chat.busy = true
    chat.done = false
    chat.turnSource = 'telegram'
    chat.awaitingTurn = true
    chat.activeTurn = undefined
    chat.turnEpoch = (chat.turnEpoch ?? 0) + 1
    chat.toolEpoch = (chat.toolEpoch ?? 0) + 1
    const epoch = chat.turnEpoch
    chat.text = ''
    chat.lastText = ''
    chat.messageId = null
    clearEditTimer(chat)
    resetAux(chat)
    chat.answerEdit = Promise.resolve()
    startTyping(chat)
    await admitInOrder(chat, () => startTurn(chat, text, signal, attachments, messageId, nativeText, epoch))
  }

  /**
   * Run one hand-over of a prompt to DSH while later prompts of the same topic
   * wait for it (`runAgent` waits on `chat.admission`), so messages reach the
   * agent in the order they were sent.
   * @param chat - chat bridge state.
   * @param task - the hand-over.
   * @returns the task's result.
   */
  async function admitInOrder(chat, task) {
    let admitted
    const admission = new Promise((resolve) => { admitted = resolve })
    chat.admission = admission
    try {
      return await task()
    } finally {
      if (chat.admission === admission) chat.admission = undefined
      admitted()
    }
  }

  /**
   * Send a prompt into the turn that is running in the topic's session; DSH
   * gives it to the agent at its next step (`steer`, as the Web UI does).
   * @param chat - chat bridge state.
   * @param text - prompt text.
   * @param signal - runtime lifetime.
   * @param attachments - stored attachment blocks.
   * @param messageId - Telegram message id.
   * @returns false when the prompt still needs a turn of its own or the queue.
   */
  async function steerAgent(chat, text, signal, attachments, messageId) {
    const steered = await admitInOrder(chat, async () => {
      let agent
      try {
        agent = await ensureAgent(chat)
      } catch (error) {
        reportError('steer', error)
        return false
      }
      if (!chat.busy) return false
      // The bridge shows a turn that DSH no longer runs and that is not being
      // finalized (a lost turn/end): forget it and start a fresh turn.
      if (agent.status === 'idle' && !chat.done) {
        resetStaleTurn(chat)
        return false
      }
      let requestId
      try {
        requestId = await steerPrompt(ctx, agent, { sessionId: chat.sessionId, chatId: chat.chatId, messageId, text, attachments }, signal)
      } catch (error) {
        // Not admitted: the bot's queue still delivers it after the turn.
        reportError('steer', error)
        return false
      }
      if (requestId === undefined) return false
      // If the turn ended just before the message landed, DSH opens a new turn
      // for it; follow that turn in the topic even when mirroring is off.
      chat.steerFollow = true
      return true
    })
    if (!steered) return false
    // After the hand-over, so the next message does not wait for Telegram.
    await acknowledgeSteer(chat, messageId, signal)
    await publishStatus({ lastOutcome: 'prompt-steered' })
    return true
  }

  /** Forget a bridge turn that DSH no longer runs. */
  function resetStaleTurn(chat) {
    clearEditTimer(chat)
    clearAuxTimers(chat)
    chat.busy = false
    stopTyping(chat)
    chat.done = true
    chat.turnSource = undefined
    chat.awaitingTurn = false
    chat.activeTurn = undefined
    chat.turnEpoch = (chat.turnEpoch ?? 0) + 1
  }

  /**
   * Tell the sender that a message reached the running turn: a reaction on
   * the message, or a short note when reactions are unavailable.
   */
  async function acknowledgeSteer(chat, messageId, signal) {
    if (Number.isSafeInteger(messageId)) {
      try {
        await call('setMessageReaction', {
          chat_id: chat.chatId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji: STEER_REACTION }],
        }, signal)
        return
      } catch (error) {
        if (signal.aborted) return
        warn(`setMessageReaction failed: ${messageOf(error)}`)
      }
    }
    await sendPlain(chat.chatId, tr('↪️ Sent to the running turn.', '↪️ Отправлено в текущий ход.'), signal, chat.threadId)
  }

  /**
   * Show the turn's placeholders and hand its prompt to DSH.
   * @param chat - chat bridge state.
   * @param epoch - the turn epoch this prompt opened.
   */
  async function startTurn(chat, text, signal, attachments, messageId, nativeText, epoch) {
    const answer = await sendPlain(chat.chatId, tr('⏳ Generating…', '⏳ Генерирую…'), bridgeAbort.signal, chat.threadId)
    chat.messageId = answer?.message_id ?? null
    if (readLive(config.showThinking, true) === true) {
      const thinking = await sendPlain(chat.chatId, '💭 Thinking…', bridgeAbort.signal, chat.threadId)
      chat.thinkingMessageId = thinking?.message_id ?? null
    }
    try {
      const agent = await ensureAgent(chat)
      let admitted = false
      if (nativeText) {
        admitted = admitText(ctx, { sessionId: chat.sessionId, chatId: chat.chatId, messageId, text }, signal)
        if (admitted !== false) await admitted
      }
      if (!admitted) {
        const id = randomUUID()
        telegramMessageIds.add(id)
        agent.followup({ id, role: 'user', content: [...(text.trim().length === 0 ? [] : [{ type: 'text', text }]), ...attachments], source: { kind: 'user' } })
      }
      // The turn/end listener finalizes the Telegram turn. whenIdle is only a
      // fallback for the turn that started this epoch, never a queued turn.
      void agent.whenIdle().then(() => {
        if (chat.turnSource === 'telegram' && chat.awaitingTurn && chat.turnEpoch === epoch) return finalizeChat(chat)
      }).catch((error) => fireAndForget('agent-idle', () => failChat(chat, error, true)))
    } catch (error) {
      fireAndForget('agent-start', () => failChat(chat, error))
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
   * Remember a topic's name, for labels and the titles of bound sessions.
   * A rename of a topic with a bound session moves the title's topic prefix
   * and records a note in the session, so session search finds it under
   * either name.
   * @param chatId - chat holding the topic.
   * @param threadId - topic thread.
   * @param name - topic name.
   * @param authoritative - false fills only an unknown name.
   */
  function rememberTopicName(chatId, threadId, name, authoritative) {
    if (typeof threadId !== 'number' || isAllThread(threadId)) return
    const key = `${chatId}:${threadId}`
    state.topicNames ??= {}
    if (!authoritative && state.topicNames[key] !== undefined) return
    const previous = state.topicNames[key]
    if (previous === name) return
    state.topicNames[key] = name
    void persistState()
    if (typeof state.threads[key] !== 'string') return
    fireAndForget('topic-rename', () => onTopicRenamed(chatId, threadId, previous, name))
  }

  /**
   * Carry a topic rename into the bound session: move its title prefix and,
   * when the old name was known, record the rename as a note.
   * @param chatId - chat holding the topic.
   * @param threadId - topic thread.
   * @param previous - the old name, if the bot knew it.
   * @param name - the new name.
   */
  async function onTopicRenamed(chatId, threadId, previous, name) {
    const sessionId = state.threads[`${chatId}:${threadId}`]
    if (typeof sessionId !== 'string') return
    let agent = ctx.get('agents')?.get(sessionId)
    // The note must land in the session even when nobody has it open.
    if (agent === undefined && previous !== undefined) {
      const chat = await chatFor(chatId, threadId)
      if (chat.sessionId !== sessionId) return
      agent = await ensureAgent(chat)
    }
    if (agent?.session !== undefined) syncTopicTitle(agent.session, chatId, threadId, previous === undefined ? [] : [previous])
    if (previous === undefined || agent === undefined) return
    const text = `Telegram topic renamed: "${previous}" -> "${name}" (thread ${threadId})`
    recordNote(agent, text, `Topic renamed: ${previous} → ${name}`)
  }

  /**
   * Record a note in a session without starting a turn, as a message that
   * session search indexes. Search indexes `user/message` events; context
   * queued with `agent.inject` becomes one only when the next step claims it.
   * So an idle session gets the message appended now, the way the agent loop
   * commits claimed context, and a running one gets it queued for its next
   * step, which comes soon. The source is the bot's own notice kind, so the
   * mirror, title generation and the Web UI do not treat it as typed text.
   * A session that has not run its first step yet has no system prompt at
   * surface node 0. DSH's first step appends one there, and the session
   * format rejects a log whose first system/message comes after another
   * surface message, so such a session gets the note queued instead; the
   * first step then commits it after the system prompt.
   * @param agent - the session's live agent.
   * @param text - note text for the model and for search.
   * @param summary - one-line label the Web UI shows.
   */
  function recordNote(agent, text, summary) {
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'telegram-topic', form: 'notice', summary: summary.slice(0, 120) },
    }
    if (agent.status === 'idle' && typeof agent.session?.append === 'function' && hasSystemHead(agent.session)) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    } else if (typeof agent.inject === 'function') {
      agent.inject(message)
    } else {
      throw new Error('The session cannot record notes.')
    }
  }

  /**
   * Whether a session's first surface node is a system/message, the only
   * state in which a message may be appended to it outside a step.
   * @param session - DSH session.
   * @returns false when the head cannot be read, so callers queue instead.
   */
  function hasSystemHead(session) {
    try {
      const nodes = session.surface?.nodes
      if (nodes !== undefined) {
        if (nodes.length === 0) return false
        const event = typeof session.eventAt === 'function'
          ? session.eventAt(nodes[0])
          : session.snapshotEvents?.().find((item) => item.seq === nodes[0])
        return event?.type === 'system/message'
      }
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
      if (!Array.isArray(events)) return false
      const surfaceTypes = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])
      const first = events.find((event) => surfaceTypes.has(event.type))
      return first?.type === 'system/message'
    } catch {
      return false
    }
  }

  /**
   * The topic name a bound session's title starts with.
   * @param chatId - chat holding the topic.
   * @param threadId - topic thread.
   * @returns the topic's name, or "topic <id>" while it is unknown.
   */
  function topicPrefixOf(chatId, threadId) {
    const name = state.topicNames?.[`${chatId}:${threadId}`]
    return typeof name === 'string' && name.trim().length > 0 ? name.trim() : `topic ${threadId}`
  }

  /**
   * The topic a session is bound to.
   * @param sessionId - DSH session id.
   * @returns `{ chatId, threadId }`, or undefined.
   */
  function topicOfSession(sessionId) {
    if (!stateLoaded || typeof sessionId !== 'string') return undefined
    const record = state.sessions[sessionId]
    if (typeof record?.chatId !== 'number' || typeof record.threadId !== 'number') return undefined
    if (state.threads[`${record.chatId}:${record.threadId}`] !== sessionId) return undefined
    return { chatId: record.chatId, threadId: record.threadId }
  }

  /**
   * Bring a topic session's title to "<topic name> · <conversation title>".
   * DSH writes the conversation part (its title provider, or the first-prompt
   * fallback); DSH has no title hook, so the bot adds the prefix by appending
   * the same title event with the same source, which keeps automatic titling
   * going. Before a conversation title exists the title is the bare topic
   * name, set as a user title so DSH's fallback does not replace it; the bot
   * asks DSH for the real title at the first model request (see
   * `startTopicTitle`). A title someone typed is left alone.
   * @param session - live session.
   * @param chatId - chat holding the topic.
   * @param threadId - topic thread.
   * @param previousNames - earlier topic names the title may still carry.
   */
  function syncTopicTitle(session, chatId, threadId, previousNames = []) {
    const service = ctx.get('sessionTitle')
    if (service === undefined) return
    const prefix = topicPrefixOf(chatId, threadId)
    const names = [prefix, ...previousNames, `topic ${threadId}`]
    let current
    try {
      current = service.get(session)
    } catch (error) {
      warn(`session title not read for ${session?.id}: ${messageOf(error)}`)
      return
    }
    if (current === undefined) {
      setSessionTitle(session, prefix)
      return
    }
    const title = current.title
    if (current.source?.kind === 'user') {
      if (isPlaceholderTitle(title, names) && title !== prefix) setSessionTitle(session, prefix)
      return
    }
    const wanted = topicTitle(prefix, topicTask(title, names))
    if (wanted === title) return
    try {
      session.append('session/title', {
        title: wanted,
        messageSeqs: Array.isArray(current.messageSeqs) ? [...current.messageSeqs] : [],
        source: current.source,
      })
    } catch (error) {
      warn(`session title not set for ${session?.id}: ${messageOf(error)}`)
    }
  }

  /** Sessions whose first conversation title is being generated. */
  const titleRequests = new Set()

  /**
   * Ask DSH for a topic session's conversation title once the session has a
   * message and a model route, while its title is still the bot placeholder.
   * The placeholder is a user title, which stops DSH's automatic titling, so
   * the bot starts it with `sessionTitle.refresh` (the registered provider,
   * or DSH's fallback when none is). It waits for a `request/header` event
   * because model providers take their route from the logged header.
   * @param session - live session that logged a request header.
   */
  function startTopicTitle(session) {
    const topic = topicOfSession(session?.id)
    const service = ctx.get('sessionTitle')
    if (topic === undefined || typeof service?.refresh !== 'function' || titleRequests.has(session.id)) return
    const current = service.get(session)
    const names = [topicPrefixOf(topic.chatId, topic.threadId), `topic ${topic.threadId}`]
    if (current !== undefined && (current.source?.kind !== 'user' || !isPlaceholderTitle(current.title, names))) return
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    const hasPrompt = events.some((event) => event?.type === 'user/message'
      && event.data?.source?.kind === 'user'
      && (event.data.content ?? []).some((block) => block?.type === 'text' && block.text.trim().length > 0))
    if (!hasPrompt) return
    titleRequests.add(session.id)
    Promise.resolve()
      .then(() => service.refresh(session))
      .catch((error) => warn(`session title not generated for ${session.id}: ${messageOf(error)}`))
      .finally(() => titleRequests.delete(session.id))
  }

  /**
   * Set a live session's DSH title. Telegram topics are never renamed here.
   * @param session - live session.
   * @param title - new title.
   */
  function setSessionTitle(session, title) {
    try {
      ctx.get('sessionTitle')?.rename(session, title)
    } catch (error) {
      warn(`session title not set for ${session?.id}: ${messageOf(error)}`)
    }
  }

  /** File types Telegram shows inline as photos. */
  const PHOTO_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

  /**
   * Upload one local file into a topic.
   * @param chatId - target chat.
   * @param threadId - topic thread.
   * @param file - `{ name, data }`.
   * @param signal - request lifetime.
   * @returns the Bot API message.
   */
  async function uploadFile(chatId, threadId, file, signal) {
    const photo = PHOTO_TYPES[extname(file.name).toLowerCase()] !== undefined && file.data.length <= 10 * 1024 * 1024
    const method = photo ? 'sendPhoto' : 'sendDocument'
    const field = photo ? 'photo' : 'document'
    const boundary = `----dsh-telegram-${randomUUID()}`
    const safeName = file.name.replace(/["\r\n]/gu, '_')
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="message_thread_id"\r\n\r\n${threadId}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ]
    const body = Buffer.concat([
      Buffer.from(parts.join(''), 'utf8'),
      file.data,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ])
    // The JSON payload only names the chat and topic for pacing and error handling.
    return call(method, { chat_id: chatId, message_thread_id: threadId }, signal, 120_000, { body, contentType: `multipart/form-data; boundary=${boundary}` })
  }

  /** Bot API upload limit for sendDocument. */
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

  /**
   * Read one local file for upload, checking the path and the size limit.
   * @param path - absolute path.
   * @returns `{ path, name, data }`.
   * @throws an error marked `retryable: false`.
   */
  async function readUploadFile(path) {
    if (!isAbsolute(path)) throw finalError(`File paths must be absolute: ${path}`)
    let data
    try {
      data = await readFile(path)
    } catch (error) {
      throw finalError(error)
    }
    if (data.length > MAX_UPLOAD_BYTES) throw finalError(`${path} is larger than the 50 MB bot upload limit.`)
    return { path, name: basename(path), data }
  }

  /**
   * Remember that a file went to a topic in one turn, so the same file is
   * not uploaded twice in that turn (present, telegram_send and reply images
   * may all name it).
   * @param chat - topic state.
   * @param turn - DSH turn number; without one nothing is remembered.
   * @param path - absolute path.
   * @returns false when the file already went to the topic in this turn.
   */
  function claimTurnFile(chat, turn, path) {
    if (typeof turn !== 'number') return true
    if (chat.turnFiles?.turn !== turn) chat.turnFiles = { turn, paths: new Set() }
    if (chat.turnFiles.paths.has(path)) return false
    chat.turnFiles.paths.add(path)
    return true
  }

  /**
   * Upload files the session showed its user (present, or local images in
   * the final reply) into the session's topic, so a reader on Telegram sees
   * what the Web UI shows. Uses the telegram_send limits and send log; the
   * session already has these files, so nothing is recorded back into it.
   * A file that cannot be sent gets a short note in the topic instead.
   * @param chat - topic state.
   * @param paths - absolute paths.
   * @param options - `{ sessionId, turn, label, quiet }`; `quiet` skips the
   *   note for files that cannot be read (a broken image link).
   */
  async function forwardFiles(chat, paths, { sessionId, turn, label, quiet = false }) {
    const failed = []
    for (const path of paths) {
      if (!claimTurnFile(chat, turn, path)) continue
      let file
      try {
        file = await readUploadFile(path)
      } catch (error) {
        warn(`${label}: ${path} not sent to topic ${chat.threadId}: ${messageOf(error)}`)
        if (!quiet) failed.push(`${basename(path)}: ${messageOf(error)}`)
        continue
      }
      try {
        const result = await uploadFile(chat.chatId, chat.threadId, file, bridgeAbort.signal)
        await sentLog.record({
          chatId: chat.chatId,
          threadId: chat.threadId,
          topic: state.topicNames?.[`${chat.chatId}:${chat.threadId}`] ?? null,
          messageIds: result?.message_id === undefined ? [] : [result.message_id],
          text: '',
          files: [file.name],
          fromSession: sessionId ?? null,
          job: null,
          label,
          boundSession: sessionId ?? null,
          recorded: true,
        }).catch((error) => reportError('sent-log', error))
      } catch (error) {
        reportError('forward-file', error)
        // A deleted topic has dropped its binding; nothing more can go there.
        if (isTopicGone(messageOf(error))) return
        failed.push(`${file.name}: ${messageOf(error)}`)
      }
    }
    if (failed.length > 0) {
      await sendPlain(chat.chatId, `⚠️ ${tr('Could not send', 'Не удалось отправить')}:\n${failed.join('\n')}`.slice(0, MAX_TELEGRAM_TEXT), bridgeAbort.signal, chat.threadId)
        .catch((error) => reportError('forward-file', error))
    }
  }

  /** Messages sent through sendToTopic, for the context of later replies. */
  const sentLog = createSentLog({ onError: (error) => reportError('sent-log', error) })

  /**
   * Who sent a topic message, as a short label for the session record.
   * @param from - `{ label, sessionId, job }`.
   * @returns label text, or an empty string.
   */
  function senderOf(from) {
    const job = typeof from?.job === 'string' && from.job.trim().length > 0 ? from.job.trim() : undefined
    const session = typeof from?.sessionId === 'string' && from.sessionId.length > 0 ? from.sessionId : undefined
    const label = typeof from?.label === 'string' && from.label.trim().length > 0 ? from.label.trim() : undefined
    const parts = []
    if (job !== undefined) parts.push(`job "${job}"`)
    if (session !== undefined) parts.push(`${job === undefined ? '' : 'from '}session ${session}`)
    if (parts.length === 0 && label !== undefined) parts.push(label)
    return parts.join(' ')
  }

  /**
   * An error a retry will not fix: callers such as scheduled-job delivery
   * read `retryable: false` and stop trying.
   * @param error - the error, or its message.
   * @returns the error, marked.
   */
  function finalError(error) {
    const marked = error instanceof Error ? error : new Error(String(error))
    marked.retryable = false
    return marked
  }

  /**
   * Thread ids the bot knows in a chat: bound topics and named ones.
   * @param chatId - chat to list.
   * @returns the thread ids.
   */
  function knownThreads(chatId) {
    const prefix = `${chatId}:`
    const keys = [...Object.keys(state.threads), ...Object.keys(state.topicNames ?? {})]
    return new Set(keys.filter((key) => key.startsWith(prefix)).map((key) => Number(key.slice(prefix.length))).filter((id) => !isAllThread(id)))
  }

  /**
   * Send text and files into a topic, addressed by its thread id, and
   * record them in the session bound to that topic without starting a turn.
   * The Host service, the agent tool and the file spool all use this.
   * Errors a retry cannot fix (an unknown thread id, a bad file, a send that
   * already reached Telegram in part) carry `retryable: false`.
   * @param request - `{ to, text, files, from }`; `to` is the topic's
   *   thread id; `from` may hold `label` (who sent it), `job` (a job name)
   *   and `sessionId` (the sender session; when it is the bound session
   *   itself, no copy is recorded).
   * @param signal - request lifetime.
   * @returns where it went and whether the session recorded it.
   */
  async function sendToTopic(request, signal = bridgeAbort.signal) {
    await stateReady
    if (lifetime === undefined) throw new Error('The Telegram bot is not running.')
    if (topics.chatId === 0) throw new Error('The bot has no chat yet. Send /start to the bot first.')
    const text = typeof request?.text === 'string' ? request.text : ''
    const paths = Array.isArray(request?.files) ? request.files.map(String) : []
    if (text.trim().length === 0 && paths.length === 0) throw finalError('Nothing to send: give text or files.')
    const chatId = topics.chatId
    let threadId
    try {
      threadId = resolveThreadTarget(knownThreads(chatId), request?.to)
    } catch (error) {
      throw finalError(error)
    }
    const target = { threadId, name: state.topicNames?.[`${chatId}:${threadId}`] }
    // Read every file first, so a bad path fails before anything is sent.
    const files = []
    for (const path of paths) files.push(await readUploadFile(path))
    const messageIds = []
    try {
      if (text.trim().length > 0) {
        for (const chunk of splitAnswerText(text.trim())) {
          const result = await sendAnswer(chatId, chunk, signal, threadId)
          if (result?.message_id === undefined) throw new Error('Telegram did not accept the message.')
          messageIds.push(result.message_id)
        }
      }
      // The bound session sending into its own topic: present later in the
      // same turn skips these files.
      const own = typeof request?.from?.sessionId === 'string' && state.threads[`${chatId}:${threadId}`] === request.from.sessionId
        ? chatForSession(request.from.sessionId)
        : undefined
      for (const file of files) {
        if (own !== undefined) claimTurnFile(own, own.activeTurn, file.path)
        const result = await uploadFile(chatId, threadId, file, signal)
        if (result?.message_id !== undefined) messageIds.push(result.message_id)
      }
    } catch (error) {
      // call() has already dropped the topic's binding and name.
      if (isTopicGone(messageOf(error))) {
        throw finalError(`Telegram thread ${threadId} no longer exists; the bot forgot it.`)
      }
      // Part of it is in Telegram already; sending again would repeat that part.
      throw messageIds.length > 0 ? finalError(`${messageOf(error)} (after ${messageIds.length} message(s) were sent)`) : error
    }
    let sessionId = state.threads[`${chatId}:${threadId}`]
    const sender = senderOf(request?.from)
    let recorded = false
    let recordError
    let note
    if (typeof sessionId !== 'string') {
      // A known topic without a session gets one, as /new would make, so the
      // message is recorded. A topic whose user is choosing a session is left
      // to that choice.
      const chat = await chatFor(chatId, threadId)
      if (chat.bindPickerShown === true) {
        note = 'The topic is waiting for someone to choose its session; the message was only sent to Telegram.'
      } else {
        try {
          chat.cwd = cwdOf()
          await ensureAgent(chat)
          sessionId = chat.sessionId
          info(`opened session ${sessionId} for topic ${threadId} to record a send`)
        } catch (error) {
          recordError = `no session could be opened for the topic: ${messageOf(error)}`
          reportError('topic-send-open', error)
        }
      }
    }
    if (typeof sessionId === 'string' && sessionId !== request?.from?.sessionId) {
      try {
        const chat = await chatFor(chatId, threadId)
        const agent = ctx.get('agents')?.get(sessionId) ?? await ensureAgent(chat)
        const label = sender.length > 0 ? ` by ${sender}` : ''
        const where = target.name === undefined ? `topic ${threadId}` : `topic "${target.name}"`
        const content = [{ type: 'text', text: `[Sent to the Telegram ${where}${label}]${text.trim().length > 0 ? `\n${text.trim()}` : ''}` }]
        const store = ctx.get('attachments')
        for (const file of files) {
          if (store === undefined) break
          const mediaType = PHOTO_TYPES[extname(file.name).toLowerCase()]
          const attachment = mediaType === undefined
            ? await store.saveFile({ data: file.data, name: file.name })
            : await store.saveImage({ data: file.data, mediaType, name: file.name })
          content.push({ type: mediaType === undefined ? 'file' : 'image', attachment })
        }
        const id = randomUUID()
        // A next-step inbox item is durable and waits for whatever turn comes
        // next; it does not wake the agent. The request id keeps the mirror from
        // echoing it back into the topic.
        const message = { id, role: 'user', content, source: { kind: 'user', rpcId: `telegram-post:${id}` } }
        if (typeof agent?.inject === 'function') agent.inject(message)
        else if (typeof agent?.send === 'function') agent.send(message, 'next-step', false)
        else throw new Error('The bound session cannot record messages.')
        recorded = true
      } catch (error) {
        // The message is already in Telegram; report the missing record
        // instead of failing the send.
        recordError = messageOf(error)
        reportError('topic-send-record', error)
      }
    }
    try {
      await sentLog.record({
        chatId,
        threadId,
        topic: target.name ?? null,
        messageIds,
        text: text.trim(),
        files: files.map((file) => file.name),
        fromSession: typeof request?.from?.sessionId === 'string' ? request.from.sessionId : null,
        job: typeof request?.from?.job === 'string' && request.from.job.trim().length > 0 ? request.from.job.trim() : null,
        label: typeof request?.from?.label === 'string' ? request.from.label : null,
        boundSession: typeof sessionId === 'string' ? sessionId : null,
        recorded: recorded || (typeof sessionId === 'string' && sessionId === request?.from?.sessionId),
      })
    } catch (error) {
      reportError('sent-log', error)
    }
    await publishStatus({ lastTopicSend: { threadId, topic: target.name ?? null, at: new Date().toISOString(), recorded } })
    return {
      chatId,
      threadId,
      topic: target.name ?? null,
      sessionId: sessionId ?? null,
      recorded,
      ...(recordError === undefined ? {} : { recordError }),
      ...(note === undefined ? {} : { note }),
      messageIds,
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
    await publishStatus({ lastCreateTopicCall: { chatId, name } })
    const clean = shortLabel(name, 120) || 'DSH session'
    for (const candidate of [clean, `${clean} · ${randomUUID().slice(0, 4)}`]) {
      try {
        const topic = await call('createForumTopic', { chat_id: chatId, name: candidate }, signal)
        if (typeof topic?.message_thread_id === 'number') {
          rememberTopicName(chatId, topic.message_thread_id, candidate, true)
          return topic.message_thread_id
        }
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
   * Deliver a session preview into its topic.
   * @param record - topic mapping.
   * @param chatId - control chat.
   * @param signal - request lifetime.
   * @returns true when the topic is usable.
   */
  async function deliverSessionTopic(record, chatId, signal) {
    try {
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
      try {
        await sendMenu(chatId, record.threadId, await chatFor(chatId, record.threadId), signal)
      } catch (error) {
        // The preview already reached the topic; a menu failure is not a
        // reason to create a second topic.
        if (!signal.aborted) reportError('topic-menu', error)
      }
      return true
    } catch (error) {
      if (!signal.aborted) reportError('topic-delivery', error)
      return false
    }
  }

  /**
   * Open or reuse one topic for an existing session.
   * @param sessionId - session id.
   * @param chatId - control chat.
   * @param signal - request lifetime.
   * @returns topic record, or undefined.
   */
  async function openTopicForSession(sessionId, chatId, signal) {
    const key = `${chatId}:${sessionId}`
    const inFlight = openingTopics.get(key)
    if (inFlight !== undefined) return inFlight
    const opening = (async () => {
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
      const record = {
        sessionId,
        chatId,
        threadId,
        title,
        ...(header?.cwd === undefined ? {} : { cwd: header.cwd }),
        updatedAt: Date.now(),
      }
      state.sessions[sessionId] = record
      state.threads[`${chatId}:${threadId}`] = sessionId
      await persistState()
      await notifyAll(`📂 ${tr('Session opened', 'Открыта сессия')} <code>${escapeHtml(sessionId)}</code>`, signal)
      await deliverSessionTopic(record, chatId, signal)
      return record
    })()
    openingTopics.set(key, opening)
    try {
      return await opening
    } finally {
      if (openingTopics.get(key) === opening) openingTopics.delete(key)
    }
  }

  /**
   * Create a fresh Telegram topic for a forked DSH session.
   * @param sessionId - forked session id.
   * @param chatId - control chat.
   * @param title - topic title.
   * @param signal - request lifetime.
   * @returns the new mapping, or undefined.
   */
  async function createForkTopic(sessionId, chatId, title, signal) {
    const records = await ctx.get('sessionQuery')?.listSessions(signal)
    const header = records?.find((entry) => entry.header.id === sessionId)?.header
    const threadId = await createTopic(chatId, title, signal)
    if (threadId === undefined) return undefined
    const record = {
      sessionId,
      chatId,
      threadId,
      title,
      titleLocked: true,
      ...(header?.cwd === undefined ? {} : { cwd: header.cwd }),
      updatedAt: Date.now(),
    }
    state.sessions[sessionId] = record
    state.threads[`${chatId}:${threadId}`] = sessionId
    await persistState()
    forgetChatState(chatId, threadId)
    await notifyAll(`📂 ${tr('Session opened', 'Открыта сессия')} <code>${escapeHtml(sessionId)}</code>`, signal)
    await deliverSessionTopic(record, chatId, signal)
    return record
  }

  /**
   * Drop any stale in-memory chat state for a newly created topic.
   * @param chatId - control chat.
   * @param threadId - new topic thread.
   */
  function forgetChatState(chatId, threadId) {
    const key = `${chatId}:${threadId}`
    const previous = chats.get(key)
    if (previous !== undefined) chats.delete(key)
  }

  /**
   * Build the next automatic fork title: "<source title> (N)".
   * @param sourceId - source session id.
   * @returns topic title.
   */
  async function nextForkTitle(sourceId) {
    const sourceTitle = state.sessions[sourceId]?.title || await sessionTitle(sourceId)
    const records = await ctx.get('sessionQuery')?.listSessions(bridgeAbort.signal)
    const branch = (records ?? []).filter((entry) => entry.header?.parentSession === sourceId).length + 1
    return shortLabel(`${sourceTitle} (${branch})`, 120)
  }

  /**
   * Fork one session from the /sessions picker into a fresh topic.
   * @param sourceId - source session id.
   * @param chatId - control chat.
   * @param controlThreadId - topic that owns the picker.
   * @param signal - request lifetime.
   * @returns the new topic mapping, or undefined.
   */
  async function forkSessionFromMenu(sourceId, chatId, signal) {
    const controller = ctx.get('sessionController')
    if (controller === undefined || typeof controller.fork !== 'function') {
      throw new Error(tr('Session forking is unavailable in this profile.', 'Форк сессий недоступен в этом профиле.'))
    }
    const result = await controller.fork({ sessionId: sourceId })
    const forkId = typeof result === 'string' ? result : result?.sessionId
    if (typeof forkId !== 'string' || forkId.length === 0) throw new Error(tr('Fork returned no session id.', 'Форк не вернул id сессии.'))
    return createForkTopic(forkId, chatId, await nextForkTitle(sourceId), signal)
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

  /** Return a short, stable callback code for a workspace reference. */
  function workspaceCode(workspaceRef) {
    if (workspaceRef === undefined || workspaceRef === 'all') return 'a'
    for (const [code, value] of workspaceCodes) if (value === workspaceRef) return code
    workspaceCodeSeq += 1
    const code = `w${workspaceCodeSeq}`
    workspaceCodes.set(code, workspaceRef)
    return code
  }

  /** Resolve a callback workspace code back to a workspace id. */
  function workspaceFromCode(code) {
    return code === 'a' ? 'all' : (workspaceCodes.get(code) ?? 'all')
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
    const matching = await sessionsInWorkspace(workspace, signal, 12)
    const rows = []
    if (workspace !== undefined) {
      rows.push([{ text: tr('➕ New session in this workspace', '➕ Новая сессия в этом workspace'), callback_data: `n:${workspace.id}` }])
    }
    for (const record of matching) {
      const title = await sessionTitle(record.header.id, record.header)
      rows.push([{
        text: `${record.live ? '🟢' : '⚪'} ${shortLabel(title, 44)}`,
        callback_data: `s:${workspaceCode(workspaceRef)}:${record.header.id}`,
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
      text: tr('🔀 Continue in Telegram fork', '🔀 Продолжить в Telegram fork'),
      callback_data: `f:${sessionId}`,
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
      if (prefix === 'tw' || prefix === 'tr' || prefix === 'tn' || prefix === 'tb') {
        const chatState = await chatFor(chat.id, threadId)
        if (isAllThread(threadId)) return
        if (chatState.busy) {
          await send(chat.id, tr('Stop the current task first.', 'Сначала останови текущую задачу.'), signal, threadId)
          return
        }
        if (prefix === 'tr') {
          await showTopicWorkspacePicker(chatState, signal, query.message.message_id)
          return
        }
        if (prefix === 'tb') {
          await bindTopic(chatState, { sessionId: ref }, signal, query.message.message_id)
          return
        }
        const workspace = ctx.get('workspaceRegistry')?.get(ref)
        if (typeof workspace?.path !== 'string' || workspace.path.length === 0) {
          await send(chat.id, tr('Workspace not found. Send /workspace again.', 'Workspace не найден. Отправь /workspace снова.'), signal, threadId)
          return
        }
        if (prefix === 'tw') await showTopicSessionPicker(chatState, workspace, signal, query.message.message_id)
        else await bindTopic(chatState, { cwd: workspace.path }, signal, query.message.message_id)
        return
      }
      if (prefix === 'w') {
        if (ref === 'root') await showWorkspaces(chat.id, threadId, signal, query.message.message_id)
        else if (ref === 'all') await showSessions(chat.id, threadId, 'all', signal, query.message.message_id)
        else await showSessions(chat.id, threadId, ref, signal, query.message.message_id)
        return
      }
      if (prefix === 's') {
        const separator = ref.indexOf(':')
        const code = separator === -1 ? 'a' : ref.slice(0, separator)
        const sessionId = separator === -1 ? ref : ref.slice(separator + 1)
        await showSessionPreview(chat.id, threadId, sessionId, workspaceFromCode(code), signal, query.message.message_id)
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
      if (prefix === 'f') {
        const record = await forkSessionFromMenu(ref, chat.id, signal)
        if (record === undefined) {
          await send(chat.id, tr('Failed to create a fork topic. Check Topics in chat settings.', 'Не удалось создать fork-topic. Проверь Topics в настройках чата.'), signal, threadId)
          return
        }
        await editKeyboard(
          chat.id,
          threadId,
          query.message.message_id,
          `✅ ${tr('Session forked in topic', 'Сессия форкнута в topic')} «${escapeHtml(record.title)}».`,
          [],
          signal,
        )
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
      const detail = messageOf(error)
      await publishStatus({ lastCallbackError: detail, lastErrorKind: classifyError(error), lastErrorScope: 'callback' })
      // Replying into a deleted topic only produces a second identical error.
      if (!/message thread not found|topic.*not found/iu.test(detail)) {
        await send(chat.id, `❌ ${escapeHtml(detail)}`, signal, threadId)
      }
    }
  }

  /**
   * Create a fresh DSH session in a new topic.
   * @param chatId - control chat.
   * @param controlThreadId - thread that requested creation.
   * @param signal - request lifetime.
   */
  async function createNewSessionTopic(chatId, controlThreadId, signal, cwd, initialText = '', initialAttachments = [], messageId) {
    await publishStatus({ lastCreateTopic: { initialText: initialText.slice(0, 160), controlThreadId } })
    // A command must never be forwarded into a new session as a prompt.
    if (initialText.trim().startsWith('/')) {
      await send(chatId, tr('Unknown command. /help lists commands.', 'Неизвестная команда. /help — список.'), signal, controlThreadId)
      return
    }
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
      if (initialText.trim().length > 0 || initialAttachments.length > 0) await runAgent(chatState, initialText, signal, initialAttachments, messageId)
    } catch (error) {
      await send(chatId, `❌ ${escapeHtml(messageOf(error))}`, signal, controlThreadId)
    }
  }

  /**
   * Detach the current session from a topic. The session stays in DSH and can
   * be bound again later from the session picker.
   * @param chatState - topic state.
   * @param keepSelection - keep the model/effort/access choice for the next session.
   * @returns the detached session id, if any.
   */
  function releaseTopic(chatState, keepSelection) {
    const previousId = chatState.sessionId
    cancelQuestionsForChat(chatState)
    chatState.pendingPrompts = []
    chatState.steerFollow = false
    // Old agent listeners check boundAgent and go quiet once it changes.
    chatState.boundAgent = undefined
    chatState.sessionId = undefined
    chatState.panelMessageId = undefined
    if (keepSelection && chatState.selection !== undefined) {
      // Keep the choice, but not the object the old agent still reads.
      chatState.selection = { current: { ...chatState.selection.current }, assembled: undefined }
    } else {
      chatState.selection = undefined
      chatState.permission = undefined
    }
    delete state.threads[chatState.key]
    // The old record would otherwise still point at this topic, and
    // "Continue in Telegram" would reopen it here.
    if (typeof previousId === 'string' && state.sessions[previousId]?.threadId === chatState.threadId) {
      delete state.sessions[previousId]
    }
    return previousId
  }

  /**
   * Remove a session's binding to any topic other than `exceptKey`, so one
   * session is never mirrored into two topics.
   * @param sessionId - session that moves.
   * @param exceptKey - topic key that keeps it.
   */
  function releaseSessionElsewhere(sessionId, exceptKey) {
    for (const [key, bound] of Object.entries(state.threads)) {
      if (bound !== sessionId || key === exceptKey) continue
      delete state.threads[key]
      const other = chats.get(key)
      if (other !== undefined) {
        other.sessionId = undefined
        other.boundAgent = undefined
        other.selection = undefined
        other.permission = undefined
      }
    }
  }

  /**
   * Drop everything the bot keeps about a topic Telegram says no longer exists
   * (its session binding, its name and its live bridge state), so stale topics
   * clean themselves up instead of failing on every later call. The session
   * stays in DSH and can be bound to another topic.
   * @param chatId - chat that held the topic.
   * @param threadId - the deleted topic's thread id.
   * @param method - Bot API method that reported it, for the log.
   * @returns whether anything was dropped.
   */
  function forgetGoneTopic(chatId, threadId, method) {
    if (typeof threadId !== 'number' || isAllThread(threadId)) return false
    const key = `${chatId}:${threadId}`
    const sessionId = state.threads[key]
    const chat = chats.get(key)
    const named = state.topicNames?.[key] !== undefined
    const records = Object.entries(state.sessions).filter(([, record]) => String(record?.chatId) === String(chatId) && record?.threadId === threadId)
    if (sessionId === undefined && chat === undefined && !named && records.length === 0) return false
    if (chat !== undefined) {
      releaseTopic(chat, false)
      chat.bindPrompts = []
      chats.delete(key)
    }
    delete state.threads[key]
    for (const [id] of records) delete state.sessions[id]
    delete state.topicNames?.[key]
    info(`Telegram topic ${threadId} no longer exists (${method}); dropped its binding${typeof sessionId === 'string' ? ` to ${sessionId}` : ''} and name`)
    void persistState()
    return true
  }

  /**
   * Bind a fresh DSH session to an existing topic in the same workspace. The
   * previous session stays in DSH as history.
   * @param chatState - current topic state.
   * @param signal - request lifetime.
   */
  async function startNewSessionInTopic(chatState, signal) {
    const previous = typeof chatState.sessionId === 'string' ? state.sessions[chatState.sessionId] : undefined
    const cwd = chatState.cwd ?? previous?.cwd ?? defaultWorkspaceCwd()
    const title = previous?.title
    const previousId = releaseTopic(chatState, true)
    chatState.cwd = cwd
    await persistState()
    await ensureAgent(chatState)
    const record = state.sessions[chatState.sessionId]
    if (record !== undefined && typeof title === 'string' && title.length > 0) {
      record.title = title
      await persistState()
    }
    await send(
      chatState.chatId,
      `🆕 ${tr('New session started in this topic.', 'В этом топике начата новая сессия.')}` +
        (typeof previousId === 'string'
          ? `\n${tr('The previous session stays in DSH', 'Предыдущая сессия осталась в DSH')}: <code>${escapeHtml(previousId)}</code>`
          : ''),
      signal,
      chatState.threadId,
    )
    await sendMenu(chatState.chatId, chatState.threadId, chatState, signal)
  }

  /** @returns the registered Workspaces, or an empty list. */
  function listWorkspaces() {
    try {
      return ctx.get('workspaceRegistry')?.list() ?? []
    } catch {
      return []
    }
  }

  /**
   * List recent ordinary sessions that belong to one workspace.
   * @param workspace - workspace record, or undefined for all sessions.
   * @param signal - request lifetime.
   * @param limit - maximum number of sessions.
   * @returns newest-first session records.
   */
  async function sessionsInWorkspace(workspace, signal, limit) {
    const query = ctx.get('sessionQuery')
    if (query === undefined) return []
    const archived = new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
    const records = await query.listSessions(signal)
    return records
      .filter((record) => !archived.has(record.header.id))
      .filter((record) => record.header?.origin !== 'subagent')
      .filter((record) => workspace === undefined
        || (workspace.sessionIds ?? []).includes(record.header.id)
        || record.header.cwd === workspace.path)
      .sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0))
      .slice(0, limit)
  }

  /**
   * Ask which workspace an unbound topic (or /workspace) should use.
   * @param chatState - topic state.
   * @param signal - request lifetime.
   * @param messageId - picker message to edit, if any.
   */
  async function showTopicWorkspacePicker(chatState, signal, messageId) {
    const workspaces = listWorkspaces().slice(0, 10)
    const currentCwd = typeof chatState.sessionId === 'string' ? chatState.cwd : undefined
    const rows = workspaces.map((workspace) => [{
      text: `${workspace.path === currentCwd ? '✅' : '📁'} ${shortLabel(workspace.title || basename(workspace.path), 44)}`,
      callback_data: `tw:${workspace.id}`,
    }])
    await renderMenu(
      chatState.chatId,
      chatState.threadId,
      messageId,
      `<b>${tr('Which workspace should this topic use?', 'Какой workspace использовать в этом топике?')}</b>`,
      rows,
      signal,
    )
  }

  /**
   * Ask whether to start a new session in a workspace or bind an existing one.
   * @param chatState - topic state.
   * @param workspace - chosen workspace.
   * @param signal - request lifetime.
   * @param messageId - picker message to edit.
   */
  async function showTopicSessionPicker(chatState, workspace, signal, messageId) {
    const records = await sessionsInWorkspace(workspace, signal, 8)
    const rows = [[{ text: tr('🆕 New session', '🆕 Новая сессия'), callback_data: `tn:${workspace.id}` }]]
    for (const record of records) {
      const id = record.header.id
      const title = state.sessions[id]?.title || await sessionTitle(id, record.header)
      const boundHere = chatState.sessionId === id
      const boundElsewhere = !boundHere && Object.entries(state.threads).some(([key, bound]) => bound === id && key !== chatState.key)
      const mark = boundHere ? '✅' : boundElsewhere ? '🔗' : record.live ? '🟢' : '⚪'
      rows.push([{ text: `${mark} ${shortLabel(title, 44)}`, callback_data: `tb:${id}` }])
    }
    rows.push([{ text: tr('⬅️ Back', '⬅️ Назад'), callback_data: 'tr:' }])
    await renderMenu(
      chatState.chatId,
      chatState.threadId,
      messageId,
      `<b>${escapeHtml(workspace.title || basename(workspace.path))}</b>\n\n` +
        tr('Start a new session, or continue an existing one in this topic.', 'Начни новую сессию или продолжи существующую в этом топике.') +
        (records.some((record) => Object.entries(state.threads).some(([key, bound]) => bound === record.header.id && key !== chatState.key))
          ? `\n🔗 ${tr('is bound to another topic and moves here.', 'привязана к другому топику и переедет сюда.')}`
          : ''),
      rows,
      signal,
    )
  }

  /**
   * Remember a message sent before the topic has a session and ask for the
   * workspace once. The message runs after the topic is bound.
   * @param chatState - unbound topic state.
   * @param prompt - text, attachments and Telegram message id.
   * @param signal - request lifetime.
   */
  async function askTopicBinding(chatState, prompt, signal) {
    chatState.bindPrompts ??= []
    if (prompt !== undefined) chatState.bindPrompts.push(prompt)
    if (listWorkspaces().length === 0) {
      await bindTopic(chatState, { cwd: defaultWorkspaceCwd() }, signal)
      return
    }
    if (chatState.bindPickerShown === true) {
      await send(chatState.chatId, tr('Choose a workspace above first; your message is sent after that.', 'Сначала выбери workspace выше; сообщение отправится после этого.'), signal, chatState.threadId)
      return
    }
    chatState.bindPickerShown = true
    await showTopicWorkspacePicker(chatState, signal)
  }

  /**
   * Bind a topic to a new session in a workspace or to an existing session,
   * then send the messages that waited for the binding.
   * @param chatState - topic state.
   * @param target - `{ cwd }` for a new session or `{ sessionId }`.
   * @param signal - request lifetime.
   * @param messageId - picker message to replace with the result.
   */
  async function bindTopic(chatState, target, signal, messageId) {
    if (typeof target.sessionId === 'string') {
      const otherBusy = [...chats.values()].some((other) => other !== chatState && other.sessionId === target.sessionId && other.busy)
      if (otherBusy) {
        await send(chatState.chatId, tr('That session is working in another topic. Try again when it finishes.', 'Эта сессия сейчас работает в другом топике. Попробуй, когда она закончит.'), signal, chatState.threadId)
        return
      }
    }
    if (typeof target.sessionId === 'string' && target.sessionId === chatState.sessionId) {
      if (messageId !== undefined) await editKeyboard(chatState.chatId, chatState.threadId, messageId, `✅ ${tr('This topic already uses that session.', 'Этот топик уже использует эту сессию.')}`, [], signal)
      return
    }
    releaseTopic(chatState, false)
    let label
    if (typeof target.sessionId === 'string') {
      const records = await ctx.get('sessionQuery')?.listSessions(signal)
      const header = records?.find((entry) => entry.header.id === target.sessionId)?.header
      const title = await sessionTitle(target.sessionId, header)
      releaseSessionElsewhere(target.sessionId, chatState.key)
      chatState.cwd = header?.cwd
      await bindSession(chatState, target.sessionId, title, header?.cwd)
      await ensureAgent(chatState)
      label = title
    } else {
      chatState.cwd = target.cwd
      await persistState()
      await ensureAgent(chatState)
      label = tr('New session', 'Новая сессия')
    }
    chatState.bindPickerShown = false
    const where = typeof chatState.cwd === 'string' ? basename(chatState.cwd) : '?'
    const text = `✅ <b>${escapeHtml(label)}</b>\n${tr('Workspace', 'Workspace')}: <code>${escapeHtml(where)}</code>`
    if (messageId === undefined || !await editKeyboard(chatState.chatId, chatState.threadId, messageId, text, [], signal)) {
      await send(chatState.chatId, text, signal, chatState.threadId)
    }
    await sendMenu(chatState.chatId, chatState.threadId, chatState, signal)
    const waiting = (chatState.bindPrompts ?? []).splice(0)
    for (const prompt of waiting) {
      await runAgent(chatState, prompt.text, signal, prompt.attachments ?? [], prompt.messageId)
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
      lastThreadId: message.message_thread_id ?? null,
      lastOutcome: 'received',
      detail: '',
    })
    const announced = topicNameOf(message)
    if (announced !== undefined && chat !== undefined && typeof message.message_thread_id === 'number') {
      try {
        if (chatAllowed(chat, allowedChatsOf(config))) rememberTopicName(chat.id, message.message_thread_id, announced.name, announced.authoritative)
      } catch {
        // A malformed allowlist is reported by the main check below.
      }
    }
    const hasAttachment = downloadableFile(message) !== undefined
    // A forward is a prompt even when its media cannot be attached (video,
    // voice, poll...): the agent still learns what was forwarded and from whom.
    const forwarded = isForwarded(message)
    if (((text === undefined || text.length === 0) && !hasAttachment && !forwarded) || from === undefined || chat === undefined) {
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
    if (allowedUser && allowedChat) await rememberControlChat(chat.id)
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
    // Forwarded text is content, never an answer to a pending question or a command.
    if (!forwarded && await consumeQuestionReply(chatState, text ?? '', signal)) return
    const inSession = typeof chatState.sessionId === 'string'
    if (hasAttachment || forwarded) {
      // A file in All follows the same path as text: create one session topic.
      if (hasAttachment && !inSession && !isAllThread(threadId)) {
        await send(chat.id, tr('Open a session first: /sessions.', 'Сначала открой сессию: /sessions.'), signal, threadId)
        return
      }
      try {
        const prompt = await promptFrom(message, signal, chatState.sessionId)
        if (forwarded) batchForward(chatState, chat.id, threadId, prompt, signal)
        else await dispatchPrompt(chatState, chat.id, threadId, prompt, signal)
      } catch (error) {
        await send(chat.id, `❌ ${escapeHtml(messageOf(error))}`, signal, threadId)
      }
      return
    }
    const parts = text.trim().split(/\s+/u)
    const command = normalizeCommand(parts[0])
    await publishStatus({
      lastCommand: command,
      lastMessageText: text.slice(0, 160),
      lastInSession: inSession,
      lastThreadId: threadId ?? null,
    })

    const topicKey = `${chat.id}:${threadId}`
    const freshTopic = !isAllThread(threadId) && !inSession && chatState.bindPickerShown !== true
      && (chatState.bindPrompts?.length ?? 0) === 0
    if (isAutoCommandTopic(command, text, state.topicNames?.[topicKey], freshTopic)) {
      await answerInAll(message, signal, type)
      return
    }

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
          `✅ <b>${tr('Telegram bot enabled', 'Telegram-бот включён')}</b>\n` +
          `${tr('Connected as', 'Подключён как')} @${me?.username ?? 'unknown'}.\n` +
          `Your user id: <code>${from.id}</code>\n` +
          `This chat id: <code>${chat.id}</code>\n` +
          `${tr('Topic', 'Топик')}: <code>${threadId ?? 0}</code>\n\n` +
          (inSession
            ? `${tr('Current session', 'Текущая сессия')}: <code>${chatState.sessionId}</code>\n`
            : isAllThread(threadId)
              ? `${tr('To start a conversation, create a topic and send a message in it, or just send a message here in All: Telegram makes a topic for it. In the topic, pick the workspace, then a new session or an existing one. /sessions opens existing sessions in new topics.', 'Чтобы начать разговор, создай топик и напиши в него, или просто напиши здесь, в All: Telegram сам создаст для сообщения топик. В топике выбери workspace, затем новую или существующую сессию. /sessions открывает существующие сессии в новых топиках.')}\n`
              : `${tr('This topic has no session yet. Send a message to choose a workspace.', 'У этого топика ещё нет сессии. Напиши сообщение, чтобы выбрать workspace.')}\n`) +
          `\n<b>${tr('First run', 'Первый запуск')}:</b> @BotFather → Bot Settings → <b>Threaded mode</b> → ${tr('Enable', 'Включить')}.\n` +
          `${tr('Commands', 'Команды')}: /sessions, /new, /workspace, /current, /menu, /rename, /fork, /last, /clear, /stop, /restart, /status, /id, /ping.`,
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
    if (command === '/new') {
      if (isAllThread(threadId)) {
        await createNewSessionTopic(chat.id, threadId, signal, defaultWorkspaceCwd())
        return
      }
      if (chatState.busy) {
        await send(chat.id, tr('Stop the current task before starting a new session.', 'Останови текущую задачу перед новой сессией.'), signal, threadId)
        return
      }
      if (!inSession) {
        // No workspace to keep yet: ask for one like any new topic.
        await askTopicBinding(chatState, undefined, signal)
        return
      }
      try {
        await startNewSessionInTopic(chatState, signal)
      } catch (error) {
        await send(chat.id, `❌ ${escapeHtml(messageOf(error))}`, signal, threadId)
      }
      return
    }
    if (command === '/workspace') {
      if (isAllThread(threadId)) {
        await send(chat.id, tr('Use /workspace inside a topic.', 'Используй /workspace внутри топика.'), signal, threadId)
        return
      }
      if (chatState.busy) {
        await send(chat.id, tr('Stop the current task before switching workspace.', 'Останови текущую задачу перед сменой workspace.'), signal, threadId)
        return
      }
      chatState.bindPickerShown = true
      await showTopicWorkspacePicker(chatState, signal)
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
      const texts = (await recentAssistantTexts(chatState.sessionId, limit))
        .filter((text) => text.trim().length > 0)
      if (texts.length === 0) {
        await send(chat.id, tr('This session has no assistant messages yet.', 'В этой сессии пока нет ответов ассистента.'), signal, threadId)
        return
      }
      const title = await sessionTitle(chatState.sessionId)
      const total = texts.length
      for (const [index, text] of [...texts].reverse().entries()) {
        const chunks = splitAnswerText(text.trim())
        if (chunks.length === 0) continue
        const label = total === 1
          ? tr('Latest assistant answer', 'Последний ответ ассистента')
          : `${tr('Answer', 'Ответ')} ${index + 1}/${total}`
        try {
          for (const [chunkIndex, chunk] of chunks.entries()) {
            const body = chunkIndex === 0 ? `**${label}** · ${title}\n\n${chunk}` : chunk
            const sent = await sendAnswer(chat.id, body, signal, threadId)
            if (sent === undefined) throw new Error(`Telegram did not accept ${label} (${chunkIndex + 1}/${chunks.length})`)
          }
        } catch (error) {
          reportError('last-send', error)
          await send(chat.id, `❌ ${escapeHtml(messageOf(error))}`, signal, threadId)
          return
        }
      }
      return
    }

    if (command === '/fork') {
      if (!inSession) {
        await send(chat.id, tr('Open a session first: /sessions.', 'Сначала открой сессию: /sessions.'), signal, threadId)
        return
      }
      if (chatState.busy) {
        await send(chat.id, tr('Stop the current task before forking.', 'Останови текущую задачу перед форком.'), signal, threadId)
        return
      }
      const controller = ctx.get('sessionController')
      if (controller === undefined || typeof controller.fork !== 'function') {
        await send(chat.id, tr('Session forking is unavailable in this profile.', 'Форк сессий недоступен в этом профиле.'), signal, threadId)
        return
      }
      let requested = parts.slice(1).join(' ').trim()
      if ((requested.startsWith('"') && requested.endsWith('"')) || (requested.startsWith("'") && requested.endsWith("'"))) {
        requested = requested.slice(1, -1).trim()
      }
      if (requested.length > 120) {
        await send(chat.id, tr('Fork name must be at most 120 characters.', 'Имя форка должно быть не длиннее 120 символов.'), signal, threadId)
        return
      }
      const sourceId = chatState.sessionId
      let forkId
      try {
        const result = await controller.fork({ sessionId: sourceId })
        forkId = typeof result === 'string' ? result : result?.sessionId
      } catch (error) {
        await send(chat.id, `❌ ${escapeHtml(messageOf(error))}`, signal, threadId)
        return
      }
      if (typeof forkId !== 'string' || forkId.length === 0) {
        await send(chat.id, tr('Fork returned no session id.', 'Форк не вернул id сессии.'), signal, threadId)
        return
      }
      const title = requested.length > 0 ? requested : await nextForkTitle(sourceId)
      const record = await createForkTopic(forkId, chat.id, title, signal)
      if (record === undefined) {
        await send(chat.id, `❌ ${tr('Session was forked but the topic could not be created.', 'Сессия форкнута, но topic создать не удалось.')}`, signal, threadId)
        return
      }
      await send(
        chat.id,
        `🍴 ${tr('Session forked', 'Сессия форкнута')}: <b>${escapeHtml(record.title || title)}</b>`,
        signal,
        threadId,
      )
      return
    }

    if (command === '/rename') {
      if (!inSession || threadId === undefined) {
        await send(chat.id, tr('Only a session topic can be renamed.', 'Переименовать можно только topic сессии.'), signal, threadId)
        return
      }
      const name = parts.slice(1).join(' ').trim()
      if (name.length === 0) {
        await send(chat.id, tr('Usage: <code>/rename New topic name</code>', 'Использование: <code>/rename Новое имя топика</code>'), signal, threadId)
        return
      }
      if (name.length > 128) {
        await send(chat.id, tr('Topic name must be at most 128 characters.', 'Имя топика не должно быть длиннее 128 символов.'), signal, threadId)
        return
      }
      const record = state.sessions[chatState.sessionId]
      const previous = record === undefined ? undefined : { title: record.title, titleLocked: record.titleLocked }
      if (record !== undefined) {
        // Lock before the API call so a concurrent provider title event cannot
        // rename the topic back while the request is in flight.
        record.title = name
        record.titleLocked = true
        await persistState()
      }
      try {
        await publishStatus({ lastTopicRename: { threadId, name, source: 'rename' } })
        // Telegram's private-topic editForumTopic is currently inconsistent:
        // it returns true while some clients keep the old title. Repeating the
        // same edit gives those clients another service update to consume.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await call('editForumTopic', {
            chat_id: chat.id,
            message_thread_id: threadId,
            name,
          }, signal)
          if (attempt < 2) await sleep(200, signal)
        }
        rememberTopicName(chat.id, threadId, name, true)
        await send(chat.id, `✏️ ${tr('Topic renamed', 'Topic переименован')}: <b>${escapeHtml(name)}</b>`, signal, threadId)
      } catch (error) {
        if (record !== undefined) {
          record.title = previous?.title
          record.titleLocked = previous?.titleLocked
          await persistState()
        }
        await send(chat.id, `❌ ${escapeHtml(messageOf(error))}`, signal, threadId)
      }
      return
    }
    if (command === '/restart') {
      await send(chat.id, tr('♻️ Restarting the Telegram bot…', '♻️ Перезапускаю Telegram-бота…'), signal, threadId)
      scheduleRestart('command')
      return
    }
    if (command === '/clear') {
      if (!inSession) {
        await send(chat.id, tr('There is no active session in this topic.', 'В этом topic нет активной сессии.'), signal, threadId)
        return
      }
      // The bot's own queue (busyMessages: queue) and Telegram messages that
      // DSH holds but the agent has not taken yet.
      let queued = chatState.pendingPrompts?.length ?? 0
      chatState.pendingPrompts = []
      try {
        queued += clearTelegramInbox(ctx.get('agents')?.get(chatState.sessionId), chatState.chatId)
      } catch (error) {
        reportError('clear', error)
      }
      await send(
        chat.id,
        queued === 0
          ? tr('🧹 Queue is already empty.', '🧹 Очередь уже пуста.')
          : `${tr('🧹 Cleared queued messages', '🧹 Очищена очередь')}: ${queued}`,
        signal,
        threadId,
      )
      return
    }
    if (command === '/stop') {
      if (!inSession) {
        await send(chat.id, tr('There is no active session in this topic.', 'В этом topic нет активной сессии.'), signal, threadId)
        return
      }
      // Telegram may deliver /stop twice (double tap or retry). The first
      // invocation owns cleanup; the duplicate must not enqueue more work.
      if (chatState.stopping === true || (!chatState.busy && chatState.done)) return
      chatState.stopping = true
      try {
        chatState.busy = false
        stopTyping(chatState)
        chatState.done = true
        chatState.turnSource = undefined
        chatState.awaitingTurn = false
        chatState.activeTurn = undefined
        chatState.pendingPrompts = []
        chatState.steerFollow = false
        chatState.turnEpoch = (chatState.turnEpoch ?? 0) + 1
        try {
          ctx.get('agents')?.get(chatState.sessionId)?.inbox?.clear()
        } catch {
          // Already idle or inbox unavailable.
        }
        clearEditTimer(chatState)
        clearAuxTimers(chatState)
        cancelQuestionsForChat(chatState)
        try {
          ctx.get('agents')?.get(chatState.sessionId)?.cancel({ kind: 'user' })
        } catch {
          // Already idle or disposed.
        }
        // Do not wait for a pending network edit; the outbound bucket keeps
        // the stop marker ordered after any in-flight edit.
        // Delete auxiliary messages without blocking the stop acknowledgement.
        if (chatState.thinkingMessageId !== null) {
          const id = chatState.thinkingMessageId
          chatState.thinkingMessageId = null
          fireAndForget('stop-thinking-delete', () => deleteMessage(chat.id, threadId, id))
        }
        if (chatState.toolMessageId !== null) {
          const id = chatState.toolMessageId
          chatState.toolMessageId = null
          fireAndForget('stop-tool-delete', () => deleteMessage(chat.id, threadId, id))
        }
        // The streamed partial answer stays in the first message. Send the
        // marker separately and do not spend time re-editing that message.
        await send(chat.id, `⏹ ${tr('Stopped.', 'Остановлено.')}`, signal, threadId)
        chatState.text = ''
        chatState.lastText = ''
        chatState.messageId = null
        resetAux(chatState)
        await publishStatus({ lastOutcome: 'stopped', lastStopAt: Date.now() })
      } finally {
        chatState.stopping = false
      }
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

    // Ordinary text becomes a prompt, with what it replies to or quotes.
    await dispatchPrompt(chatState, chat.id, threadId, await promptFrom(message, signal, chatState.sessionId), signal)
  }

  /**
   * Answer a chat-wide command that Telegram moved into a topic created for
   * it: run it as if sent in All, then delete that topic so it does not stay
   * behind as an empty conversation.
   * @param message - the command message, still carrying its topic.
   * @param signal - runtime lifetime.
   * @param type - Telegram update key, for diagnostics.
   */
  async function answerInAll(message, signal, type) {
    const chatId = message.chat.id
    const threadId = message.message_thread_id
    const key = `${chatId}:${threadId}`
    const { message_thread_id: _thread, is_topic_message: _topic, ...rest } = message
    const inAll = { ...rest }
    // The reply target of a topic's first message is the topic creation itself.
    if (inAll.reply_to_message?.forum_topic_created !== undefined) delete inAll.reply_to_message
    await handleMessage(inAll, signal, type)
    chats.delete(key)
    delete state.threads[key]
    delete state.topicNames?.[key]
    await persistState()
    try {
      await call('deleteForumTopic', { chat_id: chatId, message_thread_id: threadId }, signal)
      await publishStatus({ lastAutoTopicDeleted: { threadId, at: Date.now() } })
    } catch (error) {
      reportError('auto-topic-delete', error)
      await send(
        chatId,
        tr(
          'Telegram made this topic from a command sent in All. The answer is in All; this topic can be deleted.',
          'Telegram создал этот топик из команды, отправленной в All. Ответ — в All; этот топик можно удалить.',
        ),
        signal,
        threadId,
      )
    }
  }

  /**
   * Build the agent prompt for one message: its text, what it replies to,
   * quotes or forwards, its own photo or document and a replied-to one.
   * @param message - Telegram message.
   * @param signal - request lifetime.
   * @param currentSession - session bound to the message's topic, if any.
   * @returns prompt text, attachment blocks and Telegram message id.
   */
  async function promptFrom(message, signal, currentSession) {
    const attachments = []
    const forwarded = isForwarded(message)
    let ownFile = false
    if (downloadableFile(message) !== undefined) {
      const saved = await saveTelegramAttachment(message, signal)
      if (saved.note !== undefined) attachments.push(saved.note)
      attachments.push(saved.block)
      ownFile = true
    }
    // A replied-to photo or document is attached as well; a failure only
    // changes the note, the message itself still goes through.
    let replyFile
    const target = forwarded ? undefined : (repliedMessage(message) ?? message.external_reply ?? undefined)
    const file = downloadableFile(target)
    if (file !== undefined) {
      if (file.size !== undefined && file.size > DOWNLOAD_LIMIT_BYTES) {
        replyFile = 'too-large'
      } else {
        try {
          const saved = await saveTelegramAttachment(target, signal)
          if (saved.note !== undefined) attachments.push(saved.note)
          attachments.push(saved.block)
          replyFile = 'attached'
        } catch (error) {
          replyFile = 'failed'
          warn(`replied-to file not attached: ${messageOf(error)}`)
        }
      }
    }
    // A reply to something the bot sent on another sender's behalf carries
    // that message in full, with its sender and time.
    let sent
    const reference = replyReference(message)
    if (reference !== undefined) {
      try {
        sent = await sentLog.find(reference.chatId, reference.messageId)
      } catch (error) {
        warn(`sent-message lookup failed: ${messageOf(error)}`)
      }
    }
    let text = composePrompt(message, { botId: me?.id, ownFile, replyFile, sent, currentSession })
    // A recording speaks for itself through its transcript.
    if (ownFile && !forwarded && spokenMediaOf(message) === undefined && messageBody(message).trim().length === 0) {
      const ask = tr('Analyze the attached file.', 'Проанализируй приложенный файл.')
      text = text.length === 0 ? ask : `${text}\n\n${ask}`
    }
    return { text, attachments, messageId: message.message_id, from: message.from }
  }

  /**
   * Route one prompt: a new topic from All, the workspace picker in a topic
   * without a session, or a turn in the bound session.
   * @param chatState - topic state.
   * @param chatId - Telegram chat.
   * @param threadId - topic thread.
   * @param prompt - text, attachments and Telegram message id.
   * @param signal - runtime lifetime.
   */
  async function dispatchPrompt(chatState, chatId, threadId, prompt, signal) {
    // Say who is writing: several allowed users may share one bot.
    const label = senderLabel(prompt.from)
    if (label !== undefined) prompt = { ...prompt, text: prompt.text.length > 0 ? `${label}\n${prompt.text}` : label }
    const route = routeMessage({ threadId, inSession: typeof chatState.sessionId === 'string' })
    if (route === 'new-topic') {
      await createNewSessionTopic(chatId, threadId, signal, defaultWorkspaceCwd(), prompt.text, prompt.attachments, prompt.messageId)
      return
    }
    if (route === 'current-topic') {
      // A topic the user created (or Telegram created for a message sent in
      // All) has no session yet: ask for the workspace, then run the message.
      await askTopicBinding(chatState, prompt, signal)
      return
    }
    await runAgent(chatState, prompt.text, signal, prompt.attachments, prompt.messageId)
  }

  /** Forwards waiting to be sent as one prompt, by topic key. */
  const forwardBatches = new Map()

  /**
   * Collect forwarded messages that arrive together in one topic and send
   * them as one prompt once no more arrive for FORWARD_BATCH_MS.
   * @param chatState - topic state.
   * @param chatId - Telegram chat.
   * @param threadId - topic thread.
   * @param prompt - one forwarded message's prompt.
   * @param signal - runtime lifetime.
   */
  function batchForward(chatState, chatId, threadId, prompt, signal) {
    const key = `${chatId}:${threadId ?? 0}`
    let batch = forwardBatches.get(key)
    if (batch === undefined) {
      batch = { prompts: [], timer: undefined }
      forwardBatches.set(key, batch)
    }
    batch.prompts.push(prompt)
    clearTimeout(batch.timer)
    batch.timer = setTimeout(() => {
      forwardBatches.delete(key)
      if (signal.aborted) return
      const prompts = batch.prompts
      const merged = {
        text: prompts.map((item) => item.text).filter((text) => text.length > 0).join('\n\n'),
        attachments: prompts.flatMap((item) => item.attachments),
        messageId: prompts[0].messageId,
        from: prompts[0].from,
      }
      fireAndForget('forward-batch', () => dispatchPrompt(chatState, chatId, threadId, merged, signal))
    }, FORWARD_BATCH_MS)
  }

  /**
   * Warn when BotFather forum settings would make Telegram create topics for
   * ordinary messages in All.
   * @param bot - getMe result.
   * @param signal - runtime lifetime.
   */
  async function checkForumConfiguration(bot, signal) {
    const topicsEnabled = bot?.has_topics_enabled
    const usersCanCreate = bot?.allows_users_to_create_topics
    await publishStatus({
      threadedMode: typeof topicsEnabled === 'boolean' ? topicsEnabled : null,
      usersCanCreateTopics: typeof usersCanCreate === 'boolean' ? usersCanCreate : null,
    })
    if (topicsEnabled === false) {
      await notifyAll(
        `⚠️ <b>${tr('Threaded mode is disabled', 'Threaded mode выключен')}</b>\n` +
          tr('Enable it in @BotFather → Bot Settings → Threaded mode.', 'Включи его в @BotFather → Bot Settings → Threaded mode.'),
        signal,
      )
      return
    }
    if (usersCanCreate === false) {
      // Topics are created by the user; each new topic asks for its workspace.
      await notifyAll(
        `⚠️ <b>${tr('Users cannot create topics', 'Пользователи не могут создавать топики')}</b>\n` +
          tr(
            'Create topics yourself to start sessions. In @BotFather → Bot Settings → Threaded mode, turn off “Disallow users to create new threads”.',
            'Топики для сессий создаёшь ты. В @BotFather → Bot Settings → Threaded mode выключи «Disallow users to create new threads».',
          ),
        signal,
      )
    }
  }

  /**
   * Poll getUpdates until the runtime is stopped.
   * @param tokenLifetime - this runtime's lifetime.
   * @returns resolves when polling stops.
   */
  /** Dispatch one committed Telegram update without owning its cursor. */
  async function dispatchUpdate(update, signal) {
    const type = Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown'
    await publishStatus({ lastUpdateKeys: Object.keys(update), lastUpdateType: type })
    if (update.callback_query !== undefined) {
      await handleCallback(update.callback_query, signal)
      return
    }
    const message = update.message ?? update.business_message ?? update.channel_post ?? update.edited_message
    if (message !== undefined) {
      await handleMessage(message, signal, type)
      return
    }
    await publishStatus({ lastUpdateAt: Date.now() })
  }

  async function poll(tokenLifetime) {
    await stateReady
    const admission = createUpdateAdmission({
      getState: () => state,
      persist: persistState,
      handle: dispatchUpdate,
      onError: async (error, update) => {
        await publishStatus({ state: 'error', detail: messageOf(error), lastUpdateKeys: Object.keys(update) })
      },
    })
    let healthy = false
    let connected = false
    while (!tokenLifetime.signal.aborted) {
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
        connected = true
        info(`connected as @${me.username ?? me.id}`)
        await publishStatus({ state: 'running', detail: '', username: me.username ?? String(me.id), startupStage: 'polling' })
        // Menu publication and the startup notice must never delay getUpdates.
        // Either request can be rate-limited or time out independently.
        void publishCommands(tokenLifetime.signal)
        void checkForumConfiguration(me, tokenLifetime.signal)
        void notifyAll(
          `🟢 <b>${tr('Telegram bot enabled', 'Telegram-бот включён')}</b>\n` +
            `@${escapeHtml(me.username ?? String(me.id))}\n` +
            tr('Polling started. Send /start to open the menu.', 'Polling запущен. Отправь /start, чтобы открыть меню.'),
          tokenLifetime.signal,
        )
        break
      } catch (error) {
        if (tokenLifetime.signal.aborted) return
        warn(`getMe failed: ${messageOf(error)}`)
        await publishStatus({ state: 'error', detail: messageOf(error) })
        await sleep(RETRY_DELAY_MS, tokenLifetime.signal)
      }
    }
    if (!connected || tokenLifetime.signal.aborted) return

    while (!tokenLifetime.signal.aborted) {
      let updates
      try {
        updates = await call(
          'getUpdates',
          {
            offset: state.updateOffset ?? 0,
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
        try {
          await admission.accept(update, tokenLifetime.signal)
        } catch (error) {
          if (!tokenLifetime.signal.aborted) reportError('update-handler', error)
        }
      }
    }
  }

  /** Retry startup after the credential store becomes ready. */
  function scheduleStartRetry() {
    if (startRetryTimer !== undefined || !isEnabled(config)) return
    startRetryTimer = setTimeout(() => {
      startRetryTimer = undefined
      fireAndForget('start-retry', () => start())
    }, 5000)
  }

  /** Stop the active runtime and wait for its loop to settle. */
  async function stop() {
    startEpoch += 1
    if (startRetryTimer !== undefined) {
      clearTimeout(startRetryTimer)
      startRetryTimer = undefined
    }
    const current = lifetime
    lifetime = undefined
    me = undefined
    startedAt = 0
    if (current === undefined) return
    current.abort()
    await current.settled
    await publishStatus({ state: 'stopped', detail: '', username: '' })
  }

  /** Coalesce concurrent runtime starts. */
  async function start() {
    while (startInFlight !== undefined) await startInFlight.catch(() => {})
    if (lifetime !== undefined) return
    const epoch = startEpoch
    const task = startInternal(epoch)
    startInFlight = task
    try {
      return await task
    } finally {
      if (startInFlight === task) startInFlight = undefined
    }
  }

  /** Start the runtime if enabled and a token is available. */
  async function startInternal(epoch) {
    if (startRetryTimer !== undefined) {
      clearTimeout(startRetryTimer)
      startRetryTimer = undefined
    }
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
    let token
    try {
      token = await resolveToken()
    } catch (error) {
      reportError('token', error)
      await publishStatus({ state: 'error', detail: messageOf(error) })
      scheduleStartRetry()
      return
    }
    if (token === undefined) {
      await publishStatus({ state: 'idle', detail: 'TELEGRAM_BOT_TOKEN is not configured' })
      scheduleStartRetry()
      return
    }
    if (epoch !== startEpoch) return
    const controller = new AbortController()
    const current = {
      controller,
      abort: () => controller.abort(),
    }
    current.settled = poll({ signal: controller.signal })
      .catch((error) => {
        if (!controller.signal.aborted) reportError('poll', error)
      })
      .finally(() => {
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
      fireAndForget('restart', () => restart(reason))
    }, RESTART_DEBOUNCE_MS)
  }

  /** Topic sending for other plugins: `ctx.get('telegramTopics').send(...)`. */
  const topicService = {
    /**
     * @param request - `{ to, text, files, from }`: `to` is the topic's
     *   thread id, `text` Markdown, `files` absolute paths, `from`
     *   `{ job, sessionId, label }` naming the sender.
     */
    send: ({ to, text, files = [], from } = {}) => sendToTopic({ to, text, files, from }),
    /** @returns the topics the bot knows in its chat: thread id, last known name, bound session. */
    topics: () => [...knownThreads(topics.chatId)]
      .sort((left, right) => left - right)
      .map((threadId) => {
        const key = `${topics.chatId}:${threadId}`
        return { threadId, name: state.topicNames?.[key] ?? null, sessionId: state.threads[key] ?? null }
      }),
  }
  if (typeof ctx.provide === 'function') ctx.provide('telegramTopics', topicService)

  /** Model-facing tool for sending into a topic; see sendToTopic. */
  const sendTool = {
    name: 'telegram_send',
    description: 'Send a message, and optionally files, into a Telegram topic of the DSH Telegram bot, addressed by its numeric thread id. The message appears in the topic and is recorded in the session bound to that topic, which sees it on its next turn; no turn is started. Use it to notify the user on Telegram. Fails on a thread id the bot does not know.',
    parameters: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Numeric Telegram thread id of the topic (/id in the topic shows it).' },
        text: { type: 'string', description: 'Message text; Markdown is converted for Telegram.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files to attach.' },
      },
      required: ['thread'],
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (typeof args?.thread !== 'string' && typeof args?.thread !== 'number') throw new Error('thread is required')
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      return sendToTopic({
        to: args.thread,
        text: typeof args.text === 'string' ? args.text : '',
        files: Array.isArray(args.files) ? args.files : [],
        from: typeof sessionId === 'string' ? { label: `session ${sessionId}`, sessionId } : undefined,
      }, exec?.signal ?? bridgeAbort.signal)
    },
  }
  if (typeof ctx.inject === 'function') {
    // Register whenever the Host tool registry is available; the
    // registration ends with this plugin.
    ctx.inject(['tools'], (scoped) => { scoped.tools.register(sendTool) })
  } else if (typeof ctx.get('tools')?.register === 'function') {
    ctx.effect(() => ctx.get('tools').register(sendTool), 'dsh-telegram-bot: telegram_send tool')
  }

  /** Requests written by `dsh-telegram-send` or any process with DSH home access. */
  const outbox = createOutbox({
    handle: (request) => sendToTopic(request),
    ready: () => lifetime !== undefined && topics.chatId !== 0 && !bridgeAbort.signal.aborted,
    onError: (error) => reportError('outbox', error),
  })
  ctx.effect(() => {
    void stateReady.then(() => outbox.start()).catch((error) => reportError('outbox', error))
    return () => outbox.stop()
  }, 'dsh-telegram-bot: outbox')

  // Host-wide feeds: every session's events, whichever client started the
  // turn. Only sessions bound to a topic are mirrored.
  ctx.on('session/event', (session, event) => {
    try {
      onMirrorEvent(session, event)
    } catch (error) {
      reportError('mirror-event', error)
    }
    // Topic session titles: prefix every title DSH generates with the topic
    // name, and start the first one. Both run after the current event, so the
    // title service has folded it and no event is appended inside another's
    // delivery.
    if (event?.type === 'session/title' && event.data?.source?.kind !== 'user') {
      const topic = topicOfSession(session?.id)
      if (topic !== undefined) {
        fireAndForget('topic-title', () => {
          const live = ctx.get('agents')?.get(session.id)?.session
          if (live !== undefined) syncTopicTitle(live, topic.chatId, topic.threadId)
        })
      }
    } else if (event?.type === 'request/header') {
      fireAndForget('topic-title', () => startTopicTitle(session))
    }
  }, { global: true })
  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const chat = chatForSession(payload?.agent?.session?.id)
      if (chat === undefined || chat.turnSource !== 'mirror') return
      if (readLive(config.mirrorTurns, true) !== true && chat.steerFollow !== true) return
      onFrame(chat, payload.frame)
    } catch (error) {
      reportError('mirror-stream', error)
    }
  }, { global: true })

  ctx.on('settings/document-updated', (ns) => {
    if (ns === name) scheduleRestart('settings')
  })
  ctx.on('credentials/reference-updated', (ref) => {
    if (ref === tokenRefOf(config)) scheduleRestart('token')
  })

  ctx.effect(
    () => {
      void start().catch((error) => reportError('start', error))
      return () => {
        if (restartTimer !== undefined) {
          clearTimeout(restartTimer)
          restartTimer = undefined
        }
        if (startRetryTimer !== undefined) {
          clearTimeout(startRetryTimer)
          startRetryTimer = undefined
        }
        bridgeAbort.abort()
        void stop().catch((error) => reportError('stop', error))
      }
    },
    'dsh-telegram-bot: runtime',
  )
}

