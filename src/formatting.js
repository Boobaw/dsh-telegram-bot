/** Markdown/Telegram formatting helpers. */
import telegramifyMarkdown from 'telegramify-markdown'

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
export const ANSWER_MARKDOWN_LIMIT = 3900

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
 * Whether Telegram rejected the entity markup rather than the request itself.
 * @param detail - Telegram error description.
 * @returns true when a plain-text retry is appropriate.
 */
function isTelegramParseError(detail) {
  return /can't parse entities|unsupported start tag|can't find end tag|reserved and must be escaped|parse entities/iu.test(String(detail))
}

/** Whether a Telegram thread id denotes the General / All topic. */
function isAllThread(threadId) {
  return threadId === undefined || threadId === null || threadId === 0 || threadId === 1
}

/** Normalize a Telegram command token, dropping an optional @botname suffix. */
function normalizeCommand(token) {
  return String(token ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .trim()
    .toLowerCase()
    .split('@')[0]
}

/**
 * Decide where an ordinary (non-command) message belongs.
 * @param {{ threadId?: number|null, inSession: boolean, hasAttachment?: boolean }} input
 * @returns {'new-topic'|'current-topic'|'continue'|'command'}
 */
function routeMessage({ threadId, inSession, hasAttachment = false }) {
  if (isAllThread(threadId)) return 'new-topic'
  if (hasAttachment) return inSession ? 'continue' : 'current-topic'
  return inSession ? 'continue' : 'current-topic'
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
/** Return the last unclosed fenced code block in a Markdown chunk. */
function openFenceAtEnd(text) {
  let open
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (match === null) continue
    if (open === undefined) {
      open = { marker: match[1], info: match[2].trim() }
    } else if (match[1][0] === open.marker[0] && match[1].length >= open.marker.length && match[2].trim().length === 0) {
      open = undefined
    }
  }
  return open
}

/** Wrap reasoning to the phone width and keep only the last lines. */
function wrapThinkingLines(text, width = 43, maxLines = 9) {
  // Hard character wrapping is prefix-stable: growing text never reflows the
  // lines above, so only the bottom of the window changes.
  const lines = []
  for (const source of String(text).split('\n')) {
    if (source.length === 0) {
      lines.push('')
      continue
    }
    for (let index = 0; index < source.length; index += width) {
      lines.push(source.slice(index, index + width))
    }
  }
  const tail = lines.slice(-maxLines)
  if (tail.length > 0) tail[tail.length - 1] = tail.at(-1).slice(0, 30).trimEnd()
  return tail.join('\n')
}

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
    let chunk = rest.slice(0, cut).trimEnd()
    if (chunk.length === 0) break
    let tail = rest.slice(cut).trimStart()
    const fence = openFenceAtEnd(chunk)
    if (fence !== undefined) {
      chunk += `\n${fence.marker}`
      tail = `${fence.marker}${fence.info}\n${tail}`
    }
    chunks.push(chunk)
    rest = tail
  }
  return chunks
}


export {
  splitTableRow,
  isTableSeparator,
  isTableRow,
  preprocessTables,
  preprocessRelativeLinks,
  toTelegramMarkdown,
  fitAnswerText,
  parseToolArguments,
  compactToolValue,
  toolArg,
  wrapVisualLines,
  htmlToPlain,
  isTelegramParseError,
  isAllThread,
  normalizeCommand,
  routeMessage,
  clipPreview,
  splitAnswerText,
  wrapThinkingLines,
}
