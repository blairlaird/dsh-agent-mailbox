/**
 * A durable, local-only mailbox so agents that cannot see each other can talk.
 *
 * WHY THIS EXISTS
 *
 * An audit of 23 DSH messaging plugins found every one of them assumes the
 * participants are DSH sessions. Two agents driving the harness from outside —
 * an MCP client each — have no way to address one another, so a human ends up
 * relaying every message by hand. Three capabilities were absent or nearly so
 * across the whole ecosystem: search (0 of 23), delivery receipts (2 of 23),
 * and redaction of secrets (1 of 23).
 *
 * Design credit: the heartbeat registry, atomic temp+rename writes, and the
 * idea of stating a trust boundary in the system prompt are taken from
 * dsh-crosstalk (MIT, Jesse-njx). This is an independent implementation, not
 * a fork — it carries no dependency and needs no build step, so it installs
 * anywhere.
 *
 * APPEND-ONLY, EVERYWHERE
 *
 * An edit supersedes, a withdrawal tombstones, a receipt is its own record.
 * A participant therefore cannot rewrite what they said after the fact, which
 * is what makes this log usable as evidence of what was actually agreed. It
 * also means a crash mid-write costs the last line rather than the history,
 * and a human can read the file without this code.
 *
 * SECURITY POSTURE
 *   - no network of any kind, and no dynamic code evaluation
 *   - redaction on INGEST: an append-only log cannot be edited afterwards to
 *     remove a key someone pasted into it
 *   - atomic writes, so a reader never observes a half-written record
 *   - bounded message and identity sizes
 *   - identities validated, so a name cannot smuggle newlines or structure
 *   - message CONTENT is data written by another agent. It is never an
 *     instruction; the tool descriptions say so to the model that reads it.
 */
import { appendFileSync, readFileSync, readdirSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { redactDiagnostic } from './redact.js'
import { fingerprintSend, signMessage, verifyMessage, planRetention } from './integrity.js'

/** Bounds. Generous enough for a real handoff, small enough to keep forever. */
const MAX_TEXT = 16000
const MAX_NAME = 64

const KIND = {
  MESSAGE: 'message',
  EDIT: 'edit',
  WITHDRAW: 'withdraw',
  REACTION: 'reaction',
  RECEIPT: 'receipt',
  COMPACTION: 'compaction'
}

/**
 * The broadcast address. Reserved, never a participant.
 *
 * Found by adversarial review: nothing stopped an agent announcing itself as
 * `*`. Such a participant would read as a wildcard everywhere it was printed
 * and would appear to be the sender of every broadcast.
 */
const BROADCAST = '*'

/**
 * Every C0 control character plus DEL, built from codes so the pattern cannot
 * be mangled by an editor or a tool that rewrites literal control bytes.
 */
const CONTROL_CHARS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) +
  String.fromCharCode(127) + ']')

/**
 * A participant name must be one clean line.
 *
 * Every C0 control character is refused, not just the obvious three. A tab or
 * newline would break the one-record-per-line shape of the log; the rest
 * (backspace, escape, carriage return) corrupt any terminal that prints them,
 * which is where these names are usually read.
 */
function identity(value, field, { allowBroadcast = false } = {}) {
  const name = String(value ?? '').trim()
  if (name === BROADCAST) {
    if (allowBroadcast) return name
    throw new Error(`mailbox: "${BROADCAST}" is the reserved broadcast address and cannot be a participant`)
  }
  if (name === '' || name.length > MAX_NAME || CONTROL_CHARS.test(name)) {
    throw new Error(
      `mailbox: \`${field}\` must be a non-empty single-line identity of at most ${MAX_NAME} characters, ` +
      'with no control characters'
    )
  }
  return name
}

/**
 * Every C0 control character EXCEPT tab and newline, plus DEL.
 *
 * Identities were validated from the start; message bodies were not, and they
 * are printed straight into a terminal by `/mailbox`. A peer that can write
 * an escape sequence into a message can move the reader's cursor, repaint
 * lines the operator already read, or hide text behind a carriage return —
 * forging the transcript of a conversation the operator is supervising.
 *
 * Tab and newline survive because a message is prose and a diff, and both
 * need them. Everything else has no meaning in a message and one use in an
 * attack.
 */
const CONTROL_IN_TEXT = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(8) +
  String.fromCharCode(11) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g')

/** Labels are one token: no whitespace of any kind is meaningful in them. */
const CONTROL_IN_LABEL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) +
  String.fromCharCode(127) + ']', 'g')

/** Thread keys are labels, not payloads; an unbounded one is free storage. */
function boundedKey(value) {
  return String(value).replace(CONTROL_IN_LABEL, '').slice(0, 200)
}

/** Priority is printed in a terminal too, and is a label, not prose. */
function boundedLabel(value, max) {
  return String(value).replace(CONTROL_IN_LABEL, '').slice(0, max)
}

function bounded(text) {
  const body = String(text ?? '').replace(CONTROL_IN_TEXT, '')
  // Says it was cut: silent truncation reads as the whole message.
  return body.length > MAX_TEXT
    ? `${body.slice(0, MAX_TEXT)}\n… [truncated, ${body.length - MAX_TEXT} more characters]`
    : body
}

/** `@name` mentions, so a reader can filter to what actually needs them. */
function mentionsIn(text) {
  return [...new Set([...String(text).matchAll(/@([A-Za-z0-9_-]{1,64})/g)].map((m) => m[1]))]
}

/**
 * @param file - the append-only log. Omit for an in-memory box (tests).
 * @param now - injected clock.
 */
export function createMailbox({ file, now = Date.now, signingSecret, maxRecords } = {}) {
  function records() {
    if (file === undefined || !existsSync(file)) return []
    const out = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      // A corrupt line is skipped, never fatal. One bad append must not make
      // the entire conversation unreadable.
      try { out.push(JSON.parse(line)) } catch { /* skip */ }
    }
    return out
  }

  function append(record) {
    const all = records()
    const seq = all.reduce((high, r) => Math.max(high, r.seq ?? 0), 0) + 1
    const base = { seq, at: now(), ...record }
    // SIGNING. An append-only log is tamper-EVIDENT, not tamper-proof: anyone
    // who can write the file can edit a line. A signature makes an altered
    // record fail verification instead of passing silently. Integrity, not
    // secrecy -- the log stays readable by design.
    //
    // EVERY KIND is signed, not only `message`. Signing messages alone left
    // edit and withdraw -- the two records that change what a message says --
    // unprotected, so the log could be rewritten without breaking a single
    // signature.
    const stored = signingSecret === undefined
      ? base
      : { ...base, sig: signMessage(signingSecret, base) }
    if (file !== undefined) {
      mkdirSync(dirname(file), { recursive: true })
      // Append is atomic enough for a single line on every platform we target;
      // the temp+rename dance is reserved for whole-file rewrites, which is
      // what compaction below does.
      appendFileSync(file, `${JSON.stringify(stored)}\n`, 'utf8')
      // Guarded on the count we ALREADY have. compact() re-reads the whole
      // log just to decide whether it needs to do anything, so calling it
      // unconditionally would double the read cost of every single send in
      // order to answer "no" almost every time.
      if (maxRecords !== undefined && all.length + 1 > maxRecords) compact()
    }
    return stored
  }

  /**
   * Drop the OLDEST records once the log exceeds `maxRecords`.
   *
   * `maxRecords` was accepted and never used, and `planRetention` was written,
   * tested, and never called -- so the README's "retention / compaction" was a
   * claim about code that did not run. A durable log that only grows is a disk
   * exhaustion bug with a good excuse.
   *
   * WHAT IS NEVER DROPPED: anything at or after the least-advanced
   * ACKNOWLEDGED reader. A cursor someone still holds must not be compacted
   * out from under them, because "nothing new" and "it is gone" would become
   * the same answer. A participant that never acknowledges is not protected --
   * which is the honest consequence of never saying how far you have read,
   * and the reason mailbox_acknowledge exists.
   *
   * The compaction is ITSELF A RECORD. Silent deletion in a log whose whole
   * value is "nothing is lost" would be the worst possible failure, so the
   * rewritten file opens by saying what it dropped and through which seq.
   */
  function compact() {
    if (file === undefined || maxRecords === undefined) return { dropped: 0 }
    const all = records()
    if (all.length <= maxRecords) return { dropped: 0 }

    const acknowledged = all.filter((r) => r.kind === KIND.RECEIPT).map((r) => Number(r.upTo) || 0)
    const keepSince = acknowledged.length === 0 ? 0 : Math.min(...acknowledged) + 1

    const { keep, dropped } = planRetention(all, { maxRecords, keepSince })
    if (dropped.length === 0) return { dropped: 0 }

    const note = {
      seq: 0,
      at: now(),
      kind: KIND.COMPACTION,
      dropped: dropped.length,
      through: dropped.reduce((high, r) => Math.max(high, r.seq ?? 0), 0)
    }
    // Whole-file rewrite, so temp+rename: a reader must see either the old
    // log or the new one, never a half-written file with the history gone.
    const temp = `${file}.${process.pid}.compact`
    writeFileSync(temp, `${[note, ...keep].map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    renameSync(temp, file)
    return { dropped: dropped.length, through: note.through }
  }

  function messageAt(all, seq) {
    const found = all.find((r) => r.seq === seq && r.kind === KIND.MESSAGE)
    if (found === undefined) throw new Error(`mailbox: no message with seq ${seq}`)
    return found
  }

  function requireAuthor(all, seq, from) {
    const target = messageAt(all, seq)
    if (target.from !== from) {
      throw new Error(`mailbox: only the author (${target.from}) may modify message ${seq}`)
    }
    return target
  }

  /**
   * Fold edits, withdrawals and reactions onto their targets.
   *
   * The raw log keeps every record; this is the CURRENT view. Both are
   * available, because "what is true now" and "what was said" are different
   * questions and this log can answer each of them honestly.
   */
  function current(all) {
    const bySeq = new Map()
    // Authorship is captured from the ORIGINAL message and never re-read from
    // the folded copy, so an edit cannot launder itself into authorship of
    // the next edit.
    const authorOf = new Map()
    for (const r of all) {
      if (r.kind !== KIND.MESSAGE) continue
      bySeq.set(r.seq, { ...r })
      authorOf.set(r.seq, r.from)
    }

    // Authorship is checked AGAIN here, at the fold, not only in edit() and
    // withdraw() at write time. Those guard this process; the fold guards the
    // FILE. Anything that can append a line -- another process, a stale
    // handle, a peer that got hold of the path -- could otherwise write
    // `{kind:"withdraw", withdraws: 12}` and erase someone else's message
    // from every reader's view, with the write-time check never consulted.
    // Two checks because they defend against two different things.
    const byAuthor = (r, target) => target !== undefined && r.from === authorOf.get(target)

    for (const r of all) {
      if (r.kind === KIND.EDIT && bySeq.has(r.edits) && byAuthor(r, r.edits)) {
        bySeq.set(r.edits, { ...bySeq.get(r.edits), text: r.text, editedFrom: r.edits, editedAt: r.at })
      }
      if (r.kind === KIND.WITHDRAW && byAuthor(r, r.withdraws)) bySeq.delete(r.withdraws)
      if (r.kind === KIND.REACTION && bySeq.has(r.reactsTo)) {
        const target = bySeq.get(r.reactsTo)
        bySeq.set(r.reactsTo, {
          ...target,
          reactions: [...target.reactions ?? [], { from: r.from, emoji: r.emoji }]
        })
      }
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  }

  const api = {
    /**
     * @param replyTo - seq being answered; also sets the thread when none is
     *   given, so a reply threads without ceremony.
     * @param priority - free-form, e.g. `urgent`.
     */
    send({ from, to, text, thread, replyTo, priority, idempotencyKey, attachments } = {}) {
      const author = identity(from, 'from')
      const addressee = identity(to, 'to', { allowBroadcast: true })
      if (String(text ?? '').trim() === '') throw new Error('mailbox: `text` is required')

      // Redacted on the way IN. An append-only log cannot be edited later to
      // remove a key that was pasted into it.
      const body = redactDiagnostic(bounded(text))

      // IDEMPOTENCY. A client that loses its connection mid-send cannot tell
      // whether the message landed. Retrying risks saying the same thing
      // twice; not retrying risks never saying it. A key makes the retry safe.
      //
      // The key is matched together with a fingerprint of the arguments, so
      // reusing a key for DIFFERENT content is refused rather than answered
      // with the earlier message -- returning the wrong message under a key
      // the caller believes identifies this one is a wrong answer shaped
      // exactly like a right one.
      // The key is NORMALISED ONCE and the same value is used to look up and
      // to store. Comparing the raw argument against a stored, truncated copy
      // meant a key longer than the bound could never match its own retry --
      // idempotency that silently stopped working at exactly the length where
      // a client is most likely to be generating keys programmatically.
      const key = idempotencyKey === undefined ? undefined : boundedKey(idempotencyKey)
      const fingerprint = key === undefined
        ? undefined
        : fingerprintSend({ from: author, to: addressee, text: body, thread, replyTo, priority })
      if (key !== undefined) {
        // Scoped to the AUTHOR. One global namespace let any participant burn
        // a key first and turn another agent's send into a refusal -- a
        // denial of service that needs no privileges and leaves the victim
        // seeing a validation error about content they never wrote.
        const seen = records().find((r) => r.idem === key && r.from === author)
        if (seen !== undefined) {
          if (seen.fp !== fingerprint) {
            throw new Error(
              `mailbox: idempotencyKey ${JSON.stringify(idempotencyKey)} was already used for different ` +
              `content (message ${seen.seq}). Use a new key, or resend the identical message.`
            )
          }
          return { ...seen, deduplicated: true }
        }
      }

      return append({
        kind: KIND.MESSAGE,
        from: author,
        to: addressee,
        ...thread !== undefined
          ? { thread: boundedKey(thread) }
          : replyTo !== undefined ? { thread: String(replyTo) } : {},
        ...replyTo === undefined ? {} : { replyTo },
        ...priority === undefined ? {} : { priority: boundedLabel(priority, 32) },
        mentions: mentionsIn(body),
        ...key === undefined ? {} : { idem: key, fp: fingerprint },
        // Attachment IDS LIVE IN THE LOG. They previously existed only in the
        // sender's HTTP reply, so a recipient reading the message afterwards
        // -- which is the entire point of a durable mailbox -- had no way to
        // learn what was attached or what hash to fetch. The bytes stay
        // content-addressed outside the log; only the reference is stored.
        ...attachments === undefined || attachments.length === 0 ? {} : { attachments },
        text: body
      })
    },

    /** Supersede one's own message. The original stays on the record. */
    edit({ from, seq, text } = {}) {
      const author = identity(from, 'from')
      requireAuthor(records(), seq, author)
      return append({ kind: KIND.EDIT, from: author, edits: seq, text: redactDiagnostic(bounded(text)) })
    },

    /** Withdraw one's own message. Tombstoned, never erased. */
    withdraw({ from, seq } = {}) {
      const author = identity(from, 'from')
      requireAuthor(records(), seq, author)
      return append({ kind: KIND.WITHDRAW, from: author, withdraws: seq })
    },

    /** Acknowledge without adding a message to the timeline. */
    react({ from, seq, emoji } = {}) {
      const author = identity(from, 'from')
      messageAt(records(), seq)
      return append({
        kind: KIND.REACTION,
        from: author,
        reactsTo: seq,
        emoji: String(emoji ?? '').slice(0, 32)
      })
    },

    /** Record how far a participant has read. */
    acknowledge({ from, upTo } = {}) {
      return append({ kind: KIND.RECEIPT, from: identity(from, 'from'), upTo: Number(upTo) || 0 })
    },

    /** @returns participant -> highest acknowledged seq. */
    receipts() {
      const out = {}
      for (const r of records()) {
        if (r.kind === KIND.RECEIPT) out[r.from] = Math.max(out[r.from] ?? 0, r.upTo ?? 0)
      }
      return out
    },

    /** Messages addressed to someone that they have not acknowledged. */
    unreadCount({ to } = {}) {
      const seen = api.receipts()[to] ?? 0
      return current(records()).filter((m) => (m.to === to || m.to === '*') && m.seq > seen).length
    },

    /**
     * Reading NEVER consumes.
     *
     * A reader that crashes mid-handling can ask again with the same cursor,
     * and a second participant sees the same history. A queue that popped
     * would make a crash indistinguishable from a delivery.
     *
     * @param current - fold edits/withdrawals/reactions instead of the raw log.
     * @returns `{ messages, cursor, more? }`
     */
    read({ since = 0, to, from, thread, mentions, priority, limit = 100, current: folded = true } = {}) {
      const all = records()
      const source = folded ? current(all) : all
      const matches = source.filter((m) => (m.seq ?? 0) > since
        // '*' is a broadcast: addressed to everyone, so it matches any reader.
        && (to === undefined || m.to === to || m.to === '*')
        && (from === undefined || m.from === from)
        && (thread === undefined
          || String(m.thread ?? '') === String(thread)
          || String(m.seq) === String(thread))
        && (mentions === undefined || (m.mentions ?? []).includes(mentions))
        && (priority === undefined || m.priority === priority))
      const page = matches.slice(0, limit)
      const truncated = matches.length > limit
      return {
        messages: page,
        // A TRUNCATED read must not return the log's high-water mark. It did,
        // so a caller that paged with the returned cursor -- which is what
        // the cursor is FOR -- skipped everything past the limit, silently,
        // and only ever under load. When the page is short of the matches,
        // the cursor is the last message actually handed over.
        cursor: truncated
          ? page.reduce((high, m) => Math.max(high, m.seq ?? 0), since)
          : all.reduce((high, r) => Math.max(high, r.seq ?? 0), 0),
        // Said, not silent: a truncated read that does not say so reads as
        // the whole conversation.
        ...truncated ? { more: matches.length - limit } : {}
      }
    },

    /**
     * Find an earlier decision by its text.
     *
     * No plugin in the surveyed ecosystem had this, and it is the difference
     * between a log and a memory.
     */
    search(needle, { limit = 50, visibleTo } = {}) {
      const term = String(needle ?? '').trim().toLowerCase()
      if (term === '') return []
      return current(records())
        .filter((m) => String(m.text).toLowerCase().includes(term))
        // `visibleTo` restricts results to the caller's own correspondence.
        // Undefined means unrestricted, which is correct on loopback and
        // wrong the moment tokens exist -- so the decision is made by the
        // caller that knows whether authentication is on, not here.
        .filter((m) => visibleTo === undefined
          || m.to === visibleTo || m.from === visibleTo || m.to === BROADCAST)
        .slice(0, limit)
    },

    /** Who has spoken here, so a caller can address someone without guessing. */
    participants() {
      const seen = new Map()
      for (const r of records()) {
        for (const who of [r.from, r.to]) {
          if (who === undefined || who === '*') continue
          seen.set(who, Math.max(seen.get(who) ?? 0, r.at ?? 0))
        }
      }
      return [...seen.entries()]
        .map(([name, lastSeenAt]) => ({ name, lastSeenAt }))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    }
  }

  /**
   * Does the log still verify?
   *
   * Signing was previously WRITE-ONLY: records got a `sig` field and nothing
   * ever checked one, which is the shape of security theatre — a stored
   * signature nobody verifies detects exactly as much tampering as no
   * signature at all. This is the read side, and `GET /health` reports it, so
   * the answer reaches an operator without anyone remembering to ask.
   *
   * @returns `{ signed, checked, valid, invalid: [seq] }`. `signed: false`
   *   means no secret is configured — NOT that the log is clean.
   */
  api.integrity = function integrity() {
    if (signingSecret === undefined) return { signed: false, checked: 0, valid: 0, invalid: [] }
    const invalid = []
    let checked = 0
    for (const record of records()) {
      // A compaction note is written by the rewrite itself, not appended
      // through append(), so it carries no signature and is not evidence.
      if (record.kind === KIND.COMPACTION) continue
      checked += 1
      if (!verifyMessage(signingSecret, record)) invalid.push(record.seq)
    }
    return { signed: true, checked, valid: checked - invalid.length, invalid }
  }

  /** Exposed so retention can be exercised and asserted, not just configured. */
  api.compact = compact

  return api
}

/**
 * Presence, as a directory of small files.
 *
 * One file per participant, replaced by temp+rename so a reader never sees a
 * half-written beat. A file-per-peer rather than one shared file means two
 * participants writing at once cannot lose each other's entry.
 */
export function createPresence({ dir, now = Date.now, staleAfterMs = 90_000 } = {}) {
  return {
    announce(name, extra = {}) {
      const who = identity(name, 'name')
      // `extra` is peer-controlled and was spread onto the record unchecked,
      // so `role` -- the one field callers actually pass -- skipped every
      // bound and every validator that `name` goes through, and is printed
      // beside the name by /mailbox-peers. Sanitised HERE rather than at the
      // tool layer so the slash-command path is covered by the same rule.
      const clean = extra?.role === undefined
        ? {}
        : { role: boundedLabel(extra.role, MAX_NAME) }
      if (dir === undefined) return { name: who, ...clean }
      mkdirSync(dir, { recursive: true })
      const record = { name: who, at: now(), ...clean }
      const target = join(dir, `${encodeURIComponent(who)}.json`)
      const temp = `${target}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(record), 'utf8')
      // Atomic swap: a reader sees either the old beat or the new one.
      renameSync(temp, target)
      return record
    },

    /**
     * @returns every announced peer, each flagged live or stale.
     *
     * Stale entries are REPORTED rather than hidden: "was here, went quiet"
     * is information, and silently dropping a peer looks identical to one
     * that never existed.
     */
    list() {
      if (dir === undefined || !existsSync(dir)) return []
      const out = []
      for (const entry of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        try {
          const record = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
          out.push({ ...record, live: now() - (record.at ?? 0) <= staleAfterMs })
        } catch { /* a half-written or foreign file is not a peer */ }
      }
      return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    }
  }
}
