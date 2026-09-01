/**
 * Waking an idle agent when a message arrives.
 *
 * A mailbox nobody watches is a mailbox somebody has to remember to check.
 * If a peer sends a handoff while the other agent is idle, polling on a timer
 * means the reply is late by however long the timer is, and polling tightly
 * burns turns to learn nothing.
 *
 * So this watches the log file and resolves the moment a new record lands.
 *
 * ON THE BOUND, because this plugin's sibling refuses execution deadlines and
 * the distinction matters: `waitFor` takes a `holdMs` and returns EMPTY when
 * it expires. That is a TRANSPORT bound — how long one HTTP request parks
 * before answering "nothing yet, ask again" — not a limit on work. No message
 * is dropped, no job is cancelled, and the caller's cursor is unchanged, so
 * an expired wait and a fresh one are indistinguishable to the conversation.
 * A deadline that ends work is forbidden; a deadline that ends a *poll* is
 * what keeps a connection from being held open forever.
 */
import { watch, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** How long one long-poll parks before answering "nothing yet". */
export const DEFAULT_HOLD_MS = 25_000

/**
 * @param file - the mailbox log to watch.
 * @param mailbox - a mailbox to read through, so filters stay in one place.
 */
export function createNotifier({ file, mailbox } = {}) {
  const listeners = new Set()
  let watcher

  function ensureWatching() {
    if (watcher !== undefined || file === undefined) return
    // The log may not exist until the first send; watch the directory so the
    // very first message still wakes a waiter.
    mkdirSync(dirname(file), { recursive: true })
    try {
      watcher = watch(dirname(file), { persistent: false }, () => {
        for (const notify of [...listeners]) notify()
      })
    } catch {
      // A platform or sandbox without file watching degrades to the caller's
      // own polling. Losing the doorbell must not lose the mailbox.
      watcher = undefined
    }
  }

  return {
    /**
     * Resolve as soon as a matching message exists after `since`.
     *
     * @returns the same shape as `mailbox.read`, empty when the hold expires.
     */
    async waitFor({ since = 0, holdMs = DEFAULT_HOLD_MS, ...filter } = {}) {
      // Check first: a message that arrived before the wait began must not be
      // missed while listening for the next one.
      const immediate = mailbox.read({ since, ...filter })
      if (immediate.messages.length > 0) return immediate

      ensureWatching()
      return new Promise((resolve) => {
        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          listeners.delete(check)
          clearTimeout(timer)
          resolve(value)
        }
        const check = () => {
          const found = mailbox.read({ since, ...filter })
          if (found.messages.length > 0) finish(found)
        }
        // Transport bound only: answers "nothing yet", never cancels anything.
        const timer = setTimeout(() => finish({ ...mailbox.read({ since, ...filter }), waited: true }), holdMs)
        // Unref so a parked wait cannot keep the host process alive at exit.
        timer.unref?.()
        listeners.add(check)
        // A watcher can miss an event on some filesystems; re-check once the
        // listener is registered so the gap between the two cannot swallow a
        // message.
        check()
      })
    },

    /** Stop watching. Called on plugin teardown so no handle outlives it. */
    close() {
      listeners.clear()
      watcher?.close()
      watcher = undefined
    },

    /** Present so callers can tell a live doorbell from a degraded one. */
    get watching() { return watcher !== undefined || (file !== undefined && existsSync(dirname(file))) }
  }
}
