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

const usage = `Usage: dsh-telegram-send --topic <name|thread-id> [--file <path>]... [--from <label>]
                         [--no-wait] [--timeout <seconds>] [text...]

Sends text (from the arguments, or from stdin when none are given) and files
into a topic of the running DSH Telegram bot. The message is also recorded in
the session bound to that topic. Topic names ignore case.

Exit codes: 0 sent, 1 failed (for example an unknown topic), 2 bad arguments,
3 still queued after the timeout (the bot sends it once it runs).`

let options
try {
  options = parseArgs({
    allowPositionals: true,
    options: {
      topic: { type: 'string', short: 't' },
      file: { type: 'string', short: 'f', multiple: true },
      from: { type: 'string' },
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
if (values.topic === undefined || values.topic.trim().length === 0) {
  process.stderr.write(`--topic is required.\n\n${usage}\n`)
  process.exit(2)
}

let text = positionals.join(' ')
if (positionals.length === 0 && !process.stdin.isTTY) text = readFileSync(0, 'utf8')
const files = (values.file ?? []).map((path) => resolve(path))
if (text.trim().length === 0 && files.length === 0) {
  process.stderr.write(`Nothing to send: give text or --file.\n\n${usage}\n`)
  process.exit(2)
}

const id = await enqueue({
  topic: values.topic,
  text,
  files,
  ...(values.from === undefined ? {} : { from: { label: values.from } }),
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
