/**
 * Regressions for an independent security audit.
 *
 * A 40-agent adversarial review of this plugin confirmed 32 findings, of
 * which two were reachable without any credential at all. Every fix below has
 * a test here rather than only a comment, because a comment does not fail.
 *
 * Each test names the WRONG behaviour it would catch, not just the right one:
 * a regression test whose failure message does not say what broke costs its
 * reader the whole investigation again.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer } from '../src/server.js'
import { createMailbox, createPresence } from '../src/mailbox.js'
import { createAttachmentStore } from '../src/attachments.js'
import { createNotifier } from '../src/notify.js'
import { createAuth, hashToken } from '../src/auth.js'
import { createDeliveryHook } from '../src/hook.js'
import { dispatch, agentCard } from '../src/tools.js'
import { signMessage } from '../src/integrity.js'

let nextPort = 4820
const port = () => nextPort++

const box = (extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-hard-'))
  const file = join(dir, 'mail.jsonl')
  return { dir, file, mailbox: createMailbox({ file, ...extra }) }
}

const withServer = async (body, { auth, mailboxOptions } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-hard-srv-'))
  const file = join(dir, 'mail.jsonl')
  const mailbox = createMailbox({ file, ...mailboxOptions })
  const notifier = createNotifier({ file, mailbox })
  const deps = {
    mailbox,
    presence: createPresence({ dir: join(dir, 'peers') }),
    attachments: createAttachmentStore({ dir: join(dir, 'blobs') }),
    notifier,
    auth: auth ?? createAuth({ required: false }),
    hook: createDeliveryHook({}),
    home: dir
  }
  const p = port()
  const server = await startServer(deps, { host: '127.0.0.1', port: p })
  try { return await body({ port: p, deps, dir }) } finally {
    notifier.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const TOKEN = 'alice-token-value'
const authed = () => createAuth({ required: true, participants: { alice: hashToken(TOKEN) } })

/** Read an SSE stream for a moment, then hang up. */
const listen = async (url, headers, ms = 250) => {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), ms)
  let text = ''
  try {
    const response = await fetch(url, { headers, signal: control.signal })
    if (!response.ok) return { status: response.status, text: await response.text() }
    const decoder = new TextDecoder()
    for await (const chunk of response.body) text += decoder.decode(chunk, { stream: true })
  } catch { /* aborting the read is how this ends */ } finally { clearTimeout(timer) }
  return { status: 200, text }
}

// ---------------------------------------------------------------- CRITICAL

test('GET /stream without a token is refused when auth is required', async () => {
  await withServer(async ({ port: p, deps }) => {
    deps.mailbox.send({ from: 'alice', to: 'alice', text: 'CONFIDENTIAL: deploy key rotation plan' })
    const got = await listen(`http://127.0.0.1:${p}/stream`, {})
    assert.equal(got.status, 401, 'an unauthenticated stream must not open at all')
    assert.doesNotMatch(got.text, /CONFIDENTIAL/, 'and it must not have leaked the log on the way out')
  }, { auth: authed() })
})

test('GET /stream cannot be pointed at another participant with ?to=', async () => {
  await withServer(async ({ port: p, deps }) => {
    deps.mailbox.send({ from: 'alice', to: 'bob', text: 'BOBS-PRIVATE-MAIL' })
    deps.mailbox.send({ from: 'bob', to: 'alice', text: 'ALICES-MAIL' })
    // A VALID token, asking for someone else's mail. Gating the route alone
    // would let this through, which is why the filter is derived from the
    // resolved identity rather than from the query string.
    const got = await listen(`http://127.0.0.1:${p}/stream?to=bob`, { authorization: `Bearer ${TOKEN}` })
    assert.equal(got.status, 401)
    assert.doesNotMatch(got.text, /BOBS-PRIVATE-MAIL/)
  }, { auth: authed() })
})

test('a valid token streams its own mail', async () => {
  await withServer(async ({ port: p, deps }) => {
    deps.mailbox.send({ from: 'bob', to: 'alice', text: 'ALICES-MAIL' })
    deps.mailbox.send({ from: 'bob', to: 'carol', text: 'CAROLS-MAIL' })
    const got = await listen(`http://127.0.0.1:${p}/stream`, { authorization: `Bearer ${TOKEN}` })
    assert.equal(got.status, 200)
    assert.match(got.text, /ALICES-MAIL/, 'the gate must not have broken the feature it protects')
    assert.doesNotMatch(got.text, /CAROLS-MAIL/)
  }, { auth: authed() })
})

test('GET /health does not disclose the peer roster without a token', async () => {
  await withServer(async ({ port: p, deps }) => {
    deps.presence.announce('alice', { role: 'orchestrator' })
    const open = await fetch(`http://127.0.0.1:${p}/health`)
    assert.equal(open.status, 401)
    assert.doesNotMatch(await open.text(), /orchestrator/)

    const withToken = await fetch(`http://127.0.0.1:${p}/health`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(withToken.status, 200)
  }, { auth: authed() })
})

test('with auth off, loopback reads stay open', async () => {
  await withServer(async ({ port: p, deps }) => {
    deps.mailbox.send({ from: 'a', to: 'b', text: 'hello' })
    assert.equal((await fetch(`http://127.0.0.1:${p}/health`)).status, 200)
    const got = await listen(`http://127.0.0.1:${p}/stream?to=b`, {})
    assert.match(got.text, /hello/, 'the default single-machine case must not need a token')
  })
})

test('an oversize body is refused rather than buffered', async () => {
  await withServer(async ({ port: p }) => {
    // 9 MiB, past the 8 MiB cap. Before the cap this accumulated into one
    // string until the client stopped, which is a heap kill from any socket.
    const huge = 'x'.repeat(9 * 1024 * 1024)
    let status = 0
    try {
      const response = await fetch(`http://127.0.0.1:${p}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', pad: huge })
      })
      status = response.status
    } catch {
      // A destroyed connection is also an acceptable refusal.
      status = 413
    }
    assert.equal(status, 413)
  })
})

// ------------------------------------------------------------------- HIGH

test('a malformed body is a parse error, not a 202', async () => {
  await withServer(async ({ port: p }) => {
    const response = await fetch(`http://127.0.0.1:${p}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json'
    })
    const payload = await response.json()
    assert.equal(payload.error.code, -32700, 'answering 202 told a broken client it had succeeded')
    assert.equal(payload.id, null)
  })
})

test('a tools/call sent as a notification is actually dispatched', async () => {
  await withServer(async ({ port: p, deps }) => {
    const response = await fetch(`http://127.0.0.1:${p}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'mailbox_send', arguments: { from: 'a', to: 'b', text: 'fire and forget' } }
      })
    })
    assert.equal(response.status, 202, 'a notification is still never answered')
    // The 202 is sent before dispatch, so give the write a moment to land.
    for (let i = 0; i < 40 && deps.mailbox.read({ to: 'b' }).messages.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.equal(deps.mailbox.read({ to: 'b' }).messages.length, 1,
      'accepted-and-never-run is a lost message wearing a success code')
  })
})

test('the agent card ignores a peer-supplied ?port=', async () => {
  await withServer(async ({ port: p }) => {
    const response = await fetch(`http://127.0.0.1:${p}/.well-known/agent.json?port=${p}@evil.example`)
    const card = await response.json()
    // WHATWG parses "127.0.0.1:4470" as userinfo here, so interpolating the
    // query made the card's ORIGIN evil.example -- an A2A redirector.
    assert.equal(new URL(card.url).hostname, '127.0.0.1')
    assert.equal(card.url, `http://127.0.0.1:${p}`)
  })
})

test('a non-numeric ?since does not deafen the stream', async () => {
  await withServer(async ({ port: p, deps }) => {
    deps.mailbox.send({ from: 'a', to: 'b', text: 'audible' })
    // Number('abc') is NaN and `seq > NaN` is false for every record, so this
    // was a subscriber that looked healthy and could never hear anything.
    const got = await listen(`http://127.0.0.1:${p}/stream?to=b&since=abc`, {})
    assert.match(got.text, /audible/)
  })
})

test('the stream drains past one page instead of skipping the rest', async () => {
  await withServer(async ({ port: p, deps }) => {
    for (let i = 0; i < 250; i += 1) deps.mailbox.send({ from: 'a', to: 'b', text: `m${i}` })
    const got = await listen(`http://127.0.0.1:${p}/stream?to=b`, {}, 900)
    // The cursor used to jump to the log's high-water mark after one page, so
    // everything past the limit was skipped silently and only under load.
    assert.match(got.text, /"text":"m0"/)
    assert.match(got.text, /"text":"m249"/, 'messages past the first page were dropped')
  })
})

test('a truncated read returns a cursor that does not skip the remainder', () => {
  const { dir, mailbox } = box()
  try {
    for (let i = 0; i < 10; i += 1) mailbox.send({ from: 'a', to: 'b', text: `m${i}` })
    const first = mailbox.read({ to: 'b', limit: 4 })
    assert.equal(first.messages.length, 4)
    assert.equal(first.more, 6)
    const second = mailbox.read({ to: 'b', since: first.cursor, limit: 4 })
    assert.equal(second.messages[0].text, 'm4', 'paging with the returned cursor lost six messages')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a forged withdraw by a non-author is ignored at the fold', () => {
  const { dir, file, mailbox } = box()
  try {
    const sent = mailbox.send({ from: 'alice', to: 'bob', text: 'the agreed plan' })
    // Appended directly to the FILE, bypassing withdraw()'s write-time check.
    // Anything that can reach the path could do this.
    appendFileSync(file, `${JSON.stringify({ seq: 99, at: 1, kind: 'withdraw', from: 'mallory', withdraws: sent.seq })}\n`)
    const visible = mailbox.read({ to: 'bob' }).messages
    assert.equal(visible.length, 1, 'a peer erased another peer’s message from every reader’s view')
    assert.equal(visible[0].text, 'the agreed plan')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a forged edit by a non-author is ignored at the fold', () => {
  const { dir, file, mailbox } = box()
  try {
    const sent = mailbox.send({ from: 'alice', to: 'bob', text: 'ship on friday' })
    appendFileSync(file, `${JSON.stringify({ seq: 99, at: 1, kind: 'edit', from: 'mallory', edits: sent.seq, text: 'ship now' })}\n`)
    assert.equal(mailbox.read({ to: 'bob' }).messages[0].text, 'ship on friday')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the author can still edit and withdraw', () => {
  const { dir, mailbox } = box()
  try {
    const sent = mailbox.send({ from: 'alice', to: 'bob', text: 'first' })
    mailbox.edit({ from: 'alice', seq: sent.seq, text: 'second' })
    assert.equal(mailbox.read({ to: 'bob' }).messages[0].text, 'second',
      'the author check must not have broken the feature it guards')
    mailbox.withdraw({ from: 'alice', seq: sent.seq })
    assert.equal(mailbox.read({ to: 'bob' }).messages.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mailbox_search is scoped to the caller when auth is on', async () => {
  const { dir, mailbox } = box()
  try {
    mailbox.send({ from: 'bob', to: 'carol', text: 'secret between bob and carol' })
    mailbox.send({ from: 'bob', to: 'alice', text: 'secret for alice' })
    const deps = { mailbox, auth: createAuth({ required: true, participants: { alice: hashToken(TOKEN) } }) }
    const found = await dispatch(deps, 'mailbox_search', { query: 'secret' }, 'alice')
    assert.equal(found.messages.length, 1, 'search took no identity, so any token read everyone’s mail')
    assert.equal(found.messages[0].to, 'alice')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mailbox_search stays global with auth off', async () => {
  const { dir, mailbox } = box()
  try {
    mailbox.send({ from: 'bob', to: 'carol', text: 'findable' })
    const deps = { mailbox, auth: createAuth({ required: false }) }
    const found = await dispatch(deps, 'mailbox_search', { query: 'findable' }, undefined)
    assert.equal(found.messages.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ----------------------------------------------------------------- MEDIUM

test('an idempotency key burned by one peer does not block another', () => {
  const { dir, mailbox } = box()
  try {
    mailbox.send({ from: 'mallory', to: 'x', text: 'squatting', idempotencyKey: 'deploy-1' })
    // One global namespace let any participant pre-burn a key and turn
    // another agent's send into a validation error about content it never
    // wrote -- denial of service with no privileges required.
    const mine = mailbox.send({ from: 'alice', to: 'bob', text: 'real work', idempotencyKey: 'deploy-1' })
    assert.equal(mine.text, 'real work')
    assert.equal(mine.deduplicated, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an over-long idempotency key still matches its own retry', () => {
  const { dir, mailbox } = box()
  try {
    const key = `k${'0'.repeat(400)}`
    const first = mailbox.send({ from: 'a', to: 'b', text: 'once', idempotencyKey: key })
    const retry = mailbox.send({ from: 'a', to: 'b', text: 'once', idempotencyKey: key })
    // The raw argument used to be compared against a stored, truncated copy,
    // so a long key could never match itself and every retry duplicated.
    assert.equal(retry.deduplicated, true)
    assert.equal(retry.seq, first.seq)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('control characters are stripped from text, thread and priority', () => {
  const { dir, mailbox } = box()
  try {
    const esc = String.fromCharCode(27)
    const sent = mailbox.send({
      from: 'a',
      to: 'b',
      text: `before${esc}[2Kafter\r\nkept\tkept`,
      thread: `t${esc}[31m`,
      priority: `urg${String.fromCharCode(7)}ent`
    })
    // An escape sequence in a message repaints the terminal an operator is
    // supervising the conversation in -- forging the transcript.
    assert.doesNotMatch(sent.text, new RegExp(esc))
    assert.doesNotMatch(sent.text, /\r/)
    assert.match(sent.text, /kept\tkept/, 'tab and newline are prose, and must survive')
    assert.match(sent.text, /\n/)
    assert.equal(sent.thread, 't[31m')
    assert.equal(sent.priority, 'urgent')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an announced role is bounded and sanitised', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-pres-'))
  try {
    const presence = createPresence({ dir })
    const record = presence.announce('alice', { role: `x${String.fromCharCode(27)}[2J`.padEnd(500, 'y') })
    assert.ok(record.role.length <= 64, 'role skipped every bound name goes through')
    assert.doesNotMatch(record.role, new RegExp(String.fromCharCode(27)))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('extra announce fields are not spread onto the record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-pres2-'))
  try {
    const presence = createPresence({ dir })
    const record = presence.announce('alice', { role: 'ok', live: true, at: 0, injected: 'x' })
    assert.equal(record.injected, undefined)
    assert.notEqual(record.at, 0, 'a peer must not be able to forge its own last-seen time')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('attachment bytes are not written when the send is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-att-'))
  try {
    const blobs = join(dir, 'blobs')
    const deps = {
      mailbox: createMailbox({ file: join(dir, 'mail.jsonl') }),
      attachments: createAttachmentStore({ dir: blobs }),
      auth: createAuth({ required: false })
    }
    await assert.rejects(() => dispatch(deps, 'mailbox_send', {
      from: 'a',
      to: '',                       // refused by the mailbox
      text: 'hi',
      attachments: [{ content: Buffer.from('payload').toString('base64'), name: 'a.txt' }]
    }, undefined))
    // Writing first meant a refused send still spent the recipient's disk,
    // and nothing referenced the result afterwards to find or remove it.
    // A missing directory is the stronger result: nothing was created at all.
    const written = existsSync(blobs) ? readdirSync(blobs) : []
    assert.deepEqual(written, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('attachment ids are persisted in the log, not only in the reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-att2-'))
  try {
    const file = join(dir, 'mail.jsonl')
    const deps = {
      mailbox: createMailbox({ file }),
      attachments: createAttachmentStore({ dir: join(dir, 'blobs') }),
      auth: createAuth({ required: false })
    }
    await dispatch(deps, 'mailbox_send', {
      from: 'a',
      to: 'b',
      text: 'see attached',
      attachments: [{ content: Buffer.from('payload').toString('base64'), name: 'a.txt' }]
    }, undefined)
    // The ids lived only in the sender's HTTP reply, so a recipient reading
    // afterwards -- the entire point of a durable mailbox -- could not learn
    // what was attached or what hash to fetch.
    const stored = deps.mailbox.read({ to: 'b' }).messages[0]
    assert.equal(stored.attachments.length, 1)
    assert.match(stored.attachments[0].id, /^[0-9a-f]{64}$/)
    assert.match(readFileSync(file, 'utf8'), /"attachments"/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// --------------------------------------------------------- CLAIMED, NOW REAL

test('signing covers edit and withdraw, not only message', () => {
  const { dir, mailbox } = box({ signingSecret: 's3cret' })
  try {
    const sent = mailbox.send({ from: 'a', to: 'b', text: 'one' })
    const edit = mailbox.edit({ from: 'a', seq: sent.seq, text: 'two' })
    // Signing only `message` left the records that REWRITE a message outside
    // the signature entirely.
    assert.equal(typeof edit.sig, 'string')
    assert.equal(mailbox.integrity().invalid.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('integrity() names a record altered on disk', () => {
  const { dir, file, mailbox } = box({ signingSecret: 's3cret' })
  try {
    mailbox.send({ from: 'a', to: 'b', text: 'original' })
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    const tampered = { ...JSON.parse(lines[0]), text: 'rewritten' }
    writeFileSync(file, `${JSON.stringify(tampered)}\n`)
    const report = mailbox.integrity()
    // A `sig` field nobody verifies detects exactly as much tampering as no
    // signature at all. This is the read side that made it real.
    assert.equal(report.signed, true)
    assert.deepEqual(report.invalid, [tampered.seq])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a signature from the wrong secret does not verify', () => {
  const { dir, file, mailbox } = box({ signingSecret: 's3cret' })
  try {
    const sent = mailbox.send({ from: 'a', to: 'b', text: 'x' })
    const forged = { ...sent, text: 'y' }
    forged.sig = signMessage('wrong-secret', forged)
    writeFileSync(file, `${JSON.stringify(forged)}\n`)
    assert.deepEqual(mailbox.integrity().invalid, [sent.seq])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('retention actually compacts once maxRecords is exceeded', () => {
  const { dir, file, mailbox } = box({ maxRecords: 20 })
  try {
    for (let i = 0; i < 40; i += 1) mailbox.send({ from: 'a', to: 'b', text: `m${i}` })
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    // maxRecords was accepted and never used; planRetention was written,
    // tested, and never called. The README claimed compaction regardless.
    assert.ok(lines.length <= 22, `log kept growing: ${lines.length} lines`)
    const note = JSON.parse(lines[0])
    assert.equal(note.kind, 'compaction', 'a silent deletion in this log would be the worst failure it has')
    assert.ok(note.dropped > 0)
    assert.equal(mailbox.read({ to: 'b' }).messages.at(-1).text, 'm39', 'the newest must always survive')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('compaction never drops below an acknowledged reader', () => {
  const { dir, mailbox } = box({ maxRecords: 30 })
  try {
    for (let i = 0; i < 10; i += 1) mailbox.send({ from: 'a', to: 'b', text: `m${i}` })
    mailbox.acknowledge({ from: 'b', upTo: 3 })
    for (let i = 10; i < 60; i += 1) mailbox.send({ from: 'a', to: 'b', text: `m${i}` })
    // A cursor someone still holds must not be compacted out from under them,
    // or "nothing new" and "it is gone" become the same answer.
    const texts = mailbox.read({ to: 'b' }).messages.map((m) => m.text)
    assert.ok(texts.includes('m3'), 'compaction passed the least-advanced acknowledged reader')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// -------------------------------------------------------------- AVAILABILITY

test('a throwing listener does not take the host down', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-notify-'))
  try {
    const file = join(dir, 'mail.jsonl')
    const mailbox = createMailbox({ file })
    const notifier = createNotifier({ file, mailbox })
    let healthy = 0
    // An uncaught throw inside an fs.watch callback is not caught by anything
    // above it: it ends the host process this plugin is a guest in.
    notifier.subscribe(() => { throw new Error('listener exploded') })
    notifier.subscribe(() => { healthy += 1 })
    mailbox.send({ from: 'a', to: 'b', text: 'trigger' })
    await new Promise((r) => setTimeout(r, 250))
    notifier.close()
    assert.ok(healthy > 0, 'one broken listener silenced every other one')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('holdMs is clamped, and an expired hold still loses nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-hold-'))
  try {
    const file = join(dir, 'mail.jsonl')
    const mailbox = createMailbox({ file })
    const notifier = createNotifier({ file, mailbox })
    const started = Date.now()
    const result = await notifier.waitFor({ to: 'nobody', holdMs: 40 })
    notifier.close()
    assert.ok(Date.now() - started < 3000)
    // The clamp bounds a PARKED REQUEST, never work: an expired hold returns
    // empty, drops no message and moves no cursor.
    assert.deepEqual(result.messages, [])
    assert.equal(result.waited, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a non-numeric holdMs does not turn a wait into a busy poll', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-hold2-'))
  try {
    const file = join(dir, 'mail.jsonl')
    const mailbox = createMailbox({ file })
    const notifier = createNotifier({ file, mailbox })
    // Number('soon') is NaN, and setTimeout(NaN) fires immediately -- so an
    // unguarded hold turns a long-poll into a spin loop. Raced rather than
    // awaited: the correct behaviour is to fall back to the 25s default, and
    // waiting that out would put 25 idle seconds in every test run.
    const parked = notifier.waitFor({ to: 'nobody', holdMs: 'soon' })
    const outcome = await Promise.race([
      parked.then(() => 'returned'),
      new Promise((r) => setTimeout(() => r('still parked'), 300))
    ])
    notifier.close()
    assert.equal(outcome, 'still parked', 'a NaN hold returned instantly, which is a spin loop')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the agent card does not understate the server', () => {
  // `streaming: false` while GET /stream serves Server-Sent Events is the
  // same class of error as overstating: a client believes it either way.
  assert.equal(agentCard({}).capabilities.streaming, true)
})
