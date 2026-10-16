import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ZOOM, bringIntoView, frame, union } from './camera.ts'

const viewport = { width: 1800, height: 900 }
const wide = { x: 0, y: 0, width: 6000, height: 300 }

test('frame: keeps the viewport aspect ratio and never zooms past MAX_ZOOM', () => {
  const view = frame({ x: 100, y: 100, width: 50, height: 50 }, wide, viewport)
  assert.equal(view.width / view.height, viewport.width / viewport.height)
  assert.equal(view.width, viewport.width / MAX_ZOOM)
})

test('frame: keeps the view inside the diagram (plus margin) when the target is at an edge', () => {
  const view = frame({ x: 5900, y: 100, width: 100, height: 100 }, wide, viewport)
  assert.equal(view.x + view.width, 6040)
})

test('bringIntoView: stays put when the target is already in view, else moves just far enough', () => {
  const current = { x: 0, y: 0, width: 1800, height: 900 }
  assert.deepEqual(
    bringIntoView(current, { x: 100, y: 100, width: 200, height: 100 }, wide, viewport),
    current
  )
  const moved = bringIntoView(current, { x: 2000, y: 100, width: 200, height: 100 }, wide, viewport)
  assert.deepEqual(moved, { ...current, x: 2240 - 1800 })
})

test('union: bounds every rect', () => {
  assert.deepEqual(
    union([
      { x: 0, y: 10, width: 5, height: 5 },
      { x: 20, y: 0, width: 5, height: 5 },
    ]),
    { x: 0, y: 0, width: 25, height: 15 }
  )
})
