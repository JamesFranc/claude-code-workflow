import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { runCheckRefs } from './main.ts'
import { REVIEW_RULES_PATH } from './entry-cap.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'

const captureStdout = (run: () => void): string => {
  const original = process.stdout.write.bind(process.stdout)
  let captured = ''
  process.stdout.write = ((chunk: string) => {
    captured += chunk
    return true
  }) as typeof process.stdout.write
  try {
    run()
  } finally {
    process.stdout.write = original
  }
  return captured
}

const captureStderr = (fn: () => void): string => {
  const chunks: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk))
    return true
  }
  try {
    fn()
  } finally {
    process.stderr.write = orig
  }
  return chunks.join('')
}

// A minimal scannable root: one bin tool, one skill doc referencing it bare (`bin/mytool`, the
// relative-reference shape). Callers build the doc's own content per test.
const withFixtureRoot = (docContent: string, run: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'check-refs-line-endings-'))
  try {
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'mytool'), '#!/bin/sh\n')
    mkdirSync(join(root, 'skills'))
    writeFileSync(join(root, 'skills', 'fixture.md'), docContent)
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('runCheckRefs: an unquoted placeholder in a hook heredoc command is reported as command-example', () => {
  withFixtureRoot('Nothing to see.\n', (root) => {
    mkdirSync(join(root, 'hooks'))
    writeFileSync(
      join(root, 'hooks', 'fixture.sh'),
      '#!/bin/sh\ncat >&2 <<EOF\nRun mytool show --id <id> first.\nEOF\n'
    )
    const stdout = captureStdout(() => runCheckRefs(root))
    const output = JSON.parse(stdout) as {
      findings: { file: string; line: number; category: string; matched: string }[]
    }
    const hookFindings = output.findings.filter((f) => f.file === 'hooks/fixture.sh')
    assert.deepEqual(hookFindings, [
      {
        file: 'hooks/fixture.sh',
        line: 3,
        col: 22,
        category: 'command-example',
        matched: '<id>',
        fix: 'quote the placeholder so it reaches argv as one word: "<id>"',
      },
    ])
  })
})

// --- CommonMark line endings: \n, \r, and \r\n all scan the same ---

// Splitting on \n alone collapses a CR-only file into one "line" spanning the whole file — the bin
// reference on the file's second logical line is still found (the regex needs no line anchor), but
// reported at line 1 instead of its real line 2.
test('runCheckRefs: a bin/ reference on the second logical line of a CR-only file is reported at line 2, not line 1', () => {
  const content = ['Some intro text.', 'Run bin/mytool to do the thing.'].join('\r')
  withFixtureRoot(content, (root) => {
    setRequestedExitCode(99)
    const stdout = captureStdout(() => runCheckRefs(root))
    const output = JSON.parse(stdout) as { findings: { line: number; matched: string }[] }
    const binFindings = output.findings.filter((f) => f.matched === 'bin/mytool')
    assert.equal(binFindings.length, 1)
    assert.equal(binFindings[0]?.line, 2)
    assert.equal(getRequestedExitCode(), 1)
  })
})

// Regression guard: the same fixture under CRLF line endings resolves the same way. splitLines
// tries the `\r\n` alternative before the bare `\r` one specifically so a CRLF pair is consumed as
// one delimiter rather than two — trying `\r` first would consume only the `\r`, leave the `\n` as
// a second delimiter, and insert a spurious empty line between the two real ones, shifting this
// fixture's reported line from 2 to 3.
test('runCheckRefs: a bin/ reference on the second logical line of a CRLF file is reported at line 2', () => {
  const content = ['Some intro text.', 'Run bin/mytool to do the thing.'].join('\r\n')
  withFixtureRoot(content, (root) => {
    setRequestedExitCode(99)
    const stdout = captureStdout(() => runCheckRefs(root))
    const output = JSON.parse(stdout) as { findings: { line: number; matched: string }[] }
    const binFindings = output.findings.filter((f) => f.matched === 'bin/mytool')
    assert.equal(binFindings.length, 1)
    assert.equal(binFindings[0]?.line, 2)
    assert.equal(getRequestedExitCode(), 1)
  })
})

// hooks/*.sh ships instruction text to agents the same as a skill doc does, so scanFiles scans it too
// — through the real entry point, not a copy of the glob pattern used to find it. A bare invocation
// planted in a hooks/*.sh file must come back the same way one in skills/ does.
test('runCheckRefs: a bare invocation inside a hooks/*.sh file is reported', () => {
  withFixtureRoot('No bin or question-flag content here.', (root) => {
    mkdirSync(join(root, 'hooks'))
    writeFileSync(
      join(root, 'hooks', 'fixture.sh'),
      '#!/bin/sh\ndashboard item add --type question\n'
    )
    setRequestedExitCode(99)
    const stdout = captureStdout(() => runCheckRefs(root))
    const output = JSON.parse(stdout) as {
      findings: { file: string; category: string; line: number }[]
    }
    const hookFindings = output.findings.filter((f) => f.category === 'question-flag')
    assert.equal(hookFindings.length, 1)
    assert.equal(hookFindings[0]?.file, 'hooks/fixture.sh')
    assert.equal(hookFindings[0]?.line, 2)
    assert.equal(getRequestedExitCode(), 1, 'a hooks/*.sh finding fails the gate, not just stdout')
  })
})

// A hooks/test-*.sh harness ships fixtures to a local test runner, not instructions to an agent —
// a harness built to test the question gate needs the bare invocation as its own negative case, so
// the sweep must not fire on it. The sibling hooks/fixture.sh (no test- prefix) in the same root is
// the non-vacuity control: it still gets caught, so the 0 above is a real exclusion, not evidence
// the sweep stopped running.
test('runCheckRefs: a hooks/test-*.sh harness is excluded from the question-flags sweep', () => {
  withFixtureRoot('No bin or question-flag content here.', (root) => {
    mkdirSync(join(root, 'hooks'))
    writeFileSync(
      join(root, 'hooks', 'test-fixture.sh'),
      '#!/bin/sh\ndashboard item add --type question\n'
    )
    writeFileSync(
      join(root, 'hooks', 'fixture.sh'),
      '#!/bin/sh\ndashboard item add --type question\n'
    )
    setRequestedExitCode(99)
    const stdout = captureStdout(() => runCheckRefs(root))
    const output = JSON.parse(stdout) as { findings: { file: string; category: string }[] }
    const hookFindings = output.findings.filter((f) => f.category === 'question-flag')
    assert.equal(hookFindings.length, 1)
    assert.equal(hookFindings[0]?.file, 'hooks/fixture.sh')
    assert.equal(getRequestedExitCode(), 1, 'the sibling control finding still sets the exit code')
  })
})

// --- Rendered form: runCheckRefs writes every finding to stderr via formatFinding, which is not
// exported and had no test — of any kind — inspecting stderr or naming formatFinding. Two branches
// exist by category: the four "special" categories (fence-shape, heading-citation, entry-cap,
// question-flag) render `→ <fix>` verbatim; the three bin-ref categories (relative, env-var,
// absolute) render `→ use bare '<fix>'`. The categorization is duplicated here independently of
// main.ts, not read from it — reading it from main.ts would make the test agree with a mutant that
// changes the categorization, defeating the point of pinning it.

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

const gitShow = (sha: string, relPath: string): string =>
  execFileSync('git', ['show', `${sha}:${relPath}`], { cwd: REPO_ROOT, encoding: 'utf-8' })

// The published snapshot has no history, so these commits exist only in the source repo. The snapshot
// is the one tree without `.private-terms.json` (tracked in the source, excluded from the export), so
// the tests skip only there; a shallow source checkout still runs them and fails.
const isSnapshot = (): boolean =>
  spawnSync('git', ['cat-file', '-e', 'HEAD:.private-terms.json'], { cwd: REPO_ROOT }).status !== 0

const hasCommit = (sha: string): boolean =>
  spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: REPO_ROOT }).status === 0

const historySkip = (...shas: string[]): string | false => {
  if (!isSnapshot()) {
    return false
  }

  const missing = shas.filter((sha) => !hasCommit(sha))
  return missing.length === 0
    ? false
    : `needs commit(s) ${missing.join(', ')}, absent from this clone`
}

const SPECIAL_RENDER_CATEGORIES = new Set([
  'fence-shape',
  'heading-citation',
  'path-citation',
  'path-heading-citation',
  'entry-cap',
  'question-flag',
  'command-example',
])

const expectedRenderedLine = (f: {
  file: string
  line: number
  col: number
  category: string
  matched: string
  fix: string
}): string =>
  SPECIAL_RENDER_CATEGORIES.has(f.category)
    ? `${f.file}:${f.line}:${f.col}  ${f.category}  '${f.matched}' → ${f.fix}`
    : `${f.file}:${f.line}:${f.col}  ${f.category}  '${f.matched}' → use bare '${f.fix}'`

// One root carrying a fixture per category, each isolated in its own file so one category's
// trigger cannot shift another's finding count.
const withAllCategoriesFixtureRoot = (run: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'check-refs-render-form-'))
  try {
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'mytool'), '#!/bin/sh\n')

    mkdirSync(join(root, 'skills'))
    writeFileSync(join(root, 'skills', 'relative.md'), 'Run bin/mytool for the relative case.\n')
    writeFileSync(
      join(root, 'skills', 'env-var.md'),
      'Run ${TOOLS_DIR}/bin/mytool for the env-var case.\n'
    )
    writeFileSync(
      join(root, 'skills', 'absolute.md'),
      'Run /usr/local/bin/mytool for the absolute case.\n'
    )
    writeFileSync(
      join(root, 'skills', 'heading.md'),
      '## Overview\n\nSee `## Nonexistent Heading` for details.\n'
    )
    writeFileSync(
      join(root, 'skills', 'path.md'),
      'See `skills/missing.md` and `skills/heading.md` §Nonexistent Heading.\n'
    )
    // The pre-FLOW-202 quick-change template, reused from fence-shape.test.ts's own trigger: real
    // history, not a synthetic fence — both shas are on main and survive any squash. The test skips in a
    // clone without that history (the published snapshot).
    writeFileSync(
      join(root, 'skills', 'fence-shape-fixture.md'),
      gitShow('1351aac', 'skills/quick-change/SKILL.md')
    )

    mkdirSync(join(root, 'skills', 'code-review', 'references'), { recursive: true })
    const overCapEntries = Array.from({ length: 163 }, (_, i) => `- [ ] Entry ${i + 1}`).join('\n')
    writeFileSync(join(root, REVIEW_RULES_PATH), overCapEntries)

    mkdirSync(join(root, 'hooks'))
    writeFileSync(
      join(root, 'hooks', 'fixture.sh'),
      '#!/bin/sh\ndashboard item add --type question\n'
    )
    writeFileSync(
      join(root, 'skills', 'command-example.md'),
      '```bash\nmytool show --id <id> --json\n```\n'
    )

    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test(
  'runCheckRefs: renders every finding category to stderr in the correct branch form',
  { skip: historySkip('1351aac') },
  () => {
    withAllCategoriesFixtureRoot((root) => {
      setRequestedExitCode(99)
      let stdout = ''
      const stderr = captureStderr(() => {
        stdout = captureStdout(() => runCheckRefs(root))
      })
      const output = JSON.parse(stdout) as {
        findings: {
          file: string
          line: number
          col: number
          category: string
          matched: string
          fix: string
        }[]
      }
      const stderrLines = stderr.split('\n').filter((l) => l.length > 0)
      assert.equal(
        stderrLines.length,
        output.findings.length,
        'exactly one rendered line per finding — a mutation that emits both branch forms for one finding must not pass'
      )

      const byCategory = (category: string) =>
        output.findings.filter((f) => f.category === category)

      assert.equal(byCategory('relative').length, 1)
      assert.equal(byCategory('env-var').length, 1)
      assert.equal(byCategory('absolute').length, 1)
      assert.equal(byCategory('heading-citation').length, 1)
      const inPathFixture = (category: string) =>
        byCategory(category).filter((f) => f.file === 'skills/path.md')
      assert.equal(inPathFixture('path-citation').length, 1)
      assert.equal(inPathFixture('path-heading-citation').length, 1)
      assert.equal(byCategory('entry-cap').length, 1)
      assert.equal(byCategory('question-flag').length, 1)
      assert.equal(byCategory('fence-shape').length, 1)
      const inCommandExampleFixture = byCategory('command-example').filter(
        (f) => f.file === 'skills/command-example.md'
      )
      assert.equal(inCommandExampleFixture.length, 1)

      for (const f of output.findings) {
        assert.ok(
          stderrLines.includes(expectedRenderedLine(f)),
          `missing/mismatched rendered line for category ${f.category}: ${JSON.stringify(f)}`
        )
      }
      assert.equal(getRequestedExitCode(), 1)
    })
  }
)

// A question-flag finding rendering through the special-fix branch (never "use bare", nonsense fix
// text for a category whose `fix` is prose telling the agent which flags to add) is pinned by the
// loop above: `expectedRenderedLine` selects the special-branch form for 'question-flag' via
// SPECIAL_RENDER_CATEGORIES, and the assertion inside the loop requires that exact line be present.
