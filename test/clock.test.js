import './setup-home.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { clientTimeZone, formatMoment, formatTelegramDate, processTimeZone, resolveTimeZone } from '../src/clock.js'

test('a moment reads as weekday, date, local time and UTC offset', () => {
  const instant = Date.UTC(2026, 2, 2, 8, 41, 12)
  assert.equal(formatMoment(instant, 'Europe/Berlin'), 'Mon 2026-03-02 09:41 UTC+01:00')
  assert.equal(formatMoment(instant, 'UTC'), 'Mon 2026-03-02 08:41 UTC+00:00')
  assert.equal(formatMoment(instant, 'Asia/Kolkata'), 'Mon 2026-03-02 14:11 UTC+05:30')
  assert.equal(formatMoment(instant, 'America/Los_Angeles'), 'Mon 2026-03-02 00:41 UTC-08:00')
  // Summer time moves the offset with it.
  assert.equal(formatMoment(Date.UTC(2026, 6, 1, 10, 0), 'Europe/Berlin'), 'Wed 2026-07-01 12:00 UTC+02:00')
  assert.equal(formatTelegramDate(instant / 1000, 'Asia/Shanghai'), 'Mon 2026-03-02 16:41 UTC+08:00')
  assert.equal(formatTelegramDate(undefined, 'UTC'), undefined)
  assert.equal(formatMoment(Number.NaN, 'UTC'), undefined)
})

test('the zone setting falls back to the process zone, and a bad one says so', () => {
  assert.deepEqual(resolveTimeZone(''), { timeZone: processTimeZone() })
  assert.deepEqual(resolveTimeZone(' Europe/Berlin '), { timeZone: 'Europe/Berlin' })
  const bad = resolveTimeZone('Mars/Olympus')
  assert.equal(bad.timeZone, processTimeZone())
  assert.match(bad.error, /Mars\/Olympus/u)
})

test('only zone names DSH accepts are reported as the client zone', () => {
  assert.equal(clientTimeZone('Europe/Berlin'), 'Europe/Berlin')
  assert.equal(clientTimeZone('UTC'), 'UTC')
  assert.equal(clientTimeZone('EST'), undefined)
  assert.equal(clientTimeZone(undefined), undefined)
})
