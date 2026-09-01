/**
 * Two processes, one mailbox.
 *
 * This is the topology this plugin's own README and src/home.js RECOMMEND.
 * The Windows container split is fixed by pointing every participant at one
 * explicit `home` — "Every participant then shares one log, whatever launched
 * them" — and that is precisely the arrangement in which two harness
 * instances call send() at the same moment.
 *
 * append() assigned a seq by reading the log's high-water mark and adding one,
 * with nothing between the read and the write. Two processes therefore handed
 * out the same seq, and current() keys its fold by seq — so the later record
 * silently replaced the earlier one. Both senders were told success; roughly a
 * quarter of the messages were then unreachable through mailbox_read,
 * mailbox_wait, GET /stream, /mailbox and mailbox_search alike. The bytes sat
 * on disk, and no API returned them.
 *
 * Found by an adversarial sweep, reproduced with real child processes rather
 * than argued from the source, and pinned here the same way: these tests spawn
 * actual OS processes, because an in-process test cannot fail for this reason.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createMailbox } from '../src/mailbox.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mailboxUrl = pathToFileURL(join(repo, 'src', 'mailbox.js')).href

/** A sender that runs in its OWN process, so the race is real. */
const SENDER = `
import { createMailbox } from ${JSON.stringify(mailboxUrl)}
const [file, who, count] = process.argv.slice(2)
const mailbox = createMailbox({ file })
const mine = []
for (let i = 0; i < Number(count); i += 1) {
  mine.push(mailbox.send({ from: who, to: 'reader', text: who + ' says ' + i }).seq)
}
process.stdout.write(JSON.stringify(mine))
`

const race = (senders, count) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-race-'))
  const file = join(dir, 'mail.jsonl')
  const script = join(dir, 'sender.mjs')
  writeFileSync(script, SENDER, 'utf8')

  // Start them all, then collect. execFileSync would serialise them and the
  // race would never happen, which is how this bug survived 209 tests.
  const running = senders.map((who) =>
    new Promise((done) => {
      import('node:child_process').then(({ execFile }) => {
        execFile(process.execPath, [script, file, who, String(count)], { encoding: 'utf8' },
          (error, stdout) => done({ who, error, seqs: stdout ? JSON.parse(stdout) : [] }))
      })
    })
  )
  return { dir, file, running: Promise.all(running) }
}

const readAll = (file) => readFileSync(file, 'utf8').split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l))

test('two processes writing one mailbox never lose a message', async () => {
  const senders = ['codex', 'claude']
  const perSender = 40
  const { dir, file, running } = race(senders, perSender)
  try {
    const results = await running
    for (const r of results) assert.equal(r.error, null, `${r.who} failed: ${r.error?.message}`)

    const onDisk = readAll(file).filter((r) => r.kind === 'message')
    assert.equal(onDisk.length, senders.length * perSender, 'every send must reach the log')

    // THE ACTUAL DEFECT. Both senders were told success; the fold then threw
    // some away because two records claimed one seq.
    const seqs = onDisk.map((r) => r.seq)
    const duplicates = seqs.filter((s, i) => seqs.indexOf(s) !== i)
    assert.deepEqual(duplicates, [],
      `${duplicates.length} seq collisions — two records claiming one seq means the fold drops one`)

    // And the reader must be able to see every one of them.
    const mailbox = createMailbox({ file })
    const visible = mailbox.read({ to: 'reader', limit: 10_000 }).messages
    assert.equal(visible.length, senders.length * perSender,
      'a message on disk that no read returns is a message lost in silence')

    const texts = new Set(visible.map((m) => m.text))
    for (const who of senders) {
      for (let i = 0; i < perSender; i += 1) {
        assert.ok(texts.has(`${who} says ${i}`), `"${who} says ${i}" was accepted and is unreachable`)
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a seq handed to one sender is never handed to another', async () => {
  const { dir, running } = race(['a', 'b', 'c'], 25)
  try {
    const results = await running
    const handed = results.flatMap((r) => r.seqs)
    const clashes = handed.filter((s, i) => handed.indexOf(s) !== i)
    // The success record a sender receives names a seq. Two senders holding
    // the same one cannot both be right, and each believes it is.
    assert.deepEqual(clashes, [], `the same seq was returned to more than one sender: ${clashes}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a duplicate seq already in a log is reported, not silently folded away', () => {
  // A log written before this was fixed still carries collisions. Folding them
  // away silently would hide historical loss behind a clean-looking mailbox,
  // so integrity() has to be able to say so.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-dup-'))
  try {
    const file = join(dir, 'mail.jsonl')
    const rows = [
      { seq: 1, at: 1, kind: 'message', from: 'a', to: 'b', text: 'first' },
      { seq: 2, at: 2, kind: 'message', from: 'a', to: 'b', text: 'second' },
      { seq: 2, at: 3, kind: 'message', from: 'c', to: 'b', text: 'shadowed by the fold' }
    ]
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    const mailbox = createMailbox({ file })
    const report = mailbox.integrity()
    assert.deepEqual(report.duplicateSeqs, [2],
      'a log whose seqs collide must not report as healthy')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the lock does not leak a file behind a normal send', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-lock-'))
  try {
    const file = join(dir, 'mail.jsonl')
    const mailbox = createMailbox({ file })
    mailbox.send({ from: 'a', to: 'b', text: 'one' })
    mailbox.send({ from: 'a', to: 'b', text: 'two' })
    assert.equal(existsSync(`${file}.lock`), false, 'the lock must be released, not left on disk')
    assert.equal(mailbox.read({ to: 'b' }).messages.length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a stale lock from a dead process does not wedge the mailbox forever', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-stale-'))
  try {
    const file = join(dir, 'mail.jsonl')
    // A process that died mid-append leaves its lock behind. Waiting on it
    // forever would turn one crash into a permanently unusable mailbox.
    //
    // Staleness is decided by the file's MTIME, not by anything written
    // inside it -- a crashed process cannot update its own record, and mtime
    // needs no cross-platform process-liveness check. So the simulation has
    // to age the file, which is what a real abandoned lock looks like.
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, at: 0 }), 'utf8')
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(`${file}.lock`, longAgo, longAgo)
    const mailbox = createMailbox({ file })
    const sent = mailbox.send({ from: 'a', to: 'b', text: 'after a crash' })
    assert.equal(sent.seq, 1)
    assert.equal(mailbox.read({ to: 'b' }).messages[0].text, 'after a crash')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('one acknowledgement does not permanently disable compaction', () => {
  // REPORTED BY AN ADVERSARIAL SWEEP, with numbers: maxRecords 100, a single
  // acknowledge at upTo:3, then 500 sends produced 502 records and climbing.
  //
  // keepSince took the minimum over EVERY receipt RECORD ever written rather
  // than each participant's highest, so the first acknowledgement pinned it
  // forever -- and /mailbox acknowledges automatically on every read, so one
  // glance at the mailbox disabled retention for good. compact() kept
  // returning {dropped: 1} the whole time: it was dropping its own previous
  // bookkeeping note and nothing else.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-compact-'))
  try {
    const file = join(dir, 'mail.jsonl')
    const mailbox = createMailbox({ file, maxRecords: 100 })
    mailbox.send({ from: 'a', to: 'reader', text: 'early' })
    mailbox.acknowledge({ from: 'reader', upTo: 3 })
    for (let i = 0; i < 400; i += 1) mailbox.send({ from: 'a', to: 'reader', text: `m${i}` })

    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
    assert.ok(lines.length <= 120, `retention never ran: ${lines.length} records at maxRecords 100`)
    // The newest must always survive, whatever else was dropped.
    assert.equal(mailbox.read({ to: 'reader', limit: 10_000 }).messages.at(-1).text, 'm399')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('compaction still protects the least-advanced acknowledged reader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-compact2-'))
  try {
    const file = join(dir, 'mail.jsonl')
    const mailbox = createMailbox({ file, maxRecords: 40 })
    for (let i = 0; i < 10; i += 1) mailbox.send({ from: 'a', to: 'reader', text: `m${i}` })
    // Two readers at different points: the SLOWER one sets the floor.
    mailbox.acknowledge({ from: 'fast', upTo: 9 })
    mailbox.acknowledge({ from: 'slow', upTo: 4 })
    mailbox.acknowledge({ from: 'fast', upTo: 10 })
    for (let i = 10; i < 90; i += 1) mailbox.send({ from: 'a', to: 'reader', text: `m${i}` })

    const texts = mailbox.read({ to: 'reader', limit: 10_000 }).messages.map((m) => m.text)
    assert.ok(texts.includes('m4'),
      'compaction passed the slowest acknowledged reader — its cursor now points at nothing')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
