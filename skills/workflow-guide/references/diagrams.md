# Diagrams in Workflow Docs

How to draw a diagram in any workflow doc: a PRD, an architecture doc, a change summary, or a bug
summary. Hosting renders them (`notification-protocol.md` §Phase 0), so the hosted Notion page shows
each one as an image in the house style.

## D2 or Mermaid

- **D2** for anything structural: component diagrams, data models, flowcharts, state diagrams, and
  relationship diagrams. Write it in a ` ```d2 ` block.
- **Mermaid** for sequence diagrams only, in a ` ```mermaid ` block. Simple sequence diagrams read
  well there, and D2 has no advantage for them.

## Writing D2 in the house style

The `render-diagrams` CLI owns colours, fonts, box sizes, and layout. Authors write shapes, edges,
and the keywords this section names, and never `style:`. A `style:` you add yourself overrides the
house style for that shape, so leave it out.

- **Palette.** Pick one per doc with the frontmatter key `diagram-palette`: `classic` (the
  default), `everglade`, or `origami`. Every diagram in the doc uses it, so a colour means the same
  thing throughout the doc.
- **Role.** Give every box a `class:` naming what it is. The colour comes from the role:

  | `class` | For |
  |---|---|
  | `actor` | skills, agents, people |
  | `tool` | our own services and CLIs |
  | `external` | third-party services and APIs |
  | `artifact` | docs and files (drawn as a page) |
  | `store` | databases and queues (drawn as a cylinder) |

  A box with no role fails the render. Containers (a shape with shapes inside it) never take a
  class.

  A PRD or bug-summary diagram draws the problem rather than the system, and the roles fit it too:
  people and teams are `actor`; pages, screens, and our own services are `tool`; third-party systems
  are `external`; documents, records, and reports are `artifact`; data and queues are `store`.
- **Icon.** Add `icon: lucide:<name>` to a box, using a name from [lucide.dev](https://lucide.dev/icons).
  Icons go on boxes only, never on containers. An unknown name fails the render.
- **Labels.** Keep them to a few words. The CLI breaks a label across lines to keep each box close
  to square, so don't add line breaks yourself.
- **Data models.** Use `shape: sql_table` with one line per field (`title: string`). A `class:` on
  the table colours its header.
- **Reading order.** A diagram reads in one direction: left to right (`direction: right`) or top to
  bottom (leave `direction` out). At most one group may sit off that line, such as an output placed
  below the flow with `near: bottom-center`, whose edges are drawn as straight lines. A diagram
  whose boxes are spread in several directions can't be followed. Only the top-level `direction`
  takes effect, so a container can't run a different way from the rest of the diagram.
- **Shape.** Aim for about 4:3. That fits both a Notion page's text column and a video frame. Never
  aim for it at the cost of reading order: a wide diagram that reads in one direction beats a 4:3
  one that doesn't. To shorten a long chain, split it into smaller diagrams; don't fold it into a
  grid. A walkthrough video can pan across a wider diagram and highlight one part at a time, so a
  video may draw its own diagrams rather than reuse the doc's.

## Ids

An id is what other things point at: an edge, and in a walkthrough video, a reveal cue. Keep ids
short, lowercase, and stable (`rd`, `rd.d2c`) and put the readable name in the label
(`d2c: D2 compile`). Renaming an id breaks every reference to it; changing a label breaks nothing.

## Example

```d2
direction: right
rd: render-diagrams CLI {
  d2c: D2 compile {class: tool; icon: lucide:code-xml}
  ras: Rasterize {class: tool; icon: lucide:image}
}
doc: Workflow doc {class: artifact; icon: lucide:file-text}
notion: Notion page {class: external; icon: lucide:globe}
doc -> rd.d2c: d2 blocks
rd.d2c -> rd.ras: SVG
rd.ras -> notion: WebP image
```

## What the CLI does with it

`render-diagrams --file "<doc>"` compiles each block with the ELK layout and the doc's palette, and
writes `diagram-<n>.svg`, `diagram-<n>.webp`, and `hosted.md` (the doc with each block replaced by
its image) to `<doc-basename>.assets/`. Hosting sends `hosted.md`. A block that fails to compile
fails the whole doc, and nothing is written.

The CLI lays each diagram out without its icons, then pins every box's size and draws the icon and
label itself as one centred block. D2 pads a shape for its icon in a way that leaves the label
small in a tall box, so drawing icons in post-processing is deliberate, not a workaround to remove.
