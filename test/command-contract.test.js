/**
 * The slash commands, checked against the REAL host contract.
 *
 * WHY THIS FILE EXISTS, SEPARATELY FROM commands.test.js
 *
 * commands.test.js registers against a fake whose `register()` accepts
 * anything. That proves the handlers behave; it cannot prove the host would
 * ever call them, because a test double has no opinion about the shape it is
 * handed.
 *
 * That gap has taken the whole harness down twice in this plugin's short life,
 * both times for the same reason -- a shape that satisfied every local test and
 * not the host:
 *
 *   - `inject` written as `{ required, optional }`. Cordis reads the object's
 *     KEYS as service names, so the plugin hung forever as "pending (waiting
 *     for services: required, optional)" and took the tree with it.
 *   - `ctx.tools?.register`. Optional chaining does not catch a THROWING
 *     getter, and Cordis throws for an undeclared service.
 *
 * So the rules below are transcribed from the host's own validator,
 * `normalizeDefinition` in @deepseek-ai/dsh-commands (lib/index.js), and run
 * against the specs this plugin actually registers. If the plugin drifts out
 * of the contract, this fails here rather than at load time in front of a
 * user -- which is the only place the previous two were caught.
 *
 * A transcription can go stale, so each rule cites the host behaviour it
 * mirrors. It is evidence, not proof: the one thing that proves these work is
 * running them in a live session.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerCommands, DEFAULT_IDENTITY } from '../src/commands.js'
import { createMailbox, createPresence } from '../src/mailbox.js'

/** Verbatim from @deepseek-ai/dsh-commands: `COMMAND_NAME`. */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/**
 * A faithful port of the host's `normalizeDefinition`, throwing the same way.
 *
 * Deliberately a COPY rather than an import: this plugin does not depend on
 * the host package, and taking a dependency on it to test against it would
 * remove the very property being protected -- that the plugin installs with
 * nothing.
 */
function normalizeDefinition(definition) {
  if (!COMMAND_NAME.test(definition.name)) {
    throw new TypeError(`command name "${definition.name}" must match ${String(COMMAND_NAME)}`)
  }
  if (typeof definition.description !== 'string') {
    throw new TypeError(`command "${definition.name}" description must be a string`)
  }
  if (definition.description.trim().length === 0) {
    throw new TypeError(`command "${definition.name}" description must not be empty`)
  }
  if (typeof definition.handler !== 'function') {
    throw new TypeError(`command "${definition.name}" handler must be a function`)
  }
  const rawInput = definition.input
  if (rawInput !== undefined) {
    if (typeof rawInput !== 'object' || rawInput === null ||
        !('hint' in rawInput) || typeof rawInput.hint !== 'string') {
      throw new TypeError(`command "${definition.name}" input hint must be a string`)
    }
    if (rawInput.hint.trim().length === 0) {
      throw new TypeError(`command "${definition.name}" input hint must not be empty`)
    }
    if ('images' in rawInput && rawInput.images !== undefined && typeof rawInput.images !== 'boolean') {
      throw new TypeError(`command "${definition.name}" input images flag must be a boolean`)
    }
  }
  return definition
}

/** Register for real and hand back every spec the plugin produced. */
const specs = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-contract-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const registered = []
  const commands = { register(spec) { registered.push(spec); return () => {} } }
  registerCommands(commands, {
    mailbox: createMailbox({ file: join(dir, 'mail.jsonl') }),
    presence: createPresence({ dir: join(dir, 'peers') })
  }, DEFAULT_IDENTITY)
  return registered
}

test('every registered command survives the host validator', (t) => {
  const registered = specs(t)
  assert.equal(registered.length, 4)
  for (const spec of registered) {
    // Throws exactly as the host would, naming the field, so a failure here
    // reads as the load-time error it is standing in for.
    assert.doesNotThrow(() => normalizeDefinition(spec), `/${spec.name} would be refused at load`)
  }
})

test('the hyphenated names are legal, which is not obvious', (t) => {
  // Three of the four names contain a hyphen. Had COMMAND_NAME been
  // `/^[a-z][a-z0-9_]*$/`, this plugin would have registered exactly one
  // command and thrown on the next three -- during load, in front of a user.
  for (const name of ['mailbox', 'mailbox-send', 'mailbox-peers', 'mailbox-search']) {
    assert.ok(COMMAND_NAME.test(name), `/${name} is not a legal command name`)
  }
  assert.deepEqual(specs(t).map((s) => s.name).sort(),
    ['mailbox', 'mailbox-peers', 'mailbox-search', 'mailbox-send'])
})

test('a command with no input at all is accepted', (t) => {
  // /mailbox-peers takes no arguments and passes no `input`. The host treats
  // the field as optional; a validator that required it would reject this one
  // command only, which is the kind of partial failure that reads as a bug in
  // the mailbox rather than in the registration.
  const peers = specs(t).find((s) => s.name === 'mailbox-peers')
  assert.equal(peers.input, undefined)
  assert.doesNotThrow(() => normalizeDefinition(peers))
})

test('every handler returns the host result shape', (t) => {
  const registered = specs(t)
  for (const spec of registered) {
    // rawInput is the field the host populates -- confirmed against
    // dsh-command-goal, dsh-command-compact and dsh-session-log-export, all
    // of which read invocation.rawInput.
    const result = spec.handler({ rawInput: '' })
    assert.ok(['success', 'error'].includes(result.kind),
      `/${spec.name} returned kind ${JSON.stringify(result.kind)}`)
    assert.equal(typeof result.text, 'string')
    assert.notEqual(result.text.trim(), '', `/${spec.name} returned an empty body`)
  }
})

test('registerCommands returns a disposer, because register() does', (t) => {
  // The host's register() returns `this.layers.effect(...)` -- a Cordis effect
  // disposer. Pushing it and calling it on unload is therefore correct; if it
  // returned nothing, `dispose?.()` would silently no-op and the commands
  // would survive a plugin reload as stale duplicates.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-contract2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const disposed = []
  const commands = { register: (spec) => () => disposed.push(spec.name) }
  const dispose = registerCommands(commands, {
    mailbox: createMailbox({ file: join(dir, 'mail.jsonl') }),
    presence: createPresence({ dir: join(dir, 'peers') })
  }, DEFAULT_IDENTITY)
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(disposed.length, 4, 'unloading the plugin must remove all four commands')
})
