// bash's `date -u +%FT%TZ`: an ISO-8601 UTC instant without fractional seconds.
export const nowIsoSeconds = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

// bash's future_iso: an ISO-8601 UTC instant `secondsFromNow` seconds ahead of now.
export const futureIso = (secondsFromNow: number): string =>
  new Date(Date.now() + secondsFromNow * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
