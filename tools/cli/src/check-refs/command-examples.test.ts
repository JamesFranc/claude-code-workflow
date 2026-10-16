import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findCommandExampleFindings } from './command-examples.ts'

const DOC = 'skills/fixture.md'
const HOOK = 'hooks/fixture.sh'
const TOOLS = ['dashboard', 'gate-ledger'] as const

const findings = (content: string, file: string = DOC) =>
  findCommandExampleFindings(content, file, TOOLS)

const placeholderFindings = (content: string, file: string = DOC) =>
  findings(content, file).filter((f) => f.fix.startsWith('quote the placeholder'))

const syntaxFindings = (content: string) =>
  findings(content).filter((f) => f.fix.startsWith('bash -n'))

const CONTROL = 'dashboard link add --label <CTL> --url x'
const CONTROL_FENCE = '```bash\n' + CONTROL + '\n```\n'

const assertOnlyControl = (result: readonly { matched: string }[]) =>
  assert.deepEqual(
    result.map((f) => f.matched),
    ['<CTL>']
  )

// --- Surface 1: shell fences ---

test('an unquoted placeholder that still parses is reported at its own line and column', () => {
  const result = findings(
    'Intro.\n\n```bash\ndashboard link add --label <TICKET-ID> --url "https://x" --root\n```\n'
  )
  assert.equal(result.length, 1)
  assert.equal(result[0]?.line, 4)
  assert.equal(result[0]?.col, 28)
  assert.equal(result[0]?.matched, '<TICKET-ID>')
  assert.equal(result[0]?.category, 'command-example')
  assert.equal(
    result[0]?.fix,
    'quote the placeholder so it reaches argv as one word: "<TICKET-ID>"'
  )
})

test('a fence bash -n rejects yields a syntax finding mapped to the file line', () => {
  const result = syntaxFindings('```sh\necho ok\ncd .worktrees/<branch-name>\n```\n')
  assert.equal(result.length, 1)
  assert.equal(result[0]?.line, 3)
  assert.equal(result[0]?.matched, 'cd .worktrees/<branch-name>')
  assert.match(result[0]?.fix ?? '', /^bash -n rejects this fence: line 2: syntax error/)
})

test('a fence indented inside a numbered list is checked, and dedented before bash -n', () => {
  const content = '1. Step:\n\n   ```shell\n   git checkout <branch-name>\n   ```\n'
  assert.equal(syntaxFindings(content).length, 1)
  assert.equal(placeholderFindings(content)[0]?.col, 17)
})

test('a placeholder in double quotes, single quotes, or quoted mid-word is not reported', () => {
  const content = [
    '```bash',
    'git checkout "<branch-name>"',
    "git checkout '<branch-name>'",
    'git push origin "<branch>":refs/heads/x',
    'git log origin/"<branch>"',
    CONTROL,
    '```',
    '',
  ].join('\n')
  assertOnlyControl(findings(content))
})

test('a placeholder quoted inside a double-quoted $( … ) is not reported', () => {
  const content =
    '```bash\ndashboard item add --type question --prompt "$(cat "<tmpfile>")" --defer\n' +
    CONTROL +
    '\n```\n'
  assertOnlyControl(findings(content))
})

test('an unquoted placeholder inside $( … ) at top level is reported', () => {
  const result = placeholderFindings(
    '```bash\nx="$(git rev-parse HEAD)" y=$(git show <sha>)\n```\n'
  )
  assert.equal(result.length, 1)
  assert.equal(result[0]?.matched, '<sha>')
})

test('a double-quoted string carried across lines keeps its placeholders quoted', () => {
  const content =
    '```bash\ngh pr comment 1 --body "first line\n<still inside the quotes>"\n' +
    CONTROL +
    '\n```\n'
  assertOnlyControl(findings(content))
})

test('a heredoc body inside a shell fence is data, not syntax, and is not scanned', () => {
  const content = [
    '```bash',
    'cat > "$f" <<\'EOF\'',
    'Replace <placeholder> with the real value.',
    'EOF',
    'echo done',
    CONTROL,
    '```',
    '',
  ].join('\n')
  assertOnlyControl(findings(content))
})

test('a placeholder in a shell comment is not reported', () => {
  assertOnlyControl(findings('```bash\n# swap <branch-name> in first\n' + CONTROL + '\n```\n'))
})

test('real redirections are not placeholders', () => {
  const content = [
    '```bash',
    'sort <in.txt >out.txt',
    'cmd > "<file>" 2>&1',
    'diff <(git log) <(git log origin/main)',
    'cat <<<"$x"',
    CONTROL,
    '```',
    '',
  ].join('\n')
  assertOnlyControl(findings(content))
})

test('an empty shell fence yields nothing', () => {
  assertOnlyControl(findings('```bash\n\n```\n' + CONTROL_FENCE))
})

// Deliberate miss: only bash/sh/shell fences are command examples to this rule.
test('a placeholder in a text, markdown, or untagged fence is not checked', () => {
  const content = [
    '```text',
    'git checkout <branch-name>',
    '```',
    '```markdown',
    'git checkout <branch-name>',
    '```',
    '```',
    'git checkout <branch-name>',
    '```',
    CONTROL_FENCE,
  ].join('\n')
  assertOnlyControl(findings(content))
})

test('when bash cannot be started, the fence is reported rather than passed', () => {
  const originalPath = process.env['PATH']
  process.env['PATH'] = ''
  try {
    const result = findings('```bash\ngit status\n```\n')
    assert.equal(result.length, 1)
    assert.match(result[0]?.fix ?? '', /^bash -n could not run \(.*\), so this fence is unchecked$/)
  } finally {
    process.env['PATH'] = originalPath
  }
})

// --- Surface 2: inline code spans ---

test('an unquoted placeholder in a command-led inline span is reported at its column in the line', () => {
  const line = 'Then run `dashboard item consume --item <id>` once it is answered.'
  const result = findings(line)
  assert.equal(result.length, 1)
  assert.equal(result[0]?.line, 1)
  assert.equal(result[0]?.col, line.indexOf('<id>') + 1)
})

test('a quoted placeholder in an inline span is not reported', () => {
  assertOnlyControl(
    findings('Run `git diff "<base>..HEAD" --name-only` first, then `' + CONTROL + '`.')
  )
})

test('a command after other text in the span is still found, through to the end of the span', () => {
  const result = findings('Use `X=1 gh pr checks <pr>` here.')
  assert.equal(result.length, 1)
  assert.equal(result[0]?.matched, '<pr>')
})

// Deliberate misses: an inline span is a command example only from a known command onward.
test('an inline span with no known command is not checked', () => {
  const content = [
    'Pass `--pr <n>` and title it `<type>: [<TICKET-ID>] <description>`.',
    'See `skills/git-worktrees/SKILL.md` and `bin/dashboard <x>`.',
    'Then `' + CONTROL + '`.',
  ].join('\n')
  assertOnlyControl(findings(content))
})

test('inline spans inside any fence are not scanned as prose spans', () => {
  assertOnlyControl(
    findings('```text\nRun `git checkout <branch-name>` now.\n```\n' + CONTROL_FENCE)
  )
})

// --- Surface 3: hook heredoc bodies ---

test('an unquoted placeholder in a hook heredoc command is reported, alternatives included', () => {
  const content = [
    '#!/usr/bin/env bash',
    "cat >&2 <<'EOF'",
    'Post it first (dashboard item add --type question --stalls <what waits|none> --prompt "...")',
    'EOF',
    '',
  ].join('\n')
  const result = findings(content, HOOK)
  assert.equal(result.length, 1)
  assert.equal(result[0]?.line, 3)
  assert.equal(result[0]?.matched, '<what waits|none>')
})

test('the quoted form of the same hook template is not reported', () => {
  const content = [
    "cat >&2 <<'EOF'",
    'Post it first (dashboard item add --type question --stalls "<what waits|none>" --prompt "...")',
    CONTROL,
    'EOF',
    '',
  ].join('\n')
  assertOnlyControl(findings(content, HOOK))
})

// Deliberate miss: a hook's own code is not scanned, only the text its heredocs print.
test('a placeholder in hook code outside any heredoc is not checked', () => {
  const content =
    '#!/bin/sh\necho "x" <<<word\ndashboard item consume --item <id>\ncat <<EOF\n' +
    CONTROL +
    '\nEOF\n'
  assertOnlyControl(findings(content, HOOK))
})

test('a heredoc body line with no known command is not checked', () => {
  const content = 'cat <<EOF\n<EXTREMELY_IMPORTANT>\nRead <this> first.\n' + CONTROL + '\nEOF\n'
  assertOnlyControl(findings(content, HOOK))
})

// --- Heredoc operator detection ---

test('a heredoc operator inside quotes does not hide the rest of the fence', () => {
  const content = '```bash\necho "see <<EOF"\n' + CONTROL + '\n```\n'
  assertOnlyControl(findings(content))
})

test('a backslash-quoted heredoc delimiter is read as a heredoc in a hook and in a fence', () => {
  const hook = 'cat <<\\EOF\nPost it: dashboard item consume --item <id>\nEOF\n'
  assert.deepEqual(
    findings(hook, HOOK).map((f) => f.matched),
    ['<id>']
  )
  const fence = '```bash\ncat <<\\EOF\nRead <this> first.\nEOF\n' + CONTROL + '\n```\n'
  assertOnlyControl(findings(fence))
})

// Deliberate misses, named in the header's not-seen list.
test('a heredoc-like operator in arithmetic hides the rest of its fence', () => {
  assertOnlyControl(findings('```bash\n' + CONTROL + '\n```\n'))
  assert.deepEqual(findings('```bash\necho $((1<<b))\n' + CONTROL + '\n```\n'), [])
})

test('a quote or comment character in hook heredoc prose hides later placeholders on that line', () => {
  const heredoc = (line: string) => `cat <<EOF\n${line}\nEOF\n`
  const pairs = [
    [
      'dashboard link add (its needed) --label <CTL> --url x',
      "dashboard link add (it's needed) --label <CTL> --url x",
    ],
    ['dashboard item add --label 12 wide <CTL>', 'dashboard item add --label 12" wide <CTL>'],
    ['dashboard item consume --item x then <CTL>', 'dashboard item consume --item #<x> then <CTL>'],
  ] as const
  for (const [control, hidden] of pairs) {
    assertOnlyControl(findings(heredoc(control), HOOK))
    assert.deepEqual(findings(heredoc(hidden), HOOK), [])
  }
})
