/**
 * The four capabilities the mailbox core does not cover: auth, attachments,
 * wake/notify, and the bind rule that makes cross-machine listening safe.
 *
 * Each one is a place where a convenient design would have been a hole, so
 * the tests assert the refusal as much as the feature.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAuth, issueToken, hashToken, assertBindAllowed } from '../src/auth.js'
import { createAttachmentStore } from '../src/attachments.js'
import { createNotifier } from '../src/notify.js'
import { createMailbox } from '../src/mailbox.js'

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-cap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------- auth

test('with auth off, a caller is whoever it claims to be', () => {
  // Acceptable on loopback, where the OS already decides who may connect.
  const auth = createAuth({ required: false })
  assert.deepEqual(auth.authenticate({ claimed: 'claude' }), { ok: true, identity: 'claude' })
})

test('with auth off, an unnamed caller is allowed through to the mailbox', () => {
  // Authentication proves WHO, it does not decide whether a name is required.
  // Enforcing one here refused mailbox_search and mailbox_peers, which need
  // no identity at all; the mailbox rejects an empty `from` on its own.
  const result = createAuth({ required: false }).authenticate({})
  assert.equal(result.ok, true)
  assert.equal(result.identity, undefined)
})

test('a valid token resolves to its participant', () => {
  const token = issueToken()
  const auth = createAuth({ required: true, participants: { codex: hashToken(token) } })
  assert.deepEqual(auth.authenticate({ claimed: 'codex', token }), { ok: true, identity: 'codex' })
})

test('a token may name its own identity', () => {
  const token = issueToken()
  const auth = createAuth({ required: true, participants: { codex: hashToken(token) } })
  assert.equal(auth.authenticate({ token }).identity, 'codex')
})

test('a missing token is refused when auth is required', () => {
  const auth = createAuth({ required: true, participants: { codex: hashToken(issueToken()) } })
  const result = auth.authenticate({ claimed: 'codex' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /token/i)
})

test('an unknown token is refused', () => {
  const auth = createAuth({ required: true, participants: { codex: hashToken(issueToken()) } })
  assert.equal(auth.authenticate({ claimed: 'codex', token: issueToken() }).ok, false)
})

test('sending as someone else is refused, not silently corrected', () => {
  // Quietly rewriting `from` would hide an impersonation attempt.
  const token = issueToken()
  const auth = createAuth({ required: true, participants: { codex: hashToken(token) } })
  const result = auth.authenticate({ claimed: 'claude', token })
  assert.equal(result.ok, false)
  assert.match(result.reason, /belongs to "codex"/)
})

test('tokens are stored hashed, never in plaintext', () => {
  const token = issueToken()
  const digest = hashToken(token)
  assert.notEqual(digest, token)
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.equal(hashToken(token), digest, 'hashing is deterministic')
})

test('issued tokens are unique and long', () => {
  const a = issueToken()
  const b = issueToken()
  assert.notEqual(a, b)
  assert.ok(a.length >= 40, 'a guessable token is not a token')
})

// ------------------------------------------------------------- bind rule

test('loopback may always be bound', () => {
  assert.doesNotThrow(() => assertBindAllowed('127.0.0.1', createAuth({ required: false })))
  assert.doesNotThrow(() => assertBindAllowed('::1', createAuth({ required: false })))
})

test('a LAN address without auth is refused', () => {
  // An unauthenticated mailbox on a LAN is an open relay for anything that
  // can reach the port.
  assert.throws(() => assertBindAllowed('0.0.0.0', createAuth({ required: false })), /without authentication/i)
})

test('a LAN address with auth configured is allowed', () => {
  const auth = createAuth({ required: true, participants: { codex: hashToken(issueToken()) } })
  assert.doesNotThrow(() => assertBindAllowed('0.0.0.0', auth))
})

// ---------------------------------------------------------- attachments

test('an attachment is stored under the hash of its content', (t) => {
  const store = createAttachmentStore({ dir: tempDir(t) })
  const put = store.put({ content: Buffer.from('diff --git a/x b/x'), name: 'patch.diff', mediaType: 'text/plain' })
  assert.match(put.id, /^[0-9a-f]{64}$/)
  assert.equal(put.name, 'patch.diff')
  assert.equal(store.get(put.id), Buffer.from('diff --git a/x b/x').toString('base64'))
})

test('identical content stores once', (t) => {
  const store = createAttachmentStore({ dir: tempDir(t) })
  const a = store.put({ content: Buffer.from('same') })
  const b = store.put({ content: Buffer.from('same') })
  assert.equal(a.id, b.id)
})

test('base64 content from an MCP caller is accepted', (t) => {
  const store = createAttachmentStore({ dir: tempDir(t) })
  const put = store.put({ content: Buffer.from('hello').toString('base64') })
  assert.equal(Buffer.from(store.get(put.id), 'base64').toString(), 'hello')
})

test('a non-hash id cannot be used to read a file', (t) => {
  // This single check is what keeps the store from being an arbitrary-file
  // read primitive for anyone who can send a message.
  const store = createAttachmentStore({ dir: tempDir(t) })
  for (const evil of ['../../etc/passwd', 'C:\\Windows\\win.ini', 'notahash', '']) {
    assert.throws(() => store.get(evil), /sha256/i)
  }
})

test('an oversized attachment is refused rather than truncated', (t) => {
  // Half a diff is worse than none.
  const store = createAttachmentStore({ dir: tempDir(t) })
  assert.throws(() => store.put({ content: Buffer.alloc(5 * 1024 * 1024) }), /exceeds/i)
})

test('empty content is refused', (t) => {
  assert.throws(() => createAttachmentStore({ dir: tempDir(t) }).put({ content: '' }), /required/i)
})

test('a traversal in the NAME is only an odd label', (t) => {
  // The stored path derives from the hash alone, so the name never reaches
  // the filesystem.
  const store = createAttachmentStore({ dir: tempDir(t) })
  const put = store.put({ content: Buffer.from('x'), name: '../../etc/passwd' })
  assert.match(put.id, /^[0-9a-f]{64}$/)
  assert.doesNotMatch(put.id, /\.\./)
})

test('reading an unknown attachment is an explicit error', (t) => {
  const store = createAttachmentStore({ dir: tempDir(t) })
  assert.throws(() => store.get('a'.repeat(64)), /no attachment/i)
})

// -------------------------------------------------------------- wake up

test('a waiter resolves immediately when a message is already there', async (t) => {
  const file = join(tempDir(t), 'mail.jsonl')
  const mailbox = createMailbox({ file })
  mailbox.send({ from: 'codex', to: 'claude', text: 'already waiting' })
  const notifier = createNotifier({ file, mailbox })
  t.after(() => notifier.close())
  const got = await notifier.waitFor({ to: 'claude', holdMs: 5000 })
  assert.equal(got.messages.length, 1)
})

test('a waiter wakes when a message arrives while it is parked', async (t) => {
  const file = join(tempDir(t), 'mail.jsonl')
  const mailbox = createMailbox({ file })
  const notifier = createNotifier({ file, mailbox })
  t.after(() => notifier.close())

  const waiting = notifier.waitFor({ to: 'claude', holdMs: 8000 })
  setTimeout(() => mailbox.send({ from: 'codex', to: 'claude', text: 'wake up' }), 30)
  const got = await waiting
  assert.equal(got.messages.length, 1)
  assert.match(got.messages[0].text, /wake up/)
})

test('a waiter ignores a message addressed to someone else', async (t) => {
  const file = join(tempDir(t), 'mail.jsonl')
  const mailbox = createMailbox({ file })
  const notifier = createNotifier({ file, mailbox })
  t.after(() => notifier.close())

  const waiting = notifier.waitFor({ to: 'claude', holdMs: 400 })
  setTimeout(() => mailbox.send({ from: 'codex', to: 'someone-else', text: 'not for you' }), 20)
  const got = await waiting
  assert.equal(got.messages.length, 0)
  assert.equal(got.waited, true, 'the hold expired rather than delivering the wrong message')
})

test('an expired hold answers empty and changes nothing', async (t) => {
  // The transport bound must be indistinguishable from never having asked:
  // no message consumed, no cursor moved.
  const file = join(tempDir(t), 'mail.jsonl')
  const mailbox = createMailbox({ file })
  const notifier = createNotifier({ file, mailbox })
  t.after(() => notifier.close())

  const got = await notifier.waitFor({ to: 'claude', holdMs: 120 })
  assert.deepEqual(got.messages, [])
  mailbox.send({ from: 'codex', to: 'claude', text: 'after the hold' })
  assert.equal(mailbox.read({ to: 'claude' }).messages.length, 1, 'nothing was lost by waiting')
})

test('a waiter picks up only what is after its cursor', async (t) => {
  const file = join(tempDir(t), 'mail.jsonl')
  const mailbox = createMailbox({ file })
  const first = mailbox.send({ from: 'codex', to: 'claude', text: 'old news' })
  const notifier = createNotifier({ file, mailbox })
  t.after(() => notifier.close())

  const waiting = notifier.waitFor({ to: 'claude', since: first.seq, holdMs: 6000 })
  setTimeout(() => mailbox.send({ from: 'codex', to: 'claude', text: 'fresh' }), 30)
  const got = await waiting
  assert.equal(got.messages.length, 1)
  assert.match(got.messages[0].text, /fresh/)
})

test('closing the notifier leaves no watcher behind', (t) => {
  const file = join(tempDir(t), 'mail.jsonl')
  const notifier = createNotifier({ file, mailbox: createMailbox({ file }) })
  notifier.close()
  assert.doesNotThrow(() => notifier.close(), 'close is idempotent')
})

test('a foreign file in the mailbox directory does not confuse a waiter', async (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'mail.jsonl')
  const mailbox = createMailbox({ file })
  const notifier = createNotifier({ file, mailbox })
  t.after(() => notifier.close())

  const waiting = notifier.waitFor({ to: 'claude', holdMs: 300 })
  setTimeout(() => writeFileSync(join(dir, 'unrelated.txt'), 'noise', 'utf8'), 20)
  assert.deepEqual((await waiting).messages, [], 'unrelated writes must not look like mail')
})
