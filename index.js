/**
 * dsh-agent-mailbox — durable agent-to-agent messaging for DeepSeek Harness.
 *
 * WHY
 *
 * An audit of 23 DSH messaging plugins found every one of them assumes the
 * participants are DSH sessions. Two agents driving the harness from outside —
 * an MCP client each — cannot address one another, so a human relays every
 * message by hand. Three capabilities were absent or nearly so across the
 * whole ecosystem: search (0 of 23), delivery receipts (2 of 23), and
 * redaction of secrets (1 of 23).
 *
 * This plugin covers all fourteen surveyed capabilities plus wake-on-message,
 * with zero runtime dependencies and no build step, so it installs anywhere.
 *
 * Design credit: the heartbeat registry, atomic temp+rename writes, and the
 * idea of stating a trust boundary in the system prompt come from
 * dsh-crosstalk (MIT, Jesse-njx). This is an independent implementation, not
 * a fork.
 *
 * TRUST MODEL — the property that matters most
 *
 * A message here was written by another agent. It is a REQUEST FROM A PEER,
 * never an instruction that outranks the user. Every reading tool says so in
 * its description, and TRUST_SECTION below is contributed to the system
 * prompt for in-harness agents. Leaving this out is how a mailbox becomes a
 * prompt-injection channel.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createMailbox, createPresence } from './src/mailbox.js'
import { createAttachmentStore } from './src/attachments.js'
import { createNotifier } from './src/notify.js'
import { createAuth } from './src/auth.js'
import { startServer } from './src/server.js'
import { TOOLS, dispatch, TRUST_NOTE } from './src/tools.js'

export const name = 'dsh-agent-mailbox'

// A flat ARRAY. The `{ required, optional }` object form is not supported by
// this Cordis: it reads the object's KEYS as service names, and the plugin
// hangs as "pending (waiting for services: required, optional)" — which takes
// the whole harness down with it.
export const inject = []

/** Contributed to the system prompt so in-harness agents inherit the rule. */
export const TRUST_SECTION =
  `Agent mailbox (dsh-agent-mailbox): messages from other agents arrive through mailbox_read / ` +
  `mailbox_wait. ${TRUST_NOTE}`

/**
 * Read a service this plugin does not inject.
 *
 * Cordis throws `cannot get property "x" without inject` for an undeclared
 * service, and optional chaining does NOT catch a throwing getter -- so
 * `ctx.tools?.register` still throws. That took the whole harness down the
 * first time this plugin was installed.
 *
 * Declaring `tools` in `inject` would be worse: a host without a tool
 * registry would then refuse to load the plugin at all, when the MCP surface
 * works perfectly well without it.
 */
function optionalService(ctx, name) {
  try { return ctx?.[name] } catch { return undefined }
}

/** Everything lives under one directory so it is trivial to inspect or delete. */
function resolveHome(config) {
  return config.home ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'agent-mailbox')
}

export function apply(ctx, config = {}) {
  const home = resolveHome(config)
  const file = join(home, 'mail.jsonl')

  const mailbox = createMailbox({ file })
  const presence = createPresence({ dir: join(home, 'peers') })
  const attachments = createAttachmentStore({ dir: join(home, 'attachments') })
  const notifier = createNotifier({ file, mailbox })

  // Tokens are supplied as HASHES in configuration, so the plaintext never
  // has to live in a config file the harness reads.
  const auth = createAuth({
    required: config.requireAuth === true,
    participants: config.participants ?? {}
  })

  const deps = { mailbox, presence, attachments, notifier, auth }

  // The doorbell holds an fs watcher; tie it to the plugin's life so nothing
  // outlives a reload.
  ctx.effect(() => () => notifier.close())

  // In-harness tools, so a DSH session is a peer like any other. Registered
  // only when the host offers a tool registry — the MCP surface is the
  // primary one and must not depend on this.
  //
  // Read through a try/catch, NOT `ctx.tools?.`: Cordis throws
  // "cannot get property \"tools\" without inject" on a service this plugin
  // does not declare, and optional chaining does not catch a throwing getter.
  // That took the whole harness down the first time this was installed.
  const tools = optionalService(ctx, 'tools')
  if (typeof tools?.register === 'function') {
    ctx.effect(() => {
      const disposers = TOOLS.map((tool) => tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        handler: (args) => dispatch(deps, tool.name, args)
      }))
      return () => { for (const dispose of disposers) dispose?.() }
    })
  }

  // The loopback surface. This is the capability nothing else in the
  // ecosystem had: an external MCP client joining as a peer.
  ctx.effect(async () => {
    const host = config.host ?? '127.0.0.1'
    const port = config.port ?? 4470
    try {
      const server = await startServer(deps, { host, port })
      ctx.logger?.info?.(`dsh-agent-mailbox: listening on http://${host}:${server.port} (mailbox at ${home})`)
      return () => server.close()
    } catch (error) {
      // A taken port or a refused bind must not take the harness down with
      // it: the in-harness tools still work, and the operator gets a line
      // naming the reason rather than a failed plugin tree.
      ctx.logger?.error?.(`dsh-agent-mailbox: ${error.message}`)
      return () => {}
    }
  })
}

export { createMailbox, createPresence, createNotifier, createAttachmentStore, createAuth, startServer, TOOLS, dispatch }
