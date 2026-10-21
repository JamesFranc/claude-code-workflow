import { execFileSync } from 'node:child_process'

const PS_TIMEOUT_MS = 10_000
const PS_MAX_BUFFER_BYTES = 64 * 1024 * 1024

export interface TeammateArgv {
  agentId: string
  teamName: string
  parentSessionId: string | undefined
}

// `ps` output for the given `-o` columns, or null when the process table could not be read.
export const readPsOutput = (columns: string): string | null => {
  try {
    return execFileSync('ps', ['-axww', '-o', columns], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
      maxBuffer: PS_MAX_BUFFER_BYTES,
    })
  } catch {
    return null
  }
}

// A teammate's Claude process carries `--agent-id`, `--agent-name` and `--team-name` together; the
// lead's own CLI calls can carry `--agent-id` alone (`review-ledger senior shutdown --agent-id <id>`),
// so all three are required.
export const parseTeammateArgv = (command: string): TeammateArgv | undefined => {
  const agentId = /--agent-id\s+(\S+)/.exec(command)?.[1]
  const teamName = /--team-name\s+(\S+)/.exec(command)?.[1]
  const hasAgentName = /--agent-name\s+\S+/.test(command)
  if (agentId === undefined || teamName === undefined || !hasAgentName) {
    return undefined
  }

  const parentSessionId = /--parent-session-id\s+(\S+)/.exec(command)?.[1]
  return { agentId, teamName, parentSessionId }
}
