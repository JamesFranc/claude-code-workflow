import type { Rect } from '../render-diagrams/render.ts'

// Where the camera looks in a diagram scene, as an SVG viewBox in the diagram's own coordinates
// (FLOW-390 architecture doc, "Camera"). A view always has the viewport's aspect ratio, so the
// diagram is never stretched.

export interface Size {
  width: number
  height: number
}

// The closest the camera zooms, so one small box never fills the frame.
export const MAX_ZOOM = 1.6
const MARGIN = 40

// The tightest view holding `target` with a margin, centred on it and kept inside the diagram.
export const frame = (target: Rect, diagram: Rect, viewport: Size): Rect => {
  const aspect = viewport.width / viewport.height
  let width = Math.max(target.width + 2 * MARGIN, viewport.width / MAX_ZOOM)
  let height = Math.max(target.height + 2 * MARGIN, viewport.height / MAX_ZOOM)
  if (width / height > aspect) {
    height = width / aspect
  } else {
    width = height * aspect
  }
  const x = clamp(
    target.x + target.width / 2 - width / 2,
    width,
    diagram.x - MARGIN,
    diagram.x + diagram.width + MARGIN
  )
  const y = clamp(
    target.y + target.height / 2 - height / 2,
    height,
    diagram.y - MARGIN,
    diagram.y + diagram.height + MARGIN
  )
  return { x, y, width, height }
}

// `current` when it already holds `target`; else the smallest move that brings it in, zooming out
// only when `target` is bigger than the view.
export const bringIntoView = (current: Rect, target: Rect, diagram: Rect, viewport: Size): Rect => {
  if (target.width + 2 * MARGIN > current.width || target.height + 2 * MARGIN > current.height) {
    return frame(union([current, target]), diagram, viewport)
  }
  const x = shift(current.x, current.width, target.x - MARGIN, target.x + target.width + MARGIN)
  const y = shift(current.y, current.height, target.y - MARGIN, target.y + target.height + MARGIN)
  return { ...current, x, y }
}

export const union = (rects: Rect[]): Rect => {
  const x = Math.min(...rects.map((rect) => rect.x))
  const y = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x, y, width: right - x, height: bottom - y }
}

// Moves a view's start along one axis just far enough to cover [from, to].
const shift = (start: number, length: number, from: number, to: number): number =>
  from < start ? from : to > start + length ? to - length : start

// Keeps a view's start on one axis inside [low, high], centring a view longer than that span.
const clamp = (start: number, length: number, low: number, high: number): number =>
  length >= high - low
    ? low - (length - (high - low)) / 2
    : Math.min(Math.max(start, low), high - length)
