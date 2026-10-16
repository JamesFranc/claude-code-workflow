const NAMED_BOT_LOGINS = new Set(['coderabbitai', 'dependabot', 'renovate'])

export const isBotLogin = (login: string): boolean =>
  NAMED_BOT_LOGINS.has(login) || login.endsWith('[bot]')
