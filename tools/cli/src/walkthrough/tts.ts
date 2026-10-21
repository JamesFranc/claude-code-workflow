import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

export interface TtsOptions {
  apiKey: string
  voiceId: string
  cacheDir: string
  apiBase?: string
}

export const DEFAULT_VOICE_ID = 'vT7ssnLimZ4obHUM4HyN'
export const MODEL_ID = 'eleven_multilingual_v2'
export const SPEED = 1.1

export class TtsError extends Error {}

// Speaks `text`, or reuses the cached audio for the same voice, model, speed and text.
export const narrate = async (text: string, options: TtsOptions): Promise<Narration> => {
  const key = createHash('sha256')
    .update(options.voiceId + MODEL_ID + SPEED + text)
    .digest('hex')
  const audioFile = join(options.cacheDir, `${key}.mp3`)
  const entryFile = join(options.cacheDir, `${key}.json`)
  const cached = readCached(entryFile, audioFile)
  if (cached !== undefined) {
    return { audioFile, alignment: cached, cached: true }
  }

  const { audio, alignment } = await synthesize(text, options)
  mkdirSync(options.cacheDir, { recursive: true })
  writeFileSync(audioFile, audio)
  writeFileSync(entryFile, JSON.stringify({ audioFile: `${key}.mp3`, alignment }))
  return { audioFile, alignment, cached: false }
}

export const readCached = (entryFile: string, audioFile: string): Alignment | undefined => {
  try {
    const entry: unknown = JSON.parse(readFileSync(entryFile, 'utf-8'))
    const alignment = isRecord(entry) ? entry.alignment : undefined
    return isAlignment(alignment) && existsSync(audioFile) ? alignment : undefined
  } catch {
    return undefined
  }
}

const synthesize = async (
  text: string,
  { apiKey, voiceId, apiBase = 'https://api.elevenlabs.io' }: TtsOptions
): Promise<{ audio: Buffer; alignment: Alignment }> => {
  const voiceSettings = { ...(await storedSettings(apiBase, voiceId, apiKey)), speed: SPEED }
  const response = await fetch(`${apiBase}/v1/text-to-speech/${voiceId}/with-timestamps`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: voiceSettings }),
  })
  if (!response.ok) {
    throw new TtsError(`ElevenLabs returned ${response.status}: ${await response.text()}`)
  }
  const body = await readJson(response)
  const audio = isRecord(body) ? body.audio_base64 : undefined
  const alignment = isRecord(body) ? body.alignment : undefined
  if (typeof audio !== 'string' || !isAlignment(alignment)) {
    throw new TtsError('ElevenLabs returned no audio_base64 and alignment')
  }
  return { audio: Buffer.from(audio, 'base64'), alignment }
}

// The voice's own settings, so that sending a speed leaves the rest as they are.
const storedSettings = async (
  apiBase: string,
  voiceId: string,
  apiKey: string
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${apiBase}/v1/voices/${voiceId}/settings`, {
    headers: { 'xi-api-key': apiKey },
  })
  if (!response.ok) {
    throw new TtsError(
      `ElevenLabs returned ${response.status} for the voice's settings: ${await response.text()}`
    )
  }
  const settings = await readJson(response)
  if (!isRecord(settings)) {
    throw new TtsError('ElevenLabs returned voice settings that are not an object')
  }
  return settings
}

// Reads the body as text outside the try, so only a body that read and failed to parse is "not JSON".
const readJson = async (response: Response): Promise<unknown> => {
  const raw = await response.text()
  try {
    return JSON.parse(raw)
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err
    }
    throw new TtsError('ElevenLabs returned a reply that is not JSON')
  }
}

const isAlignment = (value: unknown): value is Alignment =>
  isRecord(value) &&
  isArrayOf(value.characters, 'string') &&
  isArrayOf(value.character_start_times_seconds, 'number') &&
  isArrayOf(value.character_end_times_seconds, 'number')

const isArrayOf = (value: unknown, type: 'string' | 'number'): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === type)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
