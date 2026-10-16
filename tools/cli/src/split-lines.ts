// CommonMark line endings are \n, \r, and \r\n. \r\n must be tried before the bare \r alternative
// in the alternation, or a CRLF pair's \r and \n are each consumed as separate delimiters,
// producing a spurious empty line between the two real ones.
export const splitLines = (content: string): string[] => content.split(/\r\n|\r|\n/)
