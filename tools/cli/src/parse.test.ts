import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseNonBlankString, parseShaLike } from './parse.ts'

test('parseNonBlankString: rejects an empty string', () => {
  const parse = parseNonBlankString('--phase')
  assert.throws(() => parse(''), /--phase must not be blank/)
})

test('parseNonBlankString: rejects a whitespace-only string', () => {
  const parse = parseNonBlankString('--phase')
  assert.throws(() => parse('   '), /--phase must not be blank/)
  assert.throws(() => parse('\t\n '), /--phase must not be blank/)
})

test('parseNonBlankString: trims surrounding whitespace on a valid value', () => {
  const parse = parseNonBlankString('--phase')
  assert.equal(parse('  implementation  '), 'implementation')
})

test('parseNonBlankString: passes a non-blank value through unchanged (already trimmed)', () => {
  const parse = parseNonBlankString('--phase')
  assert.equal(parse('implementation'), 'implementation')
})

test('parseNonBlankString: error message includes the flag name passed in', () => {
  const parse = parseNonBlankString('--key')
  assert.throws(() => parse(''), /--key must not be blank/)
})

test('parseShaLike: accepts a 7-character lowercase hex sha', () => {
  const parse = parseShaLike('--reviewed-sha')
  assert.equal(parse('a1b2c3d'), 'a1b2c3d')
})

test('parseShaLike: accepts a 40-character lowercase hex sha', () => {
  const parse = parseShaLike('--reviewed-sha')
  const sha = 'a1b2c3d4'.repeat(5)
  assert.equal(parse(sha), sha)
})

test('parseShaLike: rejects a too-short sha (6 hex chars)', () => {
  const parse = parseShaLike('--reviewed-sha')
  assert.throws(() => parse('a1b2c3'), /--reviewed-sha must be a 7-40 character lowercase hex sha/)
})

test('parseShaLike: rejects a too-long sha (41 hex chars)', () => {
  const parse = parseShaLike('--reviewed-sha')
  assert.throws(
    () => parse('a1b2c3d4'.repeat(5) + 'a'),
    /--reviewed-sha must be a 7-40 character lowercase hex sha/
  )
})

test('parseShaLike: rejects a non-hex character', () => {
  const parse = parseShaLike('--reviewed-sha')
  assert.throws(() => parse('g123456'), /--reviewed-sha must be a 7-40 character lowercase hex sha/)
})

test('parseShaLike: rejects an uppercase sha', () => {
  const parse = parseShaLike('--reviewed-sha')
  assert.throws(() => parse('A1B2C3D'), /--reviewed-sha must be a 7-40 character lowercase hex sha/)
})

test('parseShaLike: rejects a blank value with the same message as parseNonBlankString', () => {
  const parse = parseShaLike('--reviewed-sha')
  assert.throws(() => parse(''), /--reviewed-sha must not be blank/)
})

test('parseShaLike: rejects a too-short --fix-commit (6 hex chars)', () => {
  const parse = parseShaLike('--fix-commit')
  assert.throws(() => parse('a1b2c3'), /--fix-commit must be a 7-40 character lowercase hex sha/)
})

test('parseShaLike: rejects a too-long --fix-commit (41 hex chars)', () => {
  const parse = parseShaLike('--fix-commit')
  assert.throws(
    () => parse('a1b2c3d4'.repeat(5) + 'a'),
    /--fix-commit must be a 7-40 character lowercase hex sha/
  )
})

test('parseShaLike: rejects a non-hex character in --fix-commit', () => {
  const parse = parseShaLike('--fix-commit')
  assert.throws(() => parse('g123456'), /--fix-commit must be a 7-40 character lowercase hex sha/)
})

test('parseShaLike: rejects an uppercase --fix-commit', () => {
  const parse = parseShaLike('--fix-commit')
  assert.throws(() => parse('A1B2C3D'), /--fix-commit must be a 7-40 character lowercase hex sha/)
})
