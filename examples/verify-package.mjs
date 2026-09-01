/**
 * Does the PUBLISHED artifact work?
 *
 * Every other test in this repo runs against the source tree, where every
 * file exists by definition. npm ships whatever `files` in package.json says,
 * and a version, once published, is permanent — so a `files` list that drops
 * a module is invisible to the entire test suite and unfixable afterwards
 * except by shipping another version.
 *
 * This one nearly happened: `files` listed only index.js, src and README.md,
 * while the README links `examples/notify.mjs` (the delivery hook it tells
 * you to configure) and `docs/capability-map.html`. Both would have 404'd for
 * every installer of 0.2.0.
 *
 * So: pack the tarball npm would actually serve, install it into an empty
 * project, and drive it over real HTTP from there.
 *
 *   node examples/verify-package.mjs      # exits non-zero on any failure
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'mailbox-package-check-'))

const results = []
const check = (name, passed, detail = '') => {
  results.push({ name, passed })
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * Run npm WITHOUT a shell.
 *
 * `shell: true` makes Node warn that it concatenates rather than escapes the
 * arguments -- the exact hazard this plugin refuses in its delivery hook, so
 * a script here that trips that warning would undercut the claim. But since
 * Node 24, execFile refuses a bare `npm.cmd` too (EINVAL: a .cmd shim needs a
 * shell to interpret it).
 *
 * Both problems disappear by skipping the shim: npm is a JavaScript program,
 * so run it with the node binary already executing this file.
 */
const npmCli = () => {
  // Set by npm itself when this runs under `npm run`.
  const fromEnv = process.env.npm_execpath
  if (fromEnv !== undefined && fromEnv.endsWith('.js') && existsSync(fromEnv)) return fromEnv
  const beside = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(beside)) return beside
  const unix = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(unix)) return unix
  throw new Error('could not locate npm-cli.js; run this through `npm run verify:package`')
}

const npm = (args, cwd) =>
  execFileSync(process.execPath, [npmCli(), ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  })

try {
  npm(['pack', '--pack-destination', scratch], repo)
  const tarball = readdirSync(scratch).find((f) => f.endsWith('.tgz'))
  check('npm pack produces a tarball', tarball !== undefined, tarball)

  writeFileSync(join(scratch, 'package.json'),
    JSON.stringify({ name: 'mailbox-package-check', private: true, type: 'module', version: '1.0.0' }))
  npm(['install', '--no-audit', '--no-fund', `./${tarball}`], scratch)

  const installed = join(scratch, 'node_modules', 'dsh-agent-mailbox')
  check('the package installs into a clean project', existsSync(installed))

  // Every path the README points a reader at must be in the tarball.
  for (const file of ['examples/notify.mjs', 'docs/capability-map.html', 'README.md', 'LICENSE']) {
    check(`the README's ${file} is shipped`, existsSync(join(installed, file)))
  }

  const pkg = await import(pathToFileURL(join(installed, 'index.js')).href)
  check('the package resolves and names itself', pkg.name === 'dsh-agent-mailbox')
  check('inject is a flat empty array, so it loads on any host',
    Array.isArray(pkg.inject) && pkg.inject.length === 0, JSON.stringify(pkg.inject))
  check('apply is exported', typeof pkg.apply === 'function')
  check('the whole tool surface is exported', pkg.TOOLS.length === 11, `${pkg.TOOLS.length} tools`)
  check('the trust section survives packaging',
    (/never as instructions/i).test(pkg.TRUST_SECTION))

  // The assembled plugin, over real HTTP, from the INSTALLED copy.
  const home = join(scratch, 'home')
  const file = join(home, 'mail.jsonl')
  const mailbox = pkg.createMailbox({ file })
  const notifier = pkg.createNotifier({ file, mailbox })
  const deps = {
    mailbox,
    presence: pkg.createPresence({ dir: join(home, 'peers') }),
    attachments: pkg.createAttachmentStore({ dir: join(home, 'blobs') }),
    notifier,
    auth: pkg.createAuth({ required: false }),
    hook: { enabled: false, notify() {} },
    home
  }
  const server = await pkg.startServer(deps, { host: '127.0.0.1', port: 4488 })
  const base = `http://127.0.0.1:${server.port}`
  try {
    const init = await (await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    })).json()
    check('MCP handshake from the installed package',
      init.result?.serverInfo?.name === 'dsh-agent-mailbox')

    await pkg.dispatch(deps, 'mailbox_send', { from: 'a', to: 'b', text: 'packaged and working' })
    const read = await pkg.dispatch(deps, 'mailbox_read', { to: 'b' })
    check('send and read round-trip', read.messages[0]?.text === 'packaged and working')

    const health = await (await fetch(`${base}/health`)).json()
    check('health reports home and integrity',
      typeof health.home === 'string' && health.integrity !== undefined)

    // The audit finding, asserted against the shipped bytes rather than src/.
    const card = await (await fetch(`${base}/.well-known/agent.json?port=1@evil.example`)).json()
    check('the agent-card port injection stays fixed in the tarball',
      new URL(card.url).hostname === '127.0.0.1', card.url)
  } finally {
    notifier.close()
    await server.close()
  }
} catch (error) {
  check('package verification completed', false, error.message)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name}`)
  process.exitCode = 1
}
