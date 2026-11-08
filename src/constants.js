/** Shared constants and Telegram command menus. */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default credential reference holding the bot token. */
export const DEFAULT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN'
/** Long-poll timeout requested from Telegram, in seconds. */
export const POLL_TIMEOUT_SECONDS = 25
/** Pause after a failed poll before trying again, in milliseconds. */
export const RETRY_DELAY_MS = 3000
/** Coalesce a settings write and a token write into one restart. */
export const RESTART_DEBOUNCE_MS = 300
/**
 * Forwarding several messages delivers one update per message. Forwards that
 * arrive in the same topic within this window become a single prompt.
 */
export const FORWARD_BATCH_MS = 1200

/** Loader row id and settings namespace; the npm package name stays dsh-telegram-bot. */
export const name = 'telegram-bot'

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
  { command: 'clear', description: 'Clear queued Telegram messages' },
  { command: 'status', description: 'Bot and session status' },
  { command: 'sessions', description: 'Browse workspaces and sessions' },
  { command: 'new', description: 'Start a new session in this topic' },
  { command: 'workspace', description: 'Switch this topic to another workspace' },
  { command: 'current', description: 'Show the topic session' },
  { command: 'menu', description: 'Show the model and session controls' },
  { command: 'rename', description: 'Rename this Telegram topic' },
  { command: 'fork', description: 'Fork this session into a new topic' },
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
  { command: 'clear', description: 'Очистить очередь сообщений' },
  { command: 'status', description: 'Статус бота и сессии' },
  { command: 'sessions', description: 'Выбрать workspace и сессию' },
  { command: 'new', description: 'Новая сессия в этом топике' },
  { command: 'workspace', description: 'Сменить workspace этого топика' },
  { command: 'current', description: 'Показать сессию этого топика' },
  { command: 'menu', description: 'Показать меню модели и сессии' },
  { command: 'rename', description: 'Переименовать Telegram-топик' },
  { command: 'fork', description: 'Форкнуть сессию в новый topic' },
  { command: 'last', description: 'Показать последние ответы ассистента' },
  { command: 'restart', description: 'Перезапустить Telegram-бота' },
  { command: 'id', description: 'Показать user id и chat id' },
  { command: 'ping', description: 'Проверить связь' },
]

/** Bound one Telegram message body to stay under the 4096-character API limit. */
const MAX_TELEGRAM_TEXT = 3800
/** Host-local diagnostics directory; no secrets are written here. */
const STATUS_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'telegram')


export {
  MODEL_CHOICES,
  EFFORT_CHOICES,
  BOT_COMMANDS,
  BOT_COMMANDS_RU,
  MAX_TELEGRAM_TEXT,
  STATUS_DIR,
}
