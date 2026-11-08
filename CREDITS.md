# Credits

## telegramify-markdown

Markdown → Telegram MarkdownV2 conversion is provided by
[telegramify-markdown](https://github.com/skoropadas/telegramify-markdown),
licensed under the MIT License.

It is built on [Unified](https://github.com/unifiedjs/unified) and
[Remark](https://github.com/remarkjs/remark/).

## soffits/dsh-telegram-bot

Parts of the Telegram bridge are adapted from the
[soffits/dsh-telegram-bot](https://github.com/soffits/dsh-telegram-bot) fork,
licensed under the MIT License:

- reply/quote/forward context — `src/message-context.js` and its tests;
- sending into topics by name — `src/topics.js`, `src/outbox.js` and the
  `dsh-telegram-send` command;
- chat-wide command handling in All — the command-topic helper.

The cherry-picked commits keep their original authorship and include the
`(cherry picked from commit ...)` line.
