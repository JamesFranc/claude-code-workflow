// Test-only preload (node --import): pins the clock to $FAKE_NOW_EPOCH so a tick case reads the
// same instant the bash capture's fake `date` did.
const pinnedMs = Number(process.env.FAKE_NOW_EPOCH) * 1000
if (!Number.isFinite(pinnedMs)) {
  throw new Error('fake-clock: FAKE_NOW_EPOCH is not set to an epoch in seconds')
}

class PinnedDate extends Date {
  constructor(value?: number | string | Date) {
    super(value ?? pinnedMs)
  }

  static override now(): number {
    return pinnedMs
  }
}

Object.defineProperty(globalThis, 'Date', { value: PinnedDate, writable: true, configurable: true })
