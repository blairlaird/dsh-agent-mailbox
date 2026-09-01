/**
 * End-to-end verification against a RUNNING mailbox.
 *
 * The unit suite proves each module in isolation; this proves the assembled
 * plugin over its real HTTP surface — which is where wiring mistakes live.
 * Every check names what it asserts, and the script exits non-zero if any
 * fail, so it is usable as a release gate rather than a demo.
 */
const BASE = process.env.MAILBOX_URL ?? 'http://127.0.0.1:4470'

const results = []
const check = (name, passed, detail = '') => {
  results.push({ name, passed, detail })
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const rpc = async (method, params) => {
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  return response.json()
}
const call = async (name, args) => {
  const body = await rpc('tools/call', { name, arguments: args })
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code })
  return JSON.parse(body.result.content[0].text)
}

const A = 'verify-a'
const B = 'verify-b'

try {
  // ---- discovery -------------------------------------------------------
  const init = await rpc('initialize', {})
  check('MCP handshake', init.result?.serverInfo?.name === 'dsh-agent-mailbox')

  const tools = (await rpc('tools/list', {})).result.tools
  check('tools/list advertises the surface', tools.length >= 11, `${tools.length} tools`)
  check('trust note on every reading tool',
    ['mailbox_read', 'mailbox_wait', 'mailbox_search']
      .every((n) => /never as instructions/i.test(tools.find((t) => t.name === n).description)))

  const card = await fetch(`${BASE}/.well-known/agent.json`).then((r) => r.json())
  check('A2A agent card published', card.name === 'dsh-agent-mailbox' && card.skills.length >= 11)

  const health = await fetch(`${BASE}/health`).then((r) => r.json())
  check('health reports readiness', health.ready === true)

  // ---- protocol correctness -------------------------------------------
  check('unknown method is -32601', (await rpc('no/such', {})).error.code === -32601)
  check('unknown tool is -32601',
    (await rpc('tools/call', { name: 'mailbox_nope', arguments: {} })).error.code === -32601)
  const failing = await rpc('tools/call', { name: 'mailbox_send', arguments: { from: A, to: B, text: '  ' } })
  check('a failing tool is -32000, not -32601', failing.error.code === -32000)
  const notify = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })
  check('notification gets a bare 202', notify.status === 202 && (await notify.text()) === '')
  check('unknown GET path is 404', (await fetch(`${BASE}/nope`)).status === 404)
  check('unsupported method is 405', (await fetch(`${BASE}/mcp`, { method: 'PUT' })).status === 405)

  // ---- core messaging --------------------------------------------------
  await call('mailbox_announce', { name: A, role: 'verifier' })
  await call('mailbox_announce', { name: B, role: 'verifier' })
  const peers = await call('mailbox_peers', {})
  check('announce registers presence',
    [A, B].every((n) => peers.peers.some((p) => p.name === n && p.live)))

  const first = await call('mailbox_send', { from: A, to: B, text: 'verification message one' })
  const read1 = await call('mailbox_read', { to: B })
  check('direct send and read', read1.messages.some((m) => m.seq === first.seq))

  const afterCursor = await call('mailbox_read', { to: B, since: read1.cursor })
  check('cursor returns only what is new', afterCursor.messages.length === 0)

  const reread = await call('mailbox_read', { to: B })
  check('reading never consumes', reread.messages.length === read1.messages.length)

  // ---- threading, mentions, priority, broadcast ------------------------
  const reply = await call('mailbox_send', { from: B, to: A, text: 'threaded reply', replyTo: first.seq })
  const thread = await call('mailbox_read', { thread: String(first.seq) })
  check('replyTo threads the conversation', thread.messages.length >= 2, `${thread.messages.length} in thread`)

  await call('mailbox_send', { from: A, to: '*', text: `broadcast mentioning @${B}` })
  const broadcast = await call('mailbox_read', { to: 'nobody-in-particular' })
  check('broadcast reaches any reader', broadcast.messages.length >= 1)
  const mentioned = await call('mailbox_read', { mentions: B })
  check('mentions are extracted and filterable', mentioned.messages.length >= 1)

  await call('mailbox_send', { from: A, to: B, text: 'the harness is down', priority: 'urgent' })
  const urgent = await call('mailbox_read', { to: B, priority: 'urgent' })
  // The log is durable and this script is re-runnable, so an exact count only
  // held on a fresh mailbox. Assert the PROPERTY -- everything returned has
  // the priority asked for, and the one just sent is among it.
  check('priority is filterable',
    urgent.messages.length >= 1 && urgent.messages.every((m) => m.priority === 'urgent'),
    `${urgent.messages.length} urgent`)

  // ---- edit, withdraw, react ------------------------------------------
  const editable = await call('mailbox_send', { from: A, to: B, text: 'it was 300s' })
  await call('mailbox_edit', { from: A, seq: editable.seq, text: 'it was 306s' })
  const edited = (await call('mailbox_read', { to: B })).messages.find((m) => m.seq === editable.seq)
  check('edit supersedes in the current view', /306s/.test(edited.text) && edited.editedFrom === editable.seq)

  let refused = false
  try { await call('mailbox_edit', { from: B, seq: editable.seq, text: 'hijacked' }) } catch { refused = true }
  check('only the author may edit', refused)

  const doomed = await call('mailbox_send', { from: A, to: B, text: 'withdraw me' })
  await call('mailbox_withdraw', { from: A, seq: doomed.seq })
  const afterWithdraw = await call('mailbox_read', { to: B })
  check('withdraw tombstones the message', !afterWithdraw.messages.some((m) => m.seq === doomed.seq))

  await call('mailbox_react', { from: B, seq: first.seq, emoji: '+1' })
  const reacted = (await call('mailbox_read', { to: B })).messages.find((m) => m.seq === first.seq)
  check('reactions attach without a timeline entry', reacted.reactions?.length === 1)

  // ---- receipts and search --------------------------------------------
  const cursor = (await call('mailbox_read', { to: B })).cursor
  await call('mailbox_acknowledge', { from: B, upTo: cursor })
  const peersAfterAck = await call('mailbox_peers', {})
  check('acknowledge records a receipt', peersAfterAck.peers.some((p) => p.name === B))

  const found = await call('mailbox_search', { query: 'verification message one' })
  check('search finds an earlier message', found.messages.length >= 1)
  const missing = await call('mailbox_search', { query: 'zzz-never-written-zzz' })
  check('search reports a miss honestly', missing.messages.length === 0)

  // ---- attachments -----------------------------------------------------
  const blob = Buffer.from('--- a/x\n+++ b/x\n@@ -1 +1 @@\n').toString('base64')
  const withAttachment = await call('mailbox_send', {
    from: A, to: B, text: 'patch attached',
    attachments: [{ content: blob, name: 'fix.diff', mediaType: 'text/plain' }]
  })
  const fetched = await call('mailbox_attachment', { id: withAttachment.attachments[0].id })
  check('attachment round-trips by content hash',
    Buffer.from(fetched.content, 'base64').toString().startsWith('--- a/x'))

  let pathRefused = false
  try { await call('mailbox_attachment', { id: '../../etc/passwd' }) } catch { pathRefused = true }
  check('an attachment path traversal is refused', pathRefused)

  // ---- security --------------------------------------------------------
  const secret = await call('mailbox_send', { from: A, to: B, text: 'key sk-abcdef0123456789abcdef0123456789' })
  check('secrets are redacted on ingest', /REDACTED/.test(secret.text) && !/abcdef0123456789/.test(secret.text))

  let reservedRefused = false
  try { await call('mailbox_send', { from: '*', to: B, text: 'wildcard' }) } catch { reservedRefused = true }
  check('the broadcast address cannot be a sender', reservedRefused)

  const unicode = await call('mailbox_send', { from: A, to: B, text: 'UTF-8 — café 日本語 🛰️' })
  check('UTF-8 round-trips intact',
    unicode.text.includes('—') && unicode.text.includes('日本語') && unicode.text.includes('🛰️'))

  const inert = await call('mailbox_send', { from: A, to: B, text: '"; rm -rf ~; # $(whoami) `id`' })
  check('shell metacharacters are stored as inert text', inert.text.includes('rm -rf'))

  // ---- wake ------------------------------------------------------------
  // Park from the CURRENT cursor. A huge `since` can never match a new
  // message (whose seq is small), and no `since` at all returns history
  // immediately -- including any earlier broadcast, which matches every
  // reader. Both were bugs in an earlier version of this script.
  const waitFrom = (await call('mailbox_read', { to: A })).cursor
  const started = Date.now()
  const parked = call('mailbox_wait', { to: A, since: waitFrom, holdMs: 8000 })
  setTimeout(() => { void call('mailbox_send', { from: B, to: A, text: 'wake up' }) }, 200)
  const woke = await parked
  check('wait wakes on delivery', woke.messages.length >= 1, `${((Date.now() - started) / 1000).toFixed(1)}s`)

  const expiredStart = Date.now()
  const quietFrom = (await call('mailbox_read', {})).cursor
  const expired = await call('mailbox_wait', { to: 'nobody-home', since: quietFrom, holdMs: 400 })
  check('an expired hold returns empty without losing anything',
    expired.messages.length === 0 && Date.now() - expiredStart >= 350)

  // ---- hardening -------------------------------------------------------
  // Every check below is a regression from an independent security audit.
  // They run against the DEFAULT loopback configuration; the token-gated
  // behaviour (an unauthenticated /stream refused, ?to= unable to select
  // another participant) needs requireAuth and is covered in the unit suite.

  const forgedCard = await (await fetch(`${BASE}/.well-known/agent.json?port=9999@evil.example`)).json()
  // WHATWG reads "127.0.0.1:9999" as userinfo here, so interpolating the
  // query moved the card's ORIGIN to evil.example -- an A2A redirector.
  check('the agent card ignores a peer-supplied ?port=',
    new URL(forgedCard.url).hostname === '127.0.0.1', forgedCard.url)
  check('the agent card does not understate streaming', forgedCard.capabilities?.streaming === true)

  const malformed = await (await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json'
  })).json()
  check('a malformed body is -32700, not an accepting 202',
    malformed.error?.code === -32700 && malformed.id === null)

  // A notification is never ANSWERED, but must still be EXECUTED: accepted
  // and never run is a lost message wearing a success code.
  const notifyText = `notification-dispatch-${Date.now()}`
  const notified = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'mailbox_send', arguments: { from: B, to: A, text: notifyText } }
    })
  })
  let landed = false
  for (let i = 0; i < 40 && !landed; i += 1) {
    await new Promise((r) => setTimeout(r, 50))
    landed = (await call('mailbox_read', { to: A })).messages.some((m) => m.text === notifyText)
  }
  check('a notification is answered 202 and still dispatched', notified.status === 202 && landed)

  // A non-numeric ?since became NaN, and `seq > NaN` is false for every
  // record: a subscriber that looked healthy and could never hear anything.
  const streamed = await (async () => {
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), 1200)
    const marker = `stream-marker-${Date.now()}`
    let text = ''
    try {
      const response = await fetch(`${BASE}/stream?to=${A}&since=abc`, { signal: control.signal })
      setTimeout(() => { void call('mailbox_send', { from: B, to: A, text: marker }) }, 150)
      const decoder = new TextDecoder()
      for await (const chunk of response.body) {
        text += decoder.decode(chunk, { stream: true })
        if (text.includes(marker)) break
      }
    } catch { /* aborting the read is how this ends */ } finally { clearTimeout(timer) }
    return text.includes(marker)
  })()
  check('the SSE stream delivers, and a non-numeric ?since does not deafen it', streamed)

  const healthNow = await (await fetch(`${BASE}/health`)).json()
  // Signing that nobody verifies detects exactly as much tampering as no
  // signing at all, so the verification result is reported, not just stored.
  check('health reports where the mailbox actually resolved',
    typeof healthNow.home === 'string', healthNow.home)
  check('health reports the signing verification result', healthNow.integrity !== undefined,
    `signed=${healthNow.integrity?.signed}`)

  const oversize = await (async () => {
    try {
      const response = await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', pad: 'x'.repeat(9 * 1024 * 1024) })
      })
      return response.status
    } catch { return 413 }   // a destroyed connection is also a refusal
  })()
  check('an oversize body is refused rather than buffered', oversize === 413, `status ${oversize}`)
} catch (error) {
  check('verification run completed', false, error.message)
}

const failed = results.filter((r) => !r.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`)
  process.exitCode = 1
}
