import { after, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DiagramSourceError,
  EDGE_COLOUR,
  EDGE_FONT_SIZE,
  PALETTES,
  createDiagramRenderer,
  groupClass,
  pickLabelBox,
} from './render.ts'

const renderer = createDiagramRenderer('classic')
after(() => renderer.close())

test('pickLabelBox: breaks a two-word label onto two lines when that gives the smaller box', () => {
  const box = pickLabelBox('Composition builder', (line) => line.length * 16, true)
  assert.deepEqual(box.lines, ['Composition', 'builder'])
  assert.ok(box.width >= box.height, `${box.width}x${box.height} is taller than wide`)
})

test('pickLabelBox: grows a short one-word label in height rather than width', () => {
  const box = pickLabelBox('Agent', (line) => line.length * 16, true)
  assert.deepEqual(box.lines, ['Agent'])
  assert.equal(box.width, 5 * 16 + 40)
  assert.ok(box.height <= box.width)
})

test('render: inlines a lucide icon as a data URI and draws the label as centred lines', async () => {
  const { svg, webp } = await renderer.render(
    'tts: TTS + cache {class: tool; icon: lucide:audio-lines}'
  )
  assert.match(svg, /<image href="data:image\/svg\+xml;base64,[^"]+"/)
  assert.doesNotMatch(svg, /href="https?:/)
  const lines = [...svg.matchAll(/<tspan [^>]*>([^<]*)<\/tspan>/g)].map((match) => match[1])
  assert.equal(lines.join(' '), 'TTS + cache')
  assert.match(svg, /fill="#2B3038"/)
  assert.ok(webp.length > 0)
})

test('render: reports a compile error at its line within the block, not the prelude', async () => {
  await assert.rejects(renderer.render('a -> b\nc ->'), (err: unknown) => {
    assert.ok(err instanceof DiagramSourceError)
    assert.match(err.message, /^2:1: connection missing destination/)
    return true
  })
})

test('render: rejects an icon name lucide does not have', async () => {
  await assert.rejects(
    renderer.render('a: A {class: tool; icon: lucide:not-a-real-icon}'),
    /unknown lucide icon 'not-a-real-icon'/
  )
})

test('render: rejects an icon on a container', async () => {
  await assert.rejects(
    renderer.render('box: Box {\n  icon: lucide:mic\n  a: A\n}'),
    /'box': icons are supported only on leaf boxes/
  )
})

test('render: draws shape: circle and shape: square leaves with a label', async () => {
  for (const shape of ['circle', 'square']) {
    const { svg } = await renderer.render(`a: Composition builder {class: tool; shape: ${shape}}`)
    const lines = [...svg.matchAll(/<tspan [^>]*>([^<]*)<\/tspan>/g)].map((match) => match[1])
    assert.equal(lines.join(' '), 'Composition builder')
  }
})

test('render: gives every edge kind the house style, not only ->', async () => {
  const kinds = ['->', '<->', '<-', '--']
  const { svg } = await renderer.render(
    ['a: A {class: tool}', 'b: B {class: tool}', ...kinds.map((kind) => `a ${kind} b: x`)].join(
      '\n'
    )
  )
  for (const kind of kinds) {
    const id = `(a ${kind} b)[0]`
    const group = svg.match(
      new RegExp(`<g class="${groupClass(id).replace(/[+=/]/g, '\\$&')}[^"]*">[\\s\\S]*?</g>`)
    )?.[0]
    assert.ok(group, `no group for ${id}`)
    assert.match(group, new RegExp(`<path [^>]*stroke="${EDGE_COLOUR}"`), id)
    assert.match(group, new RegExp(`font-size:${EDGE_FONT_SIZE}px`), id)
    assert.doesNotMatch(group, new RegExp(PALETTES.classic.container[1]), id)
  }
})

test('pickLabelBox: a 24-word label measures each run of words at most once', () => {
  const words = Array.from({ length: 24 }, (_, i) => `word${i}`)
  const measured: string[] = []
  const box = pickLabelBox(
    words.join(' '),
    (line) => {
      measured.push(line)
      return line.length * 16
    },
    false
  )
  assert.equal(box.lines.join(' '), words.join(' '))
  assert.ok(measured.length <= (24 * 25) / 2, `${measured.length} measurements`)
  assert.equal(new Set(measured).size, measured.length)
})

test('render: reports an empty leaf label as a source error naming the shape', async () => {
  for (const label of ['""', '" "']) {
    await assert.rejects(
      renderer.render(`a: A {class: tool}\nb: ${label}\na -> b`),
      (err: unknown) => {
        assert.ok(err instanceof DiagramSourceError, label)
        assert.equal(err.message, "'b': a box needs a label; this one is empty")
        return true
      }
    )
  }
})

test('render: measures labels D2 would substitute into or that carry a single quote', async () => {
  const out = await renderer.render(`a: 'cost \${x}' {class: tool}\nb: "it's" {class: tool}`)
  const lines = [...out.svg.matchAll(/<tspan [^>]*>([^<]*)<\/tspan>/g)].map((match) => match[1])
  assert.equal(lines.join(' '), 'cost ${x} it&#39;s')
})

test('render: draws a label for ids D2 escapes in the group class', async () => {
  const out = await renderer.render(
    `"a.b": one {class: tool}\n"a;b": two {class: tool}\n'x\${y}': three {class: tool}`
  )
  assert.match(out.svg, />one</)
  assert.match(out.svg, />two</)
  assert.match(out.svg, />three</)
})

test('render: returns the bounds of each shape and each connection route, by id', async () => {
  const { elements } = await renderer.render('a: A {class: tool}\nb: B {class: tool}\na -> b')
  assert.deepEqual(
    [...elements],
    [
      ['a', { x: 12, y: 12, width: 60, height: 70 }],
      ['b', { x: 13, y: 152, width: 57, height: 70 }],
      ['(a -> b)[0]', { x: 42, y: 82, width: 0, height: 70 }],
    ]
  )
})

test('render: rejects a leaf box with no role, naming the box and the roles', async () => {
  await assert.rejects(renderer.render('a: A {class: tool}\nb: B\na -> b'), (err: unknown) => {
    assert.ok(err instanceof DiagramSourceError)
    assert.equal(
      err.message,
      "'b': a box needs a role; give it class: actor, tool, external, artifact, store"
    )
    return true
  })
})

test('render: a container takes no role and still renders', async () => {
  const { svg } = await renderer.render('box: Box {\n  a: A {class: tool}\n}')
  assert.match(svg, />Box</)
  assert.match(svg, />A</)
})
