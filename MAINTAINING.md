# Maintaining this fork

This repository is a maintained fork of [Boobaw/dsh-telegram-bot](https://github.com/Boobaw/dsh-telegram-bot). It adds:

- `/new`: a fresh session in the same topic and workspace.
- User-created topics: each new topic asks for its workspace and a new or existing session; `/workspace` switches; topic names are never changed after session titles.
- Two-way sync: turns started in the Web UI, by scheduled tasks or by other plugins also appear in the bound topic (`mirrorTurns`).
- Sending into topics by thread id: the `telegramTopics` Host service, the `telegram_send` tool and the `dsh-telegram-send` command, with the sender (job, session) recorded and remembered, so replies to those messages carry the full original.
- Sessions the bot creates are never left blank (DSH's New conversation would reuse them): see `claimForTopic` in `src/app.js`.
- Topic session titles are `<topic name> · <DSH title>`: DSH has no title hook, so `syncTopicTitle` re-appends each generated `session/title` with the prefix and the same source (automatic titling keeps running), and `startTopicTitle` calls `sessionTitle.refresh` at the first model request, because the bare-name placeholder is a user title that stops automatic titling. Topic renames record a `telegram-topic` notice as a `user/message` (`recordNote`): session search indexes only message, tool and todo events, not titles or queued inbox items.
- Deleted topics are forgotten as soon as any Bot API call reports them gone (`forgetGoneTopic`).
- Chat-wide commands sent in All are answered in All; the topic Telegram made for them is deleted.
- Sender labels: each Telegram prompt names who wrote it.
- Voice messages, audio and round videos: downloaded, transcribed (DSH speech-to-text or a configured command) and passed with their file path.
- Messages sent during a running turn are steered into it (`src/steer.js`): text through `sessionController.prompt({ mode: 'steer' })`, the Web UI's own call, and prompts with stored attachments through `agent.steer`, the method that mode uses. DSH keeps the turn going while its next-step inbox holds input and starts a new turn when input is left after `turn/end`, so a message that lands as the turn ends is still answered; `chat.steerFollow` shows that turn in the topic even with `mirrorTurns` off, and is cleared at the first `turn/end` that leaves the inbox empty. Prompts reach DSH in order (`admitInOrder`). `busyMessages: queue` keeps upstream's bot-side queue.
- Stickers: received ones are attached as images (thumbnail or first frame for animated and video stickers) and kept in a library (`src/stickers.js`) with the agent's meaning notes; the `telegram_sticker` tool finds, views, notes, loads sets and sends them through `sendToTopic`.
- Goal rounds use upstream's `adoptGoalTurn` path (thinking, tools, answer and the goal panel, also with `mirrorTurns` off). The Host-wide mirror can see a goal round's `turn/start` before its goal prompt; `adoptGoalTurn` then takes the turn over, so it is shown once.
- Reply, quote and forward context: the agent sees what a message replies to, quotes or forwards, and forwards sent together become one prompt.

Upstream changes are merged in, not rebased, so the history of both lines stays intact.

## Merging upstream

```bash
git remote add upstream https://github.com/Boobaw/dsh-telegram-bot.git   # once
git fetch upstream
git switch main
git merge upstream/main
npm install
npm test
git push origin main
```

Conflicts usually land in `src/app.js` (most of the bridge lives there), `README.md` and the `version` line of `package.json`. Keep the fork's version as upstream's version plus a `-fork.N` suffix, and make sure `client.js` still matches `src/client.js` after the merge (`cmp client.js src/client.js`).

Fork-only code is kept in separate files where that is natural (`src/topics.js`, `src/outbox.js`, `src/message-context.js`, `src/sent-log.js`, `src/voice.js`, `src/steer.js`, `bin/dsh-telegram-send.js`, `test/fake-dsh.js`, `test/fork-features.test.js`, `test/message-context.test.js`, `test/sent-log.test.js`, `test/steer.test.js`, `test/voice.test.js`), so most upstream edits apply without touching it.
