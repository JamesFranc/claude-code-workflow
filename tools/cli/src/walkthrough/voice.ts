import { existsSync, readFileSync, writeFileSync } from 'node:fs'

// ElevenLabs' character timings, in its own field names.
export interface Alignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

export interface Narration {
  audioFile: string
  alignment: Alignment
  cached: boolean
}

export type VoiceName = 'elevenlabs' | 'kokoro' | 'mac'

// `cues` are the scene's step cues, which a voice that reports no timings uses to time them.
export type Narrator = (text: string, cues: string[], cacheDir: string) => Promise<Narration>

export interface VoiceProblem {
  message: string
  exitCode: number
}

export interface VoiceOptions {
  // The ElevenLabs API origin; tests point it at a local server.
  apiBase?: string
}

export interface Voice {
  name: VoiceName
  // Whether the voice charges for each character it voices, which `ttsCharacters` counts.
  chargedPerCharacter: boolean
  // Why the env cannot use this voice once it is selected, e.g. an ElevenLabs with no key.
  envProblem(env: NodeJS.ProcessEnv): string | undefined
  // Why a tool the voice needs is not usable, e.g. Kokoro without uv, and the exit code to stop on.
  preflight(env: NodeJS.ProcessEnv): VoiceProblem | undefined
  narrator(env: NodeJS.ProcessEnv, options: VoiceOptions): Narrator
}

export const SPEED = 1.1

export class VoiceError extends Error {}

export const readCached = (entryFile: string, audioFile: string): Alignment | undefined => {
  try {
    const entry: unknown = JSON.parse(readFileSync(entryFile, 'utf-8'))
    const alignment = isRecord(entry) ? entry.alignment : undefined
    return isAlignment(alignment) && existsSync(audioFile) ? alignment : undefined
  } catch {
    return undefined
  }
}

export const writeCacheEntry = (entryFile: string, key: string, alignment: Alignment): void => {
  writeFileSync(entryFile, JSON.stringify({ audioFile: `${key}.mp3`, alignment }))
}

export const isAlignment = (value: unknown): value is Alignment =>
  isRecord(value) &&
  isArrayOf(value.characters, 'string') &&
  isArrayOf(value.character_start_times_seconds, 'number') &&
  isArrayOf(value.character_end_times_seconds, 'number')

const isArrayOf = (value: unknown, type: 'string' | 'number'): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === type)

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
