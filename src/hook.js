/**
 * Notify on delivery, so a turn-based client can be woken.
 *
 * `mailbox_wait` quietly assumes a caller that can PARK on an open request.
 * A loop-driven agent can; most MCP clients cannot — they only exist while
 * answering their user, so a message arriving between turns is durably stored
 * and never read. Delivered but unread is indistinguishable from broken.
 *
 * This runs an operator-configured command whenever a message lands, which is
 * the generalisation of hand-wiring a file watcher: it works for any client
 * shape rather than only loop-driven ones.
 *
 * THE INJECTION HAZARD, and why this is shaped the way it is:
 *
 * The obvious implementation is a command string with the message
 * interpolated — `notify.sh "$text"` — and it is a remote shell for anyone
 * who can send a message. A peer writes `"; rm -rf ~; #` and it runs.
 *
 * So: the command is executed with `shell: false` and a fixed argv, and the
 * message reaches it through the ENVIRONMENT, never through the command line.
 * Nothing a peer writes is ever parsed as a command by anything.
 */
import { spawn } from 'node:child_process'

/** Environment values are bounded: a hook is a doorbell, not a delivery van. */
const MAX_ENV = 4000

/**
 * @param command - argv array, e.g. `['node', 'notify.mjs']`. A STRING is
 *   refused: accepting one would mean splitting it, and splitting is where
 *   quoting bugs become injection.
 * @param spawnFn - injected for tests.
 */
export function createDeliveryHook({ command, cwd, spawnFn = spawn, logger } = {}) {
  if (command === undefined) return { enabled: false, notify() {} }

  if (!Array.isArray(command) || command.length === 0 || command.some((a) => typeof a !== 'string')) {
    throw new Error(
      'dsh-agent-mailbox: notifyCommand must be an array of strings, e.g. ["node", "notify.mjs"]. ' +
      'A single string would have to be split into arguments, and that is where quoting turns into injection.'
    )
  }

  const [file, ...args] = command

  return {
    enabled: true,

    /**
     * Fire-and-forget. A hook that fails, hangs, or is missing must never
     * affect delivery: the message is already durably stored by the time this
     * runs, and a doorbell that breaks the door is worse than no doorbell.
     */
    notify(message) {
      try {
        const child = spawnFn(file, args, {
          cwd,
          // NEVER a shell. With `shell: true`, argv is re-parsed and any
          // metacharacter a peer wrote becomes syntax.
          shell: false,
          stdio: 'ignore',
          detached: false,
          env: {
            ...process.env,
            // Content travels here, never on the command line.
            MAILBOX_FROM: String(message?.from ?? '').slice(0, MAX_ENV),
            MAILBOX_TO: String(message?.to ?? '').slice(0, MAX_ENV),
            MAILBOX_SEQ: String(message?.seq ?? ''),
            MAILBOX_THREAD: String(message?.thread ?? '').slice(0, MAX_ENV),
            MAILBOX_PRIORITY: String(message?.priority ?? ''),
            MAILBOX_TEXT: String(message?.text ?? '').slice(0, MAX_ENV)
          }
        })
        // An unhandled 'error' on a child is an uncaught exception that would
        // take the host down — the exact opposite of best-effort.
        child.on?.('error', (error) => logger?.error?.(`dsh-agent-mailbox: notify hook failed: ${error.message}`))
        child.unref?.()
      } catch (error) {
        logger?.error?.(`dsh-agent-mailbox: notify hook could not start: ${error.message}`)
      }
    }
  }
}
