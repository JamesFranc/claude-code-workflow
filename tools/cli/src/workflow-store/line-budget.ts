// Defensive line-size bound: it keeps ledger lines diff-friendly and caps worst-case truncation. It
// is not a POSIX atomicity claim — PIPE_BUF governs pipes, not regular files.
export const MAX_LINE_BYTES = 4096

// Which end of a shrunk field survives. A field holding the END of a command's output keeps its end,
// where the failure message typically is; a free-text note keeps its front. Shrinking is lossless
// only for a field with a full-content sidecar elsewhere (`tail`, backed by the output file written
// alongside the ledger line) — a field with no sidecar loses whatever this removes, for good. See
// `FitLineResult.shrunkFields`.
export type KeepEnd = 'front' | 'end'

export interface FreeTextField<T> {
  name: keyof T & string
  keep: KeepEnd
}

export interface FitLineResult<T> {
  line: string
  // Every free-text field name this call actually shrank, in the order first touched. A field with
  // no full-content sidecar elsewhere (unlike `tail`, whose sidecar is the full output file written
  // alongside it) loses whatever is shrunk off it — permanently, with no copy anywhere. List a field
  // as free text here only when that loss is an acceptable outcome, and have the caller check this
  // set and surface the loss to whoever is watching when it has no sidecar of its own. A field the
  // caller cannot afford to lose even partially belongs in the identifiers, never in `freeText`.
  shrunkFields: (keyof T & string)[]
}

// Serialize, then halve the longest free-text field until the line fits, stamping the event as
// lineTruncated. Fields not listed are durable identifiers and are never shrunk. Throws when the
// line still does not fit with every free-text field emptied — the caller's identifiers alone are
// over budget, which is a bug in the caller, not a truncation case.
export const fitLine = <T extends object>(
  event: T,
  freeText: FreeTextField<T>[],
  label: string
): FitLineResult<T> => {
  let candidate = event
  let line = JSON.stringify(candidate)
  const shrunkFields: (keyof T & string)[] = []
  while (Buffer.byteLength(line, 'utf-8') > MAX_LINE_BYTES) {
    const shrunk = shrinkLongest(candidate, freeText)
    if (shrunk === null)
      throw new Error(
        `${label}: event cannot fit in ${MAX_LINE_BYTES} bytes even with free text removed`
      )
    if (!shrunkFields.includes(shrunk.field)) shrunkFields.push(shrunk.field)
    candidate = { ...shrunk.event, lineTruncated: true }
    line = JSON.stringify(candidate)
  }
  return { line, shrunkFields }
}

// A halved cut landing between a surrogate pair's two UTF-16 code units splits one astral code
// point, leaving a lone surrogate that JSON.stringify escapes as `\udXXX` rather than the character
// it belonged to — the boundary is moved one further to drop the whole pair instead of splitting it.
const isSurrogatePairSplit = (value: string, index: number): boolean =>
  index > 0 &&
  index < value.length &&
  value.charCodeAt(index - 1) >= 0xd800 &&
  value.charCodeAt(index - 1) <= 0xdbff &&
  value.charCodeAt(index) >= 0xdc00 &&
  value.charCodeAt(index) <= 0xdfff

const shrinkLongest = <T extends object>(
  event: T,
  freeText: FreeTextField<T>[]
): { event: T; field: keyof T & string } | null => {
  let longest: FreeTextField<T> | null = null
  let longestLength = 0
  for (const field of freeText) {
    const value = event[field.name]
    if (typeof value === 'string' && value.length > longestLength) {
      longest = field
      longestLength = value.length
    }
  }
  if (longest === null || longestLength === 0) return null
  const value = event[longest.name] as string
  const newLength = Math.floor(value.length / 2)
  const shrunk =
    longest.keep === 'end'
      ? value.slice(
          value.length - newLength + (isSurrogatePairSplit(value, value.length - newLength) ? 1 : 0)
        )
      : value.slice(0, newLength - (isSurrogatePairSplit(value, newLength) ? 1 : 0))
  return { event: { ...event, [longest.name]: shrunk }, field: longest.name }
}
