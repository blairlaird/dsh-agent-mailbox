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
 */
import { createServer } from 'node:http'

import { TOOLS, dispatch, agentCard } from './tools.js'
import { assertBindAllowed } from './auth.js'

const PROTOCOL_VERSION = '2024-11-05'
const ENDPOINT = '/mcp'
const RPC_PATHS = new Set(['/', ENDPOINT])

/** JSON-RPC's own code for "that method does not exist". */
const METHOD_NOT_FOUND = -32601

/**
 * @param deps - `{ mailbox, presence, attachments, notifier, auth }`
 * @returns `{ port, close() }`
 */
export async function startServer(deps, { host = '127.0.0.1', port = 4470 } = {}) {
  // Before any listener exists. A server that binds and then refuses requests
  // has already exposed the port.
  assertBindAllowed(host, deps.auth)

  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      void handle(deps, {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        // Bearer only. A token in the query string would end up in logs and
        // shell history, which is how a secret outlives its usefulness.
        token: (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined,
        body
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

async function handle(deps, { method, path, query, token, body }, response) {
  if (method === 'GET') return getRoute(deps, path, query, response)
  if (method !== 'POST') {
    return send(response, 405, { error: `method ${method} not supported`, endpoint: ENDPOINT })
  }

  let id
  try {
    const request = body === '' ? {} : JSON.parse(body)
    id = request.id

    // A JSON-RPC NOTIFICATION carries no id and must never be answered.
    // Replying to one -- even with an error -- derails a client's handshake.
    if (id === undefined) {
      response.writeHead(202, { 'content-length': 0 })
      response.end()
      return
    }

    respond(response, { jsonrpc: '2.0', id, result: await route(deps, request, token) })
  } catch (error) {
    if (id === undefined) { response.writeHead(202, { 'content-length': 0 }); response.end(); return }
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

async function getRoute(deps, path, query, response) {
  // The A2A agent card. Published so an Agent2Agent client can discover this
  // mailbox without prior configuration; it describes capabilities and
  // nothing about the machine it runs on.
  if (path === '/.well-known/agent.json' || path === '/agent-card') {
    return send(response, 200, agentCard({
      url: `http://127.0.0.1:${query.get('port') ?? ''}`.replace(/:$/, ''),
      // mailbox_wait is pull-by-held-request. It is not A2A push. Only the
      // configured delivery hook can wake a turn-based client after the
      // sender's request has completed, so advertise push only when that
      // hook is actually enabled.
      pushNotifications: deps.hook?.enabled === true
    }))
  }

  if (path === '/health') {
    const peers = deps.presence?.list() ?? []
    return send(response, 200, {
      summary: `mailbox ready — ${peers.filter((p) => p.live).length} live of ${peers.length} known peer(s)`,
      ready: true,
      authRequired: deps.auth?.required === true,
      peers
    })
  }

  if (RPC_PATHS.has(path)) {
    return send(response, 200, {
      name: 'dsh-agent-mailbox',
      version: '0.1.0',
      protocolVersion: PROTOCOL_VERSION,
      endpoint: ENDPOINT,
      transport: `JSON-RPC over POST to ${ENDPOINT} (POST / is also served)`,
      health: '/health',
      agentCard: '/.well-known/agent.json',
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
