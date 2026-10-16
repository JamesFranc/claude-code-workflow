// Minimal cross-process helper for store.test.ts's atomicWrite tmp-mode-repair regression test.
// atomicWriteCounter (store.ts) is pinned once per process and starts at 0 — proving atomicWrite
// repairs a pre-existing tmp file's mode requires seeding the EXACT tmp path it will use on its
// first call, which is only predictable in a fresh process where no earlier atomicWrite call in
// this same test file has already advanced the counter. This script is that fresh process: it
// seeds `<path>.<pid>.0.tmp` at 0644, calls atomicWrite once, and prints the seed's actual
// pre-atomicWrite mode alongside the resulting path's mode.
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWrite } from '../store.ts'

const [, , path] = process.argv
const tmp = `${path}.${process.pid}.0.tmp`

mkdirSync(dirname(path), { recursive: true })
// writeFileSync's own `mode` option is masked by the process umask the same way appendFileSync's
// is — seeding with { mode: 0o644 } directly could silently land at 0o600 under a strict umask
// (e.g. 077), which would make the tmp fixture no longer represent a stale-at-0644 tmp at all.
// chmodSync is not umask-masked, so it seeds the exact mode regardless of the runner's umask.
writeFileSync(tmp, 'stale')
chmodSync(tmp, 0o644)
const preconditionMode = statSync(tmp).mode & 0o777

atomicWrite(path, 'fresh-content')

console.log(JSON.stringify({ preconditionMode, mode: statSync(path).mode & 0o777 }))
