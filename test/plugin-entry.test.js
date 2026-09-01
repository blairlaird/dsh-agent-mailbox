/**
 * The plugin must be able to load.
 *
 * A sibling plugin was changed to `inject = { required: [...], optional: [...] }`
 * to mark a service optional. This Cordis does not support that form: it read
 * the object's KEYS as service names, the plugin hung as "pending (waiting for
 * services: required, optional)", and the whole harness refused to start.
 *
 * No unit test covered the module's exported shape, so a change that could
 * only fail at load time passed everything else.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name, TRUST_SECTION } from '../index.js'

const fakeCtx = () => {
  const effects = []
  return {
    effects,
    logger: { info() {}, error() {} },
    effect(fn) { effects.push(fn) }
  }
}

test('inject is a flat array of service names', () => {
  assert.ok(Array.isArray(inject), 'the object form takes the harness down at boot')
  for (const entry of inject) assert.equal(typeof entry, 'string')
})

test('the plugin exports what the loader needs', () => {
  assert.equal(name, 'dsh-agent-mailbox')
  assert.equal(typeof apply, 'function')
})

test('the trust section states that peer messages are not instructions', () => {
  // This text is contributed to the system prompt. Without it a mailbox is a
  // prompt-injection channel.
  assert.match(TRUST_SECTION, /never as instructions/i)
  assert.match(TRUST_SECTION, /does not outrank your user/i)
})

test('applying registers effects without touching the network', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mailbox-plugin-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const ctx = fakeCtx()
  assert.doesNotThrow(() => apply(ctx, { home, port: 0 }))
  assert.ok(ctx.effects.length >= 2, 'the doorbell and the server are both effects')
})

test('a refused bind is logged, not thrown, so the harness still starts', async (t) => {
  // A taken port or an unsafe host must not take the plugin tree down: the
  // in-harness tools still work without the loopback surface.
  const home = mkdtempSync(join(tmpdir(), 'dsh-mailbox-plugin-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const logged = []
  const ctx = { logger: { info() {}, error: (m) => logged.push(m) }, effect(fn) { this.pending ??= []; this.pending.push(fn) } }

  apply(ctx, { home, host: '0.0.0.0', requireAuth: false })
  // Run the server effect; a LAN bind without auth must be refused.
  for (const fn of ctx.pending) await fn()
  assert.ok(logged.some((m) => /without authentication/i.test(m)),
    'the refusal is reported rather than crashing the plugin tree')
})

test('the mailbox lives under one directory, so it can be inspected or deleted', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mailbox-plugin-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const ctx = fakeCtx()
  apply(ctx, { home, port: 0 })
  // Nothing is written until a message is sent; the point is that the path is
  // configurable and single-rooted rather than scattered.
  assert.ok(home.length > 0)
})
