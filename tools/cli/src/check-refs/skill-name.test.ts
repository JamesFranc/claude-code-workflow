import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findSkillNameFindings } from './skill-name.ts'

const SKILL_PATH = 'skills/quick-change/SKILL.md'

const skillDoc = (nameLine: string): string =>
  `---\n${nameLine}\ndescription: Use for small changes.\n---\n\n# Quick Change\n`

test('findSkillNameFindings: a display name with a space and capitals is flagged on its line', () => {
  const findings = findSkillNameFindings(skillDoc('name: Quick Change'), SKILL_PATH)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.category, 'skill-name')
  assert.equal(findings[0]?.line, 2)
  assert.equal(findings[0]?.matched, 'Quick Change')
})

test('findSkillNameFindings: a slug that differs from the directory is flagged', () => {
  const findings = findSkillNameFindings(skillDoc('name: quick'), SKILL_PATH)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.matched, 'quick')
})

test('findSkillNameFindings: frontmatter with no name is flagged', () => {
  const findings = findSkillNameFindings(
    '---\ndescription: Use for small changes.\n---\n',
    SKILL_PATH
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.matched, '(no name)')
})

test('findSkillNameFindings: a file with no frontmatter is flagged', () => {
  const findings = findSkillNameFindings('# Quick Change\n\nname: quick-change\n', SKILL_PATH)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.matched, '(no name)')
})

test('findSkillNameFindings: a name below the frontmatter does not count', () => {
  const content = '---\ndescription: Use for small changes.\n---\n\nname: quick-change\n'
  assert.equal(findSkillNameFindings(content, SKILL_PATH).length, 1)
})

test('findSkillNameFindings: the directory slug passes, bare or quoted', () => {
  assert.deepEqual(findSkillNameFindings(skillDoc('name: quick-change'), SKILL_PATH), [])
  assert.deepEqual(findSkillNameFindings(skillDoc('name: "quick-change"'), SKILL_PATH), [])
  assert.deepEqual(findSkillNameFindings(skillDoc("name: 'quick-change'"), SKILL_PATH), [])
})

test('findSkillNameFindings: a trailing YAML comment is not part of the name', () => {
  assert.deepEqual(findSkillNameFindings(skillDoc('name: quick-change # note'), SKILL_PATH), [])
  assert.deepEqual(findSkillNameFindings(skillDoc('name: "quick-change" # note'), SKILL_PATH), [])
  assert.deepEqual(findSkillNameFindings(skillDoc("name: 'quick-change'  # note"), SKILL_PATH), [])
})

test('findSkillNameFindings: a # inside quotes is part of the name', () => {
  const findings = findSkillNameFindings(skillDoc('name: "quick-change #note"'), SKILL_PATH)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.matched, 'quick-change #note')
})

test('findSkillNameFindings: a 64 character name equal to its directory passes, 65 is flagged for length', () => {
  const sixtyFour = 'a'.repeat(64)
  assert.deepEqual(
    findSkillNameFindings(skillDoc(`name: ${sixtyFour}`), `skills/${sixtyFour}/SKILL.md`),
    []
  )

  const sixtyFive = 'a'.repeat(65)
  const findings = findSkillNameFindings(
    skillDoc(`name: ${sixtyFive}`),
    `skills/${sixtyFive}/SKILL.md`
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.matched, sixtyFive)
  assert.ok(findings[0]?.fix.includes('at most 64'))
})

test('findSkillNameFindings: a name that is only a comment is empty, and a # without leading space is kept', () => {
  const comment = findSkillNameFindings(skillDoc('name: # c'), SKILL_PATH)
  assert.equal(comment.length, 1)
  assert.equal(comment[0]?.matched, '')

  const glued = findSkillNameFindings(skillDoc('name: quick-change#x'), SKILL_PATH)
  assert.equal(glued[0]?.matched, 'quick-change#x')
})

test('findSkillNameFindings: a slug directory over 64 characters is not told to use itself as the name', () => {
  const longDir = 'a'.repeat(65)
  const path = `skills/${longDir}/SKILL.md`
  for (const doc of [
    skillDoc('name: foo'),
    '---\ndescription: x\n---\n',
    skillDoc(`name: ${longDir}`),
  ]) {
    const fix = findSkillNameFindings(doc, path)[0]?.fix
    assert.ok(fix?.includes('at most 64'))
    assert.ok(!fix?.includes(`name: ${longDir}`))
  }
})

test('findSkillNameFindings: frontmatter that never closes is flagged with a fix that closes it', () => {
  const content = '---\nname: quick-change\ndescription: Use for small changes.\n\n# Quick Change\n'
  const findings = findSkillNameFindings(content, SKILL_PATH)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.matched, '(unterminated frontmatter)')
  assert.ok(findings[0]?.fix.includes('close the frontmatter'))
})

test('findSkillNameFindings: an unterminated block names every action needed, and doing them clears the finding', () => {
  const body = 'description: Use for small changes.\n'
  const cases = [
    {
      label: 'valid name',
      file: SKILL_PATH,
      content: `---\nname: quick-change\n${body}`,
      actions: ['close the frontmatter', 'name: quick-change'],
      repairedContent: `---\nname: quick-change\n${body}---\n`,
    },
    {
      label: 'name only in the body',
      file: SKILL_PATH,
      content: `---\n${body}# Quick Change\nname: quick-change\n`,
      actions: ['close the frontmatter', 'name: quick-change'],
      repairedContent: `---\nname: quick-change\n${body}---\n# Quick Change\n`,
    },
    {
      label: 'no name',
      file: SKILL_PATH,
      content: `---\n${body}`,
      actions: ['close the frontmatter', 'name: quick-change'],
      repairedContent: `---\nname: quick-change\n${body}---\n`,
    },
    {
      label: 'display name',
      file: SKILL_PATH,
      content: `---\nname: Quick Change\n${body}`,
      actions: ['close the frontmatter', 'name: quick-change'],
      repairedContent: `---\nname: quick-change\n${body}---\n`,
    },
    {
      label: 'fence only',
      file: SKILL_PATH,
      content: '---\n',
      actions: ['close the frontmatter', 'name: quick-change'],
      repairedContent: '---\nname: quick-change\n---\n',
    },
    {
      label: 'non-slug directory',
      file: 'skills/My_Skill/SKILL.md',
      content: `---\nname: My_Skill\n${body}`,
      actions: ['close the frontmatter', 'rename the directory'],
      repairedContent: `---\nname: my-skill\n${body}---\n`,
      repairedFile: 'skills/my-skill/SKILL.md',
    },
  ]

  for (const c of cases) {
    const findings = findSkillNameFindings(c.content, c.file)
    assert.equal(findings.length, 1, c.label)
    for (const action of c.actions) {
      assert.ok(findings[0]?.fix.includes(action), `${c.label}: fix names "${action}"`)
    }
    assert.deepEqual(
      findSkillNameFindings(c.repairedContent, c.repairedFile ?? c.file),
      [],
      `${c.label}: repaired`
    )
  }
})

test('findSkillNameFindings: --- followed only by whitespace opens and closes the block', () => {
  const trailing = '---  \nname: quick-change\ndescription: x\n---\t\n# Quick Change\n'
  assert.deepEqual(findSkillNameFindings(trailing, SKILL_PATH), [])

  const indentedCloser = '---\nname: quick-change\n  ---\n'
  assert.equal(
    findSkillNameFindings(indentedCloser, SKILL_PATH)[0]?.matched,
    '(unterminated frontmatter)'
  )
})

test('findSkillNameFindings: CRLF line endings parse the same as LF', () => {
  const crlf = (s: string): string => s.replace(/\n/g, '\r\n')
  assert.deepEqual(findSkillNameFindings(crlf(skillDoc('name: quick-change')), SKILL_PATH), [])
  assert.equal(findSkillNameFindings(crlf(skillDoc('name: Quick Change')), SKILL_PATH).length, 1)
})

test('findSkillNameFindings: files that are not a top-level skill SKILL.md are ignored', () => {
  const bad = skillDoc('name: Quick Change')
  assert.deepEqual(findSkillNameFindings(bad, 'skills/quick-change/references/guide.md'), [])
  assert.deepEqual(findSkillNameFindings(bad, 'skills/quick-change/nested/SKILL.md'), [])
  assert.deepEqual(findSkillNameFindings(bad, 'agents/implementer.md'), [])
})

test('findSkillNameFindings: a non-slug directory gets a fix that renames the directory', () => {
  const slugDirFix = findSkillNameFindings(skillDoc('name: Quick Change'), SKILL_PATH)[0]?.fix
  const badDirFix = findSkillNameFindings(skillDoc('name: my_skill'), 'skills/my_skill/SKILL.md')[0]
    ?.fix
  assert.ok(badDirFix?.startsWith('rename the directory'))
  assert.notEqual(badDirFix, slugDirFix)
  assert.ok(slugDirFix?.includes('`name: quick-change`'))
})
