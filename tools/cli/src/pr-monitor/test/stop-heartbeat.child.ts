// Acquires the lock, then on SIGTERM heartbeats once more before exiting — widening the window a
// real monitor has between the stopper's kill() returning and the signal landing, during which an
// in-flight heartbeat can still write. HOME and CLAUDE_CODE_SESSION_ID come from the
// inherited environment, set by the parent test.
import { claimLock, heartbeatLockAt, lockPath } from '../lock.ts'

const [, , prNumber, repo] = process.argv

process.on('SIGTERM', () => {
  setTimeout(() => {
    heartbeatLockAt(lockPath(prNumber, repo), `${repo}#${prNumber}`)
    process.exit(0)
  }, 200)
})
claimLock(lockPath(prNumber, repo), `${repo}#${prNumber}`)
setInterval(() => {}, 60_000)
