import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { composeHtml, timeScenes } from './compose.ts'
import { prepareScript, type PreparedScene } from './prepare.ts'
import { ScriptError, parseScript, type WalkthroughScript } from './script.ts'
import { readingAlignment } from './silent.ts'
import {
  VoiceError,
  type Alignment,
  type Narration,
  type Narrator,
  type VoiceName,
} from './voice.ts'
import { selectVoice } from './voices.ts'

interface WalkthroughOutput {
  output: string
  narrated: boolean
  // Which voice narrated the walkthrough, or null when it is silent.
  voice: VoiceName | null
  durationSeconds: number
  bytes: number
  scenes: number
  synthesizedScenes: number
  cachedScenes: number
  ttsCharacters: number
  overNotionLimit: boolean
}

type Writer = (chunk: string) => void

interface WalkthroughOptions {
  stdout?: Writer
  env?: NodeJS.ProcessEnv
  // The ElevenLabs API origin; tests point it at a local server.
  apiBase?: string
}

export const HYPERFRAMES = 'hyperframes@0.8.123'
// The most the Notion MCP's single-part upload accepts.
const NOTION_UPLOAD_LIMIT = 20 * 1024 * 1024
const MISSING_TOOL_EXIT = 2
// Child processes write to our stderr, so stdout carries only the JSON summary.
const STDERR = 2
// Mostly still slides: x264 tuned for stills at CRF 26 and 64 kbps mono speech keep a 15-minute
// walkthrough under the Notion upload limit; HyperFrames' own encode runs about twice that size.
const VIDEO_ENCODING = ['-c:v', 'libx264', '-preset', 'slow', '-tune', 'stillimage', '-crf', '26']
const AUDIO_ENCODING = ['-c:a', 'aac', '-b:a', '64k', '-ac', '1']
// The index goes at the front, so the video starts playing before it has fully downloaded.
const CONTAINER_FLAGS = ['-movflags', '+faststart']

// Renders a walkthrough script to an MP4 (FLOW-390 architecture doc, "walkthrough"): narrated when
// a voice is selected (FLOW-432), otherwise silent with the narration as subtitles (FLOW-423).
// Everything that can be checked without voicing anything is checked before the first narration.
export const runWalkthroughRender = async (
  scriptFile: string,
  outFile: string,
  options: WalkthroughOptions = {}
): Promise<void> => {
  const env = options.env ?? process.env
  const stdout = options.stdout ?? ((chunk: string) => void process.stdout.write(chunk))
  const selection = selectVoice(env)
  if (selection.problem !== undefined) {
    console.error(`walkthrough: ${selection.problem}`)
    setRequestedExitCode(1)
    return
  }
  const { voice } = selection
  const narrator = voice?.narrator(env, { apiBase: options.apiBase })
  const narrated = narrator !== undefined
  if (selection.notice !== undefined) {
    console.error(`walkthrough: ${selection.notice}`)
  }
  const ffmpegProblem = probeFfmpeg()
  if (ffmpegProblem !== undefined) {
    console.error(ffmpegProblem)
    setRequestedExitCode(MISSING_TOOL_EXIT)
    return
  }
  const preflightProblem = voice?.preflight(env)
  if (preflightProblem !== undefined) {
    console.error(preflightProblem.message)
    setRequestedExitCode(preflightProblem.exitCode)
    return
  }

  const prepared = await prepareScriptFile(scriptFile)
  if (prepared === undefined) {
    setRequestedExitCode(1)
    return
  }
  const { script, scenes } = prepared

  // Finds Chrome or downloads it, so a first run that cannot get one says so before any narration is paid for.
  if (!hyperframes(['browser', 'ensure'])) {
    setRequestedExitCode(MISSING_TOOL_EXIT)
    return
  }

  const narrations = narrator === undefined ? [] : await narrateScenes(scenes, scriptFile, narrator)
  if (narrations === undefined) {
    setRequestedExitCode(1)
    return
  }

  const workDir = mkdtempSync(join(tmpdir(), 'walkthrough-'))
  try {
    const timed = timeScenes(
      scenes,
      narrated
        ? copyNarrations(narrations, workDir)
        : scenes.map(({ narration }) => ({
            audio: undefined,
            alignment: readingAlignment(narration),
          }))
    )
    const require = createRequire(import.meta.url)
    copyFileSync(require.resolve('gsap/dist/gsap.min.js'), join(workDir, 'gsap.min.js'))
    copyFileSync(require.resolve('mermaid/dist/mermaid.min.js'), join(workDir, 'mermaid.min.js'))
    writeFileSync(join(workDir, 'index.html'), composeHtml(script.title, script.palette, timed))

    const rendered = join(workDir, 'rendered.mp4')
    if (!hyperframes(['render', workDir, '-o', rendered, '--quality', 'standard'])) {
      setRequestedExitCode(1)
      return
    }
    const encode = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        rendered,
        ...VIDEO_ENCODING,
        ...(narrated ? AUDIO_ENCODING : ['-an']),
        ...CONTAINER_FLAGS,
        outFile,
      ],
      {
        stdio: ['ignore', STDERR, STDERR],
      }
    )
    if (encode.status !== 0) {
      console.error('walkthrough: ffmpeg failed to encode the video')
      setRequestedExitCode(1)
      return
    }

    const bytes = statSync(outFile).size
    const output: WalkthroughOutput = {
      output: outFile,
      narrated,
      voice: voice?.name ?? null,
      durationSeconds: timed.reduce((sum, { duration }) => sum + duration, 0),
      bytes,
      scenes: scenes.length,
      synthesizedScenes: narrations.filter(({ cached }) => !cached).length,
      cachedScenes: narrations.filter(({ cached }) => cached).length,
      ttsCharacters: voice?.chargedPerCharacter
        ? scenes
            .filter((_, i) => narrations[i]?.cached === false)
            .reduce((sum, { narration }) => sum + narration.length, 0)
        : 0,
      overNotionLimit: bytes > NOTION_UPLOAD_LIMIT,
    }
    stdout(JSON.stringify(output) + '\n')
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

// Parses and checks the script, or reports why it cannot and returns undefined.
const prepareScriptFile = async (
  scriptFile: string
): Promise<{ script: WalkthroughScript; scenes: PreparedScene[] } | undefined> => {
  try {
    const script = parseScript(JSON.parse(readScript(scriptFile)))
    return { script, scenes: await prepareScript(script) }
  } catch (err) {
    if (!(err instanceof ScriptError || err instanceof SyntaxError)) {
      throw err
    }
    console.error(`${scriptFile}: ${err.message}`)
    return undefined
  }
}

// Voices every scene, or reports why it cannot and returns undefined.
const narrateScenes = async (
  scenes: PreparedScene[],
  scriptFile: string,
  narrator: Narrator
): Promise<Narration[] | undefined> => {
  const cacheDir = cacheDirOf(scriptFile)
  try {
    const narrations: Narration[] = []
    for (const scene of scenes) {
      narrations.push(
        await narrator(
          scene.narration,
          scene.steps.map(({ cue }) => cue),
          cacheDir
        )
      )
    }
    return narrations
  } catch (err) {
    if (!(err instanceof VoiceError)) {
      throw err
    }
    console.error(`${scriptFile}: ${err.message}`)
    return undefined
  }
}

// Copies each scene's audio into the composition, beside its alignment, keeping its format.
const copyNarrations = (
  narrations: Narration[],
  workDir: string
): { audio: string; alignment: Alignment }[] => {
  mkdirSync(join(workDir, 'audio'))
  return narrations.map(({ audioFile, alignment }, i) => {
    const audio = `audio/scene-${i}${extname(audioFile)}`
    copyFileSync(audioFile, join(workDir, audio))
    return { audio, alignment }
  })
}

// The message to print when ffmpeg cannot run, or undefined when it can.
const probeFfmpeg = (): string | undefined => {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  const code = probe.error !== undefined && 'code' in probe.error ? probe.error.code : undefined

  if (code === 'ENOENT') {
    return 'walkthrough: ffmpeg is not on PATH; install it (brew install ffmpeg).'
  }
  if (probe.error !== undefined) {
    return `walkthrough: ffmpeg could not be run (${String(code ?? probe.error.message)}).`
  }
  if (probe.signal !== null) {
    return `walkthrough: ffmpeg -version was killed by ${probe.signal}.`
  }
  if (probe.status !== 0) {
    return `walkthrough: ffmpeg -version exited with status ${probe.status}.`
  }
  return undefined
}

const readScript = (scriptFile: string): string => {
  try {
    return readFileSync(scriptFile, 'utf-8')
  } catch (err) {
    throw new ScriptError([
      `cannot read the script: ${err instanceof Error ? err.message : String(err)}`,
    ])
  }
}

// Runs a HyperFrames command with its output on stderr; on failure that output says why.
const hyperframes = (args: string[]): boolean => {
  const result = spawnSync('npx', ['-y', HYPERFRAMES, ...args], {
    stdio: ['ignore', STDERR, STDERR],
    env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' },
  })
  if (result.status !== 0) {
    console.error(`walkthrough: hyperframes ${args.join(' ')} failed`)
    return false
  }
  return true
}

// Narration audio is cached beside the script, whichever voice speaks it.
const cacheDirOf = (scriptFile: string): string =>
  join(dirname(scriptFile), `${basename(scriptFile, '.json')}.cache`)
