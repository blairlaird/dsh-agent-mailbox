/**
 * The loopback surface: MCP for tools, plus an A2A agent card.
 *
 * This is the capability no plugin in the surveyed ecosystem had. Every other
 * option assumes the participants are DSH sessions; two agents driving the
 * harness from outside had no way to address each other. A small HTTP server
 * they can both reach is the whole difference.
 *
 * The port is CONFIGURED, never chosen. A server that silently moved would
 * recreate the discovery problem this exists to remove, so a taken port fails
 * loudly and names itself.
 *
 * Binding beyond loopback is refused unless tokens are configured — see
 * assertBindAllowed. On loopback the OS already decides who may connect; on a
 * LAN, nothing would.
 *
 * EVERY ROUTE THAT RETURNS MESSAGE CONTENT IS AUTHENTICATED, not just POST.
 * An independent audit found the reverse: POST /mcp refused an unauthorized
 * caller with -32000 while `GET /stream` — written later, as "just a read" —
 * never touched deps.auth and streamed the entire log to anyone who asked.
 * Gating it is only half the fix: a caller holding a valid token could still
 * pass `?to=someone-else`. So when auth is required the addressee is DERIVED
 * FROM THE RESOLVED IDENTITY and the query string cannot select it.
 */
import { createServer } from 'node:http'

import { TOOLS, dispatch, agentCard } from './tools.js'
import { assertBindAllowed } from './auth.js'
import { describeHome } from './home.js'

const PROTOCOL_VERSION = '2024-11-05'
const ENDPOINT = '/mcp'
const RPC_PATHS = new Set(['/', ENDPOINT])

/** JSON-RPC's own code for "that method does not exist". */
const METHOD_NOT_FOUND = -32601
/** ...and for "that was not JSON at all". */
const PARSE_ERROR = -32700

/**
 * Largest request body accepted, counted in BYTES as they arrive.
 *
 * Without this the handler concatenated every chunk into one string until the
 * client stopped sending, so a single request could exhaust the heap and take
 * the host process down — before authentication, which made it reachable by
 * anyone who could open a socket. The cap is checked per chunk and the
 * connection is destroyed, so nothing is buffered past the limit.
 *
 * The value admits one maximum-size attachment: 4 MiB of bytes is ~5.4 MiB
 * base64, plus the JSON-RPC envelope. Anything larger is a mistake or an
 * attack, and both deserve the same answer.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * Concurrent Server-Sent Events subscribers.
 *
 * Each open stream folds the whole log on every message, so unbounded
 * subscribers turn one send into unbounded work. This is a resource bound on
 * a TRANSPORT, not a limit on any conversation: a refused subscriber can
 * still read, wait, and send.
 */
const MAX_STREAMS = 32

/**
 * @param deps - `{ mailbox, presence, attachments, notifier, auth }`
 * @returns `{ port, close() }`
 */
export async function startServer(deps, { host = '127.0.0.1', port = 4470 } = {}) {
  // Before any listener exists. A server that binds and then refuses requests
  // has already exposed the port.
  assertBindAllowed(host, deps.auth)

  // Shared across requests: the only thing the routes may mutate.
  const state = { streams: 0, droppedNotifications: 0 }

  const server = createServer((request, response) => {
    let body = ''
    let bytes = 0
    let refused = false
    request.setEncoding('utf8')

    request.on('data', (chunk) => {
      if (refused) return
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_BODY_BYTES) {
        // Refuse and hang up. Reading the rest to be polite would be doing
        // the attacker's buffering for them.
        refused = true
        body = ''
        send(response, 413, {
          error: `request body exceeds the ${MAX_BODY_BYTES}-byte limit`,
          hint: 'attachments are capped at 4 MiB each; send a summary and a path instead'
        })
        request.destroy()
        return
      }
      body += chunk
    })

    request.on('error', () => { refused = true })

    request.on('end', () => {
      if (refused) return
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      void handle(deps, {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        // Bearer only. A token in the query string would end up in logs and
        // shell history, which is how a secret outlives its usefulness.
        token: (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined,
        body,
        port,
        state
      }, response)
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      // Close before rejecting: a server whose listen() failed still holds a
      // handle, which keeps the event loop alive and hangs the host.
      server.close(() => {})
      reject(error.code === 'EADDRINUSE'
        ? new Error(`dsh-agent-mailbox: port ${port} is already in use — free it or configure another`)
        : error)
    })
    server.listen(port, host, () => resolve({
      port,
      close: () => new Promise((done) => {
        server.closeAllConnections()
        server.close(done)
      })
    }))
  })
}

async function handle(deps, { method, path, query, token, body, port, state }, response) {
  if (method === 'GET') return getRoute(deps, { path, query, token, port, state }, response)
  if (method !== 'POST') {
    return send(response, 405, { error: `method ${method} not supported`, endpoint: ENDPOINT })
  }

  // A body that is not JSON is a PARSE ERROR with a null id, which is what
  // JSON-RPC says and what a client can act on. Answering 202 instead — as
  // this did — told the caller "accepted" about a request that was never
  // understood, so a malformed client looked like a working one.
  let request
  try {
    request = body === '' ? {} : JSON.parse(body)
  } catch (error) {
    return respond(response, {
      jsonrpc: '2.0',
      id: null,
      error: { code: PARSE_ERROR, message: `Parse error: ${error.message}` }
    })
  }

  const id = request?.id

  // A JSON-RPC NOTIFICATION carries no id and must never be ANSWERED --
  // replying to one, even with an error, derails a client's handshake. It
  // must still be EXECUTED: dropping it silently meant a `tools/call` sent
  // without an id was accepted and never ran, which is a lost message
  // wearing a success code.
  //
  // The 202 goes first so a notification cannot park the caller: dispatch
  // happens after, and its outcome has nowhere to be reported by definition.
  if (id === undefined) {
    response.writeHead(202, { 'content-length': 0 })
    response.end()
    try {
      await route(deps, request ?? {}, token)
    } catch (error) {
      // THE REPLY CHANNEL IS CLOSED. THE OPERATOR'S IS NOT.
      //
      // JSON-RPC forbids answering a notification, so this failure cannot go
      // back to the caller -- and swallowing it meant a mailbox_send with a
      // wrong field name wrote nothing, errored nothing, and returned "202
      // Accepted". A send that neither writes nor reports is the worst
      // failure this plugin can have, and it was reported from the field
      // rather than caught here, which is the reason it is counted as well
      // as logged: an operator who never reads the log still sees a number
      // on GET /health that is not zero.
      state.droppedNotifications += 1
      const tool = request?.params?.name ?? request?.method ?? 'unknown'
      deps.logger?.error?.(
        `dsh-agent-mailbox: dropped a notification for "${tool}" — ${error.message}. ` +
        'JSON-RPC cannot answer a request sent without an "id"; resend it with one to get the error back.'
      )
    }
    return
  }

  try {
    respond(response, { jsonrpc: '2.0', id, result: await route(deps, request, token) })
  } catch (error) {
    respond(response, {
      jsonrpc: '2.0',
      id,
      // "No such method" is a different answer from "your request failed".
      error: { code: error.rpcCode ?? -32000, message: error.message }
    })
  }
}

async function route(deps, { method, params = {} }, token) {
  switch (method) {
    case 'initialize':
      return {
        // Echo the client's version when it names one: forcing our own on a
        // newer client fails a handshake for no reason.
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-agent-mailbox', version: '0.1.0' }
      }

    case 'tools/list':
      return { tools: TOOLS }

    case 'tools/call': {
      const identity = authenticate(deps, params.arguments, token)
      const value = await dispatch(deps, params.name, params.arguments ?? {}, identity)
      return { content: [{ type: 'text', text: JSON.stringify(value, undefined, 2) }] }
    }

    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: METHOD_NOT_FOUND })
  }
}

/**
 * Resolve the caller to an identity, or refuse.
 *
 * The refusal is -32000 rather than a bare throw so a client sees a real
 * JSON-RPC error naming the reason, instead of a generic failure it cannot
 * act on.
 */
function authenticate(deps, args = {}, token) {
  const claimed = args?.from ?? args?.name ?? args?.to
  const result = deps.auth?.authenticate({ claimed, token }) ?? { ok: true, identity: claimed }
  if (!result.ok) throw new Error(`unauthorized: ${result.reason}`)
  return result.identity
}

/**
 * Resolve a GET caller, for the routes that return message content.
 *
 * With auth off this is a no-op and the claimed name stands: on loopback the
 * OS already decided who may connect, and requiring a token there would break
 * the default single-machine case for no gain.
 *
 * With auth on, the resolved identity REPLACES the claim. That is the half of
 * the fix that is easy to miss — gating the route still lets any token holder
 * read another participant's mail by asking for it.
 *
 * @returns `{ ok: true, identity }` or `{ ok: false, reason }`.
 */
function authorizeRead(deps, claimed, token) {
  if (deps.auth?.required !== true) return { ok: true, identity: claimed }
  return deps.auth.authenticate({ claimed, token })
}

/** 401 with the reason named: a refusal a caller cannot diagnose is a bug report. */
function refuse(response, reason) {
  const text = JSON.stringify({ error: `unauthorized: ${reason}`, hint: 'send Authorization: Bearer <token>' }, undefined, 2)
  response.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer',
    'content-length': Buffer.byteLength(text)
  })
  response.end(text)
}

async function getRoute(deps, { path, query, token, port, state }, response) {
  // The A2A agent card. Published so an Agent2Agent client can discover this
  // mailbox without prior configuration; it describes capabilities and
  // nothing about the machine it runs on.
  //
  // The advertised url is built from the port this server is ACTUALLY
  // listening on, never from the query string. Interpolating `?port=` let a
  // caller write `4470@evil.example`, which WHATWG parses as userinfo — so
  // the card's origin became evil.example and the card became a redirector.
  if (path === '/.well-known/agent.json' || path === '/agent-card') {
    return send(response, 200, agentCard({
      url: `http://127.0.0.1:${port}`,
      // mailbox_wait is pull-by-held-request. It is not A2A push. Only the
      // configured delivery hook can wake a turn-based client after the
      // sender's request has completed, so advertise push only when that
      // hook is actually enabled.
      pushNotifications: deps.hook?.enabled === true
    }))
  }

  // SERVER-SENT EVENTS. The push transport: a client subscribes once and the
  // server writes each new message as it lands, instead of the client asking
  // repeatedly. mailbox_wait is the request/reply form of the same thing --
  // this is for clients that can hold a stream.
  //
  // No deadline: the stream stays open until the client disconnects or the
  // plugin unloads. Heartbeat comments keep intermediaries from closing an
  // idle connection, and are comments precisely so they cannot be mistaken
  // for a message.
  if (path === '/stream') {
    const allowed = authorizeRead(deps, query.get('to') ?? undefined, token)
    if (!allowed.ok) return refuse(response, allowed.reason)
    const to = allowed.identity ?? undefined

    if (state.streams >= MAX_STREAMS) {
      return send(response, 503, {
        error: `too many open streams (${MAX_STREAMS})`,
        hint: 'use mailbox_wait or mailbox_read; no message is lost by not streaming'
      })
    }

    // A non-numeric ?since produced NaN, and `seq > NaN` is false for every
    // record -- a subscriber that was permanently deaf while looking healthy.
    const asked = Number(query.get('since') ?? 0)
    let cursor = Number.isFinite(asked) && asked >= 0 ? asked : 0

    state.streams += 1
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.write(': connected\n\n')

    const push = () => {
      // The cursor advances only past messages ACTUALLY WRITTEN to this
      // stream. It used to take mailbox.read()'s cursor, which is the log's
      // high-water mark -- so anything past the page limit was skipped
      // forever, silently, and only under load. Draining in pages is what
      // makes the two agree.
      for (let page = 0; page < 1000; page += 1) {
        let sent = 0
        const { messages, more } = deps.mailbox.read({ to, since: cursor, limit: 200 })
        for (const message of messages) {
          response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
          cursor = Math.max(cursor, message.seq ?? 0)
          sent += 1
        }
        if (sent === 0 || more === undefined) return
      }
    }

    // Deliver anything already waiting BEFORE subscribing, or a message that
    // arrived between the client's cursor and this connection is skipped.
    push()
    const unsubscribe = deps.notifier.subscribe(push)
    // Heartbeat COMMENTS keep an intermediary from closing an idle stream.
    // Comments precisely so they can never be mistaken for a message.
    const beat = setInterval(() => response.write(': beat\n\n'), 20000)
    beat.unref?.()

    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      state.streams -= 1
      clearInterval(beat)
      unsubscribe()
    }
    response.on('close', stop)
    response.on('error', stop)
    return undefined
  }

  if (path === '/health') {
    // Gated for the same reason as /stream: the peer roster names every
    // participant, which is exactly the list an attacker needs to address
    // one. With auth off it stays open, because loopback already decided.
    const allowed = authorizeRead(deps, undefined, token)
    if (!allowed.ok) return refuse(response, allowed.reason)

    const peers = deps.presence?.list() ?? []
    // The resolved directory is reported on EVERY health check. A mailbox
    // that silently split into two app containers is invisible otherwise --
    // both halves look healthy, and each one is missing the other's history.
    const where = describeHome(deps.home)
    return send(response, 200, {
      summary: `mailbox ready — ${peers.filter((p) => p.live).length} live of ${peers.length} known peer(s)` +
        (where.virtualized ? ` — WARNING: sandboxed mailbox (${where.container})` : ''),
      ready: true,
      ...where,
      authRequired: deps.auth?.required === true,
      streams: state.streams,
      // Non-zero means messages were accepted and silently dropped. See the
      // notification branch in handle() for why they cannot be answered.
      droppedNotifications: state.droppedNotifications,
      // The read side of signing. A `sig` field nobody checks detects exactly
      // as much tampering as no signature at all, so the verification result
      // is reported where an operator will actually see it rather than
      // waiting to be asked. `signed: false` means no secret is configured --
      // it is not an all-clear.
      integrity: deps.mailbox?.integrity?.() ?? { signed: false },
      peers
    })
  }

  // The descriptor carries no message content and no peer names, so it stays
  // open: a client has to be able to learn how to authenticate.
  if (RPC_PATHS.has(path)) {
    return send(response, 200, {
      name: 'dsh-agent-mailbox',
      version: '0.1.0',
      protocolVersion: PROTOCOL_VERSION,
      endpoint: ENDPOINT,
      transport: `JSON-RPC over POST to ${ENDPOINT} (POST / is also served)`,
      health: '/health',
      agentCard: '/.well-known/agent.json',
      stream: '/stream',
      authRequired: deps.auth?.required === true,
      tools: TOOLS.map((t) => t.name)
    })
  }

  return send(response, 404, {
    error: `no route for GET ${path}`,
    endpoint: ENDPOINT,
    health: '/health',
    agentCard: '/.well-known/agent.json'
  })
}

/** A non-JSON-RPC answer: plain JSON, pretty-printed because people read these. */
function send(response, status, payload) {
  const text = JSON.stringify(payload, undefined, 2)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

function respond(response, payload) {
  const text = JSON.stringify(payload)
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}
