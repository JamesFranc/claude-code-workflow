import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { ESLint } from 'eslint'

// eslint.config.js scopes the `no-restricted-syntax` appendFileSync-mode rule to this exact
// file, so every case below must lint as if it lived at that path — a snippet linted under any
// other filePath silently skips the rule entirely rather than passing it.
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const SCOPED_FILE_PATH = path.join(REPO_ROOT, 'tools/cli/src/workflow-store/store.ts')

const lintSnippet = async (code: string) => {
  const eslint = new ESLint({
    overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.js'),
    cwd: REPO_ROOT,
  })
  const [result] = await eslint.lintText(code, { filePath: SCOPED_FILE_PATH })
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax')
}

test('appendFileSync mode selector: reds on no options argument at all', async () => {
  const hits = await lintSnippet('appendFileSync(p, d)')
  assert.equal(hits.length, 1)
})

test('appendFileSync mode selector: reds on an empty options object', async () => {
  const hits = await lintSnippet('appendFileSync(p, d, {})')
  assert.equal(hits.length, 1)
})

test('appendFileSync mode selector: reds on a string encoding argument', async () => {
  const hits = await lintSnippet("appendFileSync(p, d, 'utf8')")
  assert.equal(hits.length, 1)
})

test('appendFileSync mode selector: does not fire when mode is present', async () => {
  const hits = await lintSnippet('appendFileSync(p, d, { mode: 0o600 })')
  assert.equal(hits.length, 0)
})

// The message this rule fires claims "must pass { mode: 0o600 }" — a key-presence check alone
// (the selector form before this test existed) is satisfied by any value, including one this
// message explicitly rules out. These three pin the value, not just the key.
test('appendFileSync mode selector: reds on a too-permissive mode value (0o644)', async () => {
  const hits = await lintSnippet('appendFileSync(p, d, { mode: 0o644 })')
  assert.equal(hits.length, 1)
})

test('appendFileSync mode selector: reds on a too-permissive mode value (0o777)', async () => {
  const hits = await lintSnippet('appendFileSync(p, d, { mode: 0o777 })')
  assert.equal(hits.length, 1)
})

test('appendFileSync mode selector: reds on an undefined mode value', async () => {
  const hits = await lintSnippet('appendFileSync(p, d, { mode: undefined })')
  assert.equal(hits.length, 1)
})

// [callee.name=appendFileSync] matches a bare identifier only — fs.appendFileSync(...) is a
// MemberExpression whose callee has no .name, so the whole selector never even reaches the
// mode-value check on this call shape.
test('appendFileSync mode selector: reds on the fs.appendFileSync member-expression call shape too', async () => {
  const hits = await lintSnippet('fs.appendFileSync(p, d, { mode: 0o644 })')
  assert.equal(hits.length, 1)
})

test('appendFileSync mode selector: scoped to workflow-store/store.ts — does not fire elsewhere', async () => {
  const eslint = new ESLint({
    overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.js'),
    cwd: REPO_ROOT,
  })
  const [result] = await eslint.lintText('appendFileSync(p, d, {})', {
    filePath: path.join(REPO_ROOT, 'tools/cli/src/workflow-store/other-file.ts'),
  })
  const hits = result.messages.filter((m) => m.ruleId === 'no-restricted-syntax')
  assert.equal(hits.length, 0)
})
