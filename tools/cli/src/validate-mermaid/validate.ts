import { JSDOM } from 'jsdom'

export interface ValidationResult {
  valid: boolean
  error?: string
}

interface Mermaid {
  parse(text: string): Promise<unknown>
  mermaidAPI: { getDiagramFromText(text: string): Promise<{ db: object }> }
}

let mermaidReady: Promise<Mermaid> | undefined
let dom: JSDOM | undefined

export const validateMermaid = async (code: string): Promise<ValidationResult> =>
  // Mermaid needs a DOM, but only while it loads and parses. A `window` left on globalThis makes
  // @terrastruct/d2 0.1.33 take its browser path in this Node process, and its renderer never starts.
  withDomGlobals(async () => {
    const mermaid = await getMermaid()
    try {
      await mermaid.parse(code)
      return { valid: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { valid: false, error: message.split('\n')[0] }
    }
  })

export interface SequenceIds {
  participants: string[]
  messages: number
}

// Mermaid's LINETYPE.NOTE: a note names participants but is not a message between them.
const NOTE = 2

// A sequence's participant ids, and how many messages it has. A message runs from one participant to
// another, so notes, blocks and activations are not counted. The source must already parse.
export const readSequence = async (code: string): Promise<SequenceIds> =>
  withDomGlobals(async () => {
    const { db } = await (await getMermaid()).mermaidAPI.getDiagramFromText(code)
    const actors = callDb(db, 'getActors')
    const signals = callDb(db, 'getMessages')
    return {
      participants: actors instanceof Map ? [...actors.keys()].map(String) : [],
      messages: Array.isArray(signals) ? signals.filter(isMessage).length : 0,
    }
  })

const getMermaid = (): Promise<Mermaid> => {
  mermaidReady ??= (async () => {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ startOnLoad: false })
    return mermaid
  })()
  return mermaidReady
}

const withDomGlobals = async <T>(run: () => Promise<T>): Promise<T> => {
  dom ??= new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document })
  try {
    return await run()
  } finally {
    Reflect.deleteProperty(globalThis, 'window')
    Reflect.deleteProperty(globalThis, 'document')
  }
}

const callDb = (db: object, method: string): unknown => {
  const fn: unknown = Reflect.get(db, method)
  if (typeof fn !== 'function') {
    throw new Error(`validate-mermaid: a sequence diagram's database has no ${method}`)
  }
  return Reflect.apply(fn, db, [])
}

const isMessage = (signal: unknown): boolean =>
  typeof signal === 'object' &&
  signal !== null &&
  typeof Reflect.get(signal, 'from') === 'string' &&
  typeof Reflect.get(signal, 'to') === 'string' &&
  Reflect.get(signal, 'type') !== NOTE
