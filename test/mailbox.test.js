/**
 * The mailbox contract.
 *
 * Every feature here is append-only: an edit supersedes, a withdrawal
 * tombstones, a receipt is its own record. The tests assert that property
 * directly, because it is what makes the log usable as evidence of what was
 * actually agreed rather than merely as a chat.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMailbox, createPresence } from '../src/mailbox.js'

const box = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let clock = 1000
  return createMailbox({ file: join(dir, 'mail.jsonl'), now: () => (clock += 1000) })
}

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a sent message reaches its addressee', (t) => {
  const m = box(t)
  m.send({ from: 'claude', to: 'codex', text: 'readiness barrier landed' })
  const { messages } = m.read({ to: 'codex' })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].from, 'claude')
})

test('the cursor returns only what is new', (t) => {
  const m = box(t)
  m.send({ from: 'claude', to: 'codex', text: 'one' })
  const first = m.read({ to: 'codex' })
  assert.deepEqual(m.read({ to: 'codex', since: first.cursor }).messages, [])
  m.send({ from: 'claude', to: 'codex', text: 'two' })
  assert.equal(m.read({ to: 'codex', since: first.cursor }).messages.length, 1)
})

test('reading never consumes, so a crashed reader loses nothing', (t) => {
  // A queue that popped would make a crash indistinguishable from a delivery.
  const m = box(t)
  m.send({ from: 'claude', to: 'codex', text: 'important' })
  assert.equal(m.read({ to: 'codex' }).messages.length, 1)
  assert.equal(m.read({ to: 'codex' }).messages.length, 1)
})

test('history survives a fresh mailbox over the same file', (t) => {
  const file = join(tempDir(t), 'mail.jsonl')
  createMailbox({ file }).send({ from: 'claude', to: 'codex', text: 'persisted' })
  assert.equal(createMailbox({ file }).read({}).messages[0].text, 'persisted')
})

test('a reply threads under the message it answers', (t) => {
  const m = box(t)
  const first = m.send({ from: 'codex', to: 'claude', text: 'seat failed at 1.6s' })
  m.send({ from: 'claude', to: 'codex', text: 'dispatch crossed', replyTo: first.seq })
  assert.equal(m.read({ thread: first.seq }).messages.length, 2)
})

test('an explicit thread groups messages', (t) => {
  const m = box(t)
  m.send({ from: 'claude', to: 'codex', text: 'a', thread: 'readiness' })
  m.send({ from: 'codex', to: 'claude', text: 'b', thread: 'readiness' })
  m.send({ from: 'claude', to: 'codex', text: 'c', thread: 'other' })
  assert.equal(m.read({ thread: 'readiness' }).messages.length, 2)
})

test('a broadcast reaches every participant', (t) => {
  const m = box(t)
  m.send({ from: 'claude', to: 'codex', text: 'direct' })
  m.send({ from: 'claude', to: '*', text: 'anyone' })
  assert.equal(m.read({ to: 'codex' }).messages.length, 2)
  assert.equal(m.read({ to: 'someone-else' }).messages.length, 1)
})

test('mentions are extracted so a reader can filter to what needs them', (t) => {
  const m = box(t)
  const sent = m.send({ from: 'claude', to: '*', text: 'over to @codex on the adapter event' })
  assert.deepEqual(sent.mentions, ['codex'])
  assert.equal(m.read({ mentions: 'codex' }).messages.length, 1)
})

test('an edit supersedes without erasing the original', (t) => {
  const m = box(t)
  const first = m.send({ from: 'claude', to: 'codex', text: 'it was 300s' })
  m.edit({ from: 'claude', seq: first.seq, text: 'it was 306s' })
  assert.equal(m.read({ current: false }).messages.length, 2, 'the original is retained')
  const now = m.read({}).messages
  assert.equal(now.length, 1)
  assert.match(now[0].text, /306s/)
  assert.equal(now[0].editedFrom, first.seq)
})

test('only the author may edit their own message', (t) => {
  const m = box(t)
  const first = m.send({ from: 'claude', to: 'codex', text: 'mine' })
  assert.throws(() => m.edit({ from: 'codex', seq: first.seq, text: 'not yours' }), /author/i)
})

test('a withdrawal tombstones rather than erasing', (t) => {
  const m = box(t)
  const first = m.send({ from: 'claude', to: 'codex', text: 'oops' })
  m.withdraw({ from: 'claude', seq: first.seq })
  assert.equal(m.read({}).messages.length, 0, 'withdrawn from the current view')
  assert.ok(m.read({ current: false }).messages.some((r) => r.withdraws === first.seq),
    'but the withdrawal itself stays on the record')
})

test('only the author may withdraw their own message', (t) => {
  const m = box(t)
  const first = m.send({ from: 'claude', to: 'codex', text: 'mine' })
  assert.throws(() => m.withdraw({ from: 'codex', seq: first.seq }), /author/i)
})

test('a reaction attaches without adding to the timeline', (t) => {
  const m = box(t)
  const first = m.send({ from: 'codex', to: 'claude', text: 'shipped' })
  m.react({ from: 'claude', seq: first.seq, emoji: '+1' })
  const now = m.read({}).messages
  assert.equal(now.length, 1, 'a reaction is not a message')
  assert.deepEqual(now[0].reactions, [{ from: 'claude', emoji: '+1' }])
})

test('a receipt records how far a participant has read', (t) => {
  const m = box(t)
  const first = m.send({ from: 'claude', to: 'codex', text: 'please review' })
  m.acknowledge({ from: 'codex', upTo: first.seq })
  assert.equal(m.receipts().codex, first.seq)
})

test('unread counts what the addressee has not acknowledged', (t) => {
  const m = box(t)
  m.send({ from: 'claude', to: 'codex', text: 'one' })
  const second = m.send({ from: 'claude', to: 'codex', text: 'two' })
  assert.equal(m.unreadCount({ to: 'codex' }), 2)
  m.acknowledge({ from: 'codex', upTo: second.seq })
  assert.equal(m.unreadCount({ to: 'codex' }), 0)
})

test('priority is preserved and filterable', (t) => {
  const m = box(t)
  m.send({ from: 'claude', to: 'codex', text: 'fyi' })
  m.send({ from: 'claude', to: 'codex', text: 'harness is down', priority: 'urgent' })
  assert.equal(m.read({ priority: 'urgent' }).messages.length, 1)
})

test('search finds an earlier decision by its text', (t) => {
  // Absent from every plugin surveyed; it is the difference between a log and
  // a memory.
  const m = box(t)
  m.send({ from: 'claude', to: 'codex', text: 'the undici ceiling was 300s' })
  m.send({ from: 'claude', to: 'codex', text: 'unrelated' })
  assert.equal(m.search('undici').length, 1)
  assert.equal(m.search('UNDICI').length, 1, 'search is case-insensitive')
  assert.deepEqual(m.search('   '), [], 'an empty needle matches nothing, not everything')
})

test('a withdrawn message is not findable by search', (t) => {
  const m = box(t)
  const first = m.send({ from: 'claude', to: 'codex', text: 'mistaken claim about undici' })
  m.withdraw({ from: 'claude', seq: first.seq })
  assert.equal(m.search('undici').length, 0)
})

test('participants list who has spoken, most recent first', (t) => {
  const m = box(t)
  m.send({ from: 'claude', to: 'codex', text: 'hi' })
  assert.deepEqual(m.participants().map((p) => p.name).sort(), ['claude', 'codex'])
  assert.ok(m.participants()[0].lastSeenAt > 0)
})

test('a broadcast addressee is not listed as a participant', (t) => {
  const m = box(t)
  m.send({ from: 'claude', to: '*', text: 'hello all' })
  assert.deepEqual(m.participants().map((p) => p.name), ['claude'])
})

test('a secret is redacted before it is stored', (t) => {
  // An append-only log cannot be edited later to remove a leaked key.
  const m = box(t)
  const sent = m.send({ from: 'claude', to: 'codex', text: 'auth used sk-abcdef0123456789abcdef0123456789' })
  assert.doesNotMatch(sent.text, /abcdef0123456789/)
  assert.match(sent.text, /REDACTED/)
})

test('a secret is redacted in an edit too', (t) => {
  const m = box(t)
  const first = m.send({ from: 'claude', to: 'codex', text: 'clean' })
  const edited = m.edit({ from: 'claude', seq: first.seq, text: 'oops sk-abcdef0123456789abcdef0123456789' })
  assert.doesNotMatch(edited.text, /abcdef0123456789/)
})

test('an oversized message is bounded and says so', (t) => {
  const m = box(t)
  const sent = m.send({ from: 'claude', to: 'codex', text: 'x'.repeat(40000) })
  assert.ok(sent.text.length < 40000)
  assert.match(sent.text, /truncated/i)
})

test('identities are validated, so a name cannot smuggle structure', (t) => {
  const m = box(t)
  for (const bad of ['', '   ', 'a\nb', 'a\tb', 'x'.repeat(200)]) {
    assert.throws(() => m.send({ from: bad, to: 'codex', text: 'hi' }), /identity/i)
    assert.throws(() => m.send({ from: 'claude', to: bad, text: 'hi' }), /identity/i)
  }
})

test('an empty message is refused', (t) => {
  const m = box(t)
  assert.throws(() => m.send({ from: 'claude', to: 'codex', text: '  ' }), /text/i)
})

test('a corrupt line does not make the conversation unreadable', (t) => {
  const file = join(tempDir(t), 'mail.jsonl')
  const m = createMailbox({ file })
  m.send({ from: 'claude', to: 'codex', text: 'before' })
  appendFileSync(file, 'this is not json\n', 'utf8')
  m.send({ from: 'claude', to: 'codex', text: 'after' })
  assert.equal(createMailbox({ file }).read({}).messages.length, 2)
})

test('a read that hits the limit says how much it left', (t) => {
  const m = box(t)
  for (let i = 0; i < 5; i += 1) m.send({ from: 'claude', to: 'codex', text: `m${i}` })
  const page = m.read({ to: 'codex', limit: 2 })
  assert.equal(page.messages.length, 2)
  assert.equal(page.more, 3)
})

test('editing a message that does not exist is refused', (t) => {
  const m = box(t)
  assert.throws(() => m.edit({ from: 'claude', seq: 999, text: 'x' }), /no message/i)
})

test('presence announces a peer and reports it live', (t) => {
  const dir = tempDir(t)
  let clock = 5000
  const p = createPresence({ dir, now: () => clock })
  p.announce('claude', { role: 'mcp-client' })
  const [peer] = p.list()
  assert.equal(peer.name, 'claude')
  assert.equal(peer.role, 'mcp-client')
  assert.equal(peer.live, true)
})

test('a peer that stopped beating is reported stale, not hidden', (t) => {
  // "Was here, went quiet" is information. Dropping it silently looks exactly
  // like a peer that never existed.
  const dir = tempDir(t)
  let clock = 5000
  const p = createPresence({ dir, now: () => clock, staleAfterMs: 1000 })
  p.announce('codex')
  clock = 999_000
  const [peer] = p.list()
  assert.equal(peer.name, 'codex')
  assert.equal(peer.live, false)
})

test('a foreign file in the presence directory is ignored', (t) => {
  const dir = tempDir(t)
  const p = createPresence({ dir })
  p.announce('claude')
  writeFileSync(join(dir, 'notes.txt'), 'not a peer', 'utf8')
  writeFileSync(join(dir, 'broken.json'), '{ half written', 'utf8')
  assert.deepEqual(p.list().map((x) => x.name), ['claude'])
})

test('presence rejects an invalid identity', (t) => {
  assert.throws(() => createPresence({ dir: tempDir(t) }).announce('a\nb'), /identity/i)
})
