/**
 * Keep test runs away from the real ~/.dsh home. The package test script sets
 * DSH_HOME, but running one test file directly with `node --test` must not
 * overwrite the user's Telegram state either.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.DSH_HOME) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-telegram-test-home-'))
}
