export type ToolState = 'configured' | 'unconfigured' | 'failed'

export type ToolSpec = {
  readonly tool: string
  readonly use: string
  readonly onFailure: string
  readonly requiresAll?: readonly string[]
  readonly acceptsAnyPrefix?: readonly string[]
  readonly envProblem?: (env: NodeJS.ProcessEnv) => string | undefined
}

export type EnvSummary = {
  readonly present: readonly string[]
  readonly missing: readonly string[]
  readonly accepted: readonly string[]
}

export type ToolResult = {
  readonly tool: string
  readonly state: ToolState
  readonly use: string
  readonly onFailure: string
  readonly env: EnvSummary
  readonly reason?: string
}

export type CheckToolsOutput = {
  readonly results: readonly ToolResult[]
  readonly anyFailed: boolean
}
