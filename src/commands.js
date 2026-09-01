/**
 * Slash commands, so a DSH session is a participant like any external client.
 *
 * Without these the mailbox is reachable only over MCP, which means the two
 * agents can talk to each other but the person supervising them — working in a
 * DSH session — cannot join the conversation or even see it. A channel its
 * operator cannot read is a channel they cannot supervise.
 *
 * Registered through `ctx.commands`, read defensively: a host without a
 * command registry still gets the full MCP surface, and requiring the service
 * would refuse to load the plugin there.
 */
import { TRUST_NOTE } from './tools.js'

/** A DSH session's name in the mailbox, unless the operator sets one. */
export const DEFAULT_IDENTITY = 'dsh'

const ok = (text) => ({ kind: 'success', text })
const fail = (text) => ({ kind: 'error', text })

/**
 * @param commands - `ctx.commands`, already checked to exist.
 * @param deps - `{ mailbox, presence, hook }`
 * @param identity - who this session is in the mailbox.
 * @returns disposers, so unloading the plugin removes the commands.
 */
export function registerCommands(commands, deps, identity = DEFAULT_IDENTITY) {
  const { mailbox, presence, hook } = deps
  const disposers = []
  const add = (spec) => { disposers.push(commands.register(spec)) }

  add({
    name: 'mailbox',
    description: 'Read messages addressed to this session',
    input: { hint: '[--all]' },
    handler: (invocation) => {
      const raw = String(invocation.rawInput ?? '').trim()
      const seen = raw === '--all' ? 0 : (mailbox.receipts()[identity] ?? 0)
      const { messages, cursor } = mailbox.read({ to: identity, since: seen })

      if (messages.length === 0) {
        return ok(seen === 0
          ? `No messages for "${identity}".`
          : `Nothing new for "${identity}" since #${seen}. Use /mailbox --all for the whole history.`)
      }

      // Acknowledged on read, so the sender can tell an unread handoff from an
      // ignored one -- the receipt is the whole point of reading here.
      mailbox.acknowledge({ from: identity, upTo: cursor })

      const lines = messages.map((m) => {
        const when = new Date(m.at).toISOString().slice(11, 19)
        const thread = m.thread === undefined ? '' : ` [${m.thread}]`
        const flag = m.priority === undefined ? '' : ` (${m.priority})`
        return `#${m.seq} ${when} ${m.from} →${thread}${flag}\n${m.text}`
      })
      return ok([`${messages.length} message(s) for ${identity}`, '', ...lines, '', TRUST_NOTE].join('\n'))
    }
  })

  add({
    name: 'mailbox-send',
    description: 'Send a message to another agent',
    input: { hint: '<to> <message>' },
    handler: (invocation) => {
      const raw = String(invocation.rawInput ?? '').trim()
      const split = raw.indexOf(' ')
      if (split === -1) return fail('Usage: /mailbox-send <to> <message>. See /mailbox-peers for names.')

      const to = raw.slice(0, split)
      const text = raw.slice(split + 1).trim()
      if (text === '') return fail('Usage: /mailbox-send <to> <message>')

      try {
        const sent = mailbox.send({ from: identity, to, text })
        hook?.notify?.(sent)
        return ok(`Sent #${sent.seq} to ${to}.`)
      } catch (error) {
        // The mailbox's own refusals are the useful message here -- a reserved
        // name, an empty body -- so they are surfaced rather than wrapped.
        return fail(error.message)
      }
    }
  })

  add({
    name: 'mailbox-peers',
    description: 'Who else is on the mailbox, and who is live',
    handler: () => {
      const live = new Map(presence.list().map((p) => [p.name, p]))
      for (const p of mailbox.participants()) {
        if (!live.has(p.name)) live.set(p.name, { name: p.name, at: p.lastSeenAt, live: false })
      }
      if (live.size === 0) return ok('No participants yet.')

      const rows = [...live.values()].map((p) => {
        const unread = mailbox.unreadCount({ to: p.name })
        return `  ${p.live ? '●' : '○'} ${p.name}${p.role ? ` (${p.role})` : ''}` +
          `${unread > 0 ? ` — ${unread} unread` : ''}`
      })
      return ok([`You are "${identity}".`, '', ...rows, '', '● live  ○ quiet or never announced'].join('\n'))
    }
  })

  add({
    name: 'mailbox-search',
    description: 'Find an earlier message by its text',
    input: { hint: '<query>' },
    handler: (invocation) => {
      const query = String(invocation.rawInput ?? '').trim()
      if (query === '') return fail('Usage: /mailbox-search <query>')
      const found = mailbox.search(query, { limit: 20 })
      if (found.length === 0) return ok(`Nothing matching ${JSON.stringify(query)}.`)
      const lines = found.map((m) => `#${m.seq} ${m.from} → ${m.to}: ${m.text.slice(0, 160)}`)
      // The trust note belongs on EVERY surface that prints peer-written
      // text, not only /mailbox. Search results are message bodies with the
      // reassuring frame of a query the operator typed themselves, which if
      // anything makes the reminder more necessary here, not less.
      return ok([`${found.length} match(es)`, '', ...lines, '', TRUST_NOTE].join('\n'))
    }
  })

  return () => { for (const dispose of disposers) dispose?.() }
}
