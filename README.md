# dsh-telegram-bot

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/boobaw/dsh-telegram-bot)

Telegram client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It connects a DSH profile to a Telegram bot and keeps the same DSH sessions available in both interfaces.

## Demo

First setup: https://youtu.be/QEeVucfBsWk

Installation, bot token, the allowlist, `/start`, `/sessions` and a test prompt.

### Enable Threaded mode

<p align="center">
  <a href="docs/threaded-mode.gif">
    <img src="docs/threaded-mode.gif" alt="BotFather: Bot Settings → Threaded mode → Enable" width="320">
  </a>
</p>

BotFather: **Bot Settings → Threaded mode → Enable**. Leave **Disallow users to create new threads** off: you create a topic for each conversation yourself.

## Features

- One Telegram topic per DSH session; Web and Telegram use the same session.
- You create the topics. A new topic asks which workspace to use, then whether to start a new session or continue an existing one from that workspace. The message that opened the topic runs once the session is chosen.
- Topic names are yours: the bot never renames a topic after the session title. `/rename` renames it on request.
- `/workspace` moves the topic to another workspace: pick the workspace, then a new or existing session there. A session's working directory is fixed when it is created, so the previous session is not continued in this topic; it stays in DSH and can be bound again later as an existing session.
- Two-way sync: turns started anywhere else (Web UI, scheduled tasks, other plugins) also appear in the session's topic. The prompt is shown with a **From Web** or **Scheduled task** label, followed by the streamed answer. Messages sent from Telegram are not echoed back, and context that plugins add on their own (time, runtime notes) is not shown. A Telegram message sent while such a turn runs waits for it. Approvals and questions from those turns are answered where the turn started. Turn this off with **Show turns from other clients**.
- `/sessions` lists workspaces and existing sessions, and can create a new session in a selected workspace.
- Assistant answers stream into the topic with Telegram Markdown formatting. Messages sent while the agent is working are queued and processed after the current turn; `/clear` removes that queue without stopping the current answer.
- Reasoning and tool calls are shown as temporary messages and removed after the answer. Each tool-call entry is capped at two lines.
- Inline controls for model, reasoning effort, permission mode and context usage.
- Tool approvals with **Deny** / **Allow** buttons.
- `ask_user_question` support: options, multi-select, custom answers and plan review.
- Documents and photos sent in a session topic are saved as DSH attachments and passed to the agent.
- `/new`, `/workspace`, `/last`, `/rename`, `/fork`, `/clear`, `/stop`, `/restart`, `/status` and `/menu`.
- `/new` in a session topic starts a fresh DSH session in the same workspace and binds it to the same topic; the previous session stays in DSH. In All it opens a new session topic.
- One session is bound to at most one topic: binding it to a new topic releases the old one.
- `/fork [name]` creates a DSH session fork in a new Telegram topic; without a name it uses the previous title plus the branch number.
- The session picker also has **🔀 Continue in Telegram fork**; automatic fork topics end with `(N)`.
- English and Russian bot messages.
- Bot token stays in the DSH credential store.

## Requirements

- DSH `0.2.1-rc.2` or newer, Node.js 22+.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- **Threaded mode** enabled in BotFather, **Topics** enabled in the bot chat, and **Disallow users to create new threads** left off.

## Install

From this repository:

```bash
npx @deepseek-ai/dsh plugin --profile web add .
```

From npm:

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-telegram-bot@latest
```

Restart `dsh web` after installing or updating the plugin. Then open **Settings → Telegram**.

## Configure

| Field | Meaning |
| --- | --- |
| Bot token | Token from @BotFather; stored in the credential store |
| `tokenRef` | Credential/env name for the token; default `TELEGRAM_BOT_TOKEN` |
| `cwd` | Working directory for Telegram-created sessions |
| `agentPreset` | Preset mounted for Telegram sessions; default `standard` |
| Allowed users | Telegram user ids or `@usernames` |
| Allowed chats | Telegram chat ids or `@channelnames` |
| Show model thinking | Show reasoning in a temporary message |
| Show tool calls | Show tool calls in a temporary message |
| Show turns from other clients (`mirrorTurns`) | Mirror turns started outside Telegram into the bound topic; default on |
| Bot language | `en` (default) or `ru` |
| Enable bot | Start or pause Telegram polling |

The token field only reports whether a token is configured. A token supplied through the environment cannot be overwritten from the page.

## First run

1. Create a bot with @BotFather and save its token in **Settings → Telegram**.
2. In @BotFather open **Bot Settings → Threaded mode** and enable it. Leave **Disallow users to create new threads** off.
3. Open the bot chat, tap the bot name and enable **Topics**.
4. Send `/start` in **All**. With an empty allowlist the bot replies with your user and chat ids.
5. Add your user id to **Allowed users** and press **Save**.
6. Create a topic and send a message in it. Choose a workspace, then **New session** or one of the listed sessions. Your message runs in that session.

A message sent in **All** makes Telegram create a topic for it; the bot treats it like any new topic and asks for the workspace (if Telegram delivers it to All instead, the bot opens a new topic in the default workspace). `/sessions` in **All** still opens existing sessions in new topics, and commands such as `/fork` and `/last` work as before.

Topics bound by an earlier version keep their sessions after an upgrade.

## Troubleshooting topics

The bot checks `has_topics_enabled` and `allows_users_to_create_topics` on startup, writes them to `~/.dsh/telegram/status.json`, and posts a warning in the control chat when Threaded mode is off or users cannot create topics.

A correct configuration contains:

```json
"threadedMode": true,
"usersCanCreateTopics": true
```

## Send to a topic

Scripts, scheduled jobs, other plugins and agents can post into a topic by its name or thread id. The message (text and files) appears in the topic and is also recorded in the session bound to that topic, without starting a turn: whoever answers there next sees it, even after `/new`. A name that matches no topic, or more than one, is an error; nothing is created.

Names ignore case. The bot learns a topic's name when it creates the topic, when Telegram reports a topic being created or renamed, and on `/rename`. Topics bound by an earlier version start with their last title. `/id` in a topic shows its thread id.

From a shell (no bot token needed):

```bash
dsh-telegram-send --topic notify "Backup finished"
some-report | dsh-telegram-send --topic notify --from nightly-report
dsh-telegram-send --topic 7100 --file /tmp/report.pdf "Monthly report"
```

The command writes the request into `$DSH_HOME/telegram/outbox/` and waits up to `--timeout` seconds (default 30) for the plugin's answer. Exit codes: `0` sent, `1` failed (the error is printed, for example an unknown topic), `2` bad arguments, `3` still queued (the bot sends it once it runs). `--no-wait` returns right after queueing. The spool keeps requests while DSH is stopped, which is why it is a directory and not a socket; a request interrupted by a restart is sent again. The command is installed as the package's `bin`; link it onto your `PATH` if needed (`node_modules/.bin/dsh-telegram-send` in the profile).

From another Host plugin:

```js
const result = await ctx.get('telegramTopics').send('notify', 'Backup **finished**', ['/tmp/report.pdf'], { from: { label: 'backup' } })
// { chatId, threadId, topic, sessionId, recorded, messageIds }
ctx.get('telegramTopics').topics() // [{ threadId, name, sessionId }]
```

From an agent: the `telegram_send` tool takes `topic`, `text` and `files` (absolute paths). The sending session does not get a copy of its own message.

Text is Markdown, converted for Telegram like assistant answers. JPEG, PNG and WebP files up to 10 MB are sent as photos, other files as documents (up to 50 MB). A topic with no session only shows the message.

## Plugins page

The plugin page is informational. It points to **Settings → Telegram** and lists the manual configuration files. Use the bundle switch there to enable or disable the plugin; **Enable bot** is a soft pause that keeps the plugin loaded but stops polling.

## Headless profile

The bot can run without the Web UI:

```bash
mkdir -p ~/.dsh/profiles/tg
cd ~/.dsh/profiles/tg
```

`package.json`:

```json
{
  "name": "dsh-profile-tg",
  "private": true,
  "dependencies": { "dsh-telegram-bot": "latest" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-telegram-bot"]
    }
  }
}
```

`cordis.patch.yml`:

```yaml
- id: telegram-bot
  name: dsh-telegram-bot
  config:
    enabled: true
    allowedUsers: ["<user-id>"]
    allowedChats: ["<chat-id>"]
```

Install and run:

```bash
npm install
printf 'TELEGRAM_BOT_TOKEN=%s\n' '<token>' >> ~/.dsh/.env
chmod 600 ~/.dsh/.env
npx @deepseek-ai/dsh --profile tg
```

Do not put the token in `cordis.patch.yml`.

## Security

- The bot token lives in the credential store, not in the profile patch.
- Empty **Allowed users** answers only in private chats with the setup hint.
- Group and channel chats require an entry in **Allowed chats**.
- Do not run two pollers with the same token; Telegram returns `409 Conflict`.
- A DSH plugin runs in-process with the Host. Install only source you trust.

## Development

No build step is needed.

```bash
npm install
node --check index.js
node --check client.js
npm test
```

`src/app.js` is the Host runtime: Telegram polling, topic routing and the session bridge. `src/update-ledger.js` persists Telegram update cursors, `src/admission.js` uses the native DSH session queue. `src/formatting.js`, `src/state.js`, `src/status.js`, `src/utils.js`, `src/errors.js`, `src/config.js` and `src/constants.js` hold the supporting layers. `src/index.js` is the public entry point; root `index.js` is the loader-compatible wrapper. Root `client.js` is the loader-compatible client bundle. `src/client.js` contains the client source. `src/topics.js` resolves topic names and `src/outbox.js` is the file spool behind `bin/dsh-telegram-send.js`. The plugin adds one model-facing tool, `telegram_send`, and no system-prompt text.

## License

MIT

## Credits

Markdown to Telegram formatting uses [telegramify-markdown](https://github.com/skoropadas/telegramify-markdown) (MIT).
