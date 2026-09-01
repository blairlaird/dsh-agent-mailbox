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
import { createDeliveryHook } from './src/hook.js'
import { startServer } from './src/server.js'
import { TOOLS, dispatch, TRUST_NOTE } from './src/tools.js'
import { registerCommands, DEFAULT_IDENTITY } from './src/commands.js'
import { describeHome } from './src/home.js'

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
 * `ctx.reflect.get(name)` is the SUPPORTED read: Cordis documents it as
 * "read a service from the store without the inject requirement". It returns
 * undefined instead of throwing, so it needs no try/catch of its own -- the
 * one here only guards a host that has no reflect service at all.
 *
 * NOTE what this is NOT good enough for: a service that is provided LATER
 * than this plugin loads reads as absent here, permanently. For anything the
 * plugin actually needs, use ctx.inject() -- see the commands wiring below.
 */
function optionalService(ctx, name) {
  try { return ctx?.reflect?.get?.(name) } catch { return undefined }
}

/** Everything lives under one directory so it is trivial to inspect or delete. */
function resolveHome(config) {
  return config.home ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'agent-mailbox')
}

export function apply(ctx, config = {}) {
  const home = resolveHome(config)
  const file = join(home, 'mail.jsonl')

  // signingSecret and maxRecords were ACCEPTED IN CONFIG AND DROPPED HERE, so
  // the README's "HMAC message signing" and "retention / compaction" were
  // claims about code that never ran: an operator could set a signing secret,
  // see no error, and get an unsigned log. Passing them through is the whole
  // fix; mailbox.integrity() is the read side, reported by GET /health.
  const mailbox = createMailbox({
    file,
    signingSecret: config.signingSecret,
    maxRecords: config.maxRecords
  })
  const presence = createPresence({ dir: join(home, 'peers') })
  const attachments = createAttachmentStore({ dir: join(home, 'attachments') })
  const notifier = createNotifier({ file, mailbox })

  // Tokens are supplied as HASHES in configuration, so the plaintext never
  // has to live in a config file the harness reads.
  const auth = createAuth({
    required: config.requireAuth === true,
    participants: config.participants ?? {}
  })

  // Wakes a turn-based client on delivery. mailbox_wait only serves callers
  // that can PARK on an open request; most MCP clients only exist while
  // answering their user, so without this a message between turns is stored
  // and never read -- indistinguishable from broken.
  //
  // argv array, never a string, and content travels in the environment: a
  // command string with the message interpolated would be a remote shell for
  // anyone who can send a message.
  const hook = createDeliveryHook({
    command: config.notifyCommand,
    cwd: config.notifyCwd,
    logger: ctx.logger
  })

  // Say where the mailbox is, every time, and say loudly when that answer is
  // container-relative -- two agents each launching the harness otherwise get
  // two different mailboxes at the same nominal path and neither can tell.
  const where = describeHome(home)
  if (where.virtualized) ctx.logger?.error?.(`dsh-agent-mailbox: ${where.warning}`)

  // The logger travels in deps so the SERVER can report what it cannot answer.
  // A JSON-RPC notification has no reply channel; without this, a tools/call
  // that failed had nowhere at all to be reported and vanished behind a 202.
  const deps = { mailbox, presence, attachments, notifier, auth, hook, home, logger: ctx.logger }

  // The doorbell holds an fs watcher; tie it to the plugin's life so nothing
  // outlives a reload.
  ctx.effect(() => () => notifier.close())

  // Slash commands, so a DSH session is a participant like any external
  // client -- and so the person supervising two agents can read the channel
  // they are supervising. Without this the mailbox is MCP-only and invisible
  // from inside the harness.
  //
  // ctx.inject(), NOT a plain read, and NOT `commands` in this plugin's own
  // `inject`. Each of the other three shapes is wrong in its own way, and two
  // of them have already been shipped:
  //
  //   ctx.commands              throws "cannot get property \"commands\"
  //                             without inject" and takes the harness down.
  //   try { ctx.commands }      never throws and never WORKS: Cordis gates
  //                             service access on the declaration, so the
  //                             read is undefined every time and the commands
  //                             silently never register. Shipped, and only
  //                             caught by typing /mailbox-peers into a live
  //                             session and watching the model try to grep
  //                             for it.
  //   export const inject =     works here, and refuses to load the plugin at
  //     ['commands']            all on a host with no command registry --
  //                             losing the MCP surface, which needs nothing.
  //
  // ctx.inject() starts a CHILD fiber that waits for the service. On a host
  // that provides commands, they register as soon as it appears -- load order
  // stops mattering. On a host that never does, only the child stays pending
  // and everything else here runs. That is the whole point.
  const identity = config.identity ?? DEFAULT_IDENTITY
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (scoped) => {
      scoped.effect(() => registerCommands(scoped.commands, deps, identity))
    })
  } else {
    // Not Cordis, or a host too old to have the registry mixin. Fall back to
    // the direct read rather than skipping silently -- if the service happens
    // to be there already, the commands still work.
    const commands = optionalService(ctx, 'commands')
    if (typeof commands?.register === 'function') {
      ctx.effect(() => registerCommands(commands, deps, identity))
    }
  }

  // The loopback surface. This is the capability nothing else in the
  // ecosystem had: an external MCP client joining as a peer.
  ctx.effect(async () => {
    const host = config.host ?? '127.0.0.1'
    const port = config.port ?? 4470
    try {
      const server = await startServer(deps, { host, port })
      ctx.logger?.info?.(`dsh-agent-mailbox: listening on http://${host}:${server.port} — mailbox at ${home}`)
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
