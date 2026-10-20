import { elevenlabs } from './elevenlabs.ts'
import { kokoro } from './kokoro.ts'
import { mac } from './mac-voice.ts'
import type { Voice } from './voice.ts'

// The registry. A voice is available to WALKTHROUGH_VOICE, to render and to check-tools once it is listed here.
export const VOICES: readonly Voice[] = [elevenlabs, kokoro, mac]

export type VoiceSelection =
  // A named voice, or a default one; `problem` is the env's reason it cannot narrate. `notice` says
  // what a default selection passed over.
  | { voice: Voice; problem: string | undefined; notice?: string }
  | { voice: undefined; problem: string }
  // No voice selected: render goes silent, with `notice` saying why.
  | { voice: undefined; problem: undefined; notice: string }

export const selectVoice = (env: NodeJS.ProcessEnv): VoiceSelection => {
  const requested = env.WALKTHROUGH_VOICE
  if (requested === undefined || requested === '') {
    return selectDefaultVoice(env)
  }
  const voice = VOICES.find(({ name }) => name === requested)
  if (voice === undefined) {
    return {
      voice: undefined,
      problem: `WALKTHROUGH_VOICE is "${requested}"; the voices it can name are ${voiceNames(', ')}.`,
    }
  }
  const problem = voice.envProblem(env)
  return {
    voice,
    problem: problem === undefined ? undefined : `WALKTHROUGH_VOICE=${voice.name}, but ${problem}`,
  }
}

// With WALKTHROUGH_VOICE unset or empty: ElevenLabs when its env allows it, else the macOS voice
// when its env allows it, else none.
const selectDefaultVoice = (env: NodeJS.ProcessEnv): VoiceSelection => {
  const elevenlabsProblem = elevenlabs.envProblem(env)
  const macProblem = mac.envProblem(env)
  if (elevenlabsProblem === undefined) {
    return macProblem === undefined
      ? {
          voice: elevenlabs,
          problem: undefined,
          notice:
            'ELEVEN_LABS_API_KEY is set, so ElevenLabs voices the walkthrough and ' +
            'WALKTHROUGH_MAC_VOICE is ignored.',
        }
      : { voice: elevenlabs, problem: undefined }
  }
  if (macProblem === undefined) {
    return { voice: mac, problem: undefined }
  }
  return {
    voice: undefined,
    problem: undefined,
    notice:
      `no voice is selected: WALKTHROUGH_VOICE is unset or empty, ${elevenlabsProblem} and ` +
      `${macProblem} (WALKTHROUGH_VOICE can name ${voiceNames(', ')}), so the walkthrough is ` +
      'rendered without a voice, with the narration as subtitles.',
  }
}

const voiceNames = (separator: string): string => VOICES.map(({ name }) => name).join(separator)
