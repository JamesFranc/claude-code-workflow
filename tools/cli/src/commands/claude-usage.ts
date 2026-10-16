import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildCommand } from '@stricli/core'
import { runClaudeUsage } from '../claude-usage/main.ts'
import { parseNonBlankString } from '../parse.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

export const claudeUsageCommand = buildCommand({
  docs: {
    brief: 'Group Claude Code token usage by day, session, and model',
    fullDescription:
      'Reads Claude Code JSONL transcripts, deduplicates repeated API-response records, and emits ' +
      'one row per day, parent session, and model. Subagent usage is attributed to its parent ' +
      'session. By default it reads sessions for the current directory and its descendants (e.g. a ' +
      'worktree nested under it); --all scans every Claude ' +
      'project. Output is a terminal table by default; --json includes scan diagnostics and rows ' +
      'with full session IDs. --per-ticket reports cost per ticket and per role instead of per ' +
      'day/session/model. --subagents, with --per-ticket, adds the cost per sub-agent type. ' +
      '--project filters to sessions whose Claude project directory contains ' +
      'the given substring, and implies --all -- naming a project means you want that project, ' +
      "not the current directory's.",
  },
  parameters: {
    flags: {
      'claude-dir': {
        kind: 'parsed',
        parse: String,
        brief: 'Claude data directory (defaults to ~/.claude)',
        optional: true,
      },
      since: {
        kind: 'parsed',
        parse: (value: string) => parseDate(value),
        brief: 'Include grouped dates on or after YYYY-MM-DD',
        optional: true,
      },
      until: {
        kind: 'parsed',
        parse: (value: string) => parseDate(value),
        brief: 'Include grouped dates on or before YYYY-MM-DD',
        optional: true,
      },
      utc: { kind: 'boolean', brief: 'Group timestamps by UTC date instead of local date' },
      json: { kind: 'boolean', brief: 'Emit structured JSON instead of the terminal table' },
      all: { kind: 'boolean', brief: 'Include sessions from every Claude project' },
      'per-ticket': {
        kind: 'boolean',
        brief: 'Report cost per ticket and per role instead of per day/session/model',
      },
      subagents: {
        kind: 'boolean',
        brief: 'With --per-ticket, also report cost per sub-agent type',
      },
      project: {
        kind: 'parsed',
        parse: parseNonBlankString('--project'),
        brief: 'Only include sessions whose Claude project directory contains this substring',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  async func(flags: {
    'claude-dir'?: string
    since?: string
    until?: string
    utc: boolean
    json: boolean
    all: boolean
    'per-ticket': boolean
    subagents: boolean
    project?: string
  }) {
    if (flags.subagents && !flags['per-ticket']) {
      process.stderr.write('claude-usage: --subagents requires --per-ticket\n')
      setRequestedExitCode(1)
      return
    }

    await runClaudeUsage({
      claudeDir: flags['claude-dir'] ?? join(homedir(), '.claude'),
      projectDirectory: process.cwd(),
      allProjects: flags.all,
      since: flags.since,
      until: flags.until,
      utc: flags.utc,
      json: flags.json,
      perTicket: flags['per-ticket'],
      subagents: flags.subagents,
      project: flags.project,
    })
  },
})

const parseDate = (value: string): string => {
  const parsed = new Date(`${value}T00:00:00Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`Invalid date: ${value}; expected YYYY-MM-DD`)
  }
  return value
}
