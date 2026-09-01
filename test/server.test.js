/**
 * The loopback surface.
 *
 * This is the capability no plugin in the surveyed ecosystem had: an external
 * MCP client joining as a peer. The tests cover the protocol contract, the
 * A2A card, and the refusals that keep the server safe to run.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer } from '../src/server.js'
import { createMailbox, createPresence } from '../src/mailbox.js'
import { createAttachmentStore } from '../src/attachments.js'
import { createNotifier } from '../src/notify.js'
import { createAuth, issueToken, hashToken } from '../src/auth.js'
import { createDeliveryHook } from '../src/hook.js'

/** Always closes, so a failing assertion cannot hang the whole run. */
const withServer = async (t, port, body, { auth, hook } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-srv-'))
  const file = join(dir, 'mail.jsonl')
  const mailbox = createMailbox({ file })
  const notifier = createNotifier({ file, mailbox })
  const deps = {
    mailbox,
    presence: createPresence({ dir: join(dir, 'peers') }),
    attachments: createAttachmentStore({ dir: join(dir, 'blobs') }),
    notifier,
    auth: auth ?? createAuth({ required: false }),
    hook: hook ?? createDeliveryHook({})
  }
  const server = await startServer(deps, { host: '127.0.0.1', port })
  try { return await body({ server, deps, port }) } finally {
    notifier.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const rpc = (port, method, params, token) => fetch(`http://127.0.0.1:${port}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...token ? { authorization: `Bearer ${token}` } : {} },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
}).then((r) => r.json())

const call = (port, name, args, token) => rpc(port, 'tools/call', { name, arguments: args }, token)
const payload = (body) => JSON.parse(body.result.content[0].text)

test('the handshake identifies the mailbox', async (t) => {
  await withServer(t, 4601, async ({ port }) => {
    const body = await rpc(port, 'initialize', {})
    assert.equal(body.result.serverInfo.name, 'dsh-agent-mailbox')
    assert.ok(body.result.capabilities.tools)
  })
})

test('tools/list advertises the full surface', async (t) => {
  await withServer(t, 4602, async ({ port }) => {
    const names = (await rpc(port, 'tools/list', {})).result.tools.map((x) => x.name)
    for (const expected of ['mailbox_send', 'mailbox_read', 'mailbox_wait', 'mailbox_search', 'mailbox_peers']) {
      assert.ok(names.includes(expected), `missing ${expected}`)
    }
  })
})

test('every reading tool carries the trust warning', async (t) => {
  // Without this a mailbox is a prompt-injection channel: content written by
  // another agent would arrive with nothing marking it as untrusted.
  await withServer(t, 4603, async ({ port }) => {
    const tools = (await rpc(port, 'tools/list', {})).result.tools
    for (const name of ['mailbox_read', 'mailbox_wait', 'mailbox_search']) {
      const tool = tools.find((x) => x.name === name)
      assert.match(tool.description, /never as instructions/i, `${name} must warn`)
    }
  })
})

test('a message sent over MCP is readable over MCP', async (t) => {
  await withServer(t, 4604, async ({ port }) => {
    await call(port, 'mailbox_send', { from: 'codex', to: 'claude', text: 'seat startup evidence landed' })
    const read = payload(await call(port, 'mailbox_read', { to: 'claude' }))
    assert.equal(read.messages.length, 1)
    assert.match(read.messages[0].text, /seat startup/)
  })
})

test('an unknown method is -32601, immediately', async (t) => {
  await withServer(t, 4605, async ({ port }) => {
    const body = await rpc(port, 'no/such/method', {})
    assert.equal(body.error.code, -32601)
  })
})

test('an unknown tool is -32601 too', async (t) => {
  await withServer(t, 4606, async ({ port }) => {
    assert.equal((await call(port, 'mailbox_nope', {})).error.code, -32601)
  })
})

test('a failing tool is -32000, not -32601', async (t) => {
  // "No such name" and "your request failed" are different answers.
  await withServer(t, 4607, async ({ port }) => {
    const body = await call(port, 'mailbox_send', { from: 'claude', to: 'codex', text: '   ' })
    assert.equal(body.error.code, -32000)
  })
})

test('a notification is answered with a bare 202', async (t) => {
  await withServer(t, 4608, async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    })
    assert.equal(response.status, 202)
    assert.equal(await response.text(), '')
  })
})

test('the A2A agent card does not claim push when no delivery hook is configured', async (t) => {
  await withServer(t, 4609, async ({ port }) => {
    const card = await fetch(`http://127.0.0.1:${port}/.well-known/agent.json`).then((r) => r.json())
    assert.equal(card.name, 'dsh-agent-mailbox')
    assert.ok(card.skills.length >= 10, 'the card advertises the tools as skills')
    assert.equal(card.capabilities.pushNotifications, false)
  })
})

test('the A2A agent card claims push only when the delivery hook is enabled', async (t) => {
  const hook = createDeliveryHook({ command: ['node', 'notify.mjs'] })
  await withServer(t, 4623, async ({ port }) => {
    const card = await fetch(`http://127.0.0.1:${port}/.well-known/agent.json`).then((r) => r.json())
    assert.equal(card.capabilities.pushNotifications, true)
  }, { hook })
})

test('the descriptor names the endpoint, health and card', async (t) => {
  await withServer(t, 4610, async ({ port }) => {
    const body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json())
    assert.equal(body.endpoint, '/mcp')
    assert.equal(body.agentCard, '/.well-known/agent.json')
  })
})

test('health reports peers rather than a bare ok', async (t) => {
  await withServer(t, 4611, async ({ port }) => {
    await call(port, 'mailbox_announce', { name: 'claude', role: 'mcp-client' })
    const body = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json())
    assert.equal(body.ready, true)
    assert.match(body.summary, /1 live/)
  })
})

test('an unknown GET path is a 404 that points at what works', async (t) => {
  await withServer(t, 4612, async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/nope`)
    assert.equal(response.status, 404)
    assert.ok((await response.json()).endpoint)
  })
})

test('an unsupported HTTP method is refused', async (t) => {
  await withServer(t, 4613, async ({ port }) => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'PUT' })).status, 405)
  })
})

test('with auth on, a call without a token is refused', async (t) => {
  const token = issueToken()
  const auth = createAuth({ required: true, participants: { codex: hashToken(token) } })
  await withServer(t, 4614, async ({ port }) => {
    const body = await call(port, 'mailbox_send', { from: 'codex', to: 'claude', text: 'hi' })
    assert.equal(body.error.code, -32000)
    assert.match(body.error.message, /unauthorized/i)
  }, { auth })
})

test('with auth on, a valid token succeeds', async (t) => {
  const token = issueToken()
  const auth = createAuth({ required: true, participants: { codex: hashToken(token) } })
  await withServer(t, 4615, async ({ port }) => {
    const body = await call(port, 'mailbox_send', { from: 'codex', to: 'claude', text: 'authenticated' }, token)
    assert.equal(payload(body).from, 'codex')
  }, { auth })
})

test('a token cannot be used to send as someone else', async (t) => {
  // The authenticated identity overrides the claimed one, and a mismatch is
  // refused rather than quietly rewritten.
  const token = issueToken()
  const auth = createAuth({ required: true, participants: { codex: hashToken(token) } })
  await withServer(t, 4616, async ({ port }) => {
    const body = await call(port, 'mailbox_send', { from: 'claude', to: 'claude', text: 'impersonation' }, token)
    assert.match(body.error.message, /belongs to "codex"/)
  }, { auth })
})

test('an attachment round-trips by content hash', async (t) => {
  await withServer(t, 4617, async ({ port }) => {
    const content = Buffer.from('--- a/x\n+++ b/x\n').toString('base64')
    const sent = payload(await call(port, 'mailbox_send', {
      from: 'codex', to: 'claude', text: 'patch attached',
      attachments: [{ content, name: 'fix.diff', mediaType: 'text/plain' }]
    }))
    assert.equal(sent.attachments.length, 1)
    const got = payload(await call(port, 'mailbox_attachment', { id: sent.attachments[0].id }))
    assert.equal(Buffer.from(got.content, 'base64').toString(), '--- a/x\n+++ b/x\n')
  })
})

test('an attachment id that is not a hash is refused over the wire', async (t) => {
  await withServer(t, 4618, async ({ port }) => {
    const body = await call(port, 'mailbox_attachment', { id: '../../etc/passwd' })
    assert.equal(body.error.code, -32000)
    assert.match(body.error.message, /sha256/i)
  })
})

test('wait returns as soon as a peer sends', async (t) => {
  await withServer(t, 4619, async ({ port }) => {
    const waiting = call(port, 'mailbox_wait', { to: 'claude', holdMs: 8000 })
    setTimeout(() => { void call(port, 'mailbox_send', { from: 'codex', to: 'claude', text: 'wake' }) }, 60)
    const got = payload(await waiting)
    assert.equal(got.messages.length, 1)
    assert.match(got.messages[0].text, /wake/)
  })
})

test('search finds an earlier message over the wire', async (t) => {
  await withServer(t, 4620, async ({ port }) => {
    await call(port, 'mailbox_send', { from: 'codex', to: 'claude', text: 'the undici ceiling was 300s' })
    const got = payload(await call(port, 'mailbox_search', { query: 'undici' }))
    assert.equal(got.messages.length, 1)
  })
})

test('peers merges announced presence with who has spoken', async (t) => {
  await withServer(t, 4621, async ({ port }) => {
    await call(port, 'mailbox_announce', { name: 'claude' })
    await call(port, 'mailbox_send', { from: 'codex', to: 'claude', text: 'hello' })
    const names = payload(await call(port, 'mailbox_peers', {})).peers.map((p) => p.name).sort()
    assert.deepEqual(names, ['claude', 'codex'])
  })
})

test('binding beyond loopback without auth is refused before listening', async () => {
  // The refusal must happen at startup, not on the first request: a server
  // that binds and then rejects has already exposed the port.
  await assert.rejects(
    startServer({ auth: createAuth({ required: false }) }, { host: '0.0.0.0', port: 4622 }),
    /without authentication/i)
})
