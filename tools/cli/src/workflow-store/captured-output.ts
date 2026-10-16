import { createHash } from 'node:crypto'
import {
  atomicWrite,
  readClassified,
  storePath,
  ticketScope,
  unreadableErrnoPhrase,
} from './store.ts'

// The tail kept inline on a ledger event. The FULL output always lands in the sidecar, so shrinking
// this bound never loses anything.
export const TAIL_BYTES = 2000

export interface CapturedOutput {
  outputPath: string
  outputSha256: string
  outputBytes: number
  tail: string
  truncated: boolean
}

// The full output, written beside the ledger under the same ticket scope. The filename's suffix is
// the output's own sha256 rather than a counter, so outputPath is derivable from the event alone in
// any process, and two captures of the same (label, sha) land on the same file only when their
// content is byte-identical — the correct outcome for that case, not a collision.
export const writeCapturedOutput = (
  ticket: string,
  directory: string,
  label: string,
  sha: string,
  output: string
): CapturedOutput => {
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_')
  const outputSha256 = createHash('sha256').update(output).digest('hex')
  const path = storePath(
    ticketScope(ticket),
    `${directory}/${safeLabel}-${sha}-${outputSha256}.out`
  )
  atomicWrite(path, output)
  const buf = Buffer.from(output, 'utf-8')
  const tailStart = nextUtf8LeadByte(buf, Math.max(0, buf.length - TAIL_BYTES))
  return {
    outputPath: path,
    outputSha256,
    outputBytes: buf.length,
    tail: buf.subarray(tailStart).toString('utf-8'),
    truncated: buf.length > TAIL_BYTES,
  }
}

// A byte offset landing inside a multi-byte UTF-8 sequence decodes as a tail leading with a
// replacement character (U+FFFD) rather than the sequence's own lead byte — advanced forward past
// any continuation byte (`10xxxxxx`, `0x80`-`0xbf`) to the sequence's own lead byte.
const nextUtf8LeadByte = (buf: Buffer, offset: number): number => {
  let i = offset
  while (i < buf.length && (buf[i]! & 0xc0) === 0x80) i++
  return i
}

// Reads a sidecar once and returns either its verified content or the reason it cannot be trusted.
// The read is classified rather than preceded by an existsSync check: a sidecar under a directory
// that denies traversal is not missing, and calling it missing sends whoever reads this report to
// re-run work whose evidence is sitting on disk intact. Returning the content is what keeps this
// the only read — a caller that re-opened the path could be told about a different file than the
// one this function hashed.
export type SidecarRead = { ok: true; content: string } | { ok: false; reason: string }

export const readSidecar = (path: string, expectedSha256: string, label: string): SidecarRead => {
  const read = readClassified(path)
  if (read.kind === 'absent') {
    return { ok: false, reason: `${label} sidecar is missing on disk` }
  }
  if (read.kind === 'unreadable') {
    return { ok: false, reason: `${label} sidecar ${unreadableErrnoPhrase(read.code)}` }
  }

  const actual = createHash('sha256').update(read.content).digest('hex')
  if (actual !== expectedSha256) {
    return { ok: false, reason: `${label} sidecar content no longer matches its recorded digest` }
  }
  return { ok: true, content: read.content }
}
