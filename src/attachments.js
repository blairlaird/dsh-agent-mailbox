/**
 * Content-addressed attachments.
 *
 * A message often needs to carry a diff, a log tail, or a transcript that is
 * too large to paste. Two designs were rejected before this one:
 *
 *   by PATH — the message names a file the reader opens. This makes any
 *   message an arbitrary-file-read request against the reader's machine, so a
 *   peer could ask for ~/.ssh/id_rsa and be handed it. Refused outright.
 *
 *   inline in the message — an unbounded blob in an append-only log, which
 *   makes the conversation unreadable and unbounded in size.
 *
 * So: the SENDER supplies bytes, this module writes them once under a hash of
 * their content, and the message carries the hash. A reader fetches by hash,
 * never by path. Identical content stored twice costs one copy, and the hash
 * is also an integrity check — if the bytes change on disk, the id no longer
 * describes them.
 *
 * Nothing here executes, renders, or interprets an attachment. It is bytes in
 * and bytes out.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Per-attachment cap. Large enough for a transcript, small enough to keep. */
const MAX_BYTES = 4 * 1024 * 1024

/**
 * Names are for humans; they never touch the filesystem.
 *
 * The stored path is derived only from the content hash, so a name like
 * `../../etc/passwd` is just an odd label rather than a traversal.
 */
function safeName(name) {
  return String(name ?? 'attachment').replace(/[\r\n]/g, ' ').slice(0, 200)
}

/** Decode and validate, WITHOUT touching the disk. */
function describe({ content, name, mediaType } = {}) {
  const bytes = Buffer.isBuffer(content)
    ? content
    : Buffer.from(String(content ?? ''), 'base64')

  if (bytes.length === 0) throw new Error('attachments: content is required')
  if (bytes.length > MAX_BYTES) {
    // Refused rather than truncated: half a diff is worse than none, and
    // silently storing a partial file would corrupt what the reader gets.
    throw new Error(
      `attachments: ${bytes.length} bytes exceeds the ${MAX_BYTES}-byte limit; ` +
      'send a summary and a path the recipient can open themselves'
    )
  }

  return {
    bytes,
    meta: {
      id: createHash('sha256').update(bytes).digest('hex'),
      name: safeName(name),
      bytes: bytes.length,
      // Recorded as a label only. Nothing here acts on it, so a lie costs
      // the reader nothing but a wrong guess about how to display it.
      mediaType: String(mediaType ?? 'application/octet-stream').slice(0, 100)
    }
  }
}

export function createAttachmentStore({ dir } = {}) {
  return {
    /**
     * Identify and validate an attachment without storing it.
     *
     * Separated from `put` so a caller can learn the id -- and have oversize
     * refused -- BEFORE the message that references it is committed. Writing
     * first meant an invalid send still left its bytes on disk, so a peer
     * could fill the store with attachments belonging to messages that were
     * never accepted, and nothing referenced them afterwards to clean up.
     *
     * @returns `{ id, name, bytes, mediaType }` — the id is the content hash.
     */
    digest(attachment) {
      return describe(attachment).meta
    },

    /**
     * @param content - a Buffer, or a base64 string from an MCP caller.
     * @returns `{ id, name, bytes, mediaType }` — the id is the content hash.
     */
    put(attachment) {
      const { bytes, meta } = describe(attachment)
      if (dir !== undefined) {
        mkdirSync(dir, { recursive: true })
        const target = join(dir, meta.id)
        if (!existsSync(target)) {
          // Temp+rename so a reader never sees a partially written blob, and
          // so two senders storing the same bytes cannot collide mid-write.
          const temp = `${target}.${process.pid}.tmp`
          writeFileSync(temp, bytes)
          renameSync(temp, target)
        }
      }
      return meta
    },

    /**
     * @param id - a content hash from `put`.
     * @returns the bytes, base64-encoded for transport.
     *
     * The id is validated as a hash BEFORE it touches a path: that single
     * check is what keeps this a content store rather than a file-read
     * primitive for anyone who can send a message.
     */
    get(id) {
      const key = String(id ?? '')
      if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('attachments: id must be a sha256 hex digest')
      if (dir === undefined) throw new Error('attachments: no store configured')
      const path = join(dir, key)
      if (!existsSync(path)) throw new Error(`attachments: no attachment ${key}`)
      return readFileSync(path).toString('base64')
    }
  }
}
