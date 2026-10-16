import { buildCommand } from '@stricli/core'
import { runProseAdjacency } from '../prose-adjacency/main.ts'

export const proseAdjacencyCommand = buildCommand({
  docs: {
    brief:
      'Localise where a clause moved between two texts by diffing adjacent word pairs — a ' +
      "reviewer's instrument, not a lint gate",
    fullDescription:
      'Compares the text in --before and --after by tokenizing each into words and diffing the ' +
      'multiset of adjacent word pairs, reporting which pairs broke and which were created. Also ' +
      'reports two weaker instruments on the same input — whether the word multisets are identical ' +
      'and whether the character counts are identical — so the output shows the gap this detector ' +
      'closes rather than asserting it: on most reorders, both weaker instruments read identical ' +
      "while the adjacency diff is non-empty — unless the moved clause's boundary junctions cancel " +
      'exactly, which happens when the tokens bounding it at its old and new positions coincide. ' +
      'Adjacency equality is strictly weaker than sequence equality, so this detector localises a ' +
      'move it can see; it does not prove one did not happen. ' +
      'Scope boundary: for a pure re-flow (line breaks only, no reordering), whitespace-normalized ' +
      'string equality is already a complete proof of no loss and no reorder in one symmetric check — ' +
      'this detector adds nothing there. It earns its keep on rewrites, where the sequence legitimately ' +
      'changes and the question is which junctions moved. Hierarchy: word multiset < adjacency-pair ' +
      'multiset < ordered / whitespace-normalized string equality — each strictly weaker than the ' +
      'next, and this detector is not a stronger sameness proof than the strongest of the three — it ' +
      'does a different job, localising where a difference is, not proving sameness. A reorder is not ' +
      'always a defect, so this is a reviewer-invoked instrument, not something `pnpm lint` runs ' +
      'automatically.',
  },
  parameters: {
    flags: {
      before: { kind: 'parsed', parse: String, brief: 'Path to the text before the change' },
      after: { kind: 'parsed', parse: String, brief: 'Path to the text after the change' },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { before: string; after: string }) {
    runProseAdjacency(flags.before, flags.after)
  },
})
