import {
  EDGE_COLOUR,
  PALETTES,
  TEXT_COLOUR,
  groupClass,
  type PaletteName,
  type Rect,
} from '../render-diagrams/render.ts'
import { bringIntoView, frame, union, type Size } from './camera.ts'
import type { PreparedScene } from './prepare.ts'
import { captionsOf, type Caption } from './silent.ts'
import type { Alignment } from './voice.ts'

// Builds the HyperFrames composition (index.html) for a prepared script, narrated or silent. Every
// reveal, highlight and camera move is a tween on one paused GSAP timeline; HyperFrames seeks it
// frame by frame (FLOW-390 architecture doc, "Reveal semantics" and "Camera").

export interface TimedScene {
  scene: PreparedScene
  // The scene's narration audio, or undefined when the walkthrough is silent.
  audio: string | undefined
  start: number
  duration: number
  // When the narration stops, relative to the scene's start.
  spoken: number
  // When each step's cue is spoken, relative to the scene's start.
  cues: number[]
  // The narration as subtitles: only when there is no audio to hear.
  captions: Caption[]
}

// One GSAP call: `set` when it has no duration, `to` when it has one.
export interface Tween {
  at: number
  target: string
  vars: Record<string, unknown>
  duration?: number
}

export const STAGE: Size = { width: 1920, height: 1080 }
export const DIAGRAM_AREA: Size = { width: 1800, height: 870 }
// The diagram area when the scenes carry captions: shorter, so the caption band below it never
// covers a diagram.
export const CAPTIONED_DIAGRAM_AREA: Size = { width: 1800, height: 720 }
// Silence after each scene's narration before the next scene starts.
export const SCENE_TAIL = 0.8
const CAPTION_FADE = 0.2
const DIM = 0.15
const BULLET_MUTED = 0.5
const REVEAL = 0.4
const DIM_FADE = 0.3
const CAMERA_MOVE = 0.8
const HIGHLIGHT = '#FFD166'
// Two tight shadows rather than one wide one: a single blur fades out against the dark canvas.
const GLOW = `drop-shadow(0 0 4px ${HIGHLIGHT}) drop-shadow(0 0 8px ${HIGHLIGHT})`

// Places scenes back to back, each as long as its narration plus a short tail, and turns each cue
// into the time it is spoken.
export const timeScenes = (
  scenes: PreparedScene[],
  narrations: { audio: string | undefined; alignment: Alignment }[]
): TimedScene[] => {
  let start = 0
  return scenes.map((scene, i) => {
    const narration = narrations[i]
    if (narration === undefined) {
      throw new Error(`walkthrough: no narration for scene ${i}`)
    }
    const { alignment } = narration
    const spoken = alignment.character_end_times_seconds.at(-1) ?? 0
    const duration = spoken + SCENE_TAIL
    const timed = {
      scene,
      audio: narration.audio,
      start,
      duration,
      spoken,
      cues: cueTimes(scene, alignment, i),
      captions:
        narration.audio === undefined ? captionsOf(scene.narration, alignment, duration) : [],
    }
    start += timed.duration
    return timed
  })
}

export const composeHtml = (title: string, palette: PaletteName, scenes: TimedScene[]): string => {
  const total = scenes.reduce((sum, { duration }) => sum + duration, 0)
  const captioned = scenes.some(({ audio }) => audio === undefined)
  const area = captioned ? CAPTIONED_DIAGRAM_AREA : DIAGRAM_AREA
  const tweens = scenes.flatMap((timed, i) => [
    ...sceneTweens(timed, `#scene-${i}`, area),
    ...captionTweens(timed, `#scene-${i}`),
  ])
  const hasSequence = scenes.some(({ scene }) => scene.visual.kind === 'sequence')
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${stylesheet(palette, area, captioned)}</style>`,
    '</head><body>',
    `<div id="root" data-composition-id="walkthrough" data-start="0" data-duration="${total}" data-width="${STAGE.width}" data-height="${STAGE.height}">`,
    ...scenes.map((timed, i) => sceneHtml(timed, i, area)),
    '</div>',
    '<script src="gsap.min.js"></script>',
    hasSequence ? '<script src="mermaid.min.js"></script>' : '',
    `<script>${timelineScript(tweens, palette)}</script>`,
    '</body></html>',
    '',
  ].join('\n')
}

// Finds each cue in the alignment, each one after the previous, as the index of the entry where
// the cue starts.
const cueTimes = (scene: PreparedScene, alignment: Alignment, index: number): number[] => {
  let from = 0
  return scene.steps.map(({ cue }) => {
    const found = findCue(alignment.characters, cue, from)
    const time =
      found === undefined ? undefined : alignment.character_start_times_seconds[found.start]
    if (found === undefined || time === undefined) {
      throw new Error(
        `walkthrough: scene ${index}'s cue "${cue}" is not in the narration's alignment`
      )
    }
    from = found.end
    return time
  })
}

const findCue = (
  entries: string[],
  cue: string,
  from: number
): { start: number; end: number } | undefined => {
  for (let start = from; start < entries.length; start++) {
    let spoken = ''
    let end = start
    while (end < entries.length && spoken.length < cue.length) {
      spoken += entries[end]
      end++
    }
    if (spoken.startsWith(cue)) {
      return { start, end }
    }
  }
  return undefined
}

const sceneHtml = (
  { scene, audio, start, duration, captions }: TimedScene,
  i: number,
  area: Size
): string => {
  const timing = `data-start="${start}" data-duration="${duration}"`
  return [
    `<section id="scene-${i}" class="clip scene kind-${scene.visual.kind}" ${timing}>`,
    scene.visual.kind === 'title' ? '' : `<h2>${escapeHtml(scene.heading)}</h2>`,
    visualHtml(scene, i, area),
    ...captions.map(
      ({ text }, j) => `<p class="caption" data-caption="${j}">${escapeHtml(text)}</p>`
    ),
    '</section>',
    ...(audio === undefined ? [] : [`<audio ${timing} src="${audio}"></audio>`]),
  ].join('\n')
}

const visualHtml = (
  { heading, visual, diagram, steps }: PreparedScene,
  i: number,
  area: Size
): string => {
  switch (visual.kind) {
    case 'title':
      return [
        `<h1>${escapeHtml(heading)}</h1>`,
        visual.subtitle === undefined
          ? ''
          : `<p class="subtitle">${escapeHtml(visual.subtitle)}</p>`,
      ].join('')
    case 'bullets':
      return `<ul>${visual.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>`
    case 'sequence':
      return `<pre class="mermaid">${escapeHtml(visual.mermaid)}</pre>`
    case 'diagram':
      if (diagram === undefined) {
        throw new Error('walkthrough: a diagram scene reached composition uncompiled')
      }
      return `<div class="diagram">${stageSvg(diagram.svg, cameraPlan(diagram.elements, steps, area)[0], i, area)}</div>`
  }
}

const sceneTweens = (timed: TimedScene, root: string, area: Size): Tween[] => {
  const { scene } = timed
  if (scene.steps.length === 0) {
    return []
  }
  if (scene.visual.kind === 'bullets') {
    const items = (show: string[]) =>
      show.map((index) => `${root} li:nth-child(${Number(index) + 1})`)
    return revealTweens(timed, `${root} li`, items, (show, at, until) => {
      const target = items(show).join(', ')
      return [
        { at, target, vars: { color: HIGHLIGHT } },
        { at: until, target, vars: { color: TEXT_COLOUR } },
      ]
    })
  }
  if (scene.visual.kind === 'diagram' && scene.diagram !== undefined) {
    const { start, cues } = timed
    const views = cameraPlan(scene.diagram.elements, scene.steps, area)
    const camera = `${root} .diagram svg svg`
    const moves = views.slice(1).flatMap((view, j) =>
      sameView(view, views[j]) || cues[j] === undefined
        ? []
        : [
            {
              at: start + cues[j],
              target: camera,
              vars: { attr: { viewBox: viewBox(view) } },
              duration: CAMERA_MOVE,
            },
          ]
    )
    const group = (id: string) => `${root} g[class~="${groupClass(id)}"]`
    const reveals = revealTweens(
      timed,
      `${root} .diagram svg svg > g`,
      (show) => show.map(group),
      (show, at, until) => diagramHighlights(show.map(group), show, at, until)
    )
    return [...reveals, ...moves]
  }
  if (scene.visual.kind === 'sequence') {
    return revealTweens(
      timed,
      `${root} .mermaid > svg > *`,
      (show) => show.map((id) => `${root} ${sequencePart(id)}`),
      (show, at, until) => sequenceHighlights(root, show, at, until)
    )
  }
  return []
}

// Dims every element, brings each step's elements up at its cue and highlights them until the next
// cue, and brings up everything left when the narration ends. A diagram or sequence stays whole
// until the first cue, then fades; bullets start muted.
const revealTweens = (
  { scene, start, spoken, cues }: TimedScene,
  all: string,
  targets: (show: string[]) => string[],
  highlights: (show: string[], at: number, until: number) => Tween[]
): Tween[] => {
  const dim: Tween =
    scene.visual.kind === 'bullets'
      ? { at: start, target: all, vars: { opacity: BULLET_MUTED } }
      : { at: start + (cues[0] ?? spoken), target: all, vars: { opacity: DIM }, duration: DIM_FADE }
  return [
    dim,
    ...scene.steps.flatMap(({ show }, j) => {
      const at = start + (cues[j] ?? spoken)
      const until = start + (cues[j + 1] ?? spoken)
      return [
        { at, target: targets(show).join(', '), vars: { opacity: 1 }, duration: REVEAL },
        ...highlights(show, at, until),
      ]
    }),
    { at: start + spoken, target: all, vars: { opacity: 1 }, duration: REVEAL },
  ]
}

// A shape glows. An edge is recoloured instead, line and arrowheads, because a glow on a thin line
// reads as a thick blurred halo. D2 paints a head through its stroke attribute (outlined heads, and
// the group holding a crow's foot or cross, whose parts inherit it) or, for a solid head, through
// a fill attribute alone. So every element with a stroke attribute gets its stroke recoloured, and
// every one with only a fill attribute its fill, which leaves an outlined head's background alone.
// The highlight ends by emptying the inline style, which brings back the colour D2 drew.
const diagramHighlights = (groups: string[], ids: string[], at: number, until: number): Tween[] => {
  const shapes = groups.filter((_, i) => !isEdge(ids[i] ?? ''))
  const edges = groups.filter((_, i) => isEdge(ids[i] ?? ''))
  const heads = (leaf: string) => edges.map((group) => `${group} marker ${leaf}`).join(', ')
  const stroked = [
    edges.map((group) => `${group} path.connection`).join(', '),
    heads('[stroke]'),
  ].join(', ')
  const solid = heads('[fill]:not([stroke])')
  return [
    ...(shapes.length === 0
      ? []
      : [
          { at, target: shapes.join(', '), vars: { filter: GLOW } },
          { at: until, target: shapes.join(', '), vars: { filter: 'none' } },
        ]),
    ...(edges.length === 0
      ? []
      : [
          { at, target: stroked, vars: { stroke: HIGHLIGHT } },
          { at, target: solid, vars: { fill: HIGHLIGHT } },
          { at: until, target: stroked, vars: { stroke: '' } },
          { at: until, target: solid, vars: { fill: '' } },
        ]),
  ]
}

const isEdge = (id: string): boolean => /\)\[\d+\]$/.test(id)

// A participant glows. A message's arrow has its stroke recoloured and its label its fill. Mermaid's
// arrows share one marker per head shape, so recolouring a head would recolour every arrow with that
// shape; the head keeps its colour.
const sequenceHighlights = (root: string, ids: string[], at: number, until: number): Tween[] => {
  const participants = ids
    .filter((id) => !isMessageIndex(id))
    .map((id) => `${root} ${sequencePart(id)}`)
    .join(', ')
  const messages = ids.filter(isMessageIndex).map(sequencePart)
  const arrows = messages.map((part) => `${root} ${part}:not(text)`).join(', ')
  const labels = messages.map((part) => `${root} text${part}`).join(', ')
  return [
    ...(participants === ''
      ? []
      : [
          { at, target: participants, vars: { filter: GLOW } },
          { at: until, target: participants, vars: { filter: 'none' } },
        ]),
    ...(messages.length === 0
      ? []
      : [
          { at, target: arrows, vars: { stroke: HIGHLIGHT } },
          { at, target: labels, vars: { fill: HIGHLIGHT } },
          { at: until, target: arrows, vars: { stroke: '' } },
          { at: until, target: labels, vars: { fill: '' } },
        ]),
  ]
}

// The attribute selector for what a sequence step id names, as tagSequence marks it in the page.
const sequencePart = (id: string): string =>
  isMessageIndex(id)
    ? `[data-message=${JSON.stringify(id)}]`
    : `[data-participant=${JSON.stringify(id)}]`

const isMessageIndex = (id: string): boolean => /^(0|[1-9]\d*)$/.test(id)

// Each caption fades in at its first character and fades out as the next caption starts, so
// adjacent captions never overlap.
const captionTweens = ({ start, captions }: TimedScene, root: string): Tween[] =>
  captions.flatMap(({ at, until }, j) => {
    const target = `${root} [data-caption="${j}"]`
    return [
      { at: start + at, target, vars: { opacity: 1 }, duration: CAPTION_FADE },
      { at: start + until - CAPTION_FADE, target, vars: { opacity: 0 }, duration: CAPTION_FADE },
    ]
  })

// The whole diagram before the first step, then the view after each step: a step's focus is
// framed; otherwise the camera moves only as far as its revealed elements need.
const cameraPlan = (
  elements: Map<string, Rect>,
  steps: PreparedScene['steps'],
  area: Size
): Rect[] => {
  const diagram = union([...elements.values()])
  const boxes = (ids: string[]) => union(ids.flatMap((id) => elements.get(id) ?? []))
  const opening = frame(diagram, diagram, area)
  const views = [opening]
  for (const { show, focus } of steps) {
    const current = views.at(-1) ?? opening
    views.push(
      focus.length > 0
        ? frame(boxes(focus), diagram, area)
        : bringIntoView(current, boxes(show), diagram, area)
    )
  }
  return views
}

// D2's SVG is an outer svg sized to the diagram holding an inner one that draws it. The outer one
// is resized to the diagram area and the inner one becomes the camera: its viewBox is the view.
const stageSvg = (svg: string, view: Rect | undefined, scene: number, area: Size): string =>
  scopeIds(giveEachEdgeItsMarker(svg), scene)
    .replace(/viewBox="0 0 [\d.]+ [\d.]+"/, `viewBox="0 0 ${area.width} ${area.height}"`)
    .replace(
      /(<svg class="d2-\d+ d2-svg") width="[\d.]+" height="[\d.]+" viewBox="[^"]*"/,
      `$1 width="${area.width}" height="${area.height}" viewBox="${view === undefined ? '' : viewBox(view)}" preserveAspectRatio="xMidYMid meet"`
    )

// D2 emits one arrowhead marker, inside the first edge's group, and every edge points at it. Each
// edge gets its own copy inside its own group, so that recolouring an edge touches only its head.
const giveEachEdgeItsMarker = (svg: string): string => {
  const markers = new Map<string, string>()
  for (const [marker, id] of svg.matchAll(/<marker id="([^"]+)"[\s\S]*?<\/marker>/g)) {
    markers.set(id ?? '', marker)
  }
  let n = 0
  return svg
    .replace(/<path\b[^>]*>/g, (path) => {
      const clones: string[] = []
      const rewritten = path.replace(
        /(marker-(?:end|start))="url\(#([^)]+)\)"/g,
        (attribute, name: string, id: string) => {
          const marker = markers.get(id)
          if (marker === undefined) {
            return attribute
          }
          const own = `${id}-${n++}`
          clones.push(marker.replace(`id="${id}"`, `id="${own}"`))
          return `${name}="url(#${own})"`
        }
      )
      return clones.join('') + rewritten
    })
    .replace(/<marker id="([^"]+)"[\s\S]*?<\/marker>/g, (marker, id: string) =>
      markers.has(id) ? '' : marker
    )
}

// Every scene is inlined into one document, where an id must be unique for a url(#id) to find the
// right element, so each scene's ids carry its index.
const scopeIds = (svg: string, scene: number): string =>
  svg.replace(/\b(id="|url\(#|href="#)([^"')]+)/g, `$1s${scene}-$2`)

const viewBox = ({ x, y, width, height }: Rect): string =>
  [x, y, width, height].map((n) => Math.round(n)).join(' ')

const sameView = (a: Rect, b: Rect | undefined): boolean =>
  b !== undefined && viewBox(a) === viewBox(b)

const timelineScript = (tweens: Tween[], palette: PaletteName): string => {
  const { canvas, container } = PALETTES[palette]
  const theme = {
    background: canvas,
    primaryColor: container[0],
    primaryBorderColor: container[1],
    primaryTextColor: TEXT_COLOUR,
    lineColor: EDGE_COLOUR,
    textColor: TEXT_COLOUR,
    fontSize: '24px',
  }
  return `
const tweens = ${JSON.stringify(tweens).replaceAll('</', '<\\/')}
// Marks what a sequence step can show: every top-level part that draws a participant gets
// data-participant, and each message's arrow, every line of its label (Mermaid draws one text per
// line) and its number get data-message, counting the messages in the order Mermaid draws their
// arrows.
const tagSequence = (svg) => {
  let message = -1
  for (const part of svg.children) {
    const named = part.matches('[name]') ? part : part.querySelector('[name]')
    if (named !== null) {
      part.setAttribute('data-participant', named.getAttribute('name'))
    } else if (part.matches('.messageLine0, .messageLine1')) {
      message++
      part.setAttribute('data-message', String(message))
      for (let label = part.previousElementSibling; label?.matches('.messageText'); label = label.previousElementSibling) {
        label.setAttribute('data-message', String(message))
      }
    } else if (message >= 0 && (part.matches('.sequenceNumber') || (part.localName === 'line' && !part.hasAttribute('class')))) {
      part.setAttribute('data-message', String(message))
    }
  }
}
;(async () => {
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: false, theme: 'base', themeVariables: ${JSON.stringify(theme)} })
    await mermaid.run()
    document.querySelectorAll('.mermaid > svg').forEach(tagSequence)
  }
  const tl = gsap.timeline({ paused: true })
  for (const { at, target, vars, duration } of tweens) {
    if (duration === undefined) {
      tl.set(target, vars, at)
    } else {
      tl.to(target, { ...vars, duration, ease: 'power2.inOut' }, at)
    }
  }
  window.__timelines = { walkthrough: tl }
})()
`
}

const stylesheet = (palette: PaletteName, area: Size, captioned: boolean): string => `
html, body { margin: 0; background: ${PALETTES[palette].canvas}; }
#root { position: relative; width: ${STAGE.width}px; height: ${STAGE.height}px; overflow: hidden;
  color: ${TEXT_COLOUR}; font-family: "Source Sans Pro", "Helvetica Neue", Arial, sans-serif; }
.scene { position: absolute; inset: 0; }
h2 { position: absolute; top: 40px; left: 60px; margin: 0; font-size: 52px; font-weight: 600; }
.kind-title { display: flex; flex-direction: column; align-items: center; justify-content: center; }
h1 { margin: 0; font-size: 84px; font-weight: 700; text-align: center; max-width: 1600px; }
.subtitle { margin: 28px 0 0; font-size: 44px; color: ${EDGE_COLOUR}; text-align: center; max-width: 1500px; }
ul { position: absolute; top: 170px; left: 120px; right: 120px; margin: 0; padding: 0 0 0 40px;
  font-size: 46px; line-height: 1.35; }
li { margin-bottom: 28px; }
.diagram, .mermaid { position: absolute; top: 150px; left: 60px; width: ${area.width}px;
  height: ${area.height}px; margin: 0; overflow: hidden; }
.diagram > svg { width: 100%; height: 100%; }
.mermaid { display: flex; align-items: center; justify-content: center; }
.mermaid svg { max-width: 100%; max-height: 100%; }
${captioned ? captionStyle : ''}`

// The caption band starts at 1080 - 40 - 2 x 40 x 1.3 = 936px. Bullets are set so that six bullets
// of two lines each end above it: 170 + 12 x 40 x 1.3 + 5 x 20 = 894px.
const captionStyle = `.caption { position: absolute; left: 160px; right: 160px; bottom: 40px; margin: 0;
  font-size: 40px; line-height: 1.3; text-align: center; opacity: 0;
  overflow-wrap: anywhere; }
ul { font-size: 40px; line-height: 1.3; }
li { margin-bottom: 20px; }
`

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
