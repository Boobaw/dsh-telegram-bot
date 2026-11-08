/** Voice messages, audio files and round video messages: decoding and transcription. */
import { spawn } from 'node:child_process'

/** Telegram message fields that carry speech, with a default file extension. */
const SPOKEN = [
  { field: 'voice', kind: 'voice message', extension: '.ogg' },
  { field: 'video_note', kind: 'video message', extension: '.mp4' },
  { field: 'audio', kind: 'audio file', extension: '.mp3' },
]

/**
 * The spoken media a message carries, if any.
 * @param message - Telegram message.
 * @returns `{ field, kind, file, name, seconds }`, or undefined.
 */
export function spokenMediaOf(message) {
  for (const entry of SPOKEN) {
    const file = message?.[entry.field]
    if (typeof file?.file_id !== 'string') continue
    const id = message.message_id ?? Date.now()
    const name = typeof file.file_name === 'string' && file.file_name.length > 0
      ? file.file_name
      : `telegram-${entry.field.replace('_', '-')}-${id}${entry.extension}`
    return { field: entry.field, kind: entry.kind, file, name, seconds: typeof file.duration === 'number' ? file.duration : undefined }
  }
  return undefined
}

/**
 * Wrap raw 16 kHz mono 16-bit PCM in the canonical 44-byte WAV header that
 * DSH speech providers accept.
 * @param pcm - little-endian samples.
 * @returns WAV bytes.
 */
export function pcmToWave(pcm) {
  const data = pcm.length % 2 === 0 ? pcm : pcm.subarray(0, pcm.length - 1)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * Run one program and collect its output.
 * @param argv - program and arguments; no shell is involved.
 * @param signal - cancellation.
 * @param timeoutMs - upper bound for the run.
 * @returns stdout bytes; rejects with stderr on a non-zero exit.
 */
export function runProgram(argv, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () => {
      child.kill('SIGKILL')
      finish(new Error(`${argv[0]} was cancelled`))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`${argv[0]} took longer than ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => finish(new Error(`${argv[0]} could not start: ${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) finish(undefined, Buffer.concat(out))
      else finish(new Error(`${argv[0]} exited with ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(-400)}`))
    })
  })
}

/**
 * Transcribe one recording.
 * @param options - `{ mode, path, language, command, ffmpeg, speech, signal, timeoutMs }`:
 *   `mode` is `dsh` (the DSH speech-to-text service, `speech`), `command`
 *   (`command` argv, `{file}` replaced by `path`, transcript on stdout) or `off`.
 * @returns `{ text, by }`; rejects when transcription fails.
 */
export async function transcribe(options) {
  const { mode, path, signal } = options
  const timeoutMs = options.timeoutMs ?? 180_000
  if (mode === 'command') {
    const command = Array.isArray(options.command) ? options.command.filter((part) => typeof part === 'string') : []
    if (command.length === 0) throw new Error('no transcription command is configured')
    const argv = command.some((part) => part.includes('{file}'))
      ? command.map((part) => part.replaceAll('{file}', path))
      : [...command, path]
    const text = (await runProgram(argv, signal, timeoutMs)).toString('utf8').trim()
    return { text, by: 'the configured transcription command' }
  }
  if (mode !== 'dsh') throw new Error('transcription is turned off')
  const speech = options.speech
  if (speech === undefined || typeof speech.resolve !== 'function') throw new Error('the DSH speech-to-text service is not enabled')
  const pcm = await runProgram(
    [options.ffmpeg || 'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
    signal,
    timeoutMs,
  )
  if (pcm.length === 0) throw new Error('the recording has no audio')
  const spec = speech.resolve({
    audio: pcmToWave(pcm),
    ...(typeof options.language === 'string' && options.language.length > 0 ? { language: options.language } : {}),
  })
  const result = await speech.transcribe(spec, signal ?? new AbortController().signal)
  const provider = spec.provider?.info?.name ?? spec.provider?.info?.id
  return { text: String(result?.text ?? '').trim(), by: `DSH speech-to-text${provider ? ` (${provider})` : ''}` }
}

/**
 * The text the agent reads next to a spoken recording.
 * @param media - result of {@link spokenMediaOf}.
 * @param outcome - `{ path, text, by, error }`.
 * @returns prompt text.
 */
export function transcriptNote(media, outcome) {
  const length = media.seconds === undefined ? '' : `, ${Math.floor(media.seconds / 60)}:${String(media.seconds % 60).padStart(2, '0')}`
  const where = typeof outcome.path === 'string' ? `the file is attached and saved at ${outcome.path}` : 'the file is attached'
  if (outcome.error !== undefined) {
    return `[Telegram ${media.kind} "${media.name}"${length}: not transcribed (${outcome.error}); ${where}]`
  }
  if (outcome.text.length === 0) {
    return `[Telegram ${media.kind} "${media.name}"${length}: ${outcome.by} heard no speech; ${where}]`
  }
  return `[Telegram ${media.kind} "${media.name}"${length}, transcribed by ${outcome.by}; the transcript may contain mistakes, and ${where} to check it]\n${outcome.text}`
}
