# Maintaining this fork

This repository is a maintained fork of [Boobaw/dsh-telegram-bot](https://github.com/Boobaw/dsh-telegram-bot). It adds:

- `/new`: a fresh session in the same topic and workspace.
- User-created topics: each new topic asks for its workspace and a new or existing session; `/workspace` switches; topic names are never changed after session titles.
- Two-way sync: turns started in the Web UI, by scheduled tasks or by other plugins also appear in the bound topic (`mirrorTurns`).
- Sending into topics by name: the `telegramTopics` Host service, the `telegram_send` tool and the `dsh-telegram-send` command, with the sender (job, session) recorded and remembered, so replies to those messages carry the full original.
- Chat-wide commands sent in All are answered in All; the topic Telegram made for them is deleted.
- Sender labels: each Telegram prompt names who wrote it.
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

Fork-only code is kept in separate files where that is natural (`src/topics.js`, `src/outbox.js`, `src/message-context.js`, `src/sent-log.js`, `bin/dsh-telegram-send.js`, `test/fork-features.test.js`, `test/message-context.test.js`, `test/sent-log.test.js`), so most upstream edits apply without touching it.
