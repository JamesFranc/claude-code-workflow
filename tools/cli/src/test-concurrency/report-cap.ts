/**
 * CI diagnostic: the runner's size and the cap that size resolves to.
 *
 * Separate from `print-cap.ts`, whose single bare number is consumed by the
 * shell substitution in `tools/cli/package.json` and has to stay parseable.
 * This one is read by people debugging a concurrency question, so it is
 * labelled. It calls `capFor` rather than restating the formula: a copy in the
 * workflow's `run:` string is reached by no typecheck, lint or test in this
 * repo, and would report a cap that was never applied.
 */
import { availableParallelism } from 'node:os'

import { capFor } from './cap.ts'

const available = availableParallelism()

process.stdout.write(`availableParallelism: ${available}\nresolvedCap: ${capFor(available)}\n`)
