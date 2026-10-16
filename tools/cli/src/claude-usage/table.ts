export const formatTitle = (title: string): string => {
  const horizontal = '─'.repeat(title.length + 4)
  return `╭${horizontal}╮\n│  ${' '.repeat(title.length)}  │\n│  ${title}  │\n│  ${' '.repeat(title.length)}  │\n╰${horizontal}╯`
}

export const formatNumber = (value: number): string => {
  return value.toLocaleString('en-US')
}

export const shortenModel = (model: string): string => {
  return model.replace(/^claude-/, '')
}

export const renderTable = (
  headers: string[],
  values: string[][],
  numericColumns: ReadonlySet<number>
): string => {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => row[index].length))
  )
  const top = formatBorder(widths, '┌', '┬', '┐')
  const divider = formatBorder(widths, '├', '┼', '┤')
  const bottom = formatBorder(widths, '└', '┴', '┘')
  const header = formatTableRow(headers, widths, new Set())
  const body = values
    .map((row) => formatTableRow(row, widths, numericColumns))
    .join(`\n${divider}\n`)
  return `${top}\n${header}\n${divider}${body.length > 0 ? `\n${body}` : ''}\n${bottom}`
}

const formatBorder = (widths: number[], left: string, middle: string, right: string): string => {
  return `${left}${widths.map((width) => '─'.repeat(width + 2)).join(middle)}${right}`
}

// Every caller builds `values` as a literal array with one entry per header, so `widths` (derived
// from `headers.length`) always has an entry for every index here — there is no mismatched-length
// row to fall back for.
const formatTableRow = (
  values: string[],
  widths: number[],
  rightAligned: ReadonlySet<number>
): string => {
  const cells = values.map((value, index) => {
    const width = widths[index]
    return rightAligned.has(index) ? value.padStart(width) : value.padEnd(width)
  })
  return `│ ${cells.join(' │ ')} │`
}
