/**
 * Idempotent sends, message signing, and retention.
 *
 * Three gaps found by taxonomy rather than by use — the kind you only notice
 * when you list what a messaging system CAN have and check each one off.
 *
 * IDEMPOTENCY. A client that loses its connection mid-send cannot tell whether
 * the message landed. Retrying risks saying the same thing twice; not retrying
 * risks never saying it. Neither is acceptable, so a key makes the retry safe.
 *
 * SIGNING. An append-only log is tamper-EVIDENT, not tamper-proof: anyone who
 * can write the file can edit a line. A signature over the message body means
 * an altered record fails verification instead of passing silently. This is
 * integrity, not secrecy — the log stays readable by design.
 *
 * RETENTION. A durable log grows without bound. Compaction drops the OLDEST
 * records only, never the recent ones, and reports what it removed. Silent
 * deletion in a system whose value is "nothing is lost" would be the worst
 * possible failure.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * A stable fingerprint of what a send actually says.
 *
 * Keys are sorted so a client that re-serialises its own request does not lose
 * deduplication over an ordering it never chose.
 */
export function fingerprintSend(args = {}) {
  const relevant = ['from', 'to', 'text', 'thread', 'replyTo', 'priority']
  return createHash('sha256')
    .update(JSON.stringify(relevant.map((k) => [k, args[k] ?? null])), 'utf8')
    .digest('hex')
}

/**
 * Sign a message body.
 *
 * HMAC rather than a public-key signature: every participant here already
 * shares a trust domain (one machine, or a token-authenticated LAN), so a
 * shared secret is the honest match. Public-key signing would imply
 * non-repudiation between mutually distrusting parties, which this does not
 * provide and should not claim.
 */
export function signMessage(secret, message) {
  return createHmac('sha256', String(secret))
    .update(JSON.stringify([
      message.seq, message.at, message.from, message.to, message.text
    ]), 'utf8')
    .digest('hex')
}

/**
 * @returns true when the signature matches the record as stored.
 *
 * An UNSIGNED message returns false rather than true: "no signature" must
 * never read as "verified", which is the failure mode that makes signing
 * theatre.
 */
export function verifyMessage(secret, message) {
  if (typeof message?.sig !== 'string') return false
  const expected = signMessage(secret, message)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(message.sig, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Which records to keep.
 *
 * @param records - the whole log, oldest first.
 * @param maxRecords - keep at most this many.
 * @param keepSince - never drop anything at or after this seq, whatever the
 *   count. A cursor a reader still holds must not be compacted out from under
 *   it: that would turn "nothing new" into silent data loss.
 * @returns `{ keep, dropped }`
 */
export function planRetention(records, { maxRecords = 10_000, keepSince = 0 } = {}) {
  if (records.length <= maxRecords) return { keep: records, dropped: [] }

  const overflow = records.length - maxRecords
  const dropped = []
  const keep = []
  for (const record of records) {
    const seq = record.seq ?? 0
    // `keepSince: 0` means NO floor. Testing `seq >= keepSince` alone made
    // every record protected — every seq is >= 0 — so compaction silently did
    // nothing while appearing to work. A default that disables the feature it
    // guards is worse than no default.
    const protectedByReader = keepSince > 0 && seq >= keepSince
    if (dropped.length >= overflow || protectedByReader) keep.push(record)
    else dropped.push(record)
  }
  return { keep, dropped }
}
