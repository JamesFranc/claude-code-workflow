let requestedExitCode: number | undefined

export const setRequestedExitCode = (exitCode: number): void => {
  requestedExitCode = exitCode
}

export const getRequestedExitCode = (): number | undefined => requestedExitCode
