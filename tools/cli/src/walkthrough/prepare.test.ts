import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareScript } from './prepare.ts'
import { ScriptError, type Scene } from './script.ts'

const problemsOf = async (scenes: Scene[]): Promise<string[]> => {
  try {
    await prepareScript({ title: 'T', palette: 'classic', scenes })
  } catch (err) {
    if (err instanceof ScriptError) {
      return err.problems
    }
    throw err
  }
  return []
}

const diagram = (steps: Scene['steps']): Scene => ({
  heading: 'Flow',
  narration: 'The client calls the server.',
  visual: {
    kind: 'diagram',
    d2: 'client: Client {class: actor}\nserver: Server {class: tool}\nclient -> server',
  },
  steps,
})

const SEQUENCE = [
  'sequenceDiagram',
  '  autonumber',
  '  actor u as User',
  '  participant rd as Renderer',
  '  box Outside',
  '  participant el as ElevenLabs',
  '  end',
  '  u->>+rd: render',
  '  Note over rd,el: checks script',
  '  alt ok',
  '    rd->>el: voice<br/>request',
  '  else bad',
  '    el--xrd: audio',
  '  end',
  '  rd->>rd: compose',
  '  rd-)-u: mp4',
].join('\n')

test('prepareScript: compiles a diagram scene and keeps its element bounds', async () => {
  const [scene] = await prepareScript({
    title: 'T',
    palette: 'classic',
    scenes: [diagram([{ cue: 'The client', show: ['client'], focus: [] }])],
  })
  assert.deepEqual([...(scene?.diagram?.elements.keys() ?? [])].sort(), [
    '(client -> server)[0]',
    'client',
    'server',
  ])
})

test('prepareScript: rejects a cue the narration never says, or says before the previous cue', async () => {
  assert.deepEqual(
    await problemsOf([
      diagram([
        { cue: 'server', show: ['server'], focus: [] },
        { cue: 'client', show: ['client'], focus: [] },
        { cue: 'database', show: ['client'], focus: [] },
      ]),
    ]),
    [
      'scenes[0].steps[1].cue: "client" does not occur in the narration after the previous cue',
      'scenes[0].steps[2].cue: "database" does not occur in the narration after the previous cue',
    ]
  )
})

test('prepareScript: rejects an id that is not in the diagram, listing the ids that are', async () => {
  assert.deepEqual(
    await problemsOf([diagram([{ cue: 'client', show: ['cache'], focus: ['client'] }])]),
    [
      'scenes[0].steps[0].show: "cache" is not in the diagram (ids: client, server, (client -> server)[0])',
    ]
  )
})

test('prepareScript: rejects a diagram that does not compile', async () => {
  const [problem] = await problemsOf([
    { heading: 'Bad', narration: 'Bad.', visual: { kind: 'diagram', d2: 'b ->' }, steps: [] },
  ])
  assert.match(problem ?? '', /^scenes\[0\]\.visual\.d2: .*connection missing destination/)
})

test('prepareScript: reports an empty label as a problem naming the scene', async () => {
  const [problem] = await problemsOf([
    { heading: 'Bad', narration: 'Bad.', visual: { kind: 'diagram', d2: 'a: ""' }, steps: [] },
  ])
  assert.equal(problem, "scenes[0].visual.d2: 'a': a box needs a label; this one is empty")
})

test('prepareScript: rejects a bullet index out of range, focus on bullets, and steps on a title', async () => {
  assert.deepEqual(
    await problemsOf([
      {
        heading: 'T',
        narration: 'Hi there.',
        visual: { kind: 'title' },
        steps: [{ cue: 'Hi', show: ['0'], focus: [] }],
      },
      {
        heading: 'P',
        narration: 'One and two.',
        visual: { kind: 'bullets', bullets: ['one', 'two'] },
        steps: [{ cue: 'two', show: ['2'], focus: ['0'] }],
      },
    ]),
    [
      'scenes[0].steps: a title scene has nothing to reveal, so takes no steps',
      'scenes[1].steps[0].show: "2" is not a bullet index (0 to 1)',
      'scenes[1].steps[0].focus: only a diagram scene can focus',
    ]
  )
})

test('prepareScript: rejects a sequence that Mermaid cannot parse', async () => {
  const [problem] = await problemsOf([
    {
      heading: 'S',
      narration: 'Calls.',
      visual: { kind: 'sequence', mermaid: 'sequenceDiagram\n  A->>' },
      steps: [],
    },
  ])
  assert.match(problem ?? '', /^scenes\[0\]\.visual\.mermaid: /)
})

test('prepareScript: a sequence step shows participants and messages, counting only messages', async () => {
  const sequence = (show: string[], focus: string[] = []): Scene => ({
    heading: 'S',
    narration: 'Calls.',
    visual: { kind: 'sequence', mermaid: SEQUENCE },
    steps: [{ cue: 'Calls', show, focus }],
  })
  assert.deepEqual(await problemsOf([sequence(['u', 'rd', 'el', '0', '4'])]), [])
  assert.deepEqual(await problemsOf([sequence(['zz', '5'], ['rd'])]), [
    'scenes[0].steps[0].show: "zz" is neither a participant nor a message index (participants: u, rd, el; messages: 0 to 4)',
    'scenes[0].steps[0].show: "5" is neither a participant nor a message index (participants: u, rd, el; messages: 0 to 4)',
    'scenes[0].steps[0].focus: only a diagram scene can focus',
  ])
  assert.deepEqual(await problemsOf([sequence(['01'])]), [
    'scenes[0].steps[0].show: "01" is not a canonical message index (no leading zeros)',
  ])
  const numbered = await problemsOf([
    {
      heading: 'S',
      narration: 'Calls.',
      visual: {
        kind: 'sequence',
        mermaid: 'sequenceDiagram\n  participant 1 as One\n  participant b\n  1->>b: hi',
      },
      steps: [{ cue: 'Calls', show: ['1'], focus: [] }],
    },
  ])
  assert.deepEqual(numbered, [
    'scenes[0].steps[0].show: "1" is both a participant id and a message index; give the participant a non-numeric id',
  ])
})

// Mermaid's checker defines a global `window`; a D2 renderer still starting when it appears never
// closes, so this file would hang instead of failing.
test('prepareScript: finishes when a sequence scene comes before a diagram scene', async () => {
  const scenes = await prepareScript({
    title: 'T',
    palette: 'classic',
    scenes: [
      {
        heading: 'S',
        narration: 'Calls.',
        visual: { kind: 'sequence', mermaid: 'sequenceDiagram\n  A->>B: hi' },
        steps: [],
      },
      diagram([]),
    ],
  })
  assert.equal(scenes[1]?.diagram?.elements.size, 3)
})

test('prepareScript: rejects a diagram that compiles to no elements, naming the scene', async () => {
  const [problem] = await problemsOf([
    {
      heading: 'Empty',
      narration: 'Empty.',
      visual: { kind: 'diagram', d2: 'direction: right' },
      steps: [],
    },
  ])
  assert.match(problem ?? '', /^scenes\[0\]\.visual\.d2: the diagram has no elements/)
})

test('prepareScript: a sequence with no messages says so when a step shows an unknown id', async () => {
  assert.deepEqual(
    await problemsOf([
      {
        heading: 'S',
        narration: 'Calls.',
        visual: { kind: 'sequence', mermaid: 'sequenceDiagram\n  participant a\n  participant b' },
        steps: [{ cue: 'Calls', show: ['zz'], focus: [] }],
      },
    ]),
    [
      'scenes[0].steps[0].show: "zz" is neither a participant nor a message index (participants: a, b; no messages)',
    ]
  )
})
