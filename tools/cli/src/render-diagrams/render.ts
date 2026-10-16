import { Worker } from 'node:worker_threads'
import { icons as lucideIcons } from '@iconify-json/lucide'
import { D2, type Diagram, type Graph, type Shape } from '@terrastruct/d2'
import sharp from 'sharp'

// The house style for D2 diagrams in workflow docs (FLOW-390 architecture doc, "House style"):
// dark-mode palettes with one colour per role, near-square boxes whose label fills them, and an
// icon drawn directly above the label as one block centred in the box.

export type PaletteName = 'classic' | 'everglade' | 'origami'

export const PALETTE_NAMES: readonly PaletteName[] = ['classic', 'everglade', 'origami']

export const isPaletteName = (value: string): value is PaletteName =>
  PALETTE_NAMES.some((name) => name === value)

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface RenderedDiagram {
  svg: string
  webp: Buffer
  // Each shape's and connection's box, keyed by its D2 id, in the SVG's own coordinates.
  elements: Map<string, Rect>
}

// The smallest text a diagram draws: its edge labels.
export const EDGE_FONT_SIZE = 20

// The class D2 gives an element's SVG group: the base64 of its HTML-escaped id.
export const groupClass = (id: string): string => Buffer.from(escapeXml(id)).toString('base64')

export interface DiagramRenderer {
  render: (code: string) => Promise<RenderedDiagram>
  close: () => Promise<void>
}

// A problem in the author's D2 source, as opposed to a defect in the renderer. Line numbers in the
// message are relative to the first line of the fenced block's code.
export class DiagramSourceError extends Error {}

// D2's worker answers one request at a time and keeps only the latest caller's resolver, so every
// call into a renderer must be awaited before the next one starts.
export const createDiagramRenderer = (paletteName: PaletteName): DiagramRenderer => {
  const d2 = new D2()
  const palette = PALETTES[paletteName]
  const prelude = buildPrelude(palette)
  const preludeLineCount = prelude.split('\n').length - 1

  const compile = async (source: string) => {
    try {
      return await d2.compile({ fs: { index: prelude + source }, options: { layout: 'elk' } })
    } catch (err) {
      const diagnostics = parseDiagnostics(err)
      if (diagnostics === undefined) {
        throw err instanceof Error ? err : new Error(String(err))
      }
      throw new DiagramSourceError(formatDiagnostics(diagnostics, preludeLineCount))
    }
  }

  // A compile error here comes from lines the renderer appended, not from the author's source.
  const compilePinned = async (source: string) => {
    try {
      return await compile(source)
    } catch (err) {
      throw new Error(
        `render-diagrams: the pinned layout failed to compile: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      )
    }
  }

  const render = async (code: string): Promise<RenderedDiagram> => {
    const draft = await compile(code)
    const plan = await planShapes(d2, draft.diagram.shapes, draft.graph.objects, palette)
    const final = await compilePinned(`${code}\n${plan.pins.join('\n')}\n`)
    const renderOptions = {
      ...final.renderOptions,
      pad: DIAGRAM_PAD,
      themeOverrides: themeOverrides(palette),
    }
    let svg = padEdgeLabelMasks(await d2.render(final.diagram, renderOptions))
    for (const shape of final.diagram.shapes) {
      const box = plan.boxes.get(shape.id)
      if (box) {
        svg = drawLabel(svg, shape, box)
      }
    }
    const webp = await sharp(Buffer.from(svg), { density: RASTER_DENSITY })
      .resize({ width: RASTER_MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer()
    return { svg, webp, elements: elementBounds(final.diagram) }
  }

  // @terrastruct/d2 0.1.33 has no close(); its worker thread keeps the process alive until it is
  // terminated. The version is pinned exactly in package.json because this reaches into it.
  const close = async (): Promise<void> => {
    await Promise.resolve(Reflect.get(d2, 'ready')).catch(() => undefined)
    const worker: unknown = Reflect.get(d2, 'worker')
    if (worker instanceof Worker) {
      await worker.terminate()
    }
  }

  return { render, close }
}

// Picks how to break a label into lines: the smallest box, aiming for TARGET_ASPECT wide to tall,
// that is never taller than it is wide unless the content forces it.
export const pickLabelBox = (
  label: string,
  measureLine: (line: string) => number,
  hasIcon: boolean
): LabelBox => {
  const known = new Map<string, number>()
  const lineWidth = (line: string): number => {
    const cached = known.get(line)
    if (cached !== undefined) {
      return cached
    }
    const measured = measureLine(line)
    known.set(line, measured)
    return measured
  }

  let best: LabelBox = {
    lines: [label],
    width: 2 * PAD_X,
    height: 2 * PAD_Y,
    contentHeight: 0,
    icon: '',
  }
  let bestScore = Infinity

  for (const lines of lineBreaks(label.split(/\s+/).filter(Boolean), lineWidth)) {
    const width = Math.ceil(Math.max(...lines.map(lineWidth)) + 2 * PAD_X)
    const contentHeight = (hasIcon ? ICON_SIZE : 0) + lines.length * LINE_HEIGHT
    const height = Math.max(contentHeight + 2 * PAD_Y, Math.round(width / TARGET_ASPECT))
    const score = width * height * (width < height ? 2 : 1)
    if (score < bestScore) {
      best = { lines, width, height, contentHeight, icon: '' }
      bestScore = score
    }
  }

  return best
}

export interface Palette {
  canvas: string
  container: Colours
  actor: Colours
  tool: Colours
  external: Colours
  artifact: Colours
}

// [fill, stroke]
type Colours = readonly [string, string]

type Role = 'actor' | 'tool' | 'external' | 'artifact' | 'store'

interface LabelBox {
  lines: string[]
  width: number
  height: number
  contentHeight: number
  // A data: URI for the leaf's icon, or '' when it has none.
  icon: string
}

interface ShapePlan {
  pins: string[]
  boxes: Map<string, LabelBox>
}

export const PALETTES: Record<PaletteName, Palette> = {
  classic: {
    canvas: '#2B3038',
    container: ['#363C46', '#59616F'],
    actor: ['#165A5A', '#4FD1D1'],
    tool: ['#1C4673', '#6AAEF0'],
    external: ['#43356F', '#A992F0'],
    artifact: ['#6A5220', '#E5B44E'],
  },
  everglade: {
    canvas: '#2B312E',
    container: ['#353D39', '#5C6862'],
    actor: ['#7A3A0E', '#F2994A'],
    tool: ['#0E5A42', '#4CD3A5'],
    external: ['#3A4658', '#9DB0CC'],
    artifact: ['#5E5420', '#D9C65A'],
  },
  origami: {
    canvas: '#322E2B',
    container: ['#3E3934', '#6B625A'],
    actor: ['#163E70', '#7FB0EE'],
    tool: ['#6A1F33', '#E0708C'],
    external: ['#6B4A1E', '#E8B070'],
    artifact: ['#4A3870', '#B59AE6'],
  },
}

const ROLES: readonly Role[] = ['actor', 'tool', 'external', 'artifact', 'store']
export const TEXT_COLOUR = '#F2F5F8'
export const EDGE_COLOUR = '#A3ADBB'
// D2's edge glob matches a single arrow kind, so the house style names each of D2's four.
const EDGE_ARROWS: readonly string[] = ['->', '<->', '<-', '--']
const LABEL_FONT_SIZE = 32
const LINE_HEIGHT = 38
const TABLE_FONT_SIZE = 24
const ICON_SIZE = 36
const PAD_X = 20
const PAD_Y = 16
const TARGET_ASPECT = 1.2
const EDGE_LABEL_GAP_X = 10
const EDGE_LABEL_GAP_Y = 4
const DIAGRAM_PAD = 30
const RASTER_DENSITY = 144
const RASTER_MAX_WIDTH = 2400
// Shapes that are not a box with a label in it, so they keep D2's own sizing and text.
const UNBOXED_TYPES: ReadonlySet<string> = new Set(['sql_table', 'class', 'text', 'code', 'image'])

// Leaf fills come from classes rather than a leaf glob, since a glob beats a class.
const buildPrelude = (palette: Palette): string =>
  [
    `style: {fill: "${palette.canvas}"}`,
    `**: {&leaf: false; style: {fill: "${palette.container[0]}"; stroke: "${palette.container[1]}"; font-color: "${TEXT_COLOUR}"}}`,
    ...EDGE_ARROWS.map(
      (arrow) =>
        `(** ${arrow} **)[*]: {style: {stroke: "${EDGE_COLOUR}"; font-color: "${TEXT_COLOUR}"; font-size: ${EDGE_FONT_SIZE}}}`
    ),
    'classes: {',
    ...ROLES.map(
      (role) => `  ${role}: {${roleShape(role)}${roleStyle(roleColours(palette, role))}}`
    ),
    '}',
    '',
  ].join('\n')

const roleShape = (role: Role): string =>
  role === 'artifact' ? 'shape: page; ' : role === 'store' ? 'shape: cylinder; ' : ''

const roleStyle = ([fill, stroke]: Colours): string =>
  `style: {border-radius: 10; shadow: true; font-size: ${LABEL_FONT_SIZE}; font-color: "${TEXT_COLOUR}"; fill: "${fill}"; stroke: "${stroke}"}`

// `store` has no colours of its own: it is a `tool` drawn as a cylinder.
const roleColours = (palette: Palette, role: Role): Colours =>
  role === 'store' ? palette.tool : palette[role]

// Remaps D2's theme colours for anything the prelude doesn't style itself (table rows, field
// names), so nothing falls back to the default light theme's white.
const themeOverrides = (palette: Palette): Record<string, string> => {
  const [fill, stroke] = palette.container
  return {
    N1: TEXT_COLOUR,
    N2: EDGE_COLOUR,
    N3: EDGE_COLOUR,
    N4: stroke,
    N5: stroke,
    N6: fill,
    N7: fill,
    B1: stroke,
    B2: TEXT_COLOUR,
    B3: stroke,
    B4: fill,
    B5: fill,
    B6: fill,
    AA2: EDGE_COLOUR,
    AA4: fill,
    AA5: fill,
    AB4: fill,
    AB5: fill,
  }
}

// Decides every shape's final styling and size from a first compile, as explicit lines appended
// to the author's source for the second compile.
const planShapes = async (
  d2: D2,
  shapes: Shape[],
  objects: Graph['objects'],
  palette: Palette
): Promise<ShapePlan> => {
  const containers = new Set(
    shapes.flatMap(({ id }) => (id.includes('.') ? [id.slice(0, id.lastIndexOf('.'))] : []))
  )
  const pins: string[] = []
  const leaves: { shape: Shape; label: string; icon: string }[] = []
  // The compiled shape reports circle as oval and square as rectangle; the graph keeps the name.
  const declaredShapes = new Map(
    shapes.map((shape, index) => [shape.id, declaredShape(objects[index])])
  )
  for (const shape of shapes) {
    const iconName = lucideIconName(shape)
    if (iconName !== undefined) {
      pins.push(`${shape.id}.icon: null`)
    }
    if (shape.type === 'sql_table') {
      const role = shapeRole(shape)
      const header = role ? roleColours(palette, role)[0] : palette.container[1]
      pins.push(
        `${shape.id}.style.fill: "${header}"`,
        `${shape.id}.style.stroke: "${palette.container[0]}"`,
        `${shape.id}.style.font-color: "${TEXT_COLOUR}"`,
        `${shape.id}.style.font-size: ${TABLE_FONT_SIZE}`
      )
    }
    if (containers.has(shape.id) || UNBOXED_TYPES.has(shape.type)) {
      if (iconName !== undefined) {
        throw new DiagramSourceError(`'${shape.id}': icons are supported only on leaf boxes`)
      }
      continue
    }
    const label = 'label' in shape && typeof shape.label === 'string' ? shape.label : shape.id

    if (label.trim() === '') {
      throw new DiagramSourceError(`'${shape.id}': a box needs a label; this one is empty`)
    }

    if (!shapeRole(shape)) {
      throw new DiagramSourceError(
        `'${shape.id}': a box needs a role; give it class: ${ROLES.join(', ')}`
      )
    }

    leaves.push({ shape, label, icon: iconName === undefined ? '' : lucideIconDataUri(iconName) })
  }

  const widths = await measureLines(
    d2,
    leaves.flatMap(({ label }) => wordRuns(label.split(/\s+/).filter(Boolean)))
  )
  const boxes = new Map<string, LabelBox>()
  for (const { shape, label, icon } of leaves) {
    const picked = pickLabelBox(label, (line) => widths.get(line) ?? 0, icon !== '')
    const declared = declaredShapes.get(shape.id)
    const equalSides = declared === 'circle' || declared === 'square'
    const side = Math.max(picked.width, picked.height)
    const box = equalSides ? { ...picked, width: side, height: side, icon } : { ...picked, icon }
    boxes.set(shape.id, box)
    pins.push(`${shape.id}.width: ${box.width}`, `${shape.id}.height: ${box.height}`)
  }
  return { pins, boxes }
}

// D2 types a graph object as the global Object, so the declared `shape:` value is read by hand.
const declaredShape = (object: unknown): string | undefined => {
  const attributes: unknown = Reflect.get(Object(object), 'attributes')
  const shape: unknown = Reflect.get(Object(attributes), 'shape')
  const value: unknown = Reflect.get(Object(shape), 'value')
  return typeof value === 'string' ? value : undefined
}

const shapeRole = (shape: Shape): Role | undefined =>
  ROLES.find((role) => shape.classes?.includes(role))

// D2 types `icon` as a string, but the compiled diagram carries Go's url.URL as an object:
// `icon: lucide:mic` arrives as { Scheme: 'lucide', Opaque: 'mic' }.
const lucideIconName = (shape: Shape): string | undefined => {
  const icon: unknown = shape.icon
  if (icon === null || icon === undefined) {
    return undefined
  }
  if (
    typeof icon === 'object' &&
    'Scheme' in icon &&
    icon.Scheme === 'lucide' &&
    'Opaque' in icon &&
    typeof icon.Opaque === 'string'
  ) {
    return icon.Opaque
  }
  throw new DiagramSourceError(
    `'${shape.id}': only lucide icons are supported (icon: lucide:<name>)`
  )
}

const lucideIconDataUri = (name: string): string => {
  const icon =
    lucideIcons.icons[name] ?? lucideIcons.icons[lucideIcons.aliases?.[name]?.parent ?? '']
  if (!icon) {
    throw new DiagramSourceError(`unknown lucide icon '${name}'`)
  }
  const width = icon.width ?? lucideIcons.width ?? 24
  const height = icon.height ?? lucideIcons.height ?? 24
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    `${icon.body.replaceAll('currentColor', TEXT_COLOUR)}</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

// Measures each candidate line at the label font size by compiling it as a throwaway shape.
const measureLines = async (d2: D2, lines: string[]): Promise<Map<string, number>> => {
  const unique = [...new Set(lines)]
  const widths = new Map<string, number>()
  if (unique.length === 0) {
    return widths
  }
  const source = unique
    .map(
      (line, i) => `m${i}: '${line.replaceAll("'", "''")}' {style.font-size: ${LABEL_FONT_SIZE}}`
    )
    .join('\n')
  const measured = await d2.compile({ fs: { index: source }, options: { layout: 'elk' } })
  for (const shape of measured.diagram.shapes) {
    const line = unique[Number(shape.id.slice(1))]
    if (line !== undefined && 'labelWidth' in shape) {
      widths.set(line, shape.labelWidth)
    }
  }
  return widths
}

// Every contiguous run of `words` as one line: the only lines a break can use.
const wordRuns = (words: string[]): string[] =>
  words.flatMap((_, start) =>
    words.slice(start).map((_run, length) => words.slice(start, start + length + 1).join(' '))
  )

// For each line count k from 1 to words.length, the break into k lines whose widest line is
// narrowest. Asks `lineWidth` about runs of words, at most words^2 distinct ones.
const lineBreaks = (words: string[], lineWidth: (line: string) => number): string[][] => {
  const count = words.length
  const width = (from: number, to: number): number => lineWidth(words.slice(from, to).join(' '))

  // widest[k][end]: the narrowest widest-line over breaking the first `end` words into k lines.
  const widest: number[][] = [
    Array.from({ length: count + 1 }, (_, end) => (end === 0 ? 0 : Infinity)),
  ]
  const cuts: number[][] = [[]]
  const breaks: string[][] = []

  for (let k = 1; k <= count; k++) {
    widest.push(Array.from({ length: count + 1 }, () => Infinity))
    cuts.push([])

    for (let end = k; end <= count; end++) {
      for (let from = k - 1; from < end; from++) {
        const candidate = Math.max(widest[k - 1]?.[from] ?? Infinity, width(from, end))
        if (candidate < (widest[k]?.[end] ?? Infinity)) {
          widest[k]![end] = candidate
          cuts[k]![end] = from
        }
      }
    }

    const lines: string[] = []
    for (let end = count, line = k; line > 0; line--) {
      const from = cuts[line]![end]!
      lines.unshift(words.slice(from, end).join(' '))
      end = from
    }
    breaks.push(lines)
  }

  return breaks
}

// D2 masks a gap in each edge line behind its label; widen it so the label doesn't touch the line.
const padEdgeLabelMasks = (svg: string): string =>
  svg.replace(
    /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="black"><\/rect>/g,
    (_match, x: string, y: string, width: string, height: string) =>
      `<rect x="${Number(x) - EDGE_LABEL_GAP_X}" y="${Number(y) - EDGE_LABEL_GAP_Y}" ` +
      `width="${Number(width) + 2 * EDGE_LABEL_GAP_X}" height="${Number(height) + 2 * EDGE_LABEL_GAP_Y}" fill="black"></rect>`
  )

// Replaces D2's label for a leaf with the icon and the chosen lines as one block centred in the
// box.
const drawLabel = (svg: string, shape: Shape, box: LabelBox): string => {
  const label = new RegExp(
    `(<g class="${groupClass(shape.id).replace(/[+=/]/g, '\\$&')} [^"]*">[\\s\\S]*?</g>)(?:<image[^>]*/>)?<text [^>]*>[\\s\\S]*?</text>`
  )
  if (!label.test(svg)) {
    throw new Error(`render-diagrams: no label found in the SVG for '${shape.id}'`)
  }
  const top = shape.pos.y + (shape.height - box.contentHeight) / 2
  const centreX = shape.pos.x + shape.width / 2
  const icon = box.icon
    ? `<image href="${box.icon}" x="${centreX - ICON_SIZE / 2}" y="${top}" width="${ICON_SIZE}" height="${ICON_SIZE}" />`
    : ''
  const textTop = top + (box.icon ? ICON_SIZE : 0)
  const tspans = box.lines
    .map(
      (line, i) =>
        `<tspan x="${centreX}" y="${textTop + i * LINE_HEIGHT + LINE_HEIGHT * 0.78}">${escapeXml(line)}</tspan>`
    )
    .join('')
  const text =
    `<text x="${centreX}" fill="${TEXT_COLOUR}" class="text-bold" ` +
    `style="text-anchor:middle;font-size:${LABEL_FONT_SIZE}px">${tspans}</text>`
  return svg.replace(label, (_match, group: string) => `${group}${icon}${text}`)
}

const elementBounds = ({ shapes, connections }: Diagram): Map<string, Rect> => {
  const bounds = new Map<string, Rect>()
  for (const shape of shapes) {
    bounds.set(shape.id, {
      x: shape.pos.x,
      y: shape.pos.y,
      width: shape.width,
      height: shape.height,
    })
  }
  for (const connection of connections) {
    const points = connection.route.filter(isPoint)
    const xs = points.map(({ x }) => x)
    const ys = points.map(({ y }) => y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    bounds.set(connection.id, { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y })
  }
  return bounds
}

// D2 types a route point as any.
const isPoint = (value: unknown): value is { x: number; y: number } =>
  typeof value === 'object' &&
  value !== null &&
  'x' in value &&
  typeof value.x === 'number' &&
  'y' in value &&
  typeof value.y === 'number'

// Escapes the five characters Go's html.EscapeString does, which D2 applies to an id before it
// base64-encodes the id into a group's class.
const escapeXml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&#34;')

// D2 rejects a bad source with a JSON array of diagnostics; any other rejection is not the
// author's doing.
const parseDiagnostics = (err: unknown): unknown[] | undefined => {
  const message = err instanceof Error ? err.message : String(err)
  try {
    const parsed: unknown = JSON.parse(message)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const formatDiagnostics = (diagnostics: unknown[], preludeLineCount: number): string =>
  diagnostics
    .map((entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      'errmsg' in entry &&
      typeof entry.errmsg === 'string'
        ? entry.errmsg.replace(
            /^index:(\d+):(\d+): /,
            // The line counts the prelude, so it is shifted back to the block's own numbering.
            (_match, line: string, column: string) =>
              `${Number(line) - preludeLineCount}:${column}: `
          )
        : String(entry)
    )
    .join('; ')
