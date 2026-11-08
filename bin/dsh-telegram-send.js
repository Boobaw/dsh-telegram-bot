#!/usr/bin/env node
/**
 * Send a message into a topic of the running DSH Telegram bot.
 *
 * The request goes through the plugin's file spool under $DSH_HOME/telegram,
 * so it needs no bot token, and it waits there while DSH is not running.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { enqueue, waitForResult } from '../src/outbox.js'

const usage = `Usage: dsh-telegram-send --thread <thread-id> [--file <path>]...
                         [--job <name>] [--from-session <id>] [--from <label>]
                         [--no-wait] [--timeout <seconds>] [text...]

Sends text (from the arguments, or from stdin when none are given) and files
into a topic of the running DSH Telegram bot, addressed by its numeric thread
id (/id in the topic shows it). The message is also recorded in the session
bound to that topic, without starting a turn. Long text is split into several
Telegram messages.

  --job <name>           name of the job or script sending it
  --from-session <id>    DSH session sending it; defaults to $DSH_SESSION_ID
                         (set inside DSH sessions), --from-session '' for none
  --from <label>         free-form sender label, used when neither is given

Exit codes: 0 sent, 1 failed (for example an unknown thread id), 2 bad arguments,
3 still queued after the timeout (the bot sends it once it runs).`

let options
try {
  options = parseArgs({
    allowPositionals: true,
    options: {
      thread: { type: 'string', short: 't' },
      file: { type: 'string', short: 'f', multiple: true },
      from: { type: 'string' },
      job: { type: 'string', short: 'j' },
      'from-session': { type: 'string' },
      'no-wait': { type: 'boolean' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage}\n`)
  process.exit(2)
}
const { values, positionals } = options
if (values.help) {
  process.stdout.write(`${usage}\n`)
  process.exit(0)
}
if (values.thread === undefined || !/^\d+$/u.test(values.thread.trim())) {
  process.stderr.write(`--thread takes the topic's numeric thread id.\n\n${usage}\n`)
  process.exit(2)
}

let text = positionals.join(' ')
if (positionals.length === 0 && !process.stdin.isTTY) text = readFileSync(0, 'utf8')
const files = (values.file ?? []).map((path) => resolve(path))
if (text.trim().length === 0 && files.length === 0) {
  process.stderr.write(`Nothing to send: give text or --file.\n\n${usage}\n`)
  process.exit(2)
}

/** DSH session ids carry a `session-` prefix; DSH_SESSION_ID may not. */
function sessionIdOf(value) {
  const id = (value ?? '').trim()
  if (id.length === 0) return undefined
  return id.startsWith('session-') ? id : `session-${id}`
}

const from = {}
if (values.from !== undefined && values.from.trim().length > 0) from.label = values.from.trim()
if (values.job !== undefined && values.job.trim().length > 0) from.job = values.job.trim()
const sessionId = sessionIdOf(values['from-session'] ?? process.env.DSH_SESSION_ID)
if (sessionId !== undefined) from.sessionId = sessionId

const id = await enqueue({
  to: values.thread.trim(),
  text,
  files,
  ...(Object.keys(from).length === 0 ? {} : { from }),
})
if (values['no-wait']) {
  process.stdout.write(`${JSON.stringify({ queued: id })}\n`)
  process.exit(0)
}
const seconds = Number(values.timeout ?? 30)
const result = await waitForResult(id, (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000)
if (result === undefined) {
  process.stderr.write(`Still queued as ${id}: the Telegram bot did not pick it up in time. It is sent once the bot runs.\n`)
  process.exit(3)
}
if (!result.ok) {
  process.stderr.write(`${result.error}\n`)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify(result.result)}\n`)
