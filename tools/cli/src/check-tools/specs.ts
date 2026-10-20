import { elevenlabs } from '../walkthrough/elevenlabs.ts'
import { kokoro } from '../walkthrough/kokoro.ts'
import { mac } from '../walkthrough/mac-voice.ts'
import type { Voice } from '../walkthrough/voice.ts'
import { selectVoice } from '../walkthrough/voices.ts'
import type { ToolSpec } from './types.ts'

// A voice is configured only while it is the one render would narrate with, and fails with the
// problem render would stop on: any selection problem, or its own when it is the one selected.
const voiceSpec = (
  voice: Voice,
  spec: Omit<ToolSpec, 'envProblem' | 'inUse' | 'unusedReason'>
): ToolSpec => ({
  ...spec,
  envProblem: (env) => {
    const selection = selectVoice(env)
    return selection.voice === undefined || selection.voice === voice
      ? selection.problem
      : undefined
  },
  inUse: (env) => selectVoice(env).voice === voice,
  unusedReason: (env) => {
    const { voice: selected } = selectVoice(env)
    if (selected === undefined) {
      return undefined
    }
    if (env.WALKTHROUGH_VOICE) {
      return `WALKTHROUGH_VOICE selects ${selected.name}`
    }
    const ownEnvSet = (spec.requiresAll ?? []).every((name) => env[name]?.trim())
    return ownEnvSet ? `${selected.name} is selected ahead of it` : undefined
  },
})

export const TOOL_SPECS: Readonly<Record<string, ToolSpec>> = {
  jira: {
    tool: 'jira',
    use: 'Jira MCP tools',
    onFailure:
      'STOP and tell the user Jira was configured/intended but the Jira MCP tools are not working. Do NOT fall back.',
    acceptsAnyPrefix: ['JIRA_', 'ATLASSIAN_'],
  },
  notion: {
    tool: 'notion',
    use: 'Notion MCP tools',
    onFailure:
      'STOP and tell the user Notion is configured but the Notion MCP tools are not working. Do NOT fall back.',
    requiresAll: ['NOTION_PAGE_URL'],
  },
  elevenlabs: voiceSpec(elevenlabs, {
    tool: 'elevenlabs',
    use: 'ElevenLabs narration for walkthrough videos',
    onFailure:
      'STOP and tell the user ElevenLabs is configured but walkthrough render cannot voice the narration. Do NOT fall back.',
    requiresAll: ['ELEVEN_LABS_API_KEY'],
  }),
  kokoro: voiceSpec(kokoro, {
    tool: 'kokoro',
    use: 'Local Kokoro narration for walkthrough videos',
    onFailure:
      'STOP and tell the user walkthrough render cannot voice the narration, with the reason given. Do NOT fall back.',
    requiresAll: ['WALKTHROUGH_VOICE'],
  }),
  'mac-voice': voiceSpec(mac, {
    tool: 'mac-voice',
    use: 'A macOS voice narrating walkthrough videos',
    onFailure:
      'STOP and tell the user a macOS voice is configured but walkthrough render cannot voice the narration with it. Do NOT fall back.',
    requiresAll: ['WALKTHROUGH_MAC_VOICE'],
  }),
}
