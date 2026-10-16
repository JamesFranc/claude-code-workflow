// Test-only support for suites that spawn this repo's CLI as a subprocess. Production code must not
// import from here.

// Everything on the subprocess's stderr except Node's own warning lines — any `(node:<pid>)
// ...Warning:` line and the `--trace-warnings` hint that follows one, not just the
// `--experimental-transform-types` warning these suites always provoke. Stripping the whole class
// rather than that one line keeps a second, unrelated Node warning from being read as real output;
// the cost is that such a warning goes unnoticed here, which is the safe direction for an assertion
// that exists to catch what the CLI itself wrote. `equal(stderr, '')` is unusable because the
// transform-types warning is always present, so a clean run is asserted against the remainder.
export const stderrBeyondNodeWarnings = (stderr: string): string =>
  stderr
    .split('\n')
    .filter((line) => !/^\(node:\d+\) (\[[A-Z0-9]+\] )?\w*Warning: /.test(line))
    .filter((line) => !/^\(Use `node --trace-warnings/.test(line))
    .join('\n')
    .trim()
