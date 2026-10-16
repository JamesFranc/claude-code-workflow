import { buildCommand } from '@stricli/core'
import { stopLegacyMonitors } from '../pr-monitor/lock.ts'
import { CHECK_INTERVAL_MINUTES } from '../pr-monitor/poll.ts'
import { recordSelfComment, recordSelfReady, unwatchPr, watchPr } from '../pr-monitor/state.ts'

export const prMonitorCommand = buildCommand({
  docs: {
    brief: 'Watch a GitHub PR for state changes',
    fullDescription:
      "Registers the PR with this session and returns at once. The session's wake check " +
      `(\`mailbox check\`, run by the wake mod every ${CHECK_INTERVAL_MINUTES} minutes while the ` +
      'session is idle) polls it ' +
      'and wakes the session with a `[pr-monitor]` entry on a change. A PR whose state does not ' +
      'change produces no output, for any elapsed time. A MERGED/CLOSED or wedged PR stops being ' +
      'watched automatically. Pass --stop to stop watching. Registering also stops ' +
      'every background monitor left by an older version in this session. ' +
      'Pass --ack-comment <node-id> to record a review comment this session just posted, so the ' +
      'monitor does not report it back as new review feedback. ' +
      'Pass --ack-ready before running `gh pr ready` yourself, so the monitor does not wake on ' +
      'that flip.',
  },
  parameters: {
    flags: {
      pr: {
        kind: 'parsed',
        parse: String,
        brief: 'Pull request number',
        optional: false,
      },
      repo: {
        kind: 'parsed',
        parse: String,
        brief: 'Repository in owner/repo format',
        optional: false,
      },
      stop: {
        kind: 'boolean',
        brief: 'Stop watching this PR',
        default: false,
      },
      // Stricli uses the flag KEY verbatim as the CLI flag name (a camelCase key `ackComment`
      // registers as `--ackComment`, NOT `--ack-comment`). Kebab flags in this codebase use a
      // quoted kebab KEY — see dashboard.ts `'parent-key'` / `'dry-run'`. Match that so the
      // CLI flag is `--ack-comment` as documented everywhere.
      'ack-comment': {
        kind: 'parsed',
        parse: String,
        brief:
          'Record the node id of a review comment this session just posted, so the monitor does not report it back as new feedback',
        optional: true,
      },
      'ack-ready': {
        kind: 'boolean',
        brief:
          'Record that this session is about to run gh pr ready itself, so the monitor does not wake on that flip',
        default: false,
      },
    },
    positional: {
      kind: 'tuple',
      parameters: [],
    },
  },
  func(flags: {
    pr: string
    repo: string
    stop: boolean
    'ack-comment'?: string
    'ack-ready': boolean
  }) {
    // Every store path below keys on the session; without an id they would all land in the shared
    // 'no-session' partition, mixing this registration with every other session's.
    if (!process.env.CLAUDE_CODE_SESSION_ID) {
      console.error(
        'pr-monitor: no session id: run this from a Claude Code session (CLAUDE_CODE_SESSION_ID is unset)'
      )
      process.exit(2)
    }

    const ackComment = flags['ack-comment']?.trim()
    if (flags['ack-ready'] && (flags.stop || ackComment !== undefined)) {
      console.error('--ack-ready cannot be combined with --stop or --ack-comment')
      process.exit(1)
    }
    if (ackComment !== undefined && flags.stop) {
      console.error(
        '--ack-comment and --stop cannot be combined — record the comment, or stop the monitor, not both'
      )
      process.exit(1)
    }
    if (flags['ack-ready']) {
      recordSelfReady(flags.pr, flags.repo)
      console.log(`Recorded a self-initiated ready-for-review on ${flags.repo}#${flags.pr}`)
      return
    }
    if (ackComment !== undefined) {
      if (ackComment === '') {
        console.error('--ack-comment requires a review comment node id')
        process.exit(1)
      }
      recordSelfComment(flags.pr, flags.repo, ackComment)
      console.log(`Recorded ${ackComment} as self-posted on ${flags.repo}#${flags.pr}`)
      return
    }
    // A background monitor left by an older version may still be polling and waking this session;
    // stopping it (or clearing its stale lock) keeps two systems from waking it for one PR.
    const stopped = stopLegacyMonitors(flags.pr, flags.repo)
    if (flags.stop) {
      const wasWatched = unwatchPr(flags.pr, flags.repo)
      console.log(
        wasWatched
          ? `Stopped watching ${flags.repo}#${flags.pr}`
          : `${flags.repo}#${flags.pr} was not watched`
      )
    } else {
      watchPr(flags.pr, flags.repo)
      console.log(
        `Watching ${flags.repo}#${flags.pr}: the session check polls it every ` +
          `${CHECK_INTERVAL_MINUTES} minutes while the ` +
          `session is idle and wakes the session on a change. Stop with: ` +
          `pr-monitor --stop --pr ${flags.pr} --repo ${flags.repo}`
      )
    }
    for (const message of stopped) {
      console.log(`Background monitor left by an older version: ${message}`)
    }
  },
})
