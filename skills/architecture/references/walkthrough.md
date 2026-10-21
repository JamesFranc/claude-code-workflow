# Walkthrough Videos

The Architecture skill gives each architecture doc a walkthrough video at the top of its hosted
Notion page: narrated by ElevenLabs or a macOS voice when one is configured, and silent with the
narration as subtitles when neither is. The video tells the story of the work in a few minutes, so
the user can review the design by watching it. The skill writes the script after the doc and
renders it before hosting. Whenever a revision changes what the video says, it re-renders before
re-hosting.

## Files

All of these sit beside the doc in `docs/plans/`. `<doc-basename>` is the doc's file name without
`.md`.

| File | What it is |
|---|---|
| `<doc-basename>.walkthrough.json` | The script. You write it. |
| `<doc-basename>.walkthrough.cache/` | Narration audio, cached by text and voice, and by the model and speed the CLI pins for ElevenLabs or by the scene's cues for a macOS voice. `walkthrough render` writes it; keep it between renders. |
| `<doc-basename>.walkthrough.mp4` | The video. |

The doc's first line under its title embeds the video: `![Walkthrough](<doc-basename>.walkthrough.mp4)`.
Hosting turns that line into a Notion video (`skills/workflow-guide/references/notification-protocol.md`
§Phase 1).

## Choosing the voice

Run `check-tools --require elevenlabs,mac-voice` first. A `failed` result for either one: stop
and print the reason. Otherwise the first configured voice narrates the video:
- `elevenlabs` configured: ElevenLabs narrates it. `ELEVEN_LABS_VOICE_ID` overrides the voice the
  CLI pins, per project.
- else `mac-voice` configured: the macOS voice `WALKTHROUGH_MAC_VOICE` names narrates it, free and
  local. The name is as `say -v '?'` lists it. Premium voices, downloaded under System Settings →
  Accessibility → Read & Speak → System voice → Manage Voices… (Spoken Content before macOS 26),
  sound far better than the built-in compact ones.
- neither: `walkthrough render` makes the video without a voice: each scene lasts as long as
  reading its narration takes, and the narration shows as subtitles. Tell the user in one line
  that the walkthrough is silent and subtitled because no voice is configured.

With both configured, ElevenLabs wins and `walkthrough render` says on stderr that the macOS voice
is ignored.

## Write the script

The script is JSON:

```typescript
interface WalkthroughScript {
  title: string
  palette: 'classic' | 'everglade' | 'origami'  // the doc's diagram-palette
  scenes: Scene[]
}

interface Scene {
  heading: string          // shown on screen
  narration: string        // spoken; one narration per scene
  visual:
    | { kind: 'title'; subtitle?: string }
    | { kind: 'bullets'; bullets: string[] }
    | { kind: 'diagram'; d2: string }
    | { kind: 'sequence'; mermaid: string }
  steps?: Step[]           // timed reveals, in narration order
}

interface Step {
  cue: string       // a phrase copied exactly from the scene's narration
  show: string[]    // diagram: D2 ids; bullets: bullet indexes as strings ("0");
                    // sequence: participant ids and message indexes as strings ("0")
  focus?: string[]  // diagram only: D2 ids for the camera to frame
}
```

### Tell the story through the work

The video runs as long as the content needs. Scenes go in this order:

1. **Title.** The doc's title, with a one-line subtitle.
2. **The problem.** From the PRD, as bullets.
3. **North Star.** From the PRD, in a sentence or two.
4. **The shape of it.** One diagram of the whole design, with one step per story. It opens on the
   whole diagram, however small that makes it. Zoom in from a step, with `focus`, not before.
5. **Each story, in order.** Head each of its scenes `Story 2 of 5: <topic>` when there are more
   than three stories, and `Story 2: <topic>` otherwise. When the doc groups its stories into
   phases, head it `Phase A: Story 2 of 5: <topic>`, counting the stories within the phase. A story
   brings in what it needs at the point it matters:
   - the data shapes it adds or changes, shown against the existing shape when one exists;
   - the success criteria it serves;
   - the key decisions behind it;
   - its risks.

   Give a story as many scenes as that takes.
6. **Wrap-up.** The whole design once more, and what "done" looks like. End the narration by
   telling the viewer that all the details are in the Architecture doc in Notion, and that they can
   leave comments there.

There are no separate sections for success criteria, decisions, data or risks. Each one appears
inside the story it belongs to.

### Narration

Write it to be heard: plain spoken sentences, no markdown, no ids, and no file paths read out. Say
what a thing is for, not what it is called in the code. Don't mention the voice or how it was made.

### Steps

What lights up when is the part a viewer notices. Steps follow these rules:

- **Light only what the cue sentence names.** A step's `show` holds what its sentence talks about,
  usually one box and its edges. Never light most of a diagram in one step; a viewer can't follow
  that.
- **Give each step time.** Put cues at least a sentence apart, so every step stays on screen for a
  few seconds before the next.
- **Diagrams open whole and undimmed.** A diagram or sequence scene first shows the whole diagram
  at full strength, however large it is. Everything dims at the first cue, so start the first cue a
  sentence or so in, after the viewer has seen the whole.
- **Bullets start muted.** Every bullet is on screen from the start, muted, and each turns solid at
  its cue. Give each bullet its own step.
- **Use `focus` to zoom.** Use it when the step's boxes are small in a large diagram. Leave it out
  otherwise. A sequence scene can't zoom.

In a diagram scene, `show` and `focus` take D2 ids:
- a shape is its path: `rd`, `rd.d2c`;
- an edge is `(<from> <operator> <to>)[<n>]`, with the operator as written (`->`, `<-`, `<->`,
  `--`): `(docs.d2 -> rd.d2c)[0]`. The number n counts from 0 within one source, operator and
  target, so `a -> b`, `a <-> b` and `b -> a` are each `[0]`, and a second `a -> b` is
  `(a -> b)[1]`;
- an edge inside a container is written inside its path: `rd.(d2c -> ras)[0]`.

In a sequence scene, `show` takes:
- a participant, by the id in the Mermaid source: `rd` for `participant rd as Renderer`;
- a message, by its place among the messages, counting from 0 in source order: `"0"` is the first
  arrow. Notes, blocks such as `loop` and `alt`, and activations are not messages and are not
  counted.

A participant glows, box and lifeline. A message's arrow and label turn yellow.

### Diagrams

Draw each diagram in the house style (`skills/workflow-guide/references/diagrams.md`), with its
reading order and shape rules. Reuse the doc's diagrams and their ids where they fit, so the video
and the doc agree. Draw a diagram of the video's own when the story needs a narrower view.

## Render

```bash
walkthrough render --script "docs/plans/<doc-basename>.walkthrough.json" --out "docs/plans/<doc-basename>.walkthrough.mp4"
```

- The command checks the whole script before it spends anything: the schema, every cue against its
  narration, every diagram compiling, and every `show` id existing. A non-zero exit with a list of
  problems means fix the script and re-run.
- Exit 2 means a tool it needs isn't usable:
  - `ffmpeg -version` doesn't run cleanly, whether `ffmpeg` is missing or broken;
  - `ELEVEN_LABS_API_KEY` is unset, `WALKTHROUGH_MAC_VOICE` is set, and `say` or `ffprobe` doesn't
    run cleanly, whether it is missing or broken (`say` is macOS-only);
  - `hyperframes browser ensure`, run through `npx`, doesn't exit 0. For example: `npx` is missing,
    the HyperFrames package can't be fetched, or no Chrome can be found or downloaded.
- An ElevenLabs error exits 1 with its status. Stop and report ElevenLabs as broken, the same as
  `check-tools`' `onFailure`. Scenes already voiced stay cached.
- With `ELEVEN_LABS_API_KEY` unset, a `WALKTHROUGH_MAC_VOICE` naming a voice that isn't installed
  exits 1 before anything renders.
  Stop and report it, the same as `check-tools`' `onFailure` for `mac-voice`.
- stdout is a JSON summary. `narrated: false` means the video was rendered silent, with subtitles.
  `voice` says which voice narrated it: `elevenlabs`, `mac`, or `null`.
  `overNotionLimit: true` means the video is over 20 MiB and won't upload.
  Host the doc without the video and tell the user.

### Watch it before hosting

Pull a few frames as PNGs, one per diagram or sequence scene, at the scene's busiest step; in a
silent video, also one per title and bullets scene:
`ffmpeg -loglevel error -ss "<seconds>" -i "<mp4>" -frames:v 1 "<scratchpad>/<name>.png"`. Have an
`artifact-viewer` check each frame:
- the lit elements match what the cue names;
- the diagram reads in one direction;
- nothing is clipped;
- in a silent video, the subtitle reads cleanly and sits below the diagram, not over it.

Never write raw video frames (`.rgb`, rawvideo) to disk: the user's antivirus deletes them as
malware. Use PNG.

## Host the script

The user critiques the script as text, before or alongside the video. Once the architecture page is
hosted (`skills/workflow-guide/references/notification-protocol.md` §Phase 1), host the script as a
child page of it.

- **First time:**
  - Create the page with `notion-create-pages`, with `parent: { page_id: "<architecture page id>" }`
    and the title `Walkthrough script — <doc title>`.
  - Add `walkthrough-notion-page-id: <new page id>` to the architecture doc's frontmatter.
- **Afterwards:** update that page in place with `notion-update-page` and `command: "replace_content"`.

The page lists the scenes in order. For each scene it gives:
- the heading;
- what is on screen, in prose. For a diagram, that includes a key from each id to its label.
- the narration;
- the cues, each with what it lights.

## Revisions

When the user's review changes the design:
1. Edit the script wherever the change touches what the video says.
2. Re-render. A scene is voiced again, and charged, only when the cache holds no audio for its text
   in the voice, and the model and speed the CLI pins (for a macOS voice, the scene's cues), now in
   use. Every other scene comes from the cache and costs nothing.
3. Re-host the doc and the script page.

A hosted video never contradicts its hosted doc.
