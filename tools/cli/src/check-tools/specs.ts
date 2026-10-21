import type { ToolSpec } from './types.ts'

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
  elevenlabs: {
    tool: 'elevenlabs',
    use: 'ElevenLabs narration for walkthrough videos',
    onFailure:
      'STOP and tell the user ElevenLabs is configured but walkthrough render cannot voice the narration. Do NOT fall back.',
    requiresAll: ['ELEVEN_LABS_API_KEY'],
  },
  'mac-voice': {
    tool: 'mac-voice',
    use: 'A macOS voice narrating walkthrough videos',
    onFailure:
      'STOP and tell the user a macOS voice is configured but walkthrough render cannot voice the narration with it. Do NOT fall back.',
    requiresAll: ['WALKTHROUGH_MAC_VOICE'],
  },
}
