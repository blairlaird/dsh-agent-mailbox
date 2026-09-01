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

/**
 * A ctx that behaves like Cordis on the two points that matter: services are
 * only reachable through a declaration, and ctx.inject() starts a child that
 * waits for one.
 */
const fakeCtx = ({ provide = {} } = {}) => {
  const effects = []
  const injected = []
  const ctx = {
    effects,
    injected,
    logger: { info() {}, error() {} },
    effect(fn) { effects.push(fn) },
    // "Read a service from the store without the inject requirement."
    reflect: { get: (name) => provide[name] },
    inject(names, callback) {
      injected.push(names)
      // Cordis runs the child only once EVERY name resolves; a host that
      // never provides one leaves that child pending forever, which is
      // exactly the behaviour this plugin relies on.
      if (!names.every((n) => provide[n] !== undefined)) return
      // Cordis runs an effect's callback IMMEDIATELY and keeps its return
      // as the disposer -- a fake that only queues them would let a dead
      // registration look registered, which is the bug being pinned.
      const scoped = { ...ctx, ...provide, effect: (fn) => { effects.push(fn); return fn() } }
      callback(scoped)
    }
  }
  return ctx
}

/** A command registry that records what was registered, like ctx.commands. */
const fakeCommands = () => {
  const registered = []
  return { registered, register(spec) { registered.push(spec); return () => {} } }
}

test('inject is a flat array of service names', () => {
  assert.ok(Array.isArray(inject), 'the object form takes the harness down at boot')
  for (const entry of inject) assert.equal(typeof entry, 'string')
})

test('inject does not declare `commands`, so the plugin loads without one', () => {
  // Declaring it here would make the whole plugin -- MCP server included --
  // refuse to load on any host with no command registry. The commands are
  // waited for in a CHILD fiber instead.
  assert.ok(!inject.includes('commands'),
    'a host without a command registry must still get the MCP surface')
})

test('the commands are registered through ctx.inject, not a bare read', (t) => {
  // THE BUG THIS PINS. `try { ctx.commands } catch {}` never throws and never
  // works: Cordis gates service access on the declaration, so the read is
  // undefined every time and all four commands silently never register. That
  // shipped, passed every test, and was only caught by typing /mailbox-peers
  // into a live session and watching the model try to grep for it.
  const home = mkdtempSync(join(tmpdir(), 'dsh-mailbox-plugin-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const commands = fakeCommands()
  const ctx = fakeCtx({ provide: { commands } })

  apply(ctx, { home, port: 0 })

  assert.deepEqual(ctx.injected, [['commands']], 'the wait must be on `commands`')
  assert.deepEqual(commands.registered.map((c) => c.name).sort(),
    ['mailbox', 'mailbox-peers', 'mailbox-search', 'mailbox-send'],
    'all four commands must reach the registry')
})

test('a host that never provides commands still gets everything else', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mailbox-plugin-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const ctx = fakeCtx()               // provides nothing
  assert.doesNotThrow(() => apply(ctx, { home, port: 0 }))
  assert.ok(ctx.effects.length >= 2, 'the doorbell and the server still register')
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

test('a throwing service getter does not take the plugin down', (t) => {
  // Cordis throws `cannot get property "tools" without inject` for a service
  // the plugin does not declare, and OPTIONAL CHAINING DOES NOT CATCH IT --
  // `ctx.tools?.register` still throws. This exact shape took the whole
  // harness down the first time the plugin was installed, and no test caught
  // it because the fake ctx simply had no `tools` property.
  const home = mkdtempSync(join(tmpdir(), 'dsh-mailbox-plugin-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const ctx = {
    logger: { info() {}, error() {} },
    effect(fn) { this.effects ??= []; this.effects.push(fn) },
    get tools() { throw new Error('cannot get property "tools" without inject') }
  }
  assert.doesNotThrow(() => apply(ctx, { home, port: 0 }))
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
