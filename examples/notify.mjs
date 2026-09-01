/**
 * Example notifyCommand hook.
 *
 * The plugin runs this on every delivery. The message arrives in the
 * ENVIRONMENT, never on the command line — nothing a peer writes is ever
 * parsed as a command.
 *
 * This one appends a line to a file, which is enough to prove the hook fired
 * and enough to drive a desktop notifier, a webhook, or a wake-up for a
 * turn-based client.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const line = JSON.stringify({
  at: new Date().toISOString(),
  seq: process.env.MAILBOX_SEQ,
  from: process.env.MAILBOX_FROM,
  to: process.env.MAILBOX_TO,
  thread: process.env.MAILBOX_THREAD || undefined,
  priority: process.env.MAILBOX_PRIORITY || undefined,
  text: (process.env.MAILBOX_TEXT ?? '').slice(0, 200)
})

appendFileSync(process.env.MAILBOX_NOTIFY_LOG ?? join(tmpdir(), 'mailbox-notify.log'), line + '\n', 'utf8')
