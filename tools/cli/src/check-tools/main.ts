import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { TOOL_SPECS } from './specs.ts'
import type { CheckToolsOutput, ToolResult, ToolSpec } from './types.ts'

export const runCheckTools = (tools: readonly string[]): void => {
  if (tools.length === 0) {
    console.error('check-tools: --require must list at least one tool')
    process.exit(2)
  }

  const results = tools.map((tool) => classifyTool(tool, process.env))
  const output = buildOutput(results)

  for (const result of results) console.error(formatStderrLine(result))
  process.stdout.write(JSON.stringify(output) + '\n')
  setRequestedExitCode(output.anyFailed ? 1 : 0)
  return
}

const classifyTool = (tool: string, env: NodeJS.ProcessEnv): ToolResult => {
  const spec = TOOL_SPECS[tool]
  if (!spec) return unknownTool(tool)

  const present = findPresentEnv(spec, env)
  const missing = findMissingEnv(spec, env)
  const accepted = acceptedEnv(spec)

  if (missing.length > 0 && present.length > 0) {
    return result(
      spec,
      'failed',
      present,
      missing,
      accepted,
      `partial env config — required vars: ${missing.join(', ')}`
    )
  }

  if (present.length > 0) return result(spec, 'configured', present, missing, accepted)

  return result(
    spec,
    'unconfigured',
    present,
    missing,
    accepted,
    `env vars not set: ${accepted.join(', ')}`
  )
}

const unknownTool = (tool: string): ToolResult => ({
  tool,
  state: 'failed',
  use: 'unknown',
  onFailure: `unknown tool '${tool}' — add it to TOOL_SPECS`,
  env: { present: [], missing: [], accepted: [] },
  reason: `unknown tool '${tool}' — add it to TOOL_SPECS`,
})

const result = (
  spec: ToolSpec,
  state: ToolResult['state'],
  present: readonly string[],
  missing: readonly string[],
  accepted: readonly string[],
  reason?: string
): ToolResult => ({
  tool: spec.tool,
  state,
  use: spec.use,
  onFailure: spec.onFailure,
  env: { present, missing, accepted },
  ...(reason ? { reason } : {}),
})

const findPresentEnv = (spec: ToolSpec, env: NodeJS.ProcessEnv): readonly string[] => {
  const exact = spec.requiresAll?.filter((name) => isSet(env[name])) ?? []
  const prefix = Object.keys(env).filter(
    (name) => spec.acceptsAnyPrefix?.some((p) => name.startsWith(p)) && isSet(env[name])
  )
  return Array.from(new Set([...exact, ...prefix])).sort()
}

const findMissingEnv = (spec: ToolSpec, env: NodeJS.ProcessEnv): readonly string[] =>
  spec.requiresAll?.filter((name) => !isSet(env[name])) ?? []

const acceptedEnv = (spec: ToolSpec): readonly string[] => [
  ...(spec.requiresAll ?? []),
  ...(spec.acceptsAnyPrefix?.map((prefix) => `${prefix}*`) ?? []),
]

const isSet = (value: string | undefined): boolean => value !== undefined && value.trim().length > 0

const buildOutput = (results: readonly ToolResult[]): CheckToolsOutput => ({
  results,
  anyFailed: results.some((result) => result.state === 'failed'),
})

const formatStderrLine = (result: ToolResult): string => {
  const marker = result.state === 'configured' ? '✓' : result.state === 'unconfigured' ? '·' : '✗'
  const detail = result.reason ?? result.use
  return `${marker} ${result.tool}: ${result.state} — ${detail}`
}
