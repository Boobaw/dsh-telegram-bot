/** Editable plugin configuration schema. */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_TOKEN_REF } from './constants.js'

export const Config = z.object({
  /**
   * Credential reference that holds the bot token. The token itself lives in
   * the credential store (or the matching environment variable for headless
   * deployments); this config only names the reference.
   */
  tokenRef: z.string().default(DEFAULT_TOKEN_REF).volatile(),
  /** Whether the Telegram runtime should poll while this profile runs. */
  enabled: z.boolean().default(true).volatile(),
  /** Language of the bot's Telegram messages. */
  language: z.string().default('en').volatile(),
  /**
   * Telegram user ids or @usernames allowed to talk to the bot.
   * Empty means nobody, except the one-time setup hint described below.
   */
  allowedUsers: z.array(z.string()).default([]).volatile(),
  /**
   * Telegram chat ids or @channelnames the bot may answer in.
   * Empty means private chats only.
   */
  allowedChats: z.array(z.string()).default([]).volatile(),
  /**
   * Monotonic value the Restart button writes. Any settings update restarts the
   * runtime, but this field lets the button request a restart even when every
   * other field is unchanged.
   */
  restartRequest: z.number().default(0).volatile(),
  /** Working directory for Telegram-created DSH sessions. */
  cwd: z.string().default(process.cwd()).volatile(),
  /** Agent preset mounted for Telegram-created sessions when presets exist. */
  agentPreset: z.string().default('standard').volatile(),
  /** Mirror model reasoning deltas into the session topic. */
  showThinking: z.boolean().default(true).volatile(),
  /** Mirror tool calls into the session topic. */
  showToolCalls: z.boolean().default(true).volatile(),
  /**
   * Also show turns started outside Telegram (Web UI, scheduled tasks, other
   * plugins) in the topic bound to their session.
   */
  mirrorTurns: z.boolean().default(true).volatile(),
  /**
   * How voice messages, audio files and round video messages are turned into
   * text: `dsh` uses the DSH speech-to-text service (decoded with ffmpeg),
   * `command` runs `transcribeCommand`, `off` passes only the file.
   */
  transcriber: z.union(['dsh', 'command', 'off']).default('dsh').volatile(),
  /** Language hint for the DSH speech-to-text service; empty uses its setting. */
  transcribeLanguage: z.string().default('').volatile(),
  /**
   * Program and arguments for `transcriber: command`, run without a shell.
   * `{file}` is replaced by the recording's path (appended when absent); the
   * transcript is read from stdout.
   */
  transcribeCommand: z.array(z.string()).default([]).volatile(),
  /** ffmpeg program used to decode recordings for the DSH service. */
  ffmpegPath: z.string().default('ffmpeg').volatile(),
})

