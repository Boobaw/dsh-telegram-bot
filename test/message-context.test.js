import assert from 'node:assert/strict'
import test from 'node:test'
import { composePrompt, describeReply, describeSent, isForwarded, repliedMessage, replyReference } from '../src/message-context.js'

const user = { id: 42, first_name: 'Owner' }

test('long replied-to text is cut at a word with a note', () => {
  const words = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ')
  const text = composePrompt({
    from: user,
    text: 'summary?',
    reply_to_message: { message_id: 3, date: 0, from: { id: 9, first_name: 'Kim' }, text: words },
  }, { maxQuote: 100 })
  const lines = text.split('\n')
  assert.equal(lines[0], '[Replying to a message from Kim (sent 1970-01-01 00:00 UTC)]')
  assert.ok(lines[1].length <= 102)
  assert.match(lines[1], /word\d+$/u, 'cut between words')
  assert.match(lines[2], /^> \[…truncated, \d+ more characters\]$/u)
  assert.equal(lines.at(-1), 'summary?')
})

test('the user replying to their own forwarded message sees both labels', () => {
  const text = describeReply({
    from: user,
    text: 'see above',
    reply_to_message: {
      message_id: 4,
      date: 0,
      from: user,
      text: 'meeting moved',
      forward_origin: { type: 'chat', sender_chat: { id: -1009, title: 'Team' }, author_signature: 'Lee', date: 60 },
    },
  })
  assert.equal(text, '[Replying to a message from the user (their own earlier message) (sent 1970-01-01 00:00 UTC; forwarded from "Team", signed Lee, originally sent 1970-01-01 00:01 UTC)]\n> meeting moved')
})

test('a reply to another chat shows the quote, origin and link', () => {
  const text = describeReply({
    from: user,
    text: 'thoughts?',
    quote: { text: 'prices go up in May' },
    external_reply: {
      origin: { type: 'channel', chat: { id: -1005551234, title: 'Private Notes', type: 'channel' }, message_id: 12, date: 0 },
      chat: { id: -1005551234, title: 'Private Notes', type: 'channel' },
      message_id: 12,
      document: { file_id: 'd1', file_name: 'plan.pdf', file_size: 30 * 1024 * 1024 },
    },
  }, { replyFile: 'too-large' })
  assert.equal(text, '[Replying to a message from another chat (from channel "Private Notes"; sent 1970-01-01 00:00 UTC; https://t.me/c/5551234/12; contains a file "plan.pdf", too large to attach); the user quoted this part]\n> prices go up in May')
})

test('a reply to another chat without a quote says the text is not visible', () => {
  const text = describeReply({ from: user, text: 'x', external_reply: { origin: { type: 'hidden_user', sender_user_name: 'Pat', date: 0 } } })
  assert.match(text, /^\[Replying to a message from another chat \(from Pat \(account hidden\); sent [^)]+\)\]\n\(The bot cannot see/u)
})

test('legacy forward fields are still understood', () => {
  const message = { from: user, text: 'old style', forward_from: { id: 5, first_name: 'Robin', is_bot: true }, forward_date: 0 }
  assert.equal(isForwarded(message), true)
  assert.equal(composePrompt(message), '[Forwarded message from Robin, a bot (originally sent 1970-01-01 00:00 UTC)]\n> old style')
})

test('a forwarded photo notes the attachment and keeps an empty caption out', () => {
  const message = { from: user, photo: [{ file_id: 'p' }], forward_origin: { type: 'user', sender_user: user, date: 0 } }
  assert.equal(composePrompt(message, { ownFile: true }), '[Forwarded message from the user themselves (originally sent 1970-01-01 00:00 UTC; contains a photo, attached)]')
})

test('plain messages and topic roots add no context', () => {
  assert.equal(composePrompt({ from: user, text: 'hi' }), 'hi')
  const inTopic = { from: user, text: 'hi', is_topic_message: true, message_thread_id: 70, reply_to_message: { message_id: 70, date: 0, text: 'topic' } }
  assert.equal(repliedMessage(inTopic), undefined)
  assert.equal(composePrompt(inTopic), 'hi')
})

const sentEntry = {
  chatId: 100,
  messageIds: [7, 8],
  sentAt: '2026-11-08T18:03:22.000Z',
  text: 'Part one.\nPart two.',
  files: ['report.pdf'],
  fromSession: 'session-sender',
  job: 'Morning digest',
  boundSession: 'session-old',
  recorded: true,
}

test('a reply to a message sent on behalf of a job shows the full text and its sender', () => {
  const message = { from: user, text: 'done', chat: { id: 100 }, reply_to_message: { message_id: 8, date: 0, from: { id: 1, is_bot: true, first_name: 'bot' }, text: 'Part two.' } }
  const text = composePrompt(message, { botId: 1, sent: sentEntry, currentSession: 'session-new' })
  assert.equal(text, [
    '[Replying to a message from the assistant (this bot) (sent 1970-01-01 00:00 UTC)]',
    '> Part two.',
    '',
    '[The replied-to message was posted by the bot on behalf of another sender (sent 2026-11-08 18:03 UTC; by job "Morning digest"; from DSH session session-sender; 2 Telegram messages; with file "report.pdf"; recorded in session session-old, not this one). Full text:]',
    '> Part one.',
    '> Part two.',
    '(For more context, open session session-sender or session-old.)',
    '',
    'done',
  ].join('\n'))
  assert.deepEqual(replyReference(message), { chatId: 100, messageId: 8 })
})

test('a sent message recorded in the current session only names its sender', () => {
  const text = describeSent({ ...sentEntry, files: [], messageIds: [8], fromSession: null, job: null, label: 'backup', boundSession: 'session-new' }, { currentSession: 'session-new' })
  assert.equal(text, '[The replied-to message was posted by the bot on behalf of another sender (sent 2026-11-08 18:03 UTC; by backup). Full text:]\n> Part one.\n> Part two.')
})

test('no sent entry adds nothing, and forwards have no reply reference', () => {
  const message = { from: user, text: 'ok', chat: { id: 100 }, reply_to_message: { message_id: 9, date: 0, from: { id: 1 }, text: 'hi' } }
  assert.equal(composePrompt(message, { botId: 1 }), '[Replying to a message from the assistant (this bot) (sent 1970-01-01 00:00 UTC)]\n> hi\n\nok')
  assert.equal(replyReference({ ...message, forward_origin: { type: 'hidden_user', sender_user_name: 'x', date: 0 } }), undefined)
  assert.equal(replyReference({ from: user, text: 'plain' }), undefined)
})
