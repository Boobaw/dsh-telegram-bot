import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStickerLibrary, describeSticker, stickerKind } from '../src/stickers.js'

const sticker = (id, extra = {}) => ({ file_id: `file-${id}`, file_unique_id: id, emoji: '🙂', set_name: 'Set', ...extra })

test('remember keeps a written meaning, refreshes the file id and survives a reload', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'stickers-')), 'stickers.json')
  const library = createStickerLibrary({ path })
  await library.remember([sticker('A')])
  await library.setMeaning('A', '  happy  ')
  await library.remember([sticker('A', { file_id: 'file-A2' })])
  const again = createStickerLibrary({ path })
  const entry = await again.get('A')
  assert.equal(entry.meaning, 'happy')
  assert.equal(entry.fileId, 'file-A2')
  await assert.rejects(again.setMeaning('missing', 'x'), /not in the library/u)
})

test('find matches meaning words before set or emoji, and filters by emoji and set', async () => {
  const library = createStickerLibrary({ path: join(await mkdtemp(join(tmpdir(), 'stickers-')), 's.json') })
  await library.remember([sticker('A', { emoji: '😾' }), sticker('B', { emoji: '😻', set_name: 'Happy' }), sticker('C', { emoji: '😻' })])
  await library.setMeaning('A', 'happy to see you')
  assert.deepEqual((await library.find({ query: 'happy' })).stickers.map((entry) => entry.id), ['A', 'B'])
  assert.deepEqual((await library.find({ emoji: '😻', set: 'set' })).stickers.map((entry) => entry.id), ['C'])
  assert.equal((await library.find({ query: 'nothing' })).total, 0)
  assert.equal((await library.find({ limit: 1 })).stickers.length, 1)
})

test('kinds and descriptions', () => {
  assert.equal(stickerKind({ is_video: true }), 'video')
  assert.equal(stickerKind({ is_animated: true }), 'animated')
  assert.equal(stickerKind({}), 'static')
  assert.equal(describeSticker({ id: 'X', emoji: '👋', setName: 'S', setTitle: 'Title', kind: 'video' }), '👋 from set "S" (Title) (sticker X, video)')
})
