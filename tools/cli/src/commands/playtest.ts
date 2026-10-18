import { buildCommand, buildRouteMap } from '@stricli/core'
import { runPlaytestList, runPlaytestStart, runPlaytestStop } from '../playtest/main.ts'

const startCommand = buildCommand({
  docs: {
    brief: "Start a branch's web app on a free port and print its link once it answers",
    fullDescription:
      'Runs --command with /bin/sh -c in --dir, detached in its own process group, with output ' +
      'going to a log beside the state file. {port} in the command becomes a port the OS hands ' +
      'out, and is the port the link opens; {port:<label>} gets a further port. Every port is ' +
      'also exported as PLAYTEST_PORT and PLAYTEST_PORT_<LABEL>. Ready means a process in the ' +
      "command's process tree (children in groups of their own included) listens on the {port} " +
      'port and an HTTP GET there gets any response. A listener outside the tree means the port ' +
      'was taken: the tree is killed and new ports are tried, ' +
      'three times in all. A running playtest under the same --name is stopped first. Exit 0: ' +
      'prints {"name","url","ports","log"}. Exit 1: not ready within --timeout (default 120s), ' +
      'or three collisions; the tree is killed and the log tail goes to stderr. Exit 2: usage ' +
      'error.',
  },
  parameters: {
    flags: {
      name: { kind: 'parsed', parse: String, brief: 'Playtest name: the story branch' },
      dir: { kind: 'parsed', parse: String, brief: 'Directory to run the command in' },
      command: {
        kind: 'parsed',
        parse: String,
        brief: 'Shell command that starts the app; {port} and {port:<label>} are replaced',
      },
      path: {
        kind: 'parsed',
        parse: String,
        brief: 'Path the link opens (default /); the ready check always requests /',
        optional: true,
      },
      timeout: {
        kind: 'parsed',
        parse: String,
        brief: 'Seconds to wait for the app to answer (default 120)',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  async func(flags: {
    name: string
    dir: string
    command: string
    path?: string
    timeout?: string
  }) {
    await runPlaytestStart(flags)
  },
})

const stopCommand = buildCommand({
  docs: {
    brief: 'Stop a playtest: SIGTERM every group its process tree uses, SIGKILL after 5s',
    fullDescription:
      'Removes the state file and keeps the log. Exit 0 whether or not a playtest existed ' +
      'under --name, printing {"name","stopped"}.',
  },
  parameters: {
    flags: {
      name: { kind: 'parsed', parse: String, brief: 'Playtest name: the story branch' },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  async func(flags: { name: string }) {
    await runPlaytestStop(flags.name)
  },
})

const listCommand = buildCommand({
  docs: {
    brief: 'List recorded playtests as JSON, each with alive: true or false',
  },
  parameters: {
    flags: {},
    positional: { kind: 'tuple', parameters: [] },
  },
  func() {
    runPlaytestList()
  },
})

export const playtestRoutes = buildRouteMap({
  routes: {
    start: startCommand,
    stop: stopCommand,
    list: listCommand,
  },
  docs: { brief: "Run a branch's web app on a free port for the ready-for-review approval" },
})
