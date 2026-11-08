import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pcmToWave, spokenMediaOf, transcribe, transcriptNote } from '../src/voice.js'

/** The WAV check DSH applies before transcription, when DSH is installed here. */
async function dshValidateWave() {
  const candidates = [
    '@deepseek-ai/dsh-experimental-speech-to-text/wave',
    '/usr/local/lib/nodejs/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-speech-to-text/lib/types/wave.js',
  ]
  for (const candidate of candidates) {
    try {
      return (await import(candidate)).validateWave
    } catch {
      // Not installed at this place.
    }
  }
  return undefined
}

/** A stand-in for ffmpeg that prints one second of silent PCM. */
async function fakeFfmpeg(directory) {
  const path = join(directory, 'fake-ffmpeg.mjs')
  await writeFile(path, '#!/usr/bin/env node\nprocess.stdout.write(Buffer.alloc(32000))\n')
  await chmod(path, 0o755)
  return path
}

test('spoken media is found in voice, round video and audio messages', () => {
  assert.equal(spokenMediaOf({ message_id: 5, voice: { file_id: 'v', duration: 7 } }).name, 'telegram-voice-5.ogg')
  assert.equal(spokenMediaOf({ message_id: 5, video_note: { file_id: 'n' } }).kind, 'video message')
  assert.equal(spokenMediaOf({ message_id: 5, audio: { file_id: 'a', file_name: 'memo.m4a' } }).name, 'memo.m4a')
  assert.equal(spokenMediaOf({ message_id: 5, text: 'hi' }), undefined)
})

test('decoded PCM is wrapped in the WAV header DSH accepts', async (t) => {
  const wave = pcmToWave(Buffer.alloc(32000 * 2))
  assert.equal(wave.length, 44 + 64000)
  const validateWave = await dshValidateWave()
  if (validateWave === undefined) {
    t.skip('DSH speech-to-text is not installed here')
    return
  }
  assert.equal(validateWave(wave, 120), 2)
})

test('the DSH service gets a 16 kHz mono WAV and the language hint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-test-'))
  try {
    let seen
    const speech = {
      resolve: (request) => ({ ...request, provider: { info: { id: 'sensevoice', name: 'SenseVoice' } } }),
      transcribe: async (spec) => {
        seen = spec
        return { text: ' 打开客厅的灯 ', audioSeconds: 1, inferenceSeconds: 0.1 }
      },
    }
    const result = await transcribe({ mode: 'dsh', path: '/tmp/in.ogg', language: 'zh', ffmpeg: await fakeFfmpeg(directory), speech })
    assert.deepEqual(result, { text: '打开客厅的灯', by: 'DSH speech-to-text (SenseVoice)' })
    assert.equal(seen.language, 'zh')
    assert.equal(seen.audio.length, 44 + 32000)
    assert.equal(Buffer.from(seen.audio).toString('ascii', 0, 4), 'RIFF')
    await assert.rejects(transcribe({ mode: 'dsh', path: '/tmp/in.ogg', speech: undefined }), /speech-to-text service is not enabled/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a configured command gets the file path and returns stdout', async () => {
  const command = [process.execPath, '-e', 'process.stdout.write("heard " + process.argv[1] + "\\n")', '{file}']
  assert.deepEqual(await transcribe({ mode: 'command', path: '/tmp/clip.ogg', command }), { text: 'heard /tmp/clip.ogg', by: 'the configured transcription command' })
  const appended = [process.execPath, '-e', 'process.stdout.write(process.argv.at(-1))']
  assert.equal((await transcribe({ mode: 'command', path: '/tmp/x.ogg', command: appended })).text, '/tmp/x.ogg')
  await assert.rejects(transcribe({ mode: 'command', path: '/tmp/x.ogg', command: [process.execPath, '-e', 'process.exit(3)'] }), /exited with 3/)
  await assert.rejects(transcribe({ mode: 'command', path: '/tmp/x.ogg', command: [] }), /no transcription command/)
  await assert.rejects(transcribe({ mode: 'off', path: '/tmp/x.ogg' }), /turned off/)
})

test('the note gives the transcript, or the reason, and always the file path', () => {
  const media = spokenMediaOf({ message_id: 9, voice: { file_id: 'v', duration: 75 } })
  assert.equal(
    transcriptNote(media, { path: '/data/a.ogg', text: 'hello', by: 'DSH speech-to-text' }),
    '[Telegram voice message "telegram-voice-9.ogg", 1:15, transcribed by DSH speech-to-text; the transcript may contain mistakes, and the file is attached and saved at /data/a.ogg to check it]\nhello',
  )
  assert.match(transcriptNote(media, { path: '/data/a.ogg', error: 'ffmpeg could not start' }), /not transcribed \(ffmpeg could not start\); the file is attached and saved at \/data\/a\.ogg\]$/u)
  assert.match(transcriptNote(media, { text: '', by: 'X' }), /X heard no speech; the file is attached\]$/u)
})
