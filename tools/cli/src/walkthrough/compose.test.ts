import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import { CAPTIONED_DIAGRAM_AREA, DIAGRAM_AREA, composeHtml, timeScenes } from './compose.ts'
import { prepareScript, type PreparedScene } from './prepare.ts'
import type { Alignment } from './tts.ts'

const SEQUENCE = [
  'sequenceDiagram',
  '  autonumber',
  '  actor u as User',
  '  participant rd as Renderer',
  '  box Outside',
  '  participant el as ElevenLabs',
  '  end',
  '  u->>+rd: render',
  '  Note over rd,el: checks script',
  '  alt ok',
  '    rd->>el: voice<br/>request',
  '  else bad',
  '    el--xrd: audio',
  '  end',
  '  rd->>rd: compose',
  '  rd-)-u: mp4',
].join('\n')

// One character per tenth of a second.
const alignmentOf = (text: string): Alignment => ({
  characters: [...text],
  character_start_times_seconds: [...text].map((_, i) => i / 10),
  character_end_times_seconds: [...text].map((_, i) => (i + 1) / 10),
})

const bullets: PreparedScene = {
  heading: 'Points',
  narration: 'First one. Then two.',
  visual: { kind: 'bullets', bullets: ['one', 'two'] },
  steps: [
    { cue: 'First', show: ['0'], focus: [] },
    { cue: 'Then', show: ['1'], focus: [] },
  ],
}
const title: PreparedScene = {
  heading: 'Hi',
  narration: 'Hello.',
  visual: { kind: 'title' },
  steps: [],
}

test('timeScenes: places scenes back to back and times each cue from the alignment', () => {
  const timed = timeScenes(
    [title, bullets],
    [
      { audio: 'a0.mp3', alignment: alignmentOf(title.narration) },
      { audio: 'a1.mp3', alignment: alignmentOf(bullets.narration) },
    ]
  )
  assert.equal(timed[0]?.spoken, 0.6)
  assert.equal(timed[1]?.start, timed[0]?.duration)
  assert.deepEqual(timed[1]?.cues, [0, 1.1])
})

test('timeScenes: refuses a cue the spoken alignment does not contain', () => {
  assert.throws(
    () =>
      timeScenes([bullets], [{ audio: 'a.mp3', alignment: alignmentOf('First one. Later two.') }]),
    /cue "Then" is not in the narration's alignment/
  )
})

test('composeHtml: one clip and one audio per scene, and a paused timeline on window.__timelines', () => {
  const timed = timeScenes(
    [title, bullets],
    [
      { audio: 'audio/scene-0.mp3', alignment: alignmentOf(title.narration) },
      { audio: 'audio/scene-1.mp3', alignment: alignmentOf(bullets.narration) },
    ]
  )
  const html = composeHtml('Demo <1>', 'classic', timed)
  assert.equal(html.match(/<section id="scene-\d+" class="clip scene /g)?.length, 2)
  assert.equal(html.match(/<audio [^>]*src="audio\/scene-\d\.mp3"/g)?.length, 2)
  assert.match(html, /<title>Demo &lt;1&gt;<\/title>/)
  assert.match(html, /<script src="gsap\.min\.js"><\/script>/)
  assert.doesNotMatch(html, /mermaid\.min\.js/)
  assert.match(html, /window\.__timelines = \{ walkthrough: tl \}/)
  assert.match(html, /#scene-1 li:nth-child\(2\)/)
})

test('composeHtml: bullets start muted at the scene start and come up at their cue', () => {
  const timed = timeScenes(
    [bullets],
    [{ audio: 'a.mp3', alignment: alignmentOf(bullets.narration) }]
  )
  const tweens: { at: number; target: string; vars: Record<string, unknown>; duration?: number }[] =
    JSON.parse(/const tweens = (.*)\n/.exec(composeHtml('T', 'classic', timed))?.[1] ?? '[]')
  assert.deepEqual(
    tweens.filter((t) => t.target === '#scene-0 li' && t.at === 0).map((t) => t.vars),
    [{ opacity: 0.5 }]
  )
  const first = tweens.find((t) => t.target === '#scene-0 li:nth-child(1)' && t.vars.opacity === 1)
  assert.equal(first?.at, timed[0]?.cues[0])
})

test('timeScenes: times a cue by its alignment entry when earlier text is astral', () => {
  const scene = (narration: string, cue: string): PreparedScene => ({
    heading: 'H',
    narration,
    visual: { kind: 'bullets', bullets: ['x'] },
    steps: [{ cue, show: ['0'], focus: [] }],
  })
  const [rocket, lift] = timeScenes(
    [scene('🚀 Go now.', 'now'), scene('Lift 🚀🚀 a', 'a')],
    [
      { audio: 'a0.mp3', alignment: alignmentOf('🚀 Go now.') },
      { audio: 'a1.mp3', alignment: alignmentOf('Lift 🚀🚀 a') },
    ]
  )
  assert.deepEqual(rocket?.cues, [0.5])
  assert.deepEqual(lift?.cues, [0.8])
})

test('composeHtml: a scene section never carries the class of the box inside it', async () => {
  const scenes = await prepareScript({
    title: 'T',
    palette: 'classic',
    scenes: [
      {
        heading: 'D',
        narration: 'Flow.',
        visual: { kind: 'diagram', d2: '*: {class: tool}\na -> b' },
        steps: [],
      },
      {
        heading: 'S',
        narration: 'Seq.',
        visual: { kind: 'sequence', mermaid: 'sequenceDiagram\n  A->>B: hi' },
        steps: [],
      },
    ],
  })
  const html = composeHtml(
    'T',
    'classic',
    timeScenes(
      scenes,
      scenes.map(({ narration }) => ({ audio: 'a.mp3', alignment: alignmentOf(narration) }))
    )
  )
  const { document } = new JSDOM(html).window
  for (const [i, box] of ['.diagram', '.mermaid'].entries()) {
    const section = document.querySelector(`#scene-${i}`)
    assert.equal(section?.matches(box), false)
    assert.equal(document.querySelectorAll(box).length, 1)
    assert.equal(section?.querySelectorAll(box).length, 1)
  }
})

test('composeHtml: a diagram is undimmed until the first cue, where it dims and step 0 comes up', async () => {
  const scenes = await prepareScript({
    title: 'T',
    palette: 'classic',
    scenes: [
      { heading: 'B', narration: 'Hi.', visual: { kind: 'title' }, steps: [] },
      {
        heading: 'D',
        narration: 'Intro. The a box, then b.',
        visual: { kind: 'diagram', d2: '*: {class: tool}\na -> b' },
        steps: [
          { cue: 'The a', show: ['a'], focus: [] },
          { cue: 'then b', show: ['b'], focus: [] },
        ],
      },
    ],
  })
  const timed = timeScenes(
    scenes,
    scenes.map(({ narration }) => ({ audio: 'a.mp3', alignment: alignmentOf(narration) }))
  )
  const html = composeHtml('T', 'classic', timed)
  const json = /const tweens = (.*)\n/.exec(html)?.[1] ?? '[]'
  const tweens: { at: number; target: string; vars: Record<string, unknown>; duration?: number }[] =
    JSON.parse(json)
  const [, scene] = timed
  const first = (scene?.start ?? 0) + (scene?.cues[0] ?? 0)
  const all = '#scene-1 .diagram svg svg > g'
  const aOnly = tweens
    .map((tween, index) => ({ ...tween, index }))
    .filter(({ target }) => target.startsWith('#scene-1 g[class~='))
  const dims = tweens
    .map((t, index) => ({ ...t, index }))
    .filter((t) => t.target === all && t.vars.opacity === 0.15)
  assert.deepEqual(
    tweens.filter((t) => t.target === all && t.at === scene?.start),
    []
  )
  assert.equal(dims.length, 1)
  assert.equal(dims[0]?.at, first)
  const lit = aOnly.find((t) => t.at === first && t.vars.opacity === 1)
  assert.ok(lit !== undefined && lit.index > (dims[0]?.index ?? Infinity))
})

test('composeHtml: a diagram opens on the whole of it, however small that makes its text', async () => {
  const names = Array.from({ length: 12 }, (_, i) => `n${i}`)
  const scenes = await prepareScript({
    title: 'T',
    palette: 'classic',
    scenes: [
      {
        heading: 'D',
        narration: 'Intro. The first box.',
        visual: { kind: 'diagram', d2: `*: {class: tool}\n${names.join(' -> ')}` },
        steps: [{ cue: 'The first', show: ['n0'], focus: [] }],
      },
    ],
  })
  const timed = timeScenes(
    scenes,
    scenes.map(({ narration }) => ({ audio: 'a.mp3', alignment: alignmentOf(narration) }))
  )
  const viewBox = /d2-svg" width="\d+" height="\d+" viewBox="([^"]*)"/.exec(
    composeHtml('T', 'classic', timed)
  )?.[1]
  const [x = 0, y = 0, width = 0, height = 0] = (viewBox ?? '').split(' ').map(Number)
  const boxes = [...(scenes[0]?.diagram?.elements.values() ?? [])]
  assert.ok(boxes.length > 0)
  for (const box of boxes) {
    assert.ok(box.x >= x && box.x + box.width <= x + width, `x ${JSON.stringify(box)}`)
    assert.ok(box.y >= y && box.y + box.height <= y + height, `y ${JSON.stringify(box)}`)
  }
})

test('composeHtml: a shown shape glows, a shown edge is recoloured with no glow', async () => {
  const scenes = await prepareScript({
    title: 'T',
    palette: 'classic',
    scenes: [
      {
        heading: 'D',
        narration: 'Intro. The a box and its edge.',
        visual: { kind: 'diagram', d2: '*: {class: tool}\na -> b' },
        steps: [{ cue: 'The a', show: ['a', '(a -> b)[0]'], focus: [] }],
      },
    ],
  })
  const timed = timeScenes(
    scenes,
    scenes.map(({ narration }) => ({ audio: 'a.mp3', alignment: alignmentOf(narration) }))
  )
  const tweens: { at: number; target: string; vars: Record<string, unknown>; duration?: number }[] =
    JSON.parse(/const tweens = (.*)\n/.exec(composeHtml('T', 'classic', timed))?.[1] ?? '[]')
  const at = timed[0]?.cues[0]
  const shape = tweens.filter((t) => t.at === at && 'filter' in t.vars)
  const line = tweens.filter((t) => t.at === at && 'stroke' in t.vars)
  assert.deepEqual(
    shape.map((t) => t.target),
    ['#scene-0 g[class~="YQ=="]']
  )
  assert.deepEqual(
    line.map((t) => [t.target, t.vars.stroke]),
    [[line[0]?.target, '#FFD166']]
  )
  assert.equal(
    tweens.some((t) => t.target.includes('KGEgLSZndDsgYilbMF0=') && 'filter' in t.vars),
    false
  )
})

test('composeHtml: a highlight shows from its cue, ends as D2 drew it, and shows again when seeked back', async () => {
  const d2 = [
    '*: {class: tool}',
    'a <-> b',
    'b -- c',
    'c -> d: {target-arrowhead.shape: diamond}',
    'd -> e: {target-arrowhead.shape: cf-many}',
    'e -> f: {target-arrowhead.shape: cross}',
  ].join('\n')
  const edges = ['(a <-> b)[0]', '(b -- c)[0]', '(c -> d)[0]', '(d -> e)[0]', '(e -> f)[0]']
  const scenes = await prepareScript({
    title: 'T',
    palette: 'classic',
    scenes: [
      {
        heading: 'D',
        narration: 'Intro. All the edges. Then the end.',
        visual: { kind: 'diagram', d2 },
        steps: [{ cue: 'All the', show: edges, focus: [] }],
      },
    ],
  })
  const timed = timeScenes(
    scenes,
    scenes.map(({ narration }) => ({ audio: 'a.mp3', alignment: alignmentOf(narration) }))
  )
  const html = composeHtml('T', 'classic', timed)
  const { window } = new JSDOM(html, { runScripts: 'outside-only' })
  window.eval(
    readFileSync(createRequire(import.meta.url).resolve('gsap/dist/gsap.min.js'), 'utf-8')
  )
  const pageScript = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
  window.eval(pageScript)
  for (let i = 0; i < 10 && window.__timelines === undefined; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  const timeline = window.__timelines.walkthrough
  const scene = timed[0]
  const at = (scene?.start ?? 0) + (scene?.cues[0] ?? 0)
  const until = (scene?.start ?? 0) + (scene?.spoken ?? 0)
  const parts = [...window.document.querySelectorAll('#scene-0 path.connection, #scene-0 marker *')]
  const painted = (el: Element, prop: string): string | null => {
    for (let n: Element | null = el; n !== null && n.localName !== 'svg'; n = n.parentElement) {
      const value = (n as SVGElement).style.getPropertyValue(prop) || n.getAttribute(prop)
      if (value !== null) {
        return value
      }
    }
    return null
  }
  // jsdom reports #FFD166 as an rgb() value.
  const YELLOW = 'rgb(255, 209, 102)'
  const highlighted = () =>
    parts
      .filter((el) => el.localName !== 'g')
      .every((el) => painted(el, 'stroke') === YELLOW || painted(el, 'fill') === YELLOW)
  const inline = () =>
    parts.filter(
      (el) => (el as SVGElement).style.stroke !== '' || (el as SVGElement).style.fill !== ''
    )
  try {
    assert.equal(at < until, true)
    timeline.totalTime(at + 0.01)
    assert.equal(highlighted(), true)
    timeline.totalTime(until + 1)
    assert.deepEqual(inline(), [])
    timeline.totalTime(at + 0.01)
    assert.equal(highlighted(), true)
  } finally {
    window.close()
  }
})

test('composeHtml: a title card carries its heading and subtitle and no narration credit', async () => {
  const scenes = await prepareScript({
    title: 'T',
    palette: 'classic',
    scenes: [
      {
        heading: 'Heading',
        narration: 'Hi.',
        visual: { kind: 'title', subtitle: 'Sub' },
        steps: [],
      },
    ],
  })
  const html = composeHtml(
    'T',
    'classic',
    timeScenes(scenes, [{ audio: 'a.mp3', alignment: alignmentOf('Hi.') }])
  )
  const section = new JSDOM(html).window.document.querySelector('#scene-0')
  assert.equal(section?.querySelector('h1')?.textContent, 'Heading')
  assert.equal(section?.querySelector('.subtitle')?.textContent, 'Sub')
  assert.equal(section?.textContent?.includes('Narrated with'), false)
  assert.equal(html.includes('credit'), false)
})

test('composeHtml: every kind of arrowhead is highlighted in the property that paints it', async () => {
  const kinds = [
    ...[
      'triangle',
      'arrow',
      'diamond',
      'circle',
      'box',
      'cf-one',
      'cf-one-required',
      'cf-many',
      'cf-many-required',
      'cross',
    ].map((shape) => `{shape: ${shape}}`),
    ...['triangle', 'diamond', 'circle', 'box'].map(
      (shape) => `{shape: ${shape}; style.filled: false}`
    ),
  ]
  const d2 = `*: {class: tool}\n${kinds.map((head, i) => `n${i} -> m${i}: {target-arrowhead: ${head}}`).join('\n')}`
  const edges = kinds.map((_, i) => `(n${i} -> m${i})[0]`)
  const scenes = await prepareScript({
    title: 'T',
    palette: 'classic',
    scenes: [
      {
        heading: 'D',
        narration: 'Intro. All the edges. Then the end.',
        visual: { kind: 'diagram', d2 },
        steps: [{ cue: 'All the', show: edges, focus: [] }],
      },
    ],
  })
  const timed = timeScenes(
    scenes,
    scenes.map(({ narration }) => ({ audio: 'a.mp3', alignment: alignmentOf(narration) }))
  )
  const html = composeHtml('T', 'classic', timed)
  const tweens: { at: number; target: string; vars: Record<string, string> }[] = JSON.parse(
    /const tweens = (.*)\n/.exec(html)?.[1] ?? '[]'
  )
  const { document } = new JSDOM(html).window
  const at = timed[0]?.cues[0] ?? 0
  const inline = new Map<Element, Record<string, string>>()
  const paint = (el: Element, prop: string): string | null => {
    for (let n: Element | null = el; n !== null && n.localName !== 'svg'; n = n.parentElement) {
      const value = inline.get(n)?.[prop] ?? n.getAttribute(prop)
      if (value !== null) {
        return value
      }
    }
    return null
  }
  const leaves = [...document.querySelectorAll('#scene-0 marker *')].filter(
    (el) => el.localName !== 'g'
  )
  const before = leaves.map((el) => [paint(el, 'stroke'), paint(el, 'fill')])
  for (const { at: when, target, vars } of tweens) {
    if (when === at && ('stroke' in vars || 'fill' in vars)) {
      for (const el of document.querySelectorAll(target)) {
        inline.set(el, { ...inline.get(el), ...vars })
      }
    }
  }
  assert.equal(leaves.length >= kinds.length, true)
  for (const [i, el] of leaves.entries()) {
    const [stroke, fill] = before[i] ?? []
    const stroked = stroke !== null && stroke !== 'none'
    assert.equal(paint(el, stroked ? 'stroke' : 'fill'), '#FFD166', `${el.localName} ${i}`)
    if (stroked) {
      assert.equal(paint(el, 'fill'), fill, `${el.localName} ${i} keeps its background`)
    }
  }
})

test('composeHtml: two scenes from one D2 share no id, and each edge highlights only its own arrowhead', async () => {
  const d2 = '*: {class: tool}\na -> b\nb -> c'
  const scenes = await prepareScript({
    title: 'T',
    palette: 'classic',
    scenes: [0, 1].map(() => ({
      heading: 'D',
      narration: 'Intro. Then b to c.',
      visual: { kind: 'diagram' as const, d2 },
      steps: [{ cue: 'Then b', show: ['(b -> c)[0]'], focus: [] }],
    })),
  })
  const html = composeHtml(
    'T',
    'classic',
    timeScenes(
      scenes,
      scenes.map(({ narration }) => ({ audio: 'a.mp3', alignment: alignmentOf(narration) }))
    )
  )
  const { document } = new JSDOM(html).window
  const ids = [...document.querySelectorAll('[id]')].map((el) => el.id)
  assert.equal(new Set(ids).size, ids.length)
  const tweens = JSON.parse(/const tweens = (.*)\n/.exec(html)?.[1] ?? '[]') as {
    target: string
    vars: Record<string, string>
  }[]
  for (const i of [0, 1]) {
    const scene = document.querySelector(`#scene-${i}`)
    for (const el of scene?.querySelectorAll('[marker-end], [mask], [filter]') ?? []) {
      for (const attr of ['marker-end', 'mask', 'filter']) {
        const id = /url\(#([^)]+)\)/.exec(el.getAttribute(attr) ?? '')?.[1]
        if (id !== undefined) {
          assert.equal(scene?.querySelector(`[id="${id}"]`) === null, false)
        }
      }
    }
    const head = tweens.find(
      (t) => t.vars.fill === '#FFD166' && t.target.startsWith(`#scene-${i} `)
    )
    const targeted = new Set(document.querySelectorAll(head?.target ?? '!'))
    const polygons = [...(scene?.querySelectorAll('marker polygon') ?? [])]
    assert.equal(targeted.size, 1)
    const edge = [...(scene?.querySelectorAll('path.connection') ?? [])].find((path) =>
      path.closest('g')?.matches(`g[class~="${Buffer.from('(b -&gt; c)[0]').toString('base64')}"]`)
    )
    const marker = scene?.querySelector(
      `[id="${/url\(#([^)]+)\)/.exec(edge?.getAttribute('marker-end') ?? '')?.[1]}"]`
    )
    assert.deepEqual([...targeted], [marker?.querySelector('polygon')])
    assert.equal(polygons.length, 2)
  }
})

test('composeHtml: a sequence is whole until the first cue, then lights each participant and message at its cue', async () => {
  const scenes = await prepareScript({
    title: 'T',
    palette: 'classic',
    scenes: [
      {
        heading: 'S',
        narration: 'Intro. The renderer starts. It asks for a voice. Then the end.',
        visual: { kind: 'sequence', mermaid: SEQUENCE },
        steps: [
          { cue: 'The renderer', show: ['rd'], focus: [] },
          { cue: 'It asks', show: ['1'], focus: [] },
        ],
      },
    ],
  })
  const timed = timeScenes(
    scenes,
    scenes.map(({ narration }) => ({ audio: 'a.mp3', alignment: alignmentOf(narration) }))
  )
  const html = composeHtml('T', 'classic', timed)
  const tweens: { at: number; target: string; vars: Record<string, unknown>; duration?: number }[] =
    JSON.parse(/const tweens = (.*)\n/.exec(html)?.[1] ?? '[]')
  const fixture = readFileSync(
    new URL('./fixtures/sequence-mermaid-12.svg', import.meta.url),
    'utf-8'
  )
  const { window } = new JSDOM(html, { runScripts: 'outside-only' })
  window.eval(
    readFileSync(createRequire(import.meta.url).resolve('gsap/dist/gsap.min.js'), 'utf-8')
  )
  // Stands in for Mermaid's render, which needs a browser's layout, with Mermaid 12's own output.
  Object.assign(window, {
    mermaid: {
      initialize: () => undefined,
      run: async () => {
        for (const pre of window.document.querySelectorAll('pre.mermaid')) {
          pre.innerHTML = fixture
        }
      },
    },
  })
  window.eval(/<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '')
  for (let i = 0; i < 10 && window.__timelines === undefined; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  const timeline = window.__timelines.walkthrough
  const doc = window.document
  const [scene] = timed
  const [rdAt = 0, voiceAt = 0] = scene?.cues ?? []
  const opacity = (el: Element | null) => (el as SVGElement | null)?.style.opacity ?? 'missing'
  const label = (text: string) =>
    [...doc.querySelectorAll('#scene-0 text.messageText')].find((el) => el.textContent === text) ??
    null
  const YELLOW = 'rgb(255, 209, 102)'
  try {
    assert.deepEqual(
      [...doc.querySelectorAll('#scene-0 text.messageText')].map((el) =>
        el.getAttribute('data-message')
      ),
      ['0', '1', '1', '2', '3', '4']
    )
    assert.deepEqual(
      [
        ...new Set(
          [...doc.querySelectorAll('#scene-0 [data-participant]')].map((el) =>
            el.getAttribute('data-participant')
          )
        ),
      ].sort(),
      ['el', 'rd', 'u']
    )
    timeline.totalTime(rdAt - 0.05)
    assert.deepEqual(
      [...doc.querySelectorAll('#scene-0 .mermaid > svg > *')].filter(
        (el) => !['', '1'].includes(opacity(el))
      ),
      []
    )
    timeline.totalTime(rdAt + 0.5)
    assert.equal(opacity(doc.querySelector('#scene-0 [data-participant="rd"]')), '1')
    assert.equal(opacity(doc.querySelector('#scene-0 [data-participant="u"]')), '0.15')
    assert.equal(opacity(label('voice')), '0.15')
    assert.ok(
      tweens.some(
        (t) =>
          t.at === rdAt && t.target === '#scene-0 [data-participant="rd"]' && 'filter' in t.vars
      )
    )
    timeline.totalTime(voiceAt + 0.5)
    const voiceLines = [...doc.querySelectorAll('#scene-0 text[data-message="1"]')].filter((el) =>
      el.classList.contains('messageText')
    )
    assert.deepEqual(
      voiceLines.map((el) => el.textContent),
      ['voice', 'request']
    )
    for (const line of voiceLines) {
      assert.equal(opacity(line), '1')
      assert.equal((line as SVGElement).style.fill, YELLOW)
    }
    assert.equal(
      (doc.querySelector('#scene-0 .messageLine0[data-message="1"]') as SVGElement | null)?.style
        .stroke,
      YELLOW
    )
    assert.equal((label('render') as SVGElement | null)?.style.fill, '')
  } finally {
    window.close()
  }
})

test('composeHtml: a voiced walkthrough has no captions and the full diagram area', () => {
  const timed = timeScenes(
    [title, bullets],
    [
      { audio: 'a0.mp3', alignment: alignmentOf(title.narration) },
      { audio: 'a1.mp3', alignment: alignmentOf(bullets.narration) },
    ]
  )
  assert.deepEqual(
    timed.map(({ captions }) => captions),
    [[], []]
  )
  const html = composeHtml('T', 'classic', timed)
  assert.doesNotMatch(html, /caption/)
  assert.match(html, new RegExp(`height: ${DIAGRAM_AREA.height}px`))
})

test('composeHtml: a silent walkthrough has no audio, and shows each caption until the next', () => {
  const timed = timeScenes(
    [title, bullets],
    [
      { audio: undefined, alignment: alignmentOf(title.narration) },
      { audio: undefined, alignment: alignmentOf(bullets.narration) },
    ]
  )
  const html = composeHtml('T', 'classic', timed)
  assert.doesNotMatch(html, /<audio/)
  assert.match(html, /<p class="caption" data-caption="0">Hello\.<\/p>/)
  assert.match(html, /<p class="caption" data-caption="1">Then two\.<\/p>/)
  assert.match(html, new RegExp(`height: ${CAPTIONED_DIAGRAM_AREA.height}px`))
  const tweens: { at: number; target: string; vars: Record<string, unknown>; duration?: number }[] =
    JSON.parse(/const tweens = (.*)\n/.exec(html)?.[1] ?? '[]')
  const second = timed[1]
  const shown = (caption: number) =>
    tweens
      .filter((t) => t.target === `#scene-1 [data-caption="${caption}"]`)
      .map(({ at, vars, duration }) => [at, vars.opacity, duration])
  const base = second?.start ?? 0
  const secondAt = base + (second?.captions[1]?.at ?? 0)
  assert.deepEqual(shown(0), [
    [base, 1, 0.2],
    [secondAt - 0.2, 0, 0.2],
  ])
  assert.deepEqual(shown(1), [
    [secondAt, 1, 0.2],
    [base + (second?.duration ?? 0) - 0.2, 0, 0.2],
  ])
})

const styleOf = (html: string): string => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ''

test('composeHtml: a silent walkthrough sizes its bullets to clear the caption band, after the base rules', () => {
  const style = styleOf(
    composeHtml(
      'T',
      'classic',
      timeScenes([bullets], [{ audio: undefined, alignment: alignmentOf(bullets.narration) }])
    )
  )
  const baseUl = style.indexOf('\nul { position: absolute')
  const baseLi = style.indexOf('\nli { margin-bottom: 28px')
  const ul = style.indexOf('\nul { font-size: 40px; line-height: 1.3; }')
  const li = style.indexOf('\nli { margin-bottom: 20px; }')
  assert.ok(baseUl >= 0 && baseLi >= 0, 'base bullet rules are present')
  assert.ok(ul > baseUl, 'the captioned ul rule follows the base ul rule')
  assert.ok(li > baseLi, 'the captioned li rule follows the base li rule')
})

test('composeHtml: a voiced walkthrough keeps the base bullet sizing', () => {
  const html = composeHtml(
    'T',
    'classic',
    timeScenes([bullets], [{ audio: 'a.mp3', alignment: alignmentOf(bullets.narration) }])
  )
  const style = styleOf(html)
  assert.match(style, /font-size: 46px/)
  assert.match(style, /margin-bottom: 28px/)
  assert.doesNotMatch(html, /font-size: 40px; line-height: 1\.3; }/)
  assert.doesNotMatch(html, /margin-bottom: 20px/)
})

test('composeHtml: a silent walkthrough lets a caption break inside a word', () => {
  const style = styleOf(
    composeHtml(
      'T',
      'classic',
      timeScenes([title], [{ audio: undefined, alignment: alignmentOf(title.narration) }])
    )
  )
  assert.match(style, /\.caption \{[^}]*overflow-wrap: anywhere;[^}]*\}/)
})
