import { readFileSync } from 'node:fs'
import { diffProse } from './diff.ts'

export const runProseAdjacency = (beforeFile: string, afterFile: string): void => {
  const before = readFileSync(beforeFile, 'utf-8')
  const after = readFileSync(afterFile, 'utf-8')
  const result = diffProse(before, after)
  process.stdout.write(JSON.stringify(result) + '\n')
}
