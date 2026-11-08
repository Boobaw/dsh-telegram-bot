/**
 * File spool for sending to topics from outside the Host process.
 *
 * A sender writes one request file into the outbox directory; the running
 * plugin picks it up, sends it, and writes a result file next to it. Requests
 * wait in the spool while the bot is stopped, and senders need no bot token
 * or network access to the Host: only write access to the DSH home.
 */
import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STATUS_DIR } from './constants.js'

/** Default spool directory. */
export const OUTBOX_DIR = join(STATUS_DIR, 'outbox')
/** Result files older than this are removed by the plugin. */
const RESULT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Write one send request atomically.
 * @param request - `{ to, text, files, from }`, as for the `telegramTopics` service's `send`.
 * @param dir - spool directory.
 * @returns the request id.
 */
export async function enqueue(request, dir = OUTBOX_DIR) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const temporary = join(dir, `${id}.tmp`)
  await writeFile(temporary, JSON.stringify({ ...request, id, createdAt: Date.now() }) + '\n', { mode: 0o600 })
  await rename(temporary, join(dir, `${id}.json`))
  return id
}

/**
 * Wait for the plugin's result for one request.
 * @param id - request id from {@link enqueue}.
 * @param timeoutMs - how long to wait.
 * @param dir - spool directory.
 * @returns the result document, or undefined after the timeout.
 */
export async function waitForResult(id, timeoutMs, dir = OUTBOX_DIR) {
  const path = join(dir, `${id}.result.json`)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const result = JSON.parse(await readFile(path, 'utf8'))
      await rm(path, { force: true })
      return result
    } catch {
      // Not written yet.
    }
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/**
 * Plugin side: process spooled requests one at a time.
 * @param options.handle - async function sending one request; its value is the result.
 * @param options.ready - whether requests can be sent now (the bot is running).
 * @param options.onError - reports unexpected spool failures.
 * @param options.dir - spool directory.
 * @param options.intervalMs - rescan period; file watching only speeds it up.
 * @returns `{ start, stop, drain }`.
 */
export function createOutbox({ handle, ready, onError, dir = OUTBOX_DIR, intervalMs = 1000 }) {
  let timer
  let watcher
  let draining
  let again = false

  /** Put requests that were being sent when the Host stopped back in line. */
  async function recover() {
    for (const name of await readdir(dir).catch(() => [])) {
      if (name.endsWith('.processing')) {
        await rename(join(dir, name), join(dir, name.replace(/\.processing$/u, '.json'))).catch(() => {})
      }
    }
  }

  /** Remove result files nobody collected. */
  async function sweep(names) {
    for (const name of names) {
      if (!name.endsWith('.result.json')) continue
      const path = join(dir, name)
      const info = await stat(path).catch(() => undefined)
      if (info !== undefined && Date.now() - info.mtimeMs > RESULT_TTL_MS) await rm(path, { force: true })
    }
  }

  /** Send every waiting request, oldest first. */
  async function drainOnce() {
    if (!ready()) return
    const names = (await readdir(dir).catch(() => [])).sort()
    await sweep(names)
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.result.json')) continue
      if (!ready()) return
      const id = name.slice(0, -'.json'.length)
      const claimed = join(dir, `${id}.processing`)
      try {
        await rename(join(dir, name), claimed)
      } catch {
        continue
      }
      let outcome
      try {
        const request = JSON.parse(await readFile(claimed, 'utf8'))
        outcome = { ok: true, result: await handle(request) }
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      try {
        await writeFile(join(dir, `${id}.result.json`), JSON.stringify(outcome) + '\n', { mode: 0o600 })
        await rm(claimed, { force: true })
      } catch (error) {
        onError(error)
      }
    }
  }

  /** Run one drain, coalescing triggers that arrive while it runs. */
  function drain() {
    if (draining !== undefined) {
      again = true
      return draining
    }
    draining = (async () => {
      do {
        again = false
        await drainOnce()
      } while (again)
    })().catch(onError).finally(() => { draining = undefined })
    return draining
  }

  async function start() {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await recover()
    try {
      watcher = watch(dir, () => { void drain() })
      watcher.on('error', () => {})
    } catch {
      // The interval still picks requests up.
    }
    timer = setInterval(() => { void drain() }, intervalMs)
    timer.unref?.()
    void drain()
  }

  function stop() {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    watcher?.close()
    watcher = undefined
  }

  return { start, stop, drain }
}
