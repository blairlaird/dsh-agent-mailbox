/**
 * Bearer tokens that bind a caller to an identity.
 *
 * Without this, `from` is whatever the caller claims, and any process that can
 * reach the port can post as anyone. That is tolerable on loopback where the
 * OS already decides who may connect; it is not tolerable the moment the
 * server is reachable from another machine, so cross-machine listening is
 * refused unless tokens are configured.
 *
 * WHAT THIS IS NOT: a user-authentication system. It authenticates AGENTS to
 * a mailbox on a network the operator already trusts. There is no recovery
 * flow, no rotation ceremony, no roles — a token proves "I am this
 * participant" and nothing more.
 *
 * Tokens are stored HASHED. A stolen token file is then useless on its own,
 * and the plaintext exists only in the operator's configuration.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Long enough that guessing is hopeless; short enough to paste. */
const TOKEN_BYTES = 32

export function issueToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

export function hashToken(token) {
  return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex')
}

/**
 * Compare without leaking length or position through timing.
 *
 * A plain `===` on a secret is a timing oracle. It almost never matters in
 * practice and costs nothing to avoid, so there is no reason to accept it.
 */
function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * @param participants - `{ name: tokenHash }`. Hashes, never plaintext.
 * @param required - when false, every request is accepted as its claimed
 *   identity. Only ever appropriate on loopback.
 */
export function createAuth({ participants = {}, required = false } = {}) {
  return {
    get required() { return required },

    /** @returns the participant names this mailbox will accept. */
    known() { return Object.keys(participants) },

    /**
     * Resolve a request to an identity.
     *
     * @param claimed - the `from` the caller asserts.
     * @param token - bearer token, if any.
     * @returns `{ ok: true, identity }` or `{ ok: false, reason }`.
     *
     * A token that resolves to a DIFFERENT participant than the one claimed is
     * rejected rather than silently rewritten: sending as someone else is
     * exactly the attack this exists to stop, and quietly correcting it would
     * hide an attempt.
     */
    authenticate({ claimed, token } = {}) {
      // With auth off there is nothing to prove, and a read-only tool has no
      // identity to claim. Requiring one here would refuse mailbox_search and
      // mailbox_peers, which need no identity at all -- whether a name is
      // REQUIRED is the mailbox's rule, not authentication's.
      if (!required) return { ok: true, identity: claimed === undefined ? undefined : String(claimed) }
      if (token === undefined || token === '') return { ok: false, reason: 'a bearer token is required' }

      const digest = hashToken(token)
      const match = Object.entries(participants).find(([, stored]) => sameSecret(stored, digest))
      if (match === undefined) return { ok: false, reason: 'unknown token' }

      const [identity] = match
      if (claimed !== undefined && claimed !== '' && claimed !== identity) {
        return { ok: false, reason: `token belongs to "${identity}", not "${claimed}"` }
      }
      return { ok: true, identity }
    }
  }
}

/**
 * May this server listen on the given address?
 *
 * Loopback is always allowed: the OS already decides who can connect. Any
 * other address exposes the mailbox to the network, so it is refused unless
 * tokens are configured — an unauthenticated mailbox on a LAN is an open
 * relay for anything that can reach the port.
 */
export function assertBindAllowed(host, auth) {
  const loopback = new Set(['127.0.0.1', '::1', 'localhost'])
  if (loopback.has(host)) return
  if (!auth?.required) {
    throw new Error(
      `dsh-agent-mailbox: refusing to bind "${host}" without authentication. ` +
      'Listening beyond loopback exposes the mailbox to every host that can reach the port; ' +
      'configure participant tokens first, or bind 127.0.0.1.'
    )
  }
}
