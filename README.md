<div align="center">
  <img src="public/logo-transparent.png" width="420" alt="BPMN FlowSmith logo" />

  # BPMN FlowSmith

  **Prompt-to-diagram workflow for BPMN 2.0** — paste a JSON process definition, get an auto-laid-out, fully editable BPMN canvas, export it as `.bpmn`.

  [bpmn-js](https://github.com/bpmn-io/bpmn-js) · [bpmn-moddle](https://github.com/bpmn-io/bpmn-moddle) · [bpmn-auto-layout](https://github.com/bpmn-io/bpmn-auto-layout) · [Next.js](https://nextjs.org)
</div>

---

A plain-text process description goes in, a real BPMN 2.0 diagram comes out. FlowSmith generates the
XML from JSON, runs an automatic layout on it and hands the result to a full bpmn-js modeler, so every
element can still be moved, renamed, extended or deleted before you export.

## Features

- **JSON → BPMN** — validated process definitions are converted to BPMN 2.0 XML with `bpmn-moddle`.
- **Automatic layout** — `bpmn-auto-layout` computes coordinates and routes sequence-flow waypoints.
- **Editable canvas** — the full bpmn-js palette, context pad, drag & drop, direct labeling and undo.
- **Fullscreen editing** — expand the diagram to the whole viewport, `Esc` exits again.
- **Import & export** — read existing `.bpmn`/`.xml` files, download the current canvas as `.bpmn`.
- **Auto-layout on import** — files without layout information (`BPMNDiagram` DI) are laid out first.
- **No page scrolling** — the app is bound to the viewport height; only the editor and side panel scroll.
- **Strict output prompt** — one click copies the system prompt for LLMs that emit the JSON schema.
- **Dark mode** — follows `prefers-color-scheme`.

## Getting started

Requirements: **Node.js >= 20.9** (Next.js 16) and npm.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

| Script            | Description                              |
| ----------------- | ---------------------------------------- |
| `npm run dev`     | Start the dev server (Turbopack)          |
| `npm run build`   | Production build                         |
| `npm run start`   | Serve the production build               |
| `npm run lint`    | ESLint                                   |
| `npx tsc --noEmit`| Type check                               |

## Workflow

1. Click **Copy QwenCoder Prompt** and paste it into your LLM together with a plain-English process
   description.
2. Paste the returned JSON into the **Process definition (JSON)** editor.
3. Click **Generate & Edit Diagram** (or press `Ctrl`/`⌘` + `Enter`).
4. Refine the result on the canvas, optionally in fullscreen.
5. Click **Export .bpmn** to download the current state of the canvas.

## Input schema

```jsonc
{
  "processId": "Process_1",              // required, non-empty string
  "processName": "Application Review",   // optional
  "lanes": [                             // optional, ids must be unique
    { "id": "lane_1", "name": "Clerk" }
  ],
  "nodes": [                             // required, at least one, ids must be unique
    {
      "id": "task_1",                    // required
      "type": "userTask",                // required, see below
      "label": "Review Application",     // optional, becomes the element name
      "laneId": "lane_1"                 // optional, must reference an existing lane
    }
  ],
  "edges": [                             // optional, ids must be unique
    {
      "id": "e1",                        // required
      "sourceId": "start_1",             // required, must reference an existing node
      "targetId": "task_1",              // required, must reference an existing node
      "condition": "Yes"                 // optional, becomes the sequence flow name
    }
  ]
}
```

Validation errors point at the exact path, e.g. `edges[2].sourceId references unknown node "start_1".`

### Supported node types

`startEvent`, `endEvent`, `intermediateThrowEvent`, `intermediateCatchEvent`, `exclusiveGateway`,
`inclusiveGateway`, `parallelGateway`, `eventBasedGateway`, `complexGateway`, `task`, `userTask`,
`serviceTask`, `manualTask`, `scriptTask`, `sendTask`, `receiveTask`, `businessRuleTask`,
`subProcess`, `callActivity`, `dataObjectReference`, `dataStoreReference`

## How it works

```
JSON  →  parseDiagramInput()      validation + normalisation   (lib/bpmn-diagram.ts)
     →  buildBpmnXml()            bpmn-moddle: bpmn:Definitions, Process, LaneSet, flows
     →  layoutBpmnXml()           bpmn-auto-layout: coordinates + edge waypoints
     →  modeler.importXML()       bpmn-js Modeler on the canvas
```

The modeler is loaded with a dynamic `import()` on the client, so the ~490 kB bpmn-js bundle is not part
of the initial page load. Export uses `await modeler.saveXML({ format: true })`, which always reflects
the current canvas state, including manual edits.

## Project structure

```
app/
  layout.tsx                    shell, fonts, metadata, favicon (app/icon.png), footer
  page.tsx                      renders the FlowSmith workspace
  globals.css                   Tailwind entry + color tokens
components/
  BpmnFlowSmith.tsx             client component: editor, modeler, fullscreen, import/export
lib/
  bpmn-diagram.ts               JSON validation, BPMN generation, layout wrapper
types/
  bpmn-moddle.d.ts              ambient types for bpmn-moddle
  bpmn-auto-layout.d.ts         ambient types for bpmn-auto-layout
public/
  logo.png                      original logo (1408×768, opaque white background)
  logo-transparent.png          background-free variant used in this README
  flowsmith-logo.png            trimmed variant, source for the app icon
```

## Notes and limitations

- **Lanes are not drawn as swimlanes.** `lanes` and `laneId` are written into the XML as a semantic
  `bpmn:LaneSet`, but `bpmn-auto-layout` does not create lane DI, so the canvas shows positioned shapes
  without lane boxes.
- **`condition` is a label.** It is exported as the sequence flow's `name`, not as a formal
  `bpmn:conditionExpression`.
- **The XML preview is a snapshot.** It shows the last generated or imported XML. After canvas edits an
  `edited` badge appears; use **Export .bpmn** to get the current state.
- **The modeler is client-only.** Diagram rendering requires JavaScript; the page itself is statically
  prerendered.

## Tech stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 5 · Tailwind CSS 4 ·
[bpmn-js 18](https://github.com/bpmn-io/bpmn-js) · [bpmn-moddle 10](https://github.com/bpmn-io/bpmn-moddle) ·
[bpmn-auto-layout 1](https://github.com/bpmn-io/bpmn-auto-layout)

## License

No license file has been added yet — all rights reserved until one is chosen.