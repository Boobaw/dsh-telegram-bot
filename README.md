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

BotFather: **Bot Settings → Threaded mode → Enable**. Then enable **Disallow users to create new threads**, so Telegram does not create a topic for every message sent in All.

## Features

- One Telegram topic per DSH session; Web and Telegram use the same session.
- Telegram mirrors only turns initiated from Telegram; turns started in the Web UI stay in Web.
- `/sessions` lists workspaces and existing sessions, and can create a new session in a selected workspace.
- A `typing…` action is shown in the topic while its turn runs and stops when the answer is ready.
- Assistant answers stream into the topic with Telegram Markdown formatting. Messages sent while the agent is working are queued and processed after the current turn; `/clear` removes that queue without stopping the current answer.
- Replies, quotes and forwards keep their context. Ordinary messages are passed unchanged; only replies, quoted parts and forwarded messages get a short context block. A replied-to photo or document is attached when Telegram allows the bot to download it.
- Reasoning and tool calls are shown as temporary messages and removed as soon as the final answer is ready. Each tool-call entry is capped at three mobile lines.
- Inline controls for model, reasoning effort, permission mode and context usage.
- Tool approvals with **Deny** / **Allow** buttons.
- `ask_user_question` support: options, multi-select, custom answers and plan review.
- Documents and photos sent in a session topic are saved as DSH attachments and passed to the agent.
- `/new`, `/last`, `/goal`, `/rename`, `/fork`, `/clear`, `/stop`, `/restart`, `/status` and `/menu`.
- `/goal` shows and pins the current DSH goal. `/goal <objective>` creates or edits it, `/goal pause`, `/goal resume` and `/goal clear` manage it; clear unpins and removes the panel.
- `/new` in a session topic starts a fresh DSH session in the same workspace and binds it to the same topic; the previous session stays in DSH. In All it opens a new session topic.
- `/fork [name]` creates a DSH session fork in a new Telegram topic; without a name it uses the previous title plus the branch number.
- The session picker also has **🔀 Continue in Telegram fork**; automatic fork topics end with `(N)`.
- English and Russian bot messages.
- Bot token stays in the DSH credential store.

## Requirements

- DSH `0.2.1-rc.2` or newer, Node.js 22+.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- **Threaded mode** enabled in BotFather, **Topics** enabled in the bot chat, and **Disallow users to create new threads** enabled.

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
| Bot language | `en` (default) or `ru` |
| Enable bot | Start or pause Telegram polling |

The token field only reports whether a token is configured. A token supplied through the environment cannot be overwritten from the page.

## First run

1. Create a bot with @BotFather and save its token in **Settings → Telegram**.
2. In @BotFather open **Bot Settings → Threaded mode**, enable it, and enable **Disallow users to create new threads**.
3. Open the bot chat, tap the bot name and enable **Topics**.
4. Send `/start` in **All**. With an empty allowlist the bot replies with your user and chat ids.
5. Add your user id to **Allowed users** and press **Save**.
6. Send `/sessions` in **All**, choose a workspace and open or create a session.
7. Send a test message in the new topic.

An ordinary message in **All** creates a new session topic in the default workspace. Commands such as `/sessions`, `/fork` and `/last` still work in All.

If users are allowed to create threads, Telegram creates a topic before the bot receives the message; the bot then warns about the BotFather setting on startup.

## Delete topics

- `/topic delete <name or thread id>` deletes one known topic and its Telegram messages.
- `/topic wipe` asks for confirmation first; send `/topic wipe confirm` to delete every topic known to the bot in this chat. DSH sessions themselves are not deleted.

Topics are known after the bot creates them, after `/rename`, or after Telegram reports a topic creation/rename. Unknown topics cannot be listed through the Bot API.

## Send into a topic


Scripts, scheduled jobs, other plugins and agents can post into a topic by name or thread id. The message is also recorded in the session bound to that topic, without starting a turn; whoever answers there next sees it. If the topic has no session yet, the bot opens one in the configured workspace, as `/new` would.

CLI from the package:

```bash
dsh-telegram-send --topic "Release" "Build finished"
dsh-telegram-send --topic 54553 --file /tmp/report.pdf "Report attached"
dsh-telegram-send --topic "Release" --no-wait "Queued notification"
```

The request goes through a file spool under `$DSH_HOME/telegram/outbox`, so it needs no bot token and waits while DSH is stopped. Topic names ignore case; an unknown or ambiguous name is an error, and nothing is created.

Host plugins can call:

```js
await ctx.get('telegramTopics').send('Release', 'Build finished')
```

The model-facing tool is `telegram_send`.

## Troubleshooting topics


If every message in **All** creates a new topic, enable this BotFather option:

**Bot Settings → Threaded mode → Disallow users to create new threads**

The bot checks `has_topics_enabled` and `allows_users_to_create_topics` on startup, writes them to `~/.dsh/telegram/status.json`, and posts a warning in the control chat when either setting is wrong.

A correct configuration contains:

```json
"threadedMode": true,
"usersCanCreateTopics": false
```

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

`src/app.js` is the Host runtime: Telegram polling, topic routing and the session bridge. `src/update-ledger.js` persists Telegram update cursors, `src/admission.js` uses the native DSH session queue. `src/formatting.js`, `src/state.js`, `src/status.js`, `src/utils.js`, `src/errors.js`, `src/config.js` and `src/constants.js` hold the supporting layers. `src/message-context.js` builds reply/quote/forward context, `src/topics.js` resolves topic names and `src/outbox.js` powers `dsh-telegram-send`. `src/index.js` is the public entry point; root `index.js` is the loader-compatible wrapper. Root `client.js` is the loader-compatible client bundle. `src/client.js` contains the client source. The plugin registers the model-facing `telegram_send` tool for posting into a Telegram topic.

## License

MIT

## Credits

Markdown to Telegram formatting uses [telegramify-markdown](https://github.com/skoropadas/telegramify-markdown) (MIT).
