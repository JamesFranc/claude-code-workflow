import { PALETTE_NAMES, isPaletteName, type PaletteName } from '../render-diagrams/render.ts'

// The walkthrough script the Architecture skill writes beside an architecture doc
// (FLOW-390 architecture doc, "Data Structures").

export interface WalkthroughScript {
  title: string
  palette: PaletteName
  scenes: Scene[]
}

export interface Scene {
  heading: string
  narration: string
  visual: Visual
  steps: Step[]
}

export type Visual =
  | { kind: 'title'; subtitle?: string }
  | { kind: 'bullets'; bullets: string[] }
  | { kind: 'diagram'; d2: string }
  | { kind: 'sequence'; mermaid: string }

export interface Step {
  cue: string
  show: string[]
  focus: string[]
}

// Everything wrong with a script, one line per problem, each naming where it is.
export class ScriptError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(problems.join('\n'))
    this.problems = problems
  }
}

export const parseScript = (value: unknown): WalkthroughScript => {
  const problems: string[] = []
  const script = readScript(value, problems)
  if (script === undefined || problems.length > 0) {
    throw new ScriptError(problems)
  }
  return script
}

const readScript = (value: unknown, problems: string[]): WalkthroughScript | undefined => {
  if (!isRecord(value)) {
    problems.push('script: expected a JSON object')
    return undefined
  }
  const { title, palette, scenes } = value
  if (typeof title !== 'string' || title === '') {
    problems.push('title: expected a non-empty string')
  }
  if (typeof palette !== 'string' || !isPaletteName(palette)) {
    problems.push(`palette: expected one of ${PALETTE_NAMES.join(', ')}`)
  }
  if (!Array.isArray(scenes) || scenes.length === 0) {
    problems.push('scenes: expected a non-empty array')
    return undefined
  }
  const parsed = scenes.map((scene, i) => readScene(scene, `scenes[${i}]`, problems))
  if (
    typeof title === 'string' &&
    typeof palette === 'string' &&
    isPaletteName(palette) &&
    parsed.every(isDefined)
  ) {
    return { title, palette, scenes: parsed }
  }
  return undefined
}

const readScene = (value: unknown, at: string, problems: string[]): Scene | undefined => {
  if (!isRecord(value)) {
    problems.push(`${at}: expected an object`)
    return undefined
  }
  const { heading, narration, visual, steps = [] } = value
  if (typeof heading !== 'string') {
    problems.push(`${at}.heading: expected a string`)
  }
  if (typeof narration !== 'string' || narration.trim() === '') {
    problems.push(`${at}.narration: expected a non-empty string`)
  }
  const parsedVisual = readVisual(visual, `${at}.visual`, problems)
  if (!Array.isArray(steps)) {
    problems.push(`${at}.steps: expected an array`)
    return undefined
  }
  const parsedSteps = steps.map((step, i) => readStep(step, `${at}.steps[${i}]`, problems))
  if (
    typeof heading === 'string' &&
    typeof narration === 'string' &&
    parsedVisual !== undefined &&
    parsedSteps.every(isDefined)
  ) {
    return { heading, narration, visual: parsedVisual, steps: parsedSteps }
  }
  return undefined
}

const readVisual = (value: unknown, at: string, problems: string[]): Visual | undefined => {
  if (!isRecord(value)) {
    problems.push(`${at}: expected an object`)
    return undefined
  }
  const { kind, subtitle, bullets, d2, mermaid } = value
  if (kind === 'title') {
    if (subtitle !== undefined && typeof subtitle !== 'string') {
      problems.push(`${at}.subtitle: expected a string`)
      return undefined
    }
    return subtitle === undefined ? { kind } : { kind, subtitle }
  }
  if (kind === 'bullets') {
    if (!isStringArray(bullets) || bullets.length === 0) {
      problems.push(`${at}.bullets: expected a non-empty array of strings`)
      return undefined
    }
    return { kind, bullets }
  }
  if (kind === 'diagram') {
    if (typeof d2 !== 'string' || d2.trim() === '') {
      problems.push(`${at}.d2: expected a non-empty string`)
      return undefined
    }
    return { kind, d2 }
  }
  if (kind === 'sequence') {
    if (typeof mermaid !== 'string' || mermaid.trim() === '') {
      problems.push(`${at}.mermaid: expected a non-empty string`)
      return undefined
    }
    return { kind, mermaid }
  }
  problems.push(`${at}.kind: expected one of title, bullets, diagram, sequence`)
  return undefined
}

const readStep = (value: unknown, at: string, problems: string[]): Step | undefined => {
  if (!isRecord(value)) {
    problems.push(`${at}: expected an object`)
    return undefined
  }
  const { cue, show, focus = [] } = value
  if (typeof cue !== 'string' || cue.trim() === '') {
    problems.push(`${at}.cue: expected a non-empty string`)
  }
  if (!isStringArray(show) || show.length === 0) {
    problems.push(`${at}.show: expected a non-empty array of strings`)
  }
  if (!isStringArray(focus)) {
    problems.push(`${at}.focus: expected an array of strings`)
  }
  if (typeof cue === 'string' && isStringArray(show) && isStringArray(focus)) {
    return { cue, show, focus }
  }
  return undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isDefined = <T>(value: T | undefined): value is T => value !== undefined
