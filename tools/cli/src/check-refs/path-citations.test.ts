import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findPathCitationFindings } from './path-citations.ts'

// A root with one skill whose references/ file declares the headings the tests cite.
const withRoot = (run: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'check-refs-path-citations-'))
  try {
    mkdirSync(join(root, 'skills', 'demo', 'references'), { recursive: true })
    writeFileSync(
      join(root, 'skills', 'demo', 'references', 'rules.md'),
      '# Rules\n\n## Verify Against Reality (check the artifact)\n\n## Phase 1 — Hosting\n\n```bash\n## Not A Heading\n```\n'
    )
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const categories = (content: string, file: string, root: string): string[] =>
  findPathCitationFindings(content, file, root).map((f) => f.category)

test('findPathCitationFindings: a citation to a file that does not exist is a path-citation finding', () => {
  withRoot((root) => {
    const findings = findPathCitationFindings(
      'See `skills/demo/references/typo-rules.md`.',
      'agents/a.md',
      root
    )
    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.category, 'path-citation')
    assert.equal(findings[0]?.line, 1)
    assert.equal(findings[0]?.matched, '`skills/demo/references/typo-rules.md`')
  })
})

test('findPathCitationFindings: a citation into gitignored docs/plans is a finding', () => {
  withRoot((root) => {
    assert.deepEqual(categories('See `docs/plans/2026-09-29-x.md`.', 'CLAUDE.md', root), [
      'path-citation',
    ])
  })
})

test('findPathCitationFindings: references/ resolves from the skill root, and not from outside the skill', () => {
  withRoot((root) => {
    const cite = 'See `references/rules.md`.'
    assert.deepEqual(categories(cite, 'skills/demo/SKILL.md', root), [])
    assert.deepEqual(categories(cite, 'skills/demo/references/other.md', root), [])
    assert.deepEqual(categories(cite, 'agents/a.md', root), ['path-citation'])
  })
})

test('findPathCitationFindings: a path under a root this repo does not cite into is not checked', () => {
  withRoot((root) => {
    assert.deepEqual(categories('Edit `src/handlers/process.ts`.', 'agents/a.md', root), [])
  })
})

test('findPathCitationFindings: a §Heading the target file does not declare is a path-heading-citation finding', () => {
  withRoot((root) => {
    const cite = 'See `skills/demo/references/rules.md` §Missing Section.'
    assert.deepEqual(categories(cite, 'agents/a.md', root), ['path-heading-citation'])
  })
})

test('findPathCitationFindings: a heading inside a code fence does not satisfy a §Heading citation', () => {
  withRoot((root) => {
    const cite = 'See `skills/demo/references/rules.md` §Not A Heading.'
    assert.deepEqual(categories(cite, 'agents/a.md', root), ['path-heading-citation'])
  })
})

test('findPathCitationFindings: a §Heading resolves by full text or by name, with prose running on', () => {
  withRoot((root) => {
    const lines = [
      'See `skills/demo/references/rules.md` §Verify Against Reality enumerates them.',
      'See `skills/demo/references/rules.md` §Phase 1 (hosting).',
      'See `skills/demo/references/rules.md` §Phase 1 — Hosting.',
    ]
    assert.deepEqual(categories(lines.join('\n'), 'agents/a.md', root), [])
  })
})

test('findPathCitationFindings: a §Heading wrapped onto the next line resolves', () => {
  withRoot((root) => {
    const content = 'See `skills/demo/references/rules.md` §Verify Against\n> Reality for the list.'
    assert.deepEqual(categories(content, 'agents/a.md', root), [])
  })
})

test('findPathCitationFindings: a § at the end of a line, or trailing whitespace before the wrap, still resolves', () => {
  withRoot((root) => {
    const content = [
      'See `skills/demo/references/rules.md` §',
      'Verify Against Reality for the list.',
      'See `skills/demo/references/rules.md` §Verify Against   ',
      'Reality for the list.',
    ].join('\n')
    assert.deepEqual(categories(content, 'agents/a.md', root), [])
  })
})

test('findPathCitationFindings: a §Heading that stops short of the heading name is a finding', () => {
  withRoot((root) => {
    const cite = 'See `skills/demo/references/rules.md` §Verify.'
    assert.deepEqual(categories(cite, 'agents/a.md', root), ['path-heading-citation'])
  })
})

test('findPathCitationFindings: a heading name followed by more of a word is not a match', () => {
  withRoot((root) => {
    const cite = 'See `skills/demo/references/rules.md` §Phase 12 — Hosting.'
    assert.deepEqual(categories(cite, 'agents/a.md', root), ['path-heading-citation'])
  })
})

test('findPathCitationFindings: a numeric §N citation is not checked', () => {
  withRoot((root) => {
    assert.deepEqual(
      categories('See `skills/demo/references/rules.md` §3–4.', 'agents/a.md', root),
      []
    )
  })
})
