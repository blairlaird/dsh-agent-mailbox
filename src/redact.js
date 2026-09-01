/**
 * Make a diagnostic safe to keep.
 *
 * A failure detail is copied verbatim from a provider response or a stack
 * trace, so it can carry an API key. Anything retained about a failure passes
 * through here first.
 *
 * The length bound is a LOGGING bound. It truncates a string that is already
 * terminal -- the run has ended by the time there is a diagnostic to bound --
 * and can never shorten, cancel, or cap a model run.
 */

/** Bounded tail. Generous enough to keep a real stack, small enough to store. */
const MAX_CHARS = 4000

/**
 * Shapes worth catching. Deliberately broad: a missed secret is unrecoverable
 * once written, while an over-redacted diagnostic is merely less useful.
 */
const SECRETS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/gi,
  /\beyJ[A-Za-z0-9._-]{20,}/g
]

export function redactDiagnostic(text) {
  let out = String(text ?? '')
  if (out === '') return ''

  for (const pattern of SECRETS) {
    out = out.replace(pattern, (match) => {
      // Keep the label so the reader knows WHAT was redacted, never the value.
      const label = /^(sk-|eyJ)/.test(match) ? match.slice(0, 3) : match.split(/[:=]/)[0]
      return `${label}<REDACTED>`
    })
  }

  if (out.length > MAX_CHARS) {
    // Says so: silent truncation would read as the whole story.
    out = out.slice(0, MAX_CHARS) + `\n… [truncated, ${out.length - MAX_CHARS} more chars]`
  }
  return out
}
