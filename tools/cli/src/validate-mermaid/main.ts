import { readFileSync } from 'node:fs'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { extractMermaidBlocks } from './blocks.ts'
import { validateMermaid } from './validate.ts'

interface Failure {
  index: number
  startLine: number
  error: string
}

interface ValidateMermaidOutput {
  file: string
  blocks: number
  failures: Failure[]
  ok: boolean
}

// A sink for stdout, matching claude-usage/main.ts's Writer pattern. Defaults to the real stream;
// tests substitute a collector instead of monkeypatching process.stdout.write globally, which would
// stay patched across any other stdout write racing this call.
type Writer = (chunk: string) => void

const writeToStdout: Writer = (chunk) => {
  process.stdout.write(chunk)
}

interface ValidateMermaidOptions {
  stdout?: Writer
}

export const runValidateMermaid = async (
  file: string,
  options: ValidateMermaidOptions = {}
): Promise<void> => {
  const stdout = options.stdout ?? writeToStdout
  const markdown = readFileSync(file, 'utf-8')
  const blocks = extractMermaidBlocks(markdown)

  const failures: Failure[] = []
  for (const block of blocks) {
    if (block.unterminated) {
      failures.push({
        index: block.index,
        startLine: block.startLine,
        error: 'unterminated mermaid fence (no closing fence before end of file)',
      })
      continue
    }
    const result = await validateMermaid(block.code)
    if (!result.valid) {
      failures.push({
        index: block.index,
        startLine: block.startLine,
        error: result.error ?? 'unknown parse error',
      })
    }
  }

  for (const failure of failures) console.error(formatFailure(file, failure))

  const output: ValidateMermaidOutput = {
    file,
    blocks: blocks.length,
    failures,
    ok: failures.length === 0,
  }
  stdout(JSON.stringify(output) + '\n')
  setRequestedExitCode(failures.length > 0 ? 1 : 0)
}

const formatFailure = (file: string, failure: Failure): string =>
  `${file}: mermaid block #${failure.index + 1} (line ${failure.startLine}): ${failure.error}`
