/** Error classification and diagnostics policy. */
import { isTelegramParseError } from './formatting.js'
import { messageOf } from './utils.js'

/** Classify a failure for diagnostics without mixing it with formatting errors. */
function classifyError(error) {
  const detail = messageOf(error)
  if (isTelegramParseError(detail)) return 'format'
  if (error?.telegram === true) return 'telegram'
  if (/agent|turn|session|approval|question/iu.test(detail)) return 'agent'
  if (/state|storage|write|read|ENOENT|EACCES|EPERM/iu.test(detail)) return 'storage'
  return 'runtime'
}


export { classifyError }
