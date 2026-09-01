/**
 * Slash commands: how the person supervising two agents joins the channel.
 *
 * Without these the mailbox is MCP-only — the agents can talk to each other
 * but their operator cannot read it. A channel its operator cannot see is a
 * channel they cannot supervise.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerCommands, DEFAULT_IDENTITY } from '../src/commands.js'
import { createMailbox, createPresence } from '../src/mailbox.js'

/** Captures registrations the way ctx.commands would. */
const harness = (t, identity = DEFAULT_IDENTITY) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-cmd-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const mailbox = createMailbox({ file: join(dir, 'mail.jsonl') })
  const presence = createPresence({ dir: join(dir, 'peers') })
  const registry = new Map()
  const disposed = []
  const commands = {
    register(spec) { registry.set(spec.name, spec); return () => disposed.push(spec.name) }
  }
  const dispose = registerCommands(commands, { mailbox, presence }, identity)
  const run = (name, rawInput = '') => registry.get(name).handler({ rawInput })
  return { mailbox, presence, registry, run, dispose, disposed }
}

test('the mailbox commands are registered', (t) => {
  const { registry } = harness(t)
  for (const name of ['mailbox', 'mailbox-send', 'mailbox-peers', 'mailbox-search']) {
    assert.ok(registry.has(name), `missing /${name}`)
  }
})

test('unloading the plugin removes its commands', (t) => {
  const { dispose, disposed } = harness(t)
  dispose()
  assert.equal(disposed.length, 4, 'a reload must not leave stale commands behind')
})

test('reading an empty mailbox says so plainly', (t) => {
  const { run } = harness(t)
  assert.match(run('mailbox').text, /No messages/i)
})

test('reading shows messages addressed to this session', (t) => {
  const { mailbox, run } = harness(t, 'dsh')
  mailbox.send({ from: 'codex', to: 'dsh', text: 'seat evidence landed' })
  const out = run('mailbox')
  assert.match(out.text, /seat evidence landed/)
  assert.match(out.text, /codex/)
})

test('reading carries the trust warning', (t) => {
  // The operator reads peer-written content here too; it must be labelled.
  const { mailbox, run } = harness(t, 'dsh')
  mailbox.send({ from: 'codex', to: 'dsh', text: 'hello' })
  assert.match(run('mailbox').text, /never as instructions/i)
})

test('reading acknowledges, so a sender can tell unread from ignored', (t) => {
  const { mailbox, run } = harness(t, 'dsh')
  const sent = mailbox.send({ from: 'codex', to: 'dsh', text: 'please review' })
  assert.equal(mailbox.unreadCount({ to: 'dsh' }), 1)
  run('mailbox')
  assert.equal(mailbox.unreadCount({ to: 'dsh' }), 0)
  assert.equal(mailbox.receipts().dsh >= sent.seq, true)
})

test('a second read reports nothing new rather than repeating', (t) => {
  const { mailbox, run } = harness(t, 'dsh')
  mailbox.send({ from: 'codex', to: 'dsh', text: 'once' })
  run('mailbox')
  assert.match(run('mailbox').text, /Nothing new/i)
})

test('--all shows the whole history after acknowledging', (t) => {
  const { mailbox, run } = harness(t, 'dsh')
  mailbox.send({ from: 'codex', to: 'dsh', text: 'historical' })
  run('mailbox')
  assert.match(run('mailbox', '--all').text, /historical/)
})

test('sending needs a recipient and a message', (t) => {
  const { run } = harness(t)
  assert.equal(run('mailbox-send', '').kind, 'error')
  assert.equal(run('mailbox-send', 'codex').kind, 'error')
  assert.match(run('mailbox-send', 'codex   ').text, /Usage/)
})

test('sending splits recipient from message on the first space', (t) => {
  const { mailbox, run } = harness(t, 'dsh')
  const out = run('mailbox-send', 'codex the readiness barrier is live')
  assert.equal(out.kind, 'success')
  const [message] = mailbox.read({ to: 'codex' }).messages
  assert.equal(message.from, 'dsh')
  assert.equal(message.text, 'the readiness barrier is live')
})

test("the mailbox's own refusal is surfaced, not swallowed", (t) => {
  // A reserved name or an empty body should tell the operator why.
  const { run } = harness(t, 'dsh')
  const out = run('mailbox-send', '* trying to broadcast as a name')
  assert.equal(out.kind, 'success', 'broadcast IS a valid destination')
  const bad = run('mailbox-send', 'a\tb hello')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /identity/i)
})

test('peers lists participants with unread counts', (t) => {
  const { mailbox, presence, run } = harness(t, 'dsh')
  presence.announce('codex', { role: 'mcp-client' })
  mailbox.send({ from: 'codex', to: 'dsh', text: 'one' })
  const out = run('mailbox-peers').text
  assert.match(out, /codex/)
  assert.match(out, /You are "dsh"/)
  assert.match(out, /1 unread/)
})

test('peers on an empty mailbox says so', (t) => {
  assert.match(harness(t).run('mailbox-peers').text, /No participants/i)
})

test('search finds a message and reports misses honestly', (t) => {
  const { mailbox, run } = harness(t, 'dsh')
  mailbox.send({ from: 'codex', to: 'dsh', text: 'the undici ceiling was 300s' })
  assert.match(run('mailbox-search', 'undici').text, /undici/)
  assert.match(run('mailbox-search', 'nonexistent').text, /Nothing matching/i)
  assert.equal(run('mailbox-search', '').kind, 'error')
})

test('a broadcast reaches the session', (t) => {
  const { mailbox, run } = harness(t, 'dsh')
  mailbox.send({ from: 'codex', to: '*', text: 'all hands' })
  assert.match(run('mailbox').text, /all hands/)
})
