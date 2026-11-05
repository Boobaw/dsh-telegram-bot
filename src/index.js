/** Public host entry point for dsh-telegram-bot. */
export { apply } from './app.js'
export { Config } from './config.js'
export { name } from './constants.js'
export { classifyError } from './errors.js'
export {
  isAllThread,
  isTelegramParseError,
  normalizeCommand,
  routeMessage,
  splitAnswerText,
} from './formatting.js'

/** Pure helpers exposed for the local regression suite. */
import { classifyError as classify } from './errors.js'
import { isAllThread as isAll, isTelegramParseError as isParse, normalizeCommand as normalize, routeMessage as route, splitAnswerText as split } from './formatting.js'
export const __testing = {
  classifyError: classify,
  isAllThread: isAll,
  isTelegramParseError: isParse,
  normalizeCommand: normalize,
  routeMessage: route,
  splitAnswerText: split,
}
