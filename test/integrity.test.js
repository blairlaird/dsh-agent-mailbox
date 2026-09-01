/**
 * Idempotency, signing, and retention.
 *
 * Three gaps found by taxonomy rather than by use — the kind you only notice
 * by listing what a messaging system CAN have and checking each one off,
 * which is exactly how they were found here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { fingerprintSend, signMessage, verifyMessage, planRetention } from '../src/integrity.js'

// ------------------------------------------------------------ idempotency

test('the same send fingerprints identically', () => {
  const args = { from: 'a', to: 'b', text: 'hello', thread: 't' }
  assert.equal(fingerprintSend(args), fingerprintSend({ ...args }))
})

test('argument order does not change the fingerprint', () => {
  // A client that re-serialises its own request must not lose deduplication
  // over an ordering it never chose.
  assert.equal(
    fingerprintSend({ from: 'a', to: 'b', text: 'x' }),
    fingerprintSend({ text: 'x', to: 'b', from: 'a' })
  )
})

test('different text fingerprints differently', () => {
  assert.notEqual(
    fingerprintSend({ from: 'a', to: 'b', text: 'one' }),
    fingerprintSend({ from: 'a', to: 'b', text: 'two' })
  )
})

test('fields that do not change meaning are excluded', () => {
  // An idempotency key must not be part of what it identifies, or every retry
  // looks like different arguments and is refused -- the opposite of the point.
  assert.equal(
    fingerprintSend({ from: 'a', to: 'b', text: 'x', idempotencyKey: 'k1' }),
    fingerprintSend({ from: 'a', to: 'b', text: 'x', idempotencyKey: 'k2' })
  )
})

test('a missing field and an explicit null fingerprint the same', () => {
  assert.equal(
    fingerprintSend({ from: 'a', to: 'b', text: 'x' }),
    fingerprintSend({ from: 'a', to: 'b', text: 'x', thread: undefined })
  )
})

// ---------------------------------------------------------------- signing

const message = { seq: 4, at: 1000, from: 'codex', to: 'claude', text: 'verified' }

test('a signed message verifies', () => {
  const sig = signMessage('secret', message)
  assert.equal(verifyMessage('secret', { ...message, sig }), true)
})

test('an altered body fails verification', () => {
  // The point of signing an append-only log: anyone who can write the file
  // can edit a line, and this is what makes that visible.
  const sig = signMessage('secret', message)
  assert.equal(verifyMessage('secret', { ...message, text: 'tampered', sig }), false)
})

test('an altered sender fails verification', () => {
  const sig = signMessage('secret', message)
  assert.equal(verifyMessage('secret', { ...message, from: 'impostor', sig }), false)
})

test('an altered seq fails verification', () => {
  const sig = signMessage('secret', message)
  assert.equal(verifyMessage('secret', { ...message, seq: 99, sig }), false)
})

test('the wrong secret fails verification', () => {
  const sig = signMessage('secret', message)
  assert.equal(verifyMessage('other-secret', { ...message, sig }), false)
})

test('an UNSIGNED message is not verified', () => {
  // "No signature" must never read as "verified". That confusion is what makes
  // signing theatre rather than integrity.
  assert.equal(verifyMessage('secret', message), false)
  assert.equal(verifyMessage('secret', { ...message, sig: undefined }), false)
  assert.equal(verifyMessage('secret', { ...message, sig: '' }), false)
})

test('a truncated signature fails rather than throwing', () => {
  // timingSafeEqual throws on a length mismatch; a hostile record must not be
  // able to crash a reader.
  assert.doesNotThrow(() => verifyMessage('secret', { ...message, sig: 'abc' }))
  assert.equal(verifyMessage('secret', { ...message, sig: 'abc' }), false)
})

// -------------------------------------------------------------- retention

const logOf = (n) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, text: `m${i + 1}` }))

test('a log under the limit is untouched', () => {
  const { keep, dropped } = planRetention(logOf(5), { maxRecords: 10 })
  assert.equal(keep.length, 5)
  assert.deepEqual(dropped, [])
})

test('compaction drops the oldest first', () => {
  const { keep, dropped } = planRetention(logOf(10), { maxRecords: 6 })
  assert.equal(keep.length, 6)
  assert.deepEqual(dropped.map((r) => r.seq), [1, 2, 3, 4])
  assert.equal(keep[0].seq, 5, 'the survivors are the newest')
})

test('a cursor a reader still holds is never compacted away', () => {
  // Dropping a record below a live cursor turns "nothing new" into silent data
  // loss -- the worst possible failure in a system whose value is durability.
  const { keep, dropped } = planRetention(logOf(10), { maxRecords: 3, keepSince: 4 })
  assert.equal(dropped.every((r) => r.seq < 4), true)
  assert.equal(keep.some((r) => r.seq === 4), true)
})

test('a floor that protects everything drops nothing', () => {
  const { keep, dropped } = planRetention(logOf(10), { maxRecords: 2, keepSince: 1 })
  assert.equal(dropped.length, 0)
  assert.equal(keep.length, 10, 'retention never overrides a reader that has not caught up')
})

test('compaction reports what it removed', () => {
  // Silent deletion is the failure mode; the caller must be able to say so.
  const { dropped } = planRetention(logOf(8), { maxRecords: 5 })
  assert.equal(dropped.length, 3)
  assert.ok(dropped.every((r) => typeof r.seq === 'number'))
})

test('an empty log is handled', () => {
  const { keep, dropped } = planRetention([], { maxRecords: 5 })
  assert.deepEqual(keep, [])
  assert.deepEqual(dropped, [])
})
