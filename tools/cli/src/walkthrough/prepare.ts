import {
  DiagramSourceError,
  createDiagramRenderer,
  type RenderedDiagram,
} from '../render-diagrams/render.ts'
import { readSequence, validateMermaid, type SequenceIds } from '../validate-mermaid/validate.ts'
import { ScriptError, type Scene, type Step, type WalkthroughScript } from './script.ts'

export interface PreparedScene extends Scene {
  // The compiled diagram, for a diagram scene.
  diagram?: RenderedDiagram
}

// Checks everything about a script that can be checked without voicing any narration, and
// compiles its diagrams. Throws a ScriptError listing every problem it found.
export const prepareScript = async (script: WalkthroughScript): Promise<PreparedScene[]> => {
  const problems: string[] = []
  const scenes: PreparedScene[] = []
  const renderer = createDiagramRenderer(script.palette)
  try {
    for (const [i, scene] of script.scenes.entries()) {
      const at = `scenes[${i}]`
      checkCues(scene, at, problems)
      scenes.push({ ...scene, ...(await checkVisual(scene, at, problems, renderer.render)) })
    }
  } finally {
    await renderer.close()
  }
  // Only once D2 is closed: Mermaid's check puts a `window` on globalThis while it runs, and a D2
  // worker starting up while one is there never becomes ready (validateMermaid).
  for (const [i, { visual, steps }] of script.scenes.entries()) {
    if (visual.kind === 'sequence') {
      const result = await validateMermaid(visual.mermaid)
      if (!result.valid) {
        problems.push(`scenes[${i}].visual.mermaid: ${result.error ?? 'invalid'}`)
        continue
      }
      checkSequenceSteps(steps, await readSequence(visual.mermaid), `scenes[${i}]`, problems)
    }
  }
  if (problems.length > 0) {
    throw new ScriptError(problems)
  }
  return scenes
}

// Each cue must be spoken, and in step order: a cue is looked for after the previous one ends.
const checkCues = (scene: Scene, at: string, problems: string[]): void => {
  let from = 0
  for (const [j, { cue }] of scene.steps.entries()) {
    const index = scene.narration.indexOf(cue, from)
    if (index === -1) {
      problems.push(
        `${at}.steps[${j}].cue: "${cue}" does not occur in the narration after the previous cue`
      )
      continue
    }
    from = index + cue.length
  }
}

// A sequence step shows a participant by its Mermaid id and a message by its index among the
// messages, in source order.
const checkSequenceSteps = (
  steps: Step[],
  { participants, messages }: SequenceIds,
  at: string,
  problems: string[]
): void => {
  for (const [j, step] of steps.entries()) {
    for (const id of step.show) {
      const where = `${at}.steps[${j}].show`
      if (/^\d+$/.test(id) && participants.includes(id)) {
        problems.push(
          `${where}: "${id}" is both a participant id and a message index; give the participant a non-numeric id`
        )
      } else if (/^\d+$/.test(id) && !/^(0|[1-9]\d*)$/.test(id)) {
        problems.push(`${where}: "${id}" is not a canonical message index (no leading zeros)`)
      } else if (!(/^\d+$/.test(id) ? Number(id) < messages : participants.includes(id))) {
        problems.push(
          `${where}: "${id}" is neither a participant nor a message index (participants: ${participants.join(', ')}; ${messages === 0 ? 'no messages' : `messages: 0 to ${messages - 1}`})`
        )
      }
    }
    if (step.focus.length > 0) {
      problems.push(`${at}.steps[${j}].focus: only a diagram scene can focus`)
    }
  }
}

const checkVisual = async (
  scene: Scene,
  at: string,
  problems: string[],
  render: (code: string) => Promise<RenderedDiagram>
): Promise<{ diagram?: RenderedDiagram }> => {
  const { visual, steps } = scene
  if (visual.kind === 'title') {
    if (steps.length > 0) {
      problems.push(`${at}.steps: a title scene has nothing to reveal, so takes no steps`)
    }
    return {}
  }
  if (visual.kind === 'sequence') {
    return {}
  }
  if (visual.kind === 'bullets') {
    for (const [j, step] of steps.entries()) {
      for (const index of step.show) {
        if (!/^\d+$/.test(index) || Number(index) >= visual.bullets.length) {
          problems.push(
            `${at}.steps[${j}].show: "${index}" is not a bullet index (0 to ${visual.bullets.length - 1})`
          )
        }
      }
      if (step.focus.length > 0) {
        problems.push(`${at}.steps[${j}].focus: only a diagram scene can focus`)
      }
    }
    return {}
  }
  let diagram: RenderedDiagram
  try {
    diagram = await render(visual.d2)
  } catch (err) {
    if (!(err instanceof DiagramSourceError)) {
      throw err
    }
    problems.push(`${at}.visual.d2: ${err.message}`)
    return {}
  }
  if (diagram.elements.size === 0) {
    problems.push(`${at}.visual.d2: the diagram has no elements to show`)
    return {}
  }
  for (const [j, step] of steps.entries()) {
    for (const field of ['show', 'focus'] satisfies (keyof Step)[]) {
      for (const id of step[field]) {
        if (!diagram.elements.has(id)) {
          problems.push(
            `${at}.steps[${j}].${field}: "${id}" is not in the diagram (ids: ${[...diagram.elements.keys()].join(', ')})`
          )
        }
      }
    }
  }
  return { diagram }
}
