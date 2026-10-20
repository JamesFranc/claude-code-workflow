import { buildCommand, buildRouteMap } from '@stricli/core'
import { runWalkthroughRender } from '../walkthrough/main.ts'

const renderCommand = buildCommand({
  docs: {
    brief: 'Render a walkthrough script to an MP4, narrated or subtitled',
    fullDescription:
      'Reads a walkthrough script (JSON), checks every scene before voicing any of it, voices each ' +
      "scene's narration (reusing <script-basename>.cache/ beside the script for narration that " +
      "has not changed; with a macOS voice, changing a scene's cues re-voices it too), and renders " +
      'the scenes with HyperFrames to the given MP4. WALKTHROUGH_VOICE=kokoro voices it locally ' +
      'with Kokoro through uv (KOKORO_VOICE picks the English voice, default af_heart); otherwise ' +
      'ELEVEN_LABS_API_KEY voices it with ElevenLabs (ELEVEN_LABS_VOICE_ID picks the voice; ' +
      'changing either voice re-voices every scene), and failing that the macOS voice ' +
      "WALKTHROUGH_MAC_VOICE names does, as listed by say -v '?'. With none of them, the video is " +
      'rendered without a voice: each scene lasts as long as reading its narration takes, and the ' +
      'narration is shown as subtitles. Prints a JSON summary to stdout, whose narrated and voice ' +
      'fields say which. Exits 2 when ffmpeg is missing, uv is missing with Kokoro selected, ' +
      'HyperFrames cannot find or download Chrome, or a macOS voice is asked for and say or ' +
      'ffprobe cannot run; 1 when the script or WALKTHROUGH_VOICE is invalid, the macOS voice is ' +
      'not installed, or voicing or the render fails.',
  },
  parameters: {
    flags: {
      script: {
        kind: 'parsed',
        parse: String,
        brief: 'Path to the walkthrough script JSON',
        optional: false,
      },
      out: {
        kind: 'parsed',
        parse: String,
        brief: 'Path of the MP4 to write',
        optional: false,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  async func(flags: { script: string; out: string }) {
    await runWalkthroughRender(flags.script, flags.out)
  },
})

export const walkthroughRoutes = buildRouteMap({
  routes: { render: renderCommand },
  docs: { brief: 'Architecture walkthrough videos' },
})
