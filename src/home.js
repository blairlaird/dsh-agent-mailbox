/**
 * Where the mailbox lives — and whether that answer can be trusted.
 *
 * FOUND THE HARD WAY. On Windows, a packaged app runs in a container whose
 * %APPDATA% is redirected to
 *
 *   AppData\Local\Packages\<AppIdentity>\LocalCache\Roaming\...
 *
 * DSH_HOME is derived from %APPDATA%, so the mailbox path depends on WHICH
 * APP LAUNCHED THE HARNESS. Two agents each launching it get two different
 * mailboxes at the same nominal path, and neither can see the other. Observed
 * live: 61 messages in one container's copy, 18 in another, the running
 * server appending only to the second, and nothing anywhere saying so.
 *
 * This cannot be undone from inside the container — the redirect is the OS's,
 * and a process cannot see the un-virtualized path it was denied. So the
 * remedy is not a clever path fix, it is REFUSING TO BE SILENT: report the
 * resolved directory everywhere it matters, and say plainly when it is a
 * virtualized one that another app will not share.
 */

/**
 * `AppData\Local\Packages\<id>\LocalCache\` — the container redirect.
 *
 * Both separators, deliberately. The first version of this matched only `/`,
 * so on the one platform where the bug exists it never fired: `virtualized`
 * came back false for every real Windows path and the warning was never
 * printed. A detector that cannot detect its own platform is worse than none,
 * because it reads as an all-clear.
 */
const CONTAINER = /[\\/]AppData[\\/]Local[\\/]Packages[\\/]([^\\/]+)[\\/]LocalCache[\\/]/i

/**
 * @param home - the resolved mailbox directory.
 * @returns `{ home, virtualized, container?, warning? }`
 */
export function describeHome(home) {
  const match = CONTAINER.exec(String(home ?? ''))
  if (match === null) return { home, virtualized: false }

  return {
    home,
    virtualized: true,
    container: match[1],
    warning:
      `This mailbox is inside the "${match[1]}" app container. Windows redirects %APPDATA% ` +
      'per packaged app, so an agent launched from a different app resolves a DIFFERENT ' +
      'mailbox at the same nominal path and will not see these messages. Set an explicit ' +
      '`home` in the plugin config — somewhere outside AppData — so every participant ' +
      'shares one log.'
  }
}
