/**
 * Message times for the model: when a person sent a message, in the zone the
 * people writing to the bot live in, so the agent can tell how much time has
 * passed between messages.
 */

/** Zone of this process, the default for `timeZone`. */
export function processTimeZone() {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** UTC or an IANA Area/Location name, the zone shape DSH accepts as a prompt's client zone. */
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/**
 * The zone to show message times in.
 * @param setting - the `timeZone` setting; empty means the process zone.
 * @returns `{ timeZone, error }`: the canonical zone, and an error message when
 *   the setting is not a zone this runtime knows (the process zone is used then).
 */
export function resolveTimeZone(setting) {
  const wanted = typeof setting === 'string' ? setting.trim() : ''
  if (wanted.length === 0) return { timeZone: processTimeZone() }
  try {
    return { timeZone: new Intl.DateTimeFormat('en-US', { timeZone: wanted }).resolvedOptions().timeZone }
  } catch {
    return { timeZone: processTimeZone(), error: `timeZone ${JSON.stringify(wanted)} is not a known time zone; using ${processTimeZone()}` }
  }
}

/**
 * The zone to report to DSH as the zone of the person who wrote a prompt, so
 * DSH's clock context reads times in it instead of asking for one.
 * @param timeZone - a canonical zone from `resolveTimeZone`.
 * @returns the zone, or undefined for a name DSH would refuse (a bare
 *   abbreviation such as `EST`).
 */
export function clientTimeZone(timeZone) {
  return timeZone === 'UTC' || IANA_ZONE.test(timeZone ?? '') ? timeZone : undefined
}

const formatters = new Map()

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * A moment as the model reads it: weekday, date, local time and UTC offset,
 * such as `Mon 2026-03-02 09:41 UTC+01:00`.
 * @param epochMs - the moment, in milliseconds since the epoch.
 * @param timeZone - zone to show it in.
 * @returns the text, or undefined for a value that is not a time.
 */
export function formatMoment(epochMs, timeZone) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return undefined
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(epochMs).map((part) => [part.type, part.value]))
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.slice(3)
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} UTC${offset}`
}

/**
 * A Telegram time (`date` fields are Unix seconds) as the model reads it.
 * @param seconds - Unix seconds.
 * @param timeZone - zone to show it in.
 * @returns the text, or undefined for a value that is not a time.
 */
export function formatTelegramDate(seconds, timeZone) {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? formatMoment(seconds * 1000, timeZone) : undefined
}
