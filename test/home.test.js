/**
 * Whether the mailbox path can be trusted.
 *
 * Found live: two agents each launched the harness, Windows redirected
 * %APPDATA% per app container, and they silently used different mailboxes at
 * the same nominal path. 61 messages in one, 18 in the other, nothing saying
 * so. The fix is not a path trick — it is refusing to be silent about it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { describeHome } from '../src/home.js'

test('an ordinary path is reported as-is', () => {
  const got = describeHome('C:/mailboxes/agent')
  assert.equal(got.virtualized, false)
  assert.equal(got.home, 'C:/mailboxes/agent')
  assert.equal(got.warning, undefined)
})

test('a posix path is not mistaken for a container', () => {
  assert.equal(describeHome('/home/user/.dsh/agent-mailbox').virtualized, false)
})

// String.raw, NOT a plain quoted string. Written as
// 'C:\Users\b\AppData\...' this test silently passed a path with no
// backslashes in it at all -- JS reads \U \A \L \P as the bare letters and
// \b as a literal backspace -- so it was asserting against a string the
// detector was right to reject, and blamed the detector for the miss.
test('a Windows app-container path is detected', () => {
  const home = String.raw`C:\Users\b\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Roaming\dsh\agent-mailbox`
  const got = describeHome(home)
  assert.equal(got.virtualized, true)
  assert.equal(got.container, 'OpenAI.Codex_2p2nqsd0c76g0')
})

test('the warning explains the consequence, not just the fact', () => {
  // "Virtualized: true" alone means nothing to someone whose messages have
  // silently split in two.
  const got = describeHome(String.raw`C:\Users\b\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\dsh`)
  assert.match(got.warning, /DIFFERENT mailbox/)
  assert.match(got.warning, /will not see these messages/)
  assert.match(got.warning, /explicit/, 'and it must say what to do instead')
})

test('forward slashes are detected too', () => {
  assert.equal(describeHome('C:/Users/b/AppData/Local/Packages/Some.App_x/LocalCache/Roaming/dsh').virtualized, true)
})

test('a path merely containing AppData is not a container', () => {
  // Roaming\dsh is the NORMAL location; only the Packages redirect splits.
  assert.equal(describeHome('C:\Users\b\AppData\Roaming\dsh-desktop-dev\harness\agent-mailbox').virtualized, false)
})

test('missing input does not throw', () => {
  assert.doesNotThrow(() => describeHome(undefined))
  assert.equal(describeHome(undefined).virtualized, false)
})
