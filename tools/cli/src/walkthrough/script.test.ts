import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScriptError, parseScript } from './script.ts'

const valid = {
  title: 'Demo',
  palette: 'classic',
  scenes: [
    { heading: 'Demo', narration: 'Hello.', visual: { kind: 'title' } },
    {
      heading: 'Points',
      narration: 'First this.',
      visual: { kind: 'bullets', bullets: ['This'] },
      steps: [{ cue: 'First', show: ['0'] }],
    },
  ],
}

test('parseScript: reads a valid script, defaulting steps and focus to empty', () => {
  const script = parseScript(valid)
  assert.deepEqual(script.scenes[0]?.steps, [])
  assert.deepEqual(script.scenes[1]?.steps, [{ cue: 'First', show: ['0'], focus: [] }])
})

test('parseScript: lists every problem, each naming where it is', () => {
  const bad = {
    title: '',
    palette: 'neon',
    scenes: [
      { heading: 'A', narration: '', visual: { kind: 'video' } },
      {
        heading: 'B',
        narration: 'Hi.',
        visual: { kind: 'bullets', bullets: ['x'] },
        steps: [{ cue: 'Hi' }],
      },
    ],
  }
  assert.throws(
    () => parseScript(bad),
    (err) =>
      err instanceof ScriptError &&
      assert.deepEqual(err.problems, [
        'title: expected a non-empty string',
        'palette: expected one of classic, everglade, origami',
        'scenes[0].narration: expected a non-empty string',
        'scenes[0].visual.kind: expected one of title, bullets, diagram, sequence',
        'scenes[1].steps[0].show: expected a non-empty array of strings',
      ]) === undefined
  )
})

test('parseScript: rejects a script with no scenes', () => {
  assert.throws(() => parseScript({ title: 'T', palette: 'classic', scenes: [] }), {
    message: 'scenes: expected a non-empty array',
  })
})
